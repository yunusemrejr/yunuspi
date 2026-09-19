// pi-lens recent-write autofix debounce patch — re-applied by verify-harness.mjs
// (auto-discovered patch registry [3]).
//
// WHAT: pi-lens ran formatters and biome/ruff/eslint autofixes on a file the
// moment its write tool-result was processed. When the model issues two write
// calls to the same file in quick succession (long multi-part file, staged
// edits), the first write's autofix could rewrite the half-written draft,
// and the model then continued from a corrupted base.
//
// FIX: a recent-write debounce. Both mutation chokepoints in the fork's
// dist bundle — runAutofix (biome/ruff/eslint/stylelint/... fixers) and
// runFormatPhase (formatters) — now skip when the target file's mtime is
// younger than PI_LENS_RECENT_WRITE_SKIP_MS (default 5000). Diagnostics are
// UNCHANGED (report-only checks still run; only file mutation is debounced),
// and the next tool-result/agent-end pass after the debounce window applies
// fixes as before. Both the immediate tool-result path and the deferred
// agent-end drain route through these two functions, so one guard covers all
// mutation paths.
//
// Idempotent: no-op when the PI_LENS_RECENT_WRITE_SKIP marker is present.
// Exits 0 on success/no-op, 1 on anchor mismatch (upstream rebuild — patch
// needs updating). CLI: node pi-lens-autofix-debounce.mjs [--fix] (default:
// report only).
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const MARKER = "PI_LENS_RECENT_WRITE_SKIP";
// Resolved at run time from the invoking user's home, exactly like the other
// pi-lens patch modules. A hardcoded absolute path here would ship an
// unusable target to every other installation, and PI_HARNESS_PATCH_TEST_LENS
// keeps fixture overrides consistent across the patch registry.
const DIST =
  process.env.PI_HARNESS_PATCH_TEST_LENS ??
  path.join(os.homedir(), ".pi/agent/extensions/pi-lens/dist/index.js");
/** Default debounce budget. 5s: comfortably longer than the observed
 * back-to-back write gap (<1s) and far shorter than normal inter-tool-result
 * latency, so real fix cycles are delayed only in the racy case. */
const DEFAULT_BUDGET_MS = 5000;

// Injected before runFormatPhase. `nodeFs7` and `path152` are the bundle's own
// module-scope imports (checked at apply time); function declaration hoisting
// makes the helper visible to runAutofix, which is defined earlier in the file.
const HELPER = `function __piLensRecentlyWritten(filePath, dbg2) {
  try {
    const parsed = Number.parseInt(process.env.PI_LENS_RECENT_WRITE_SKIP_MS ?? "${DEFAULT_BUDGET_MS}", 10);
    const budgetMs = Math.max(0, Number.isNaN(parsed) ? ${DEFAULT_BUDGET_MS} : parsed);
    const ageMs = Math.max(0, Date.now() - nodeFs7.statSync(filePath).mtimeMs);
    if (ageMs < budgetMs) {
      (dbg2 ?? (() => {}))(\`recent-write debounce: skipping mutation of \${filePath} (age \${Math.round(ageMs)}ms < \${budgetMs}ms budget)\`);
      return true;
    }
  } catch {}
  return false;
}

`;

const ANCHOR_FORMAT =
  "async function runFormatPhase(filePath, getFormatService2, dbg2) {\n  let formatChanged = false;";
const REPLACED_FORMAT =
  HELPER +
  "async function runFormatPhase(filePath, getFormatService2, dbg2) {\n" +
  `  if (__piLensRecentlyWritten(filePath, dbg2)) {
    return { filePath, formatters: [], anyChanged: false, allSucceeded: true };
  }
  let formatChanged = false;`;

const ANCHOR_AUTOFIX =
  "async function runAutofix(filePath, cwd, getFlag, dbg2, deps, getFlagSource) {";
const REPLACED_AUTOFIX =
  "async function runAutofix(filePath, cwd, getFlag, dbg2, deps, getFlagSource) {\n" +
  `  if (__piLensRecentlyWritten(filePath, dbg2)) {
    return { fixedCount: 0, autofixTools: [], attemptedTools: [], changedFiles: [], needsContentRefresh: false, skipReason: "recent_write" };
  }`;

function readDist() {
  return fs.readFileSync(DIST, "utf8");
}

function target() {
  return {
    name: "pi-lens dist recent-write autofix debounce",
    exists: () => fs.existsSync(DIST),
    isApplied: () => {
      try {
        return readDist().includes(MARKER);
      } catch {
        return false;
      }
    },
    apply: () => {
      let src = readDist();
      if (src.includes(MARKER)) return;
      // The helper references the bundle's own fs import alias; if a rebuild
      // renamed it, fail loudly instead of shipping a ReferenceError.
      if (!src.includes('import * as nodeFs7 from "node:fs";')) {
        throw new Error(
          "pi-lens dist: nodeFs7 import alias not found (bundle rebuilt?) — update HELPER",
        );
      }
      if (!src.includes(ANCHOR_FORMAT) || !src.includes(ANCHOR_AUTOFIX)) {
        throw new Error(
          "pi-lens dist: anchor mismatch (bundle rebuilt?) — update anchors",
        );
      }
      src = src.replace(ANCHOR_FORMAT, REPLACED_FORMAT);
      src = src.replace(ANCHOR_AUTOFIX, REPLACED_AUTOFIX);
      fs.writeFileSync(DIST, src);
      if (!readDist().includes(MARKER)) {
        throw new Error(
          "pi-lens dist: debounce patch written but marker missing — refusing to report success",
        );
      }
    },
  };
}

export function targets() {
  return [target()];
}

// CLI (patch module convention): default report-only, --fix applies. Guarded
// so importing the module (verify-harness patch registry, tests) never runs
// the CLI or calls process.exit on the importer.
if (
  process.argv[1] &&
  process.argv[1].endsWith("pi-lens-autofix-debounce.mjs")
) {
  const isFix = process.argv.includes("--fix");
  const t = target();
  if (!t.exists()) {
    console.error(`pi-lens-autofix-debounce: dist missing (${DIST})`);
    process.exit(1);
  }
  if (t.isApplied()) {
    console.log("pi-lens-autofix-debounce: already applied");
    process.exit(0);
  }
  if (!isFix) {
    console.log("pi-lens-autofix-debounce: NOT applied (run with --fix)");
    process.exit(1);
  }
  try {
    t.apply();
    console.log("pi-lens-autofix-debounce: applied");
    process.exit(0);
  } catch (e) {
    console.error(
      `pi-lens-autofix-debounce: apply failed — ${String(e.message ?? e)}`,
    );
    process.exit(1);
  }
}

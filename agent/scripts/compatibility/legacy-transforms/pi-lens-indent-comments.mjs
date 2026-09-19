#!/usr/bin/env node
// pi-lens indentation-detection repair: comment-only lines must not vote.
//
// When a project has no prettier config and no .editorconfig, pi-lens detects
// the indentation width from file content and passes it as --tab-width. The
// bundled detector counted EVERY leading-space run, including JSDoc and block
// comment continuations (` * ...`), which start with exactly one space. In a
// comment-heavy file the pairwise delta vote then collapses to width 1 and
// the on-write formatter rewrites the whole file with 1-space indentation.
//
// Fix: exclude comment-only lines (`*`, `//`, `#` after optional whitespace)
// from both the tab and space samples before voting. A file with only
// comments falls back to the default instead of width 1.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../extensions/pi-lens/dist/index.js",
);
const MARKER = "PI_LENS_INDENT_COMMENTS_V1";

const ANCHOR = [
  "function detectIndentation(content) {",
  '  const lines = content.split(/\\r?\\n/);',
  '  const tabs = lines.filter((line) => /^\\t+\\S/.test(line)).length;',
  '  const spaceCounts = lines.map((line) => line.match(/^ +(?=\\S)/)?.[0].length ?? 0).filter((count) => count > 0);',
].join("\n");

const REPLACED = [
  "function detectIndentation(content) {",
  '  const lines = content.split(/\\r?\\n/);',
  `  // ${MARKER}: comment-only lines never establish code indentation.`,
  '  const codeLines = lines.filter((line) => !/^[ \\t]*(?:\\*|\\/\\/|#)/.test(line));',
  '  const tabs = codeLines.filter((line) => /^\\t+\\S/.test(line)).length;',
  '  const spaceCounts = codeLines.map((line) => line.match(/^ +(?=\\S)/)?.[0].length ?? 0).filter((count) => count > 0);',
].join("\n");

export function isAppliedSource(source) {
  return source.includes(MARKER) && source.includes("const codeLines = lines.filter");
}

export function patchSource(source) {
  if (isAppliedSource(source)) return source;
  if (!source.includes(ANCHOR)) {
    throw new Error(
      "pi-lens indentation repair: anchor mismatch (bundle rebuilt?) — update ANCHOR",
    );
  }
  const next = source.replace(ANCHOR, REPLACED);
  if (!isAppliedSource(next)) {
    throw new Error(
      "pi-lens indentation repair: patch written but marker missing — refusing to report success",
    );
  }
  return next;
}

export function targets() {
  return [
    {
      name: "pi-lens indentation detection ignores comment-only lines",
      exists: () => fs.existsSync(DIST),
      isApplied: () => {
        try {
          return isAppliedSource(fs.readFileSync(DIST, "utf8"));
        } catch {
          return false;
        }
      },
      apply: () => {
        const source = fs.readFileSync(DIST, "utf8");
        if (isAppliedSource(source)) return;
        fs.writeFileSync(DIST, patchSource(source));
      },
    },
  ];
}

// CLI (patch module convention): default report-only, --fix applies. Guarded
// so importing the module (verify-harness patch registry, tests) never runs
// the CLI or calls process.exit on the importer.
if (
  process.argv[1] &&
  process.argv[1].endsWith("pi-lens-indent-comments.mjs")
) {
  const isFix = process.argv.includes("--fix");
  const t = targets()[0];
  if (!t.exists()) {
    console.error(`pi-lens-indent-comments: dist missing (${DIST})`);
    process.exit(1);
  }
  if (t.isApplied()) {
    console.log("pi-lens-indent-comments: already applied");
    process.exit(0);
  }
  if (!isFix) {
    console.log("pi-lens-indent-comments: NOT applied (run with --fix)");
    process.exit(1);
  }
  try {
    t.apply();
    console.log("pi-lens-indent-comments: applied");
    process.exit(0);
  } catch (e) {
    console.error(`pi-lens-indent-comments: apply failed — ${String(e.message ?? e)}`);
    process.exit(1);
  }
}

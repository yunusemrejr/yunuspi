// semantic-radar/runtime.mjs — turn-end adapter used by the pi-lens bundle
// (via scripts/compatibility/legacy-transforms/pi-lens-semantic-dry.mjs). Keeps ALL policy here so the
// bundle patch stays tiny: gating, filtering, dedup, caps, formatting,
// project-diagnostics emission (=> existing disposition/suppression pipeline).
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { findDivergences, buildIndex, sourcePath } from "./radar.mjs";
import { compareCandidates } from "./neural-ranker.mjs";
import { appendTurn } from "./ledger.mjs";

// PI_LENS_RADAR_STATE_V1: cold full build once; subsequent turns update changed files only.
const MAX_TURN_FILES = 25;
const _building = new Set();
const _built = new Set();

// Share query ordering so turn-end selection preserves the ranked candidates.

/**
 * Turn-end check. Returns {advisory, divergences, diagnostics} or null.
 * modifiedAbsPaths: this turn's edited files (absolute). Never throws.
 */
export async function turnEndCheck({ cwd, dataDir, modifiedAbsPaths, maxAdvisories = 3, minTier = "high", dbg = () => {} }) {
  // Off-switches: env (fast) + direct global-config read (the bundle's
  // loadPiLensGlobalConfig filters unknown sections, so we read the raw file —
  // semanticDry.enabled:false in ~/.pi-lens/config.json turns this off).
  if (process.env.PI_LENS_SEMANTIC_DRY === "0") return null;
  try {
    const home = process.env.PI_LENS_HOME || path.join(os.homedir(), ".pi-lens");
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    if (cfg?.semanticDry?.enabled === false) return null;
  } catch { /* no config file => default on */ }
  const files = [...new Set((modifiedAbsPaths ?? []).map((f) => sourcePath(cwd, f)).filter(Boolean))];
  if (files.length === 0 || files.length > MAX_TURN_FILES) return null;
  const rel = files.map((f) => path.relative(cwd, f).replace(/\\/g, "/"));
  // Cold start: one background full build per cwd; this turn degrades to null.
  // Guard: never walk the home directory (pi-lens doctrine — a session opened
  // at ~ must not trigger a full-tree scan; oracle §6).
  const home = os.homedir();
  const resolvedCwd = path.resolve(cwd);
  const key = JSON.stringify([resolvedCwd, path.resolve(dataDir)]);
  if (_building.has(key)) return null;
  if (!_built.has(key) && resolvedCwd !== path.parse(resolvedCwd).root && resolvedCwd !== home && !resolvedCwd.startsWith(home + path.sep + ".")) {
    _building.add(key);
    queueMicrotask(() => {
      buildIndex({ cwd, dataDir }).then(
        (s) => {
          _built.add(key);
          if (_built.size > 32) _built.delete(_built.values().next().value);
          dbg(`semantic-dry: index built (${s.stats.funcs} fns, ${s.stats.ms}ms)`);
        },
        (e) => dbg(`semantic-dry: build failed: ${e}`)
      ).finally(() => _building.delete(key));
    });
    return null; // Never query a partial cold index or race a second cache load.
  }
  let divs;
  try {
    divs = await findDivergences({ cwd, dataDir, changedFiles: rel, minTier, max: 3 });
  } catch (e) {
    dbg(`semantic-dry: query failed: ${e}`);
    return null;
  }
  // discoverability for sibling sessions: upsert this turn's files into the
  // shared index (merge-safe save; content-addressed so it's idempotent).
  await buildIndex({ cwd, dataDir, changedFiles: rel }).catch((e) => dbg(`semantic-dry: upsert failed: ${e}`));
  if (divs.length === 0) return null;
  // Dedup: best candidate per NEW function; rank; cap user-facing lines.
  const byFn = new Map();
  for (const d of divs) {
    const k = `${d.newFile}::${d.newFn}`;
    const prev = byFn.get(k);
    if (!prev || compareCandidates(d, prev) < 0) byFn.set(k, d);
  }
  const top = [...byFn.values()].sort(compareCandidates).slice(0, maxAdvisories);
  // Budget: turn_end caps the JOINED advisory message at 20 lines/1000 chars,
  // first-pushed-wins — stay ≤3 lines so we never evict call-graph/actionable/
  // quality advisories pushed later (oracle §1c).
  const lines = [`\u267B\uFE0F Semantic DRY: ${byFn.size} new function(s) resemble existing implementations — reuse or diverge deliberately:`];
  for (const d of top.slice(0, 2)) {
    lines.push(`  ${d.newFile}::${d.newFn}() \u2248 ${d.file}::${d.name}() [${d.tier}: ${d.evidence.join(" + ") || "structural"}]`);
  }
  if (byFn.size > 2) lines.push(`  \u2026 +${byFn.size - 2} more — /lens-drift`);
  // Phase 4: per-turn entropy delta (introduced competing implementations).
  // Append-only NDJSON, concurrent-safe, debounced-free (one small line). Full
  // breadth/resolved measurement is O(entries) => /lens-drift, not this hot path.
  appendTurn(dataDir, {
    ts: Date.now(),
    files: files.length,
    introduced: top.map((d) => ({ fn: `${d.newFile}::${d.newFn}`, canonical: `${d.file}::${d.name}`, tier: d.tier })),
  });
  return {
    advisory: lines.join("\n"),
    divergences: top,
    // project-diagnostics shape => lens_diagnostics mode=all + applyDispositions
    // (lens_diagnostic_mark suppression) for free. Message must be STABLE:
    // the disposition anchor hashes normalizeMessage(message) WITHOUT stripping
    // numbers, so volatile j=/evidence values would re-surface suppressed
    // findings on score drift (oracle §2c). Volatile detail stays in the
    // ephemeral advisory above only.
    diagnostics: top.map((d) => ({
      filePath: path.resolve(cwd, d.newFile),
      line: d.newLine ?? 1,
      severity: "warning",
      semantic: "warning",
      tool: "semantic-dry",
      runner: "semantic-radar",
      rule: `semantic-dry:${d.file}::${d.name}`,
      message: `${d.newFn}() resembles ${d.file}::${d.name}() [${d.tier}] — reuse or document deliberate divergence`,
      source: "project-scan",
    })),
  };
}

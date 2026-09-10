// semantic-radar/drift.mjs — /lens-drift surface: entropy trend + ranked
// consolidation candidates. On-demand only (buildClusters is O(entries));
// never called from the turn hot path.
import path from "node:path";
import os from "node:os";
import { loadIndex } from "./radar.mjs";
import { buildClusters } from "./ledger.mjs";
import { readTrend, formatLedgerLine } from "./ledger.mjs";

export function dataDirFor(cwd) {
  return path.join(getProjectDataDirLite(cwd), "semantic-radar");
}

// Mirrors pi-lens getProjectDataDir slug logic (bundle fn is not importable
// from here; keep in sync — drift on format only affects /lens-drift, the
// turn path receives dataDir from the bundle itself).
function getProjectDataDirLite(cwd) {
  const fs = require0("node:fs");
  const legacy = path.join(cwd, ".pi-lens");
  const base = process.env.PILENS_DATA_DIR?.trim() || path.join(process.env.PI_LENS_HOME || path.join(os.homedir(), ".pi-lens"), "projects");
  if (!process.env.PILENS_DATA_DIR?.trim() && fs.existsSync(legacy)) return legacy;
  const slug = path.resolve(cwd).replace(/^[a-z]:/i, "").replace(/\/+/g, "-").replace(/[^A-Za-z0-9-]/g, "").replace(/^-+/, "").replace(/-+$/, "");
  return path.join(base, slug || "default");
}
import { createRequire } from "node:module";
const require0 = createRequire(import.meta.url);

export async function driftReport(cwd) {
  const dataDir = dataDirFor(cwd);
  const index = await loadIndex(dataDir);
  const stats = index.stats();
  const lines = [`\u{1F32A}\uFE0F SEMANTIC DRIFT — ${cwd}`, `index: ${stats.files} files, ${stats.funcs} functions`];
  if (stats.funcs === 0) {
    lines.push("no index yet — it builds in the background on the first edited turn.");
    return lines.join("\n");
  }
  const clusters = buildClusters(index, { maxCandidates: 24 });
  const totalCompetitors = clusters.reduce((s, c) => s + c.breadth - 1, 0);
  lines.push(`similarity clusters in sampled index: ${clusters.length} (${totalCompetitors} candidate overlaps)`);
  const trend = readTrend(dataDir, 8);
  if (trend.length) {
    lines.push("", "recent turns:");
    for (const t of trend.slice(-6)) {
      const date = typeof t.ts === "number" && Number.isFinite(t.ts) ? new Date(t.ts) : null;
      const time = date && Number.isFinite(date.getTime()) ? date.toISOString().slice(5, 16) : "unknown time";
      lines.push(`  ${time}  ${formatLedgerLine(t)}`);
    }
  }
  if (clusters.length === 0) {
    lines.push("", "no consolidation matches found in indexed, sampled evidence; unindexed or unexamined overlaps may remain.");
    return lines.join("\n");
  }
  lines.push("", "top consolidation candidates:");
  for (const c of clusters.slice(0, 5)) {
    const comp = c.members.filter((m) => !(m.file === c.canonical.file && m.name === c.canonical.name));
    lines.push(`  concept: ${c.canonical.file}::${c.canonical.name}()  (breadth ${c.breadth})`);
    for (const m of comp.slice(0, 4)) lines.push(`    competitor: ${m.file}::${m.name}()`);
    if (comp.length > 4) lines.push(`    \u2026 +${comp.length - 4} more`);
    lines.push(`    acceptance: breadth ${c.breadth}\u21921, no behavior/test regressions, lexical duplication does not increase`);
  }
  if (clusters.length > 5) lines.push(`  \u2026 and ${clusters.length - 5} more concepts`);
  return lines.join("\n");
}

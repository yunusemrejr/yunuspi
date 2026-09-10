// semantic-radar/bench.mjs — measured overhead on real repos. Usage: node bench.mjs <dir> [dir2...]
import { buildIndex, findDivergences } from "./radar.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const dirs = process.argv.slice(2);
for (const dir of dirs) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radarbench-"));
  const t0 = process.hrtime.bigint();
  const r1 = await buildIndex({ cwd: dir, dataDir });
  const fullMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  const r2 = await buildIndex({ cwd: dir, dataDir });
  const warmMs = Number(process.hrtime.bigint() - t1) / 1e6;
  // incremental: pretend 10 files changed
  const sample = Object.keys(r1.index.files).slice(0, 10).map((f) => path.join(dir, f));
  const t2 = process.hrtime.bigint();
  await findDivergences({ cwd: dir, dataDir, changedFiles: sample });
  const diffMs = Number(process.hrtime.bigint() - t2) / 1e6;
  const mem = process.memoryUsage().heapUsed;
  const idxKB = fs.statSync(path.join(dataDir, "semantic-radar-index.json")).size / 1024;
  console.log(`${dir}\n  full: ${fullMs.toFixed(0)}ms (${r1.stats.filesScanned} files, ${r1.stats.funcs} fns, ${r1.stats.skipped} skipped) | warm-idempotent: ${warmMs.toFixed(0)}ms (updated=${r2.stats.updated}) | diff-10fns: ${diffMs.toFixed(0)}ms | index: ${idxKB.toFixed(0)}KB | heap: ${(mem / 1e6).toFixed(0)}MB`);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
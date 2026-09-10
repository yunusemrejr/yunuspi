// validate real-repo precision: dump top high/lexical pairs for eyeballing.
import { buildIndex } from "./radar.mjs";
import { scorePair } from "./index.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = process.argv[2];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radarval-"));
const { index, stats } = await buildIndex({ cwd: dir, dataDir });
console.log(`${dir}: ${stats.files} files, ${stats.funcs} fns, ${stats.ms}ms`);
// all-pairs among a bounded sample (real O(n^2) check for precision, not perf)
const fns = [];
for (const [file, rec] of Object.entries(index.files)) for (const fp of rec.funcs) fns.push({ file, fp });
const seen = new Set();
const pairs = [];
for (let i = 0; i < fns.length; i++) {
  for (let j = i + 1; j < fns.length; j++) {
    if (fns[i].file === fns[j].file) continue;
    const s = scorePair(fns[i].fp, fns[j].fp);
    if (s.tier === "high" || s.tier === "lexical") {
      const k = fns[i].fp.id < fns[j].fp.id ? fns[i].fp.id + fns[j].fp.id : fns[j].fp.id + fns[i].fp.id;
      if (seen.has(k)) continue; seen.add(k);
      pairs.push({ a: fns[i], b: fns[j], s });
    }
  }
}
pairs.sort((x, y) => (y.s.tier === "lexical") - (x.s.tier === "lexical") || y.s.jaccard - x.s.jaccard);
for (const p of pairs.slice(0, 14)) {
  console.log(`\n[${p.s.tier} j=${p.s.jaccard.toFixed(2)}] ${p.a.file}::${p.a.fp.name}  ~  ${p.b.file}::${p.b.fp.name}`);
  console.log(`  calls:${JSON.stringify(p.a.fp.calls)} vs ${JSON.stringify(p.b.fp.calls)}`);
  console.log(`  props:${JSON.stringify(p.a.fp.props)} vs ${JSON.stringify(p.b.fp.props)}`);
  console.log(`  ev: ${p.s.evidence.join("; ")}`);
}
console.log(`\ntotal high/lexical cross-file pairs: ${pairs.length}`);
fs.rmSync(dataDir, { recursive: true, force: true });
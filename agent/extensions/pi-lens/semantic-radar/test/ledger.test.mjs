// semantic-radar/test/ledger.test.mjs — clusters, turn deltas, NDJSON roundtrip.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../radar.mjs";
import { parserFor, extractFunctions } from "../extract.mjs";
import { scorePair } from "../index.mjs";
import { buildClusters, turnRecord, formatLedgerLine, appendTurn, readTrend } from "../ledger.mjs";
import { dataDirFor, driftReport } from "../drift.mjs";

const PAG_CANON = `export function paginate(rows, page, size) {
  const start = (page - 1) * size;
  return rows.slice(start, start + size).map((r) => ({ id: r.id, name: r.name }));
}`;
const PAG_COMP1 = `export function paginateUsers(items, page, size) {
  const begin = (page - 1) * size;
  return items.slice(begin, begin + size).map((u) => ({ id: u.id, name: u.name }));
}`;
const PAG_COMP2 = `export function listOrdersPage(rows, page, size) {
  const offset = (page - 1) * size;
  return rows.slice(offset, offset + size).map((order) => ({ id: order.id, name: order.name }));
}`;
// A structural rewrite is candidate evidence, not a high-confidence cluster.
// Literal/operator preservation moved this historical fixture below high tier.
const PAG_PROBABLE = `export function listOrdersPage(rows, page, size) {
  const offset = (page - 1) * size;
  const out = [];
  for (let i = offset; i < offset + size && i < rows.length; i++) out.push({ id: rows[i].id, name: rows[i].name });
  return out;
}`;
const UNRELATED = `export function computeTax(income, region) {
  const rate = region === "eu" ? 0.21 : 0.07;
  if (income < 0) throw new Error("negative income value");
  return income * (1 + rate) * Math.pow(1.02, 3) + Math.sqrt(Math.abs(income));
}`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "led-"));
  fs.mkdirSync(path.join(dir, "src/lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src/foo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/lib/paginate.ts"), PAG_CANON);
  fs.writeFileSync(path.join(dir, "src/foo/users.ts"), PAG_COMP1 + "\n" + UNRELATED);
  fs.writeFileSync(path.join(dir, "src/foo/orders.ts"), PAG_COMP2);
  return dir;
}

test("clusters group competing paginations; canonical prefers lib/ placement", async () => {
  const dir = fixture();
  const { index } = await buildIndex({ cwd: dir, dataDir: path.join(dir, ".state") });
  const clusters = buildClusters(index);
  assert.equal(clusters.length, 1, `expected 1 cluster, got ${clusters.length}`);
  const c = clusters[0];
  assert.equal(c.breadth, 3, "3 competing pagination implementations");
  assert.equal(c.canonical.file, "src/lib/paginate.ts", "shared placement wins canonical");
  assert.ok(!c.members.some((m) => m.name === "computeTax"), "unrelated fn not clustered");
});

test("probable structural resemblance does not establish a concept cluster", async () => {
  const parser = await parserFor(".ts");
  const fp = source => { const tree=parser.parse(source); try {return extractFunctions(tree.rootNode,source)[0];} finally {tree.delete();} };
  const a=fp(PAG_CANON), b=fp(PAG_PROBABLE);
  assert.equal(scorePair(a,b).tier,"probable");
  assert.deepEqual(buildClusters({files:{"a.ts":{funcs:[a]},"b.ts":{funcs:[b]}}}),[]);
});

test("turnRecord: introduced on first sight, resolved on deletion, breadth deltas", async () => {
  const dir = fixture();
  const dataDir = path.join(dir, ".state");
  const { index } = await buildIndex({ cwd: dir, dataDir });
  const c1 = buildClusters(index);
  const rec1 = turnRecord({ turn: 1, clusters: c1, prevSnapshot: undefined });
  assert.equal(rec1.introduced.length, 1);
  assert.equal(rec1.introduced[0].breadth, 3);
  // consolidate: delete one competitor
  fs.rmSync(path.join(dir, "src/foo/orders.ts"));
  const r2 = await buildIndex({ cwd: dir, dataDir });
  const c2 = buildClusters(r2.index);
  const rec2 = turnRecord({ turn: 2, clusters: c2, prevSnapshot: rec1.snapshot });
  assert.equal(rec2.introduced.length, 0);
  const bc = rec2.breadthChanges[0];
  assert.ok(bc && bc.from === 3 && bc.to === 2, `expected 3->2, got ${JSON.stringify(rec2.breadthChanges)}`);
  assert.match(formatLedgerLine(rec2), /3→2/);
  // delete the last competitor → cluster dissolves → resolved
  fs.writeFileSync(path.join(dir, "src/foo/users.ts"), UNRELATED);
  const r3 = await buildIndex({ cwd: dir, dataDir });
  const rec3 = turnRecord({ turn: 3, clusters: buildClusters(r3.index), prevSnapshot: rec2.snapshot });
  assert.equal(rec3.resolved.length, 1, "dissolved cluster counts as resolved");
});

test("ledger NDJSON append + readTrend survives torn lines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledn-"));
  appendTurn(dir, { turn: 1, introduced: [], resolved: [], breadthChanges: [] });
  appendTurn(dir, { turn: 2, introduced: [{ concept: "x::paginate", breadth: 2 }], resolved: [], breadthChanges: [] });
  fs.appendFileSync(path.join(dir, "entropy-ledger.ndjson"), '{"turn":3,"cut');
  const trend = readTrend(dir);
  assert.equal(trend.length, 2, "torn final line skipped");
  assert.equal(trend[1].turn, 2);
});

test("concurrent appends interleave as complete lines (POSIX small-write)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledc-"));
  const recs = Array.from({ length: 40 }, (_, i) => ({ turn: i, introduced: [], resolved: [], breadthChanges: [] }));
  await Promise.all(recs.map((r) => Promise.resolve().then(() => appendTurn(dir, r))));
  const trend = readTrend(dir, 100);
  assert.equal(trend.length, 40);
  for (const t of trend) assert.equal(typeof t.turn, "number");
});

test("dense clone clusters score bounded neighbors rather than all pairs", async () => {
  const dir = fixture();
  try {
    const { index } = await buildIndex({ cwd: dir, dataDir: path.join(dir, ".state") });
    const fp = index.files["src/lib/paginate.ts"].funcs[0];
    let callReads = 0;
    const count = 256, limit = 8;
    const funcs = Array.from({ length: count }, (_, i) => ({
      ...fp, id: `copy-${i}`, name: `copy${i}`,
      get calls() { callReads++; return fp.calls; },
    }));
    const clusters = buildClusters({ files: { "src/lib/clones.ts": { funcs } } }, { maxCandidates: limit });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].breadth, count, "bounded recall still connects the duplicate cluster");
    assert.ok(callReads <= count * (limit * 2 + 1), `pair scoring exceeded bound: ${callReads}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("trend reads only a bounded UTF-8 tail and ignores partial records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "led-tail-"));
  const originalRead = fs.readSync;
  let readBytes = 0;
  try {
    const p = path.join(dir, "entropy-ledger.ndjson");
    fs.writeFileSync(p, "界".repeat(700_000) + "\n");
    for (let turn = 0; turn < 10; turn++) assert.equal(appendTurn(dir, { turn, note: "文字 ✓" }), true);
    fs.appendFileSync(p, '{"turn":999}'); // not durably completed with its newline yet
    fs.readSync = (...args) => { const n = originalRead(...args); readBytes += n; return n; };
    const trend = readTrend(dir, 3);
    assert.deepEqual(trend.map(r => r.turn), [7, 8, 9]);
    assert.ok(trend.every(r => r.note === "文字 ✓"));
    assert.ok(readBytes <= 256 * 1024 + 1, `read ${readBytes} bytes for a three-record tail`);
    assert.deepEqual(readTrend(dir, 0), []);
    assert.deepEqual(readTrend(dir, Infinity), []);
  } finally {
    fs.readSync = originalRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("incremental runtime records remain inspectable and writes are byte bounded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "led-shape-"));
  try {
    assert.equal(appendTurn(dir, { ts: Date.now(), files: 1,
      introduced: [{ fn: "src/users.ts::pageUsers", canonical: "src/lib/page.ts::paginate", tier: "high" }],
    }), true);
    assert.match(formatLedgerLine(readTrend(dir)[0]), /pageUsers→paginate/);
    assert.equal(appendTurn(dir, { note: "界".repeat(2000) }), false,
      "a small character count cannot bypass the atomic-write byte budget");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("drift report qualifies sampled evidence and preserves unknown historical times", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "led-report-"));
  const priorDataDir = process.env.PILENS_DATA_DIR;
  try {
    process.env.PILENS_DATA_DIR = path.join(dir, ".data");
    fs.writeFileSync(path.join(dir, "page.ts"), PAG_CANON);
    const dataDir = dataDirFor(dir);
    await buildIndex({ cwd: dir, dataDir });
    const row = { introduced: [{ fn: "src/users.ts::pageUsers", canonical: "page.ts::paginate", tier: "high" }] };
    for (const ts of [undefined, null, "not a date", 1e30, Date.UTC(2026, 8, 8, 12, 30)]) {
      assert.equal(appendTurn(dataDir, { ...row, ts }), true);
    }
    const report = await driftReport(dir);
    assert.equal((report.match(/unknown time/g) ?? []).length, 4);
    assert.match(report, /09-08T12:30/);
    assert.match(report, /pageUsers→paginate/);
    assert.match(report, /similarity clusters in sampled index: 0/);
    assert.match(report, /no consolidation matches found in indexed, sampled evidence/);
    assert.doesNotMatch(report, /one implementation per concept|✅|Invalid Date/);
  } finally {
    if (priorDataDir === undefined) delete process.env.PILENS_DATA_DIR;
    else process.env.PILENS_DATA_DIR = priorDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

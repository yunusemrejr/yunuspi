// semantic-radar/test/radar.test.mjs — node:test, zero deps.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractFunctions, parserFor } from "../extract.mjs";
import { buildIndex, findDivergences } from "../radar.mjs";
import { scorePair } from "../index.mjs";
import { lshCandidates } from "../hash.mjs";

async function fns(src, ext = ".ts") {
  const p = await parserFor(ext);
  return extractFunctions(p.parse(src).rootNode, src);
}
const get = (fns2, n) => fns2.find((f) => f.name === n);

test("dense LSH buckets stop at the candidate bound, including self exclusion", () => {
  let visited = 0;
  const dense = { *[Symbol.iterator]() {
    for (let i = 0; i < 10_000; i++) { visited++; yield `id-${i}`; }
  } };
  const table = new Map([["dense", dense]]);
  const hits = lshCandidates(table, ["dense", "dense"], 8, "id-0");
  assert.equal(hits.size, 8);
  assert.equal(visited, 9, "must not scan the rest of an oversized bucket");
  assert.ok(!hits.has("id-0"));
  for (const invalid of [0, -1, NaN, Infinity, 1.5]) {
    assert.equal(lshCandidates(table, ["dense"], invalid).size, 0);
  }
  assert.equal(visited, 9, "invalid bounds do not visit entries");
});

test("renamed-variable duplicate retains high similarity without claiming lexical identity", async () => {
  const a = get(await fns(`function paginateUsers(rows, page, size) {
    const start = (page - 1) * size;
    return rows.slice(start, start + size).map((u) => ({ id: u.id, name: u.name }));
  }`), "paginateUsers");
  const b = get(await fns(`function paginateOrders(items, page, size) {
    const begin = (page - 1) * size;
    return items.slice(begin, begin + size).map((o) => ({ id: o.id, name: o.name }));
  }`), "paginateOrders");
  const s = scorePair(a, b);
  assert.equal(s.tier, "high", `expected high, got ${s.tier} j=${s.jaccard}`);
});

test("same behavior, modest structural rewrite → high/probable", async () => {
  const a = get(await fns(`function paginateUsers(rows, page, size) {
    const start = (page - 1) * size;
    return rows.slice(start, start + size).map((u) => ({ id: u.id, name: u.name }));
  }`), "paginateUsers");
  const b = get(await fns(`function listCustomersPage(rows, page, size) {
    const offset = (page - 1) * size;
    const out = [];
    for (let i = offset; i < offset + size && i < rows.length; i++) out.push({ id: rows[i].id, name: rows[i].name });
    return out;
  }`), "listCustomersPage");
  const s = scorePair(a, b);
  assert.ok(s.tier === "high" || s.tier === "probable", `expected high/probable, got ${s.tier} j=${s.jaccard}`);
});

test("unrelated functions with similar loop/control shape NOT flagged", async () => {
  const a = get(await fns(`function sumSquares(xs) {
    let total = 0;
    for (let i = 0; i < xs.length; i++) { total += xs[i] * xs[i]; }
    return total;
  }`), "sumSquares");
  const b = get(await fns(`function logLevels(logger, events) {
    let count = 0;
    for (let i = 0; i < events.length; i++) { logger.info(events[i]); count += 1; }
    return count;
  }`), "logLevels");
  const s = scorePair(a, b);
  assert.ok(s.tier === null || s.tier === "weak", `expected no user-facing tier, got ${s.tier} j=${s.jaccard}`);
});

test("same-API wrappers (email vs sms) → high (shared calls+props+shape)", async () => {
  const a = get(await fns(`function sendEmail(to, subj) { const c = new Client({host:"smtp.x"}); c.connect(to); return c.send(subj); }`), "sendEmail");
  const b = get(await fns(`function sendSms(phone, body) { const c = new Client({host:"sms.x"}); c.connect(phone); return c.send(body); }`), "sendSms");
  const s = scorePair(a, b);
  assert.equal(s.tier, "high", `got ${s.tier} j=${s.jaccard}`);
});

test("boilerplate/tiny functions skipped", async () => {
  const fns2 = await fns(`function getId(u) { return u.id; }`);
  assert.equal(fns2.length, 0);
});

test("unsupported language degrades gracefully", async () => {
  const res = await (await import("../extract.mjs")).analyzeFile("/tmp/nonexistent-file.rb");
  assert.equal(res.supported, false);
});

test("index: build, idempotent re-upsert, move not counted as new entropy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-"));
  const dataDir = path.join(dir, "state");
  const src = `export function paginateUsers(rows, page, size) {
  const start = (page - 1) * size;
  return rows.slice(start, start + size).map((u) => ({ id: u.id, name: u.name }));
}
function sendEmail(to, subj) { const c = new Client({host:"smtp.x"}); c.connect(to); return c.send(subj); }`;
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), src);
  const r1 = await buildIndex({ cwd: dir, dataDir });
  assert.ok(r1.stats.funcs >= 2);
  const r2 = await buildIndex({ cwd: dir, dataDir });
  assert.equal(r2.stats.updated, 0, "content-addressed re-build must be idempotent");
  // move: same content, new path → funcs still found, no NEW divergence vs itself
  fs.rmSync(path.join(dir, "src", "a.ts"));
  fs.writeFileSync(path.join(dir, "src", "moved.ts"), src);
  const r3 = await buildIndex({ cwd: dir, dataDir });
  assert.ok(r3.stats.funcs >= 2);
  const divs = await findDivergences({ cwd: dir, dataDir, changedFiles: ["src/moved.ts"] });
  assert.equal(divs.length, 0, "moved file must not report divergence against itself");
});

test("diff-scoped: new competing implementation discovered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar2-"));
  const dataDir = path.join(dir, "state");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "paginate.ts"), `export function paginate(rows, page, size) {
  const start = (page - 1) * size;
  return rows.slice(start, start + size).map((r) => ({ id: r.id, name: r.name }));
}`);
  await buildIndex({ cwd: dir, dataDir });
  fs.writeFileSync(path.join(dir, "src", "orders.ts"), `export function listOrdersPage(items, page, size) {
  const begin = (page - 1) * size;
  return items.slice(begin, begin + size).map((o) => ({ id: o.id, name: o.name }));
}`);
  const divs = await findDivergences({ cwd: dir, dataDir, changedFiles: ["src/orders.ts"] });
  assert.ok(divs.length >= 1, "expected divergence candidate");
  assert.equal(divs[0].file, "src/paginate.ts");
  assert.ok(["high", "lexical"].includes(divs[0].tier), `tier=${divs[0].tier}`);
});

test("python extraction works", async () => {
  const fns2 = await fns(`def paginate_rows(rows, page, size):
    start = (page - 1) * size
    return [r for r in rows[start:start + size]]
`, ".py");
  assert.equal(fns2.length, 1);
  assert.equal(fns2[0].name, "paginate_rows");
});

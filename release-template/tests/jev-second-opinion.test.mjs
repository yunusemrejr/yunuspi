// Consensus-or-abstain second opinion between the Jev and Kev judge families.
// Transport is mocked; no network, no spend.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((dir) => fs.existsSync(path.join(dir, "extensions/lib/jev-client.ts")));
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jev-second-"));
process.env.OPENROUTER_API_KEY = "sk-or-test";
delete process.env.PI_JEV; delete process.env.PI_OFFLINE; delete process.env.PI_JEV_SECOND_OPINION;

const jev = await import(pathToFileURL(path.join(agent, "extensions/lib/jev-client.ts")));
const fusion = await import(pathToFileURL(path.join(agent, "extensions/lib/jev-fusion.ts")));

const jsonOk = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const httpFail = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "" });
const choiceQuestions = { rank: { type: "choice", instructions: "Which entry fits?", criteria: { a: "a", b: "b", c: "c" } } };
const answer = (a, b, c, choice) => ({ answers: { rank: { type: "choice", choice, probabilities: { a, b, c }, confidence: Math.max(a, b, c) } } });

function harness(respond, now = () => Date.now()) {
  const calls = [];
  jev.resetJevClient();
  jev.configureJevClient({
    now,
    schedule: () => ({}),
    openMs: 50,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const family = body.model === jev.KEV_SLUG ? "kev" : "jev";
      calls.push(family);
      return respond(family, body);
    },
  });
  return { calls };
}
let n = 0;
const fresh = () => `unit evidence ${++n} ${Math.random()}`;

test("a decisive answer costs one call and is returned unchanged", async () => {
  const { calls } = harness(() => jsonOk(answer(0.8, 0.15, 0.05, "a")));
  const result = await jev.askJev("unit", fresh(), choiceQuestions);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["jev"]);
  assert.equal(result.answers.rank.fusion, undefined);
  assert.equal(result.answers.rank.choice, "a");
});

test("an uncertain choice asks the other family once and pools the distributions", async () => {
  const { calls } = harness((family) => jsonOk(family === "jev" ? answer(0.42, 0.38, 0.2, "a") : answer(0.5, 0.3, 0.2, "a")));
  const result = await jev.askJev("unit", fresh(), choiceQuestions);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["jev", "kev"], "the second opinion comes from the other family");
  const pooled = result.answers.rank;
  assert.equal(pooled.choice, "a");
  assert.equal(pooled.fusion.agree, true);
  assert.ok(Math.abs(Object.values(pooled.probabilities).reduce((s, v) => s + v, 0) - 1) < 1e-12);
  assert.ok(pooled.probabilities.a < 0.5 + 1e-9, "a geometric pool never exceeds the more certain judge");
  assert.ok(pooled.probabilities.a > 0.42, "agreement keeps the shared confidence");
  assert.match(result.usage.model, /\+/, "usage names both models");
  assert.equal(result.usage.cached, false);
  assert.ok(jev.readJevChoice(pooled, ["a", "b", "c"]), "the pooled answer still satisfies the choice contract");
});

test("split judges flatten the decision so consumers fall back instead of acting on it", async () => {
  harness((family) => jsonOk(family === "jev" ? answer(0.46, 0.4, 0.14, "a") : answer(0.3, 0.52, 0.18, "b")));
  const result = await jev.askJev("unit", fresh(), choiceQuestions);
  const pooled = result.answers.rank;
  assert.equal(pooled.fusion.agree, false);
  const top = Math.max(...Object.values(pooled.probabilities));
  assert.ok(top < 0.5, `split decision stays unconfident (top ${top})`);
  assert.ok(top < 0.52, "never above the more certain judge");
});

test("a failing second route returns the first judge's answer untouched", async () => {
  harness((family) => family === "jev" ? jsonOk(answer(0.4, 0.35, 0.25, "a")) : httpFail(500));
  const result = await jev.askJev("unit", fresh(), choiceQuestions);
  assert.equal(result.ok, true);
  assert.equal(result.answers.rank.fusion, undefined);
  assert.deepEqual(result.answers.rank.probabilities, { a: 0.4, b: 0.35, c: 0.25 });
  assert.doesNotMatch(result.usage.model, /\+/);
});

test("both judgments are cached: repeating the question spends nothing and pools identically", async () => {
  const { calls } = harness((family) => jsonOk(family === "jev" ? answer(0.41, 0.4, 0.19, "a") : answer(0.45, 0.35, 0.2, "a")));
  const state = fresh();
  const first = await jev.askJev("unit", state, choiceQuestions);
  const before = calls.length;
  const again = await jev.askJev("unit", state, choiceQuestions);
  assert.equal(calls.length, before, "no paid call on repeat");
  assert.equal(again.usage.cached, true);
  assert.deepEqual(again.answers.rank.probabilities, first.answers.rank.probabilities);
});

test("PI_JEV_SECOND_OPINION=off keeps every decision at one call", async () => {
  const previous = process.env.PI_JEV_SECOND_OPINION;
  process.env.PI_JEV_SECOND_OPINION = "off";
  try {
    const { calls } = harness(() => jsonOk(answer(0.4, 0.35, 0.25, "a")));
    const result = await jev.askJev("unit", fresh(), choiceQuestions);
    assert.deepEqual(calls, ["jev"]);
    assert.equal(result.answers.rank.fusion, undefined);
  } finally { if (previous === undefined) delete process.env.PI_JEV_SECOND_OPINION; else process.env.PI_JEV_SECOND_OPINION = previous; }
});

test("existence and score questions never trigger a second call", async () => {
  const { calls } = harness(() => jsonOk({ answers: { ping: { type: "noul", noul: 0.5 } } }));
  const result = await jev.askJev("unit", fresh(), { ping: { type: "noul", instructions: "Is this affirmative?" } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["jev"]);
});

test("extra calls are budgeted: a burst of uncertain choices cannot double all traffic", async () => {
  let clock = 1_000_000;
  const { calls } = harness(() => jsonOk(answer(0.4, 0.35, 0.25, "a")), () => clock);
  for (let i = 0; i < 12; i++) await jev.askJev("unit", fresh(), choiceQuestions);
  const seconds = calls.filter((family, index) => index > 0 && family !== calls[index - 1]).length;
  assert.ok(calls.length < 24, `12 uncertain asks made ${calls.length} calls (${seconds} switches), under double`);
  assert.ok(calls.length <= 12 + 6 + 2, "burst allowance of six extra calls, no refill without elapsed time");
  clock += 5 * 20_000;
  const before = calls.length;
  await jev.askJev("unit", fresh(), choiceQuestions);
  assert.equal(calls.length - before, 2, "elapsed time refills the allowance");
});

test("pooling math: symmetric, floor-protected against hard vetoes, ties go to the first judge", () => {
  const ab = fusion.poolChoice({ a: 0.6, b: 0.3, c: 0.1 }, { a: 0.2, b: 0.5, c: 0.3 });
  const ba = fusion.poolChoice({ a: 0.2, b: 0.5, c: 0.3 }, { a: 0.6, b: 0.3, c: 0.1 });
  for (const id of ["a", "b", "c"]) assert.ok(Math.abs(ab.probabilities[id] - ba.probabilities[id]) < 1e-12, "order of judges does not change the pool");
  const veto = fusion.poolChoice({ a: 1, b: 0, c: 0 }, { a: 0, b: 0.9, c: 0.1 });
  assert.ok(Object.values(veto.probabilities).every((value) => value > 0), "a hard zero cannot erase an option");
  const tie = fusion.poolChoice({ a: 0.5, b: 0.5, c: 0 }, { a: 0.5, b: 0.5, c: 0 });
  assert.equal(tie.choice, "a");
  assert.equal(fusion.poolChoice({ a: 0.5, b: 0.5 }, { a: 0.5, b: 0.3, c: 0.2 }), undefined, "different option sets are not pooled");
  assert.ok(Math.abs(fusion.poolUnit(0.9, 0.9) - 0.9) < 1e-12, 'two equal existence judgments pool to themselves');
  assert.ok(Math.abs(fusion.poolUnit(0.9, 0.1) - 0.5) < 1e-12, 'opposed existence judgments cancel');
  assert.equal(fusion.uncertainChoice({ type: "choice", probabilities: { a: 0.8, b: 0.15, c: 0.05 } }), false);
  assert.equal(fusion.uncertainChoice({ type: "choice", probabilities: { a: 0.45, b: 0.4, c: 0.15 } }), true);
  assert.equal(fusion.uncertainChoice({ type: "choice", probabilities: { a: 0.9, b: 0.2 } }), false, "malformed distributions never trigger spend");
});

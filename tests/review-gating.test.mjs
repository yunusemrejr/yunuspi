import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const release = path.resolve(import.meta.dirname, "..");
const agent = fs.existsSync(path.join(release, "agent"))
  ? path.join(release, "agent")
  : path.resolve(release, "..");
const lib = (name) => import(pathToFileURL(path.join(agent, "extensions/lib/", name)));
const { createRelevantGuidance } = await lib("relevant-guidance.ts");
const { noteQualityReviewCompleted, lastQualityReviewCompletedAt } = await lib("quality-review-owner.ts");

let sessionSerial = 0;
function fixture() {
  const entries = [];
  const session = `review-gating-${process.pid}-${sessionSerial++}`;
  const pi = { getActiveTools: () => ["read"], appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) };
  const ctx = { cwd: "/fixture/workspace", sessionManager: { getBranch: () => entries, getSessionId: () => session } };
  const guidance = createRelevantGuidance(pi);
  guidance.restore(ctx);
  return {
    guidance, entries, ctx, session,
    start(prompt = "Debug the failing code path") { guidance.userInput(); guidance.start({ prompt, systemPrompt: "" }, ctx); },
    fail(times = 4) { for (let i = 0; i < times; i++) guidance.record({ toolName: "read", input: { path: "missing.txt" }, isError: true }); },
    suggested() { return guidance.candidates().some((h) => h.key === "topic:diagnostic-error-review"); },
  };
}

test("completion rendezvous is scoped per session and total on bad input", () => {
  const a = { cwd: "/fixture/a", sessionManager: { getSessionId: () => "gating-a" } };
  const b = { cwd: "/fixture/a", sessionManager: { getSessionId: () => "gating-b" } };
  assert.equal(lastQualityReviewCompletedAt(a), undefined);
  noteQualityReviewCompleted(a, 1234567890);
  assert.equal(lastQualityReviewCompletedAt(a), 1234567890);
  assert.equal(lastQualityReviewCompletedAt(b), undefined);
  assert.equal(lastQualityReviewCompletedAt({}), undefined);
  assert.equal(lastQualityReviewCompletedAt(undefined), undefined);
  assert.doesNotThrow(() => noteQualityReviewCompleted({}));
  assert.doesNotThrow(() => noteQualityReviewCompleted(undefined));
});

test("a stuck pattern earns one error-review suggestion, then the cooldown holds", () => {
  const f = fixture();
  f.start();
  f.fail(4);
  assert.equal(f.suggested(), true);
  f.start();
  f.fail(4);
  assert.equal(f.suggested(), false);
});

test("a recent decisive review suppresses the stuck suggestion", () => {
  const f = fixture();
  noteQualityReviewCompleted(f.ctx);
  f.start();
  f.fail(4);
  assert.equal(f.suggested(), false);
});

test("an old review does not suppress, and the session cap persists across restore", () => {
  const f = fixture();
  noteQualityReviewCompleted(f.ctx, Date.now() - 11 * 60_000);
  f.start();
  f.fail(4);
  assert.equal(f.suggested(), true);

  const g = fixture();
  g.entries.push({
    type: "custom",
    customType: "relevant-guidance",
    data: { version: 1, cwd: "/fixture/workspace", diag: [2, Date.now() - 60 * 60_000] },
  });
  g.guidance.restore(g.ctx);
  g.start();
  g.fail(4);
  assert.equal(g.suggested(), false);
});

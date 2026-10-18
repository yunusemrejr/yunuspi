import test from "node:test";
import assert from "node:assert/strict";
import { desktopBranchMessages, desktopGoal, desktopMessage } from "../core/coding-agent/src/modes/rpc/desktop-projection.js";

const details = { label: "JEV", detail: "d", status: "ok" };

test("harness-activity details survive the desktop projection", () => {
  const preview = desktopMessage({ role: "custom", customType: "harness-activity", content: "x", display: true, details });
  assert.deepEqual(preview.details, details);
});

test("details of any other custom message type are not sent to the desktop", () => {
  const preview = desktopMessage({ role: "custom", customType: "goal-state", content: "x", display: true, details });
  assert.equal(preview.details, undefined);
});

test("oversized harness-activity details are dropped rather than sent", () => {
  const preview = desktopMessage({ role: "custom", customType: "harness-activity", content: "x", display: true, details: { label: "JEV", detail: "x".repeat(1100) } });
  assert.equal(preview.details, undefined);
  assert.equal(preview.content, "x");
});

test("branch entries keep harness-activity details", () => {
  const [message] = desktopBranchMessages([{ type: "custom_message", customType: "harness-activity", content: "x", display: true, details: { label: "L" }, timestamp: 1 }]);
  assert.equal(message.role, "custom");
  assert.deepEqual(message.details, { label: "L" });
});

test("branch entries drop details for other custom types", () => {
  const [message] = desktopBranchMessages([{ type: "custom_message", customType: "other", content: "x", display: true, details: { label: "L" }, timestamp: 1 }]);
  assert.equal(message.details, undefined);
});

test("the latest goal snapshot reaches the desktop before any runtime starts", () => {
  const snapshot = (status, open) => ({ type: "custom", customType: "goal-state-v1", data: { id: "g1", status, criteria: [{ status: "met" }, ...Array.from({ length: open }, () => ({ status: "open" }))] } });
  assert.deepEqual(desktopGoal([snapshot("active", 5), { type: "message", message: { role: "user", content: "x" } }]), { id: "g1", status: "active", settled: 1, total: 6 });
  assert.deepEqual(desktopGoal([snapshot("active", 5), snapshot("blocked", 2)]), { id: "g1", status: "blocked", settled: 1, total: 3 }, "the newest snapshot wins");
  assert.equal(desktopGoal([snapshot("active", 1), snapshot("achieved", 0)]), null, "a finished goal shows no pill");
  assert.equal(desktopGoal([]), null);
});

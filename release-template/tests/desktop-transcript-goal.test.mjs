import test from "node:test";
import assert from "node:assert/strict";
import { applyAgentEvent, createConversation, goalMessage } from "../desktop/renderer/conversation.mjs";

const kickoff = [
  "[goal-tracked g123] Goal: Make the trailer",
  "",
  "Acceptance criteria (refine with goal({action:\"criteria\", items:[…]}) if they miss something; keep it to what the user asked):",
  "- C1: first",
  "- V: verified",
  "",
  "Work autonomously until all are verified with evidence.",
].join("\n");

const boosted = [
  "[goal-tracked g123] Goal: Boosts in force, in the order written — 3D → Video → Noslop — all applied together.",
  "",
  "The user wrote: «make a film /3d»",
  "",
  "Acceptance criteria (refine with goal({action:\"criteria\", items:[…]})):",
  "- C1: a film exists",
  "- V: verified",
  "",
  "Work autonomously until all are verified with evidence.",
].join("\n");

const activity = (label, detail = "d", status = "ok") => ({ role: "custom", customType: "harness-activity", details: { label, detail, status } });

test("a goal kickoff is read back as a goal card with its id and criteria", () => {
  const goal = goalMessage(kickoff);
  assert.equal(goal.type, "kickoff");
  assert.equal(goal.id, "g123");
  assert.equal(goal.words, "Make the trailer");
  assert.deepEqual(goal.boosts, []);
  assert.deepEqual(goal.criteria, [{ id: "C1", text: "first" }, { id: "V", text: "verified" }]);
});

test("boosts and the user's own words are recovered from a boosted kickoff", () => {
  const goal = goalMessage(boosted);
  assert.equal(goal.type, "kickoff");
  assert.deepEqual(goal.boosts, ["3D", "Video", "Noslop"]);
  assert.equal(goal.words, "make a film /3d");
});

test("a continuation is read back with its step, limit and open count", () => {
  const text = "[goal g123, continuation 2/6] The goal is not finished: 3 criteria have no evidence yet.\n- C1: first";
  assert.deepEqual(goalMessage(text), { type: "continuation", id: "g123", step: 2, limit: 6, open: 3 });
});

test("ordinary text is not a goal message", () => {
  assert.equal(goalMessage("make a film"), null);
  assert.equal(goalMessage(undefined), null);
});

test("consecutive harness activity lines merge into one activity row", () => {
  const state = createConversation([
    activity("JEV", "Jev · rank · remote judge answered"),
    activity("Effort", "thinking high → medium"),
    activity("Skills", "anatomy loaded", "skip"),
  ]);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].kind, "activity");
  assert.deepEqual(state.messages[0].items.map((item) => item.label), ["JEV", "Effort", "Skills"]);
  assert.equal(state.messages[0].items[2].status, "skip");
});

test("a non-activity message between activity lines starts a new group", () => {
  const state = createConversation([
    activity("JEV"),
    { role: "user", content: "thanks" },
    activity("Effort"),
  ]);
  assert.deepEqual(state.messages.map((message) => message.kind), ["activity", "user", "activity"]);
  assert.equal(state.messages[0].items.length, 1);
  assert.equal(state.messages[2].items.length, 1);
});

test("a warning notice is appended as a notice row", () => {
  const state = createConversation();
  applyAgentEvent(state, { type: "notice", text: "x", tone: "warning" });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].kind, "notice");
  assert.equal(state.messages[0].tone, "warning");
  assert.equal(state.messages[0].text, "x");
});

test("an identical consecutive notice counts up instead of adding a row", () => {
  const state = createConversation();
  applyAgentEvent(state, { type: "notice", text: "x", tone: "warning" });
  applyAgentEvent(state, { type: "notice", text: "x", tone: "warning" });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].count, 2);
});

test("a thinking level change is recorded on the state", () => {
  const state = applyAgentEvent(createConversation(), { type: "thinking_level_changed", level: "medium" });
  assert.equal(state.thinkingLevel, "medium");
});

test("a second kickoff with the same goal id is marked as resumed", () => {
  const state = createConversation([
    { role: "user", content: kickoff },
    { role: "user", content: kickoff },
  ]);
  const [first, second] = state.messages;
  assert.equal(first.goal.type, "kickoff");
  assert.notEqual(first.goal.resumed, true);
  assert.equal(second.goal.resumed, true);
});

test("the goal's own 'continuing (n)' notice is not repeated beside its continuation row", () => {
  const state = createConversation([]);
  applyAgentEvent(state, { type: "notice", text: "Goal g1: continuing (1) — 3 criteria open.", tone: "info" });
  applyAgentEvent(state, { type: "message_start", message: { role: "user", content: "[goal g1, continuation 1/6] The goal is not finished: 3 criteria have no evidence yet." } });
  assert.deepEqual(state.messages.map((message) => message.goal?.type ?? message.kind), ["continuation"]);
  applyAgentEvent(state, { type: "notice", text: "Goal g1: could not continue (offline). 3 criteria are still open; /goal resume restarts it.", tone: "warning" });
  assert.equal(state.messages.at(-1).kind, "notice", "a failed continuation is still said");
});

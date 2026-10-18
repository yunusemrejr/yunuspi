import test from "node:test";
import assert from "node:assert/strict";
import { correctSlashCommands, commandTokens } from "../core/coding-agent/src/core/command-correction.js";
import { goalFromStatus, readCommand } from "../desktop/renderer/command-lens.mjs";

// Mirrors desktop/main.mjs: the session's commands, plus the desktop's own local commands in the names list.
const commands = [
  { name: "3d", chainable: true, description: "Adds the 3D boost" },
  { name: "video", chainable: true },
  { name: "noslop", chainable: true },
  { name: "nobug", chainable: true },
  { name: "goal", chainable: true },
  { name: "budget", chainable: false, description: "Show the session budget" },
];
const chainable = commands.filter((command) => command.chainable).map((command) => command.name);
const names = [...commands.map((command) => command.name), "model"];
const check = (text) => ({ text, fixes: [], ...correctSlashCommands(text, { commands: names, chainable }), tokens: commandTokens(text, { commands: names, chainable }) });
const read = (text, goal = null) => readCommand(text, { commands, check: check(text), goal });
const live = { status: "active", settled: 1, total: 6 };

test("the footer status line parses into a goal, and anything else is null", () => {
  assert.deepEqual(goalFromStatus("goal ◎ 2/6"), { status: "active", settled: 2, total: 6 });
  assert.deepEqual(goalFromStatus("goal ⏸ 0/4"), { status: "paused", settled: 0, total: 4 });
  assert.deepEqual(goalFromStatus("goal ⚠ 3/3"), { status: "blocked", settled: 3, total: 3 });
  assert.equal(goalFromStatus("goal ? 2/6"), null);
  assert.equal(goalFromStatus("nonsense"), null);
  assert.equal(goalFromStatus(undefined), null);
});

test("plain text is not read as a command", () => {
  assert.equal(readCommand("make a film", { commands, check: check("make a film") }), null);
  assert.equal(readCommand("", { commands, check: check("") }), null);
});

test("chained boosts read as one goal, marked as boosts", () => {
  const reading = read("/3d /video make a film");
  assert.equal(reading.tone, "info");
  assert.ok(reading.text.includes("→ one goal for your task"), reading.text);
  assert.deepEqual(reading.marks.map((mark) => mark.kind), ["boost", "boost"]);
});

test("a mistyped boost is offered as a fix and an unrecognized one is named", () => {
  const reading = read("/3d /video /autonomy /noslop /nobugs film");
  assert.equal(reading.tone, "warn");
  assert.ok(reading.text.startsWith("Did you mean /nobug (not /nobugs)"), reading.text);
  assert.ok(reading.text.includes("/autonomy is not a command"), reading.text);
  assert.ok(reading.marks.some((mark) => mark.kind === "near"), "the mistyped token is marked near");
});

test("resume with no goal warns that nothing starts", () => {
  const reading = read("/goal resume", null);
  assert.equal(reading.tone, "warn");
  assert.ok(reading.text.includes("no goal"), reading.text);
});

test("resume with a live goal says what it resumes", () => {
  const reading = read("/goal resume", live);
  assert.equal(reading.tone, "info");
  assert.ok(reading.text.startsWith("Resumes the goal"), reading.text);
});

test("continue with words passes them along as a note", () => {
  const reading = read("/goal continue fix the logo", live);
  assert.equal(reading.tone, "info");
  assert.ok(reading.text.includes("“fix the logo” goes along as your note"), reading.text);
});

test("a new goal typed over a live one warns that it replaces it", () => {
  const reading = read("/goal build X", live);
  assert.equal(reading.tone, "warn");
  assert.ok(reading.text.includes("replaces the current one"), reading.text);
});

test("a bare boost with a live goal adds to that goal", () => {
  const reading = read("/3d", live);
  assert.ok(reading.text.startsWith("Adds /3d to the current goal"), reading.text);
});

test("a non-chainable command shows its description", () => {
  assert.ok(read("/budget").text.startsWith("Runs /budget: Show the session budget"), read("/budget").text);
});

test("a desktop-local command is read from the local table even though the core does not list it", () => {
  const reading = read("/model");
  assert.equal(reading.text, "Opens the model picker");
  assert.equal(reading.tone, "info");
});

test("an unknown command is an error that points at the browser", () => {
  const reading = read("/zzz hello");
  assert.equal(reading.tone, "error");
  assert.ok(reading.text.includes("is not a command here"), reading.text);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((dir) => fs.existsSync(path.join(dir, "extensions/pi-subagents/src/shared/thinking-ceiling.ts")));
assert.ok(agent, "thinking-ceiling source must exist");
const { sessionThinkingCeiling } = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/shared/thinking-ceiling.ts")).href);
const { sessionChildModel } = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/session-model.ts")).href);

const effort = (ceiling, version = 1) => ({ type: "custom", customType: "jev-effort-v1", data: { version, ceiling, manual: false } });

test("helpers start at the configured ceiling the effort controller persisted, not its step-down", () => {
  // The live level is Jev's step-down for an easy parent turn; children start from the person's ceiling.
  assert.equal(sessionThinkingCeiling([effort("high"), { type: "message" }, effort("max")], "minimal"), "max");
  assert.equal(sessionThinkingCeiling([], "medium"), "medium", "without a persisted ceiling the live level is used");
  assert.equal(sessionThinkingCeiling(undefined, "off"), "off");
  assert.equal(sessionThinkingCeiling([effort("loud"), effort("high", 2)], "low"), "low", "invalid or foreign entries are ignored");
  assert.equal(sessionThinkingCeiling([], undefined), undefined);
});

test("every child runs on the session's own provider/id", () => {
  assert.equal(sessionChildModel({ provider: "deepseek", id: "deepseek-flash" }), "deepseek/deepseek-flash");
  assert.throws(() => sessionChildModel(undefined), /session's model/);
});

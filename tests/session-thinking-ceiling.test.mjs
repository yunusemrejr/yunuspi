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

test("a forked child runs on the session's own provider/id", () => {
  assert.equal(sessionChildModel({ provider: "deepseek", id: "deepseek-flash" }), "deepseek/deepseek-flash");
  assert.throws(() => sessionChildModel(undefined), /session's model/);
});

test("a child that does not fork runs on its role's model, capped by the role's thinking ceiling", async () => {
  const { resolveChildRoute } = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/session-model.ts")).href);
  const session = { provider: "deepseek", id: "deepseek-flash" };
  const team = { helper: "inherit", legwork: "other/small", advisor: "off", roles: {}, maxThinking: { helper: "xhigh", legwork: "low" }, sideCalls: "legwork" };
  const available = [session, { provider: "other", id: "small" }].map((m) => ({ ...m, fullId: `${m.provider}/${m.id}` }));
  const route = (name, extra = {}) => resolveChildRoute({ agent: { name }, forked: false, parentModel: session, availableModels: available, cwd: repo, team, ...extra });
  assert.deepEqual(route("scout"), { model: "other/small", shownRole: "legwork", maxThinking: "low" });
  assert.deepEqual(route("worker"), { model: "deepseek/deepseek-flash", maxThinking: "xhigh" }, "an inheriting role runs on the session's model and shows no role");
  assert.deepEqual(route("oracle"), { model: "deepseek/deepseek-flash" });
  assert.equal(route("scout", { callRole: "main" }).model, "deepseek/deepseek-flash", "the call's role wins over the agent's");
  assert.deepEqual(route("scout", { forked: true }), { model: "deepseek/deepseek-flash" }, "a forked child stays on the session's model with no role ceiling");
  assert.deepEqual(route("scout", { forked: true, team: { ...team, legwork: "other/gone" }, agent: { name: "scout", extraFields: { role: "boss" } } }), { model: "deepseek/deepseek-flash" }, "a fork looks at neither the role's model nor the agent's role line");
  assert.throws(() => route("scout", { team: { ...team, legwork: "other/gone" } }), /team\.legwork is set to 'other\/gone', which is not among the available models/);
});

test("a call's role must be main, helper or legwork on the call and on any task or step", async () => {
  const { validateCallRoles } = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/session-model.ts")).href);
  assert.equal(validateCallRoles({ role: "legwork", tasks: [{ role: "helper" }, {}] }), undefined);
  for (const bad of [{ role: "boss" }, { tasks: [{ role: 3 }] }, { chain: [{ parallel: [{ role: "x" }] }] }, { chain: [{ parallel: { role: "x" } }] }]) {
    assert.equal(validateCallRoles(bad), "role must be main, helper, legwork.", JSON.stringify(bad));
  }
});

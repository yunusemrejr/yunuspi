import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { assertSameBytes } from "./bytes.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-llm-prefs-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_PROVIDER_STATE_FILE = path.join(root, "health.json");
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, "exclusions.json");
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(root, "economy.json");
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, "{}");
const prefsFile = path.join(root, "llm_preferences.json");
process.env.PI_LLM_PREFERENCES_FILE = prefsFile;

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((p) =>
	fs.existsSync(path.join(p, "extensions/pi-subagents/src/runs/shared/llm-preferences.ts")),
);
if (!agent) throw new Error("LLM preference source is missing");
const shared = pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/")).href;

const prefs = await import(shared + "llm-preferences.ts");
const modelInfo = await import(shared + "../../shared/model-info.ts");
const { clearLlmPreferencesCache } = prefs;

const model = (id, provider = "openrouter", extra = {}) => ({
	provider,
	id,
	fullId: `${provider}/${id}`,
	api: "openai-completions",
	baseUrl: "https://openrouter.ai/api/v1",
	contextWindow: 65536,
	maxTokens: 8192,
	input: ["text"],
	reasoning: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	...extra,
});
const registry = [
	model("qwen/qwen3-235b-a22b:free"),
	model("google/gemini-2.5-flash"),
	model("anthropic/claude-sonnet-4"),
	model("deepseek-chat", "deepseek", { baseUrl: "https://api.deepseek.com/v1" }),
];

test("thinking values map to harness levels or dynamic logic", () => {
	assert.deepEqual(prefs.normalizeThinking(undefined), { dynamic: true });
	assert.deepEqual(prefs.normalizeThinking("auto"), { dynamic: true });
	assert.deepEqual(prefs.normalizeThinking("none"), { thinking: "off", dynamic: false });
	assert.deepEqual(prefs.normalizeThinking("HIGH"), { thinking: "high", dynamic: false });
	assert.equal(prefs.normalizeThinking("nonsense").dynamic, true);
});

test("thinking choices agree with core when a model has no extended-level map", () => {
	const plain = registry[0];
	assert.deepEqual(modelInfo.getSupportedThinkingLevels(plain), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(modelInfo.getSupportedThinkingLevels({ ...plain, reasoning: false }), ["off"]);
	assert.deepEqual(modelInfo.getSupportedThinkingLevels(undefined), ["off"]);
	const extended = { ...plain, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } };
	assert.deepEqual(modelInfo.getSupportedThinkingLevels(extended), ["minimal", "low", "medium", "high", "xhigh", "max"]);
	const noMax = { ...plain, thinkingLevelMap: { off: null, xhigh: "xhigh", max: null } };
	assert.equal(modelInfo.clampSupportedThinkingLevel(noMax, "max"), "xhigh");
	assert.equal(modelInfo.clampSupportedThinkingLevel(noMax, "off"), "minimal");
	assert.equal(modelInfo.clampSupportedThinkingLevel({ ...plain, reasoning: false }, "high"), "off");
});

test("provider options translate to existing OpenRouter routing vocabulary", () => {
	assert.deepEqual(prefs.providerOptionsToRouting(undefined, "openrouter"), {});
	assert.deepEqual(prefs.providerOptionsToRouting({ routing: "auto" }, "openrouter"), {});
	assert.deepEqual(prefs.providerOptionsToRouting({ routing: "pinned", order: ["deepinfra"] }, "openrouter"), {
		routing: { only: ["deepinfra"], order: ["deepinfra"], allow_fallbacks: false },
	});
	assert.deepEqual(
		prefs.providerOptionsToRouting({ routing: "custom", order: ["deepinfra", "friendli"], allow_fallbacks: true }, "openrouter"),
		{ routing: { order: ["deepinfra", "friendli"], allow_fallbacks: true } },
	);
	assert.ok(prefs.providerOptionsToRouting({ routing: "pinned", order: [] }, "openrouter").note);
	assert.ok(prefs.providerOptionsToRouting({ routing: "pinned", order: ["x"] }, "deepseek").note);
});

test("role names normalize and task inference stays conservative", () => {
	assert.equal(prefs.normalizePreferenceRole("quality-review"), "quality_review");
	assert.equal(prefs.normalizePreferenceRole("mainFallback"), "main_session_fallback");
	assert.equal(prefs.normalizePreferenceRole("BugReviews"), "error_review");
	assert.equal(prefs.inferPreferenceRole("please run a project review of the auth layer"), "project_review");
	assert.equal(prefs.inferPreferenceRole("do an error review of these failures"), "error_review");
	assert.equal(prefs.inferPreferenceRole("quality review before merge"), "quality_review");
	assert.equal(prefs.inferPreferenceRole("convene a council on the API shape"), "council");
	assert.equal(prefs.inferPreferenceRole("implement the widget and fix the bug"), "subagents");
});

test("strict editor saves are atomic, conflict-checked, and preserve unknown JSON fields", async () => {
  const nested = path.join(root, "fresh-settings", "llm_preferences.json");
  const initial = { version: 1, models: { first: { provider: "OpenRouter", model: "org/model", extra: { retained: true } } }, preferences: { subagents: ["first"] }, futureField: { retained: true } };
  const saved = await prefs.saveLlmPreferencesDocument(nested, "missing", initial);
  assert.equal(saved.ok, true, saved.reason);
  assert.equal(fs.statSync(nested).mode & 0o777, 0o600);
  const beforeBadSave = fs.readFileSync(nested);
  const invalid = structuredClone(initial);
  invalid.preferences.subagents = ["unknown-alias"];
  const rejected = await prefs.saveLlmPreferencesDocument(nested, saved.revision, invalid);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /unknown model alias/);
  assertSameBytes(fs.readFileSync(nested), beforeBadSave, "strict validation rejects the write without replacing valid JSON");

  const changed = structuredClone(initial);
  changed.preferences.subagents.push({ provider: "openrouter", model: "org/second", provider_options: { routing: "pinned", order: ["together"] } });
  changed.newUnknownField = [1, 2, 3];
  const updated = await prefs.saveLlmPreferencesDocument(nested, saved.revision, changed);
  assert.equal(updated.ok, true, updated.reason);
  assert.deepEqual(JSON.parse(fs.readFileSync(nested, "utf8")).futureField, { retained: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(nested, "utf8")).newUnknownField, [1, 2, 3]);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${nested}.bak`, "utf8")), initial);

  const currentRevision = updated.revision;
  const manual = structuredClone(changed); manual.manualEdit = "keep me";
  fs.writeFileSync(nested, JSON.stringify(manual));
  const manualBytes = fs.readFileSync(nested);
  const conflict = await prefs.saveLlmPreferencesDocument(nested, currentRevision, changed);
  assert.equal(conflict.conflict, true);
  assertSameBytes(fs.readFileSync(nested), manualBytes, "a stale GUI revision leaves manual edits untouched");
  const restored = await prefs.saveLlmPreferencesDocument(nested, prefs.readLlmPreferencesDocument(nested).revision, undefined, { restoreBackup: true });
  assert.equal(restored.ok, true, restored.reason);
  assert.deepEqual(JSON.parse(fs.readFileSync(nested, "utf8")), initial);
});

test("stale crash locks recover and independent writers serialize on the same revision", async () => {
  const nested = path.join(root, "writer-settings", "llm_preferences.json");
  const initial = { version: 1, models: {}, preferences: { subagents: [] } };
  const first = await prefs.saveLlmPreferencesDocument(nested, "missing", initial);
  assert.equal(first.ok, true, first.reason);

  const lockPath = `${nested}.lock`;
  fs.writeFileSync(lockPath, "");
  const stale = new Date(Date.now() - 5_000);
  fs.utimesSync(lockPath, stale, stale);
  const recoveredDoc = { ...initial, recovered: true };
  const recovered = await prefs.saveLlmPreferencesDocument(nested, first.revision, recoveredDoc);
  assert.equal(recovered.ok, true, recovered.reason);
  assert.equal(fs.existsSync(lockPath), false);

  const revision = recovered.revision;
  const moduleUrl = pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/llm-preferences.ts")).href;
  const runWriter = document => new Promise((resolve, reject) => {
    const source = `import { saveLlmPreferencesDocument } from ${JSON.stringify(moduleUrl)}; const result = await saveLlmPreferencesDocument(${JSON.stringify(nested)}, ${JSON.stringify(revision)}, ${JSON.stringify(document)}); process.stdout.write(JSON.stringify(result));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => stdout += chunk);
    child.stderr.setEncoding("utf8").on("data", chunk => stderr += chunk);
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `writer exited ${code}`)));
  });
  const outcomes = await Promise.all([
    runWriter({ ...recoveredDoc, writer: "a" }),
    runWriter({ ...recoveredDoc, writer: "b" }),
  ]);
  assert.equal(outcomes.filter(result => result.ok).length, 1, "the lock admits one writer for an optimistic revision");
  assert.equal(outcomes.filter(result => result.conflict).length, 1, "the later writer sees the updated revision");
  assert.equal(fs.existsSync(lockPath), false, "all acquired locks are released");
});

test("disk failures preserve canonical bytes, return diagnostics, and release the writer lock", async () => {
  const configPath = path.join(root, "disk-failure", "llm_preferences.json");
  const initial = { models: {}, preferences: {}, marker: "original" };
  const first = await prefs.saveLlmPreferencesDocument(configPath, "missing", initial);
  const original = fs.readFileSync(configPath);
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => {
      if (to === `${configPath}.bak`) throw new Error("simulated backup disk failure");
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    const backupFailure = await prefs.saveLlmPreferencesDocument(configPath, first.revision, { ...initial, marker: "new" });
    assert.equal(backupFailure.ok, false);
    assert.match(backupFailure.reason, /backup disk failure/);
    assert.equal(fs.readFileSync(configPath).compare(original), 0);
    assert.equal(fs.existsSync(`${configPath}.lock`), false);
    fs.renameSync = (from, to) => {
      if (to === configPath) throw new Error("simulated canonical rename failure");
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    const renameFailure = await prefs.saveLlmPreferencesDocument(configPath, first.revision, { ...initial, marker: "new" });
    assert.equal(renameFailure.ok, false);
    assert.match(renameFailure.reason, /canonical rename failure/);
    assert.equal(fs.readFileSync(configPath).compare(original), 0);
    assert.equal(fs.existsSync(`${configPath}.lock`), false);
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }

  const originalFsync = fs.fsyncSync;
  let replacementInstalled = false;
  try {
    fs.renameSync = (from, to) => {
      const result = originalRename(from, to);
      if (to === configPath) replacementInstalled = true;
      return result;
    };
    fs.fsyncSync = fd => {
      if (replacementInstalled && fs.fstatSync(fd).isDirectory()) {
        replacementInstalled = false;
        fs.fsyncSync = originalFsync;
        throw new Error("simulated post-rename durability failure");
      }
      return originalFsync(fd);
    };
    syncBuiltinESMExports();
    const failed = await prefs.saveLlmPreferencesDocument(configPath, first.revision, { ...initial, marker: "new" });
    assert.equal(failed.ok, false);
    assert.match(failed.reason, /durability failure/);
    assert.equal(fs.readFileSync(configPath).compare(original), 0, "read-back-owned rollback restores exact previous bytes");
    assert.equal(fs.existsSync(`${configPath}.lock`), false);
  } finally { fs.renameSync = originalRename; fs.fsyncSync = originalFsync; syncBuiltinESMExports(); }
});

test("a document that still names both the former swarm and fusion roles keeps both route lists as one fan-out role", () => {
	fs.writeFileSync(prefsFile, JSON.stringify({ version: 1, preferences: { swarm: { models: ["or_route"] }, fusion: { models: ["other_provider"] } } }));
	clearLlmPreferencesCache();
	const loaded = prefs.loadLlmPreferences(prefsFile);
	assert.deepEqual(loaded.config.preferences.fanout.models, ["or_route", "other_provider"]);
	assert.ok(!(loaded.warnings ?? []).some(text => /duplicate preference role/.test(text)), JSON.stringify(loaded.warnings));
	assert.equal(prefs.normalizePreferenceRole("fusion"), "fanout");
	assert.equal(prefs.normalizePreferenceRole("swarms"), "fanout");
	fs.rmSync(prefsFile, { force: true });
	clearLlmPreferencesCache();
});

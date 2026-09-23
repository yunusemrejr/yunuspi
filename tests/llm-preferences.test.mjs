import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

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
const fallback = await import(shared + "model-fallback.ts");
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

function writePrefs(doc) {
	fs.writeFileSync(prefsFile, JSON.stringify(doc));
	clearLlmPreferencesCache();
}

test("missing preference file resolves to no chain (autonomous applies)", () => {
	try { fs.unlinkSync(prefsFile); } catch {}
	clearLlmPreferencesCache();
	const loaded = prefs.loadLlmPreferences();
	assert.equal(loaded.ok, false);
	assert.equal(loaded.missing, true);
	assert.deepEqual(fallback.resolveLlmPreferenceChain("subagents", registry), []);
	assert.equal(fallback.selectLlmPreferredModel("subagents", registry), undefined);
});

test("malformed preference file never throws and yields no chain", () => {
	fs.writeFileSync(prefsFile, "{not json");
	clearLlmPreferencesCache();
	assert.equal(prefs.loadLlmPreferences().ok, false);
	assert.deepEqual(fallback.resolveLlmPreferenceChain("subagents", registry), []);
	fs.writeFileSync(prefsFile, JSON.stringify({ version: 999 }));
	clearLlmPreferencesCache();
	assert.equal(prefs.loadLlmPreferences().ok, false);
});

test("ordered aliases resolve in declared order with partial failure", () => {
	writePrefs({
		version: 1,
		models: {
			first: { provider: "openrouter", model: "google/gemini-2.5-flash", thinking: "low" },
			second: { provider: "deepseek", model: "deepseek-chat" },
		},
		preferences: { subagents: { models: ["missing-alias", "first", "second"] } },
	});
	const chain = fallback.resolveLlmPreferenceChain("subagents", registry);
	assert.deepEqual(chain.map((c) => c.route), ["openrouter/google/gemini-2.5-flash", "deepseek/deepseek-chat"]);
	assert.equal(chain[0].thinking, "low");
	assert.equal(chain[0].dynamicThinking, false);
	assert.equal(chain[1].dynamicThinking, true);
	const first = fallback.selectLlmPreferredModel("subagents", registry);
	assert.equal(first.route, "openrouter/google/gemini-2.5-flash");
});

test("unknown registry models are skipped, not fatal", () => {
	writePrefs({
		version: 1,
		models: { ghost: { provider: "openrouter", model: "no/such-model-anywhere" } },
		preferences: { swarm: { models: ["ghost"] } },
	});
	assert.deepEqual(fallback.resolveLlmPreferenceChain("swarm", registry), []);
});

test("preference inspection explains missing routes without claiming runtime activity or consuming warnings", () => {
	const warnings = [], activity = [], skipped = [];
	const warn = console.warn, key = Symbol.for('yunus-pi.health.v1'), sink = globalThis[key];
	console.warn = message => warnings.push(String(message));
	globalThis[key] = (kind, data) => activity.push({ kind, data });
	fallback.clearEconomyWarnings();
	try {
		writePrefs({ preferences: { subagents: { models: [
			{ provider: 'fixture-unconfigured', model: 'missing' },
			{ provider: 'deepseek', model: 'deepseek-chat' },
		] } } });
		const options = { diagnostics: 'inspect', onSkip: event => skipped.push(event) };
		const routes = fallback.resolveLlmPreferenceChain('subagents', registry, options);
		assert.equal(routes[0].route, 'deepseek/deepseek-chat');
		assert.match(skipped[0].reason, /fixture-unconfigured.*no models/);
		assert.equal(warnings.length, 0);
		assert.equal(activity.length, 0);
		skipped.length = 0;
		assert.deepEqual(fallback.resolveLlmPreferenceChain('subagents', [], options), []);
		assert.equal(skipped.length, 2, 'an empty registry still explains every inspected priority');
		assert.equal(warnings.length, 0);
		assert.equal(activity.length, 0);
		fallback.resolveLlmPreferenceChain('subagents', registry);
		assert.equal(warnings.length, 1, 'inspection cannot consume a subsequent real selection warning');
		assert.equal(activity.length, 1);
		assert.equal(activity[0].data.route, 'fixture-unconfigured/missing');
	} finally {
		console.warn = warn;
		if (sink === undefined) delete globalThis[key]; else globalThis[key] = sink;
	}
});

test("thinking values map to harness levels or dynamic logic", () => {
	assert.deepEqual(prefs.normalizeThinking(undefined), { dynamic: true });
	assert.deepEqual(prefs.normalizeThinking("auto"), { dynamic: true });
	assert.deepEqual(prefs.normalizeThinking("none"), { thinking: "off", dynamic: false });
	assert.deepEqual(prefs.normalizeThinking("HIGH"), { thinking: "high", dynamic: false });
	assert.equal(prefs.normalizeThinking("nonsense").dynamic, true);
	writePrefs({
		version: 1,
		models: { weird: { provider: "openrouter", model: "google/gemini-2.5-flash", thinking: "nonsense" } },
		preferences: { fusion: { models: ["weird"] } },
	});
	const chain = fallback.resolveLlmPreferenceChain("fusion", registry);
	assert.equal(chain.length, 1);
	assert.equal(chain[0].dynamicThinking, true);
});

test("thinking choices agree with core when a model has no extended-level map", () => {
	const plain = registry[0];
	assert.deepEqual(modelInfo.getSupportedThinkingLevels(plain), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(modelInfo.getSupportedThinkingLevels({ ...plain, reasoning: false }), ["off"]);
	assert.deepEqual(modelInfo.getSupportedThinkingLevels(undefined), ["off"]);
	const extended = { ...plain, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } };
	assert.deepEqual(modelInfo.getSupportedThinkingLevels(extended), ["minimal", "low", "medium", "high", "xhigh", "max"]);
	writePrefs({
		version: 1,
		models: { extended: { provider: plain.provider, model: plain.id, thinking: "xhigh" } },
		preferences: { subagents: { models: ["extended"] } },
	});
	const unsupported = fallback.resolveLlmPreferenceChain("subagents", [plain]);
	assert.equal(unsupported[0].thinking, "high", "explicit strength clamps like core instead of silently becoming dynamic");
	assert.equal(unsupported[0].dynamicThinking, false);
	assert.ok(unsupported[0].explanation.includes("thinking high (requested xhigh is unsupported)"));
	const supported = fallback.resolveLlmPreferenceChain("subagents", [extended]);
	assert.equal(supported[0].thinking, "xhigh");
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
	writePrefs({
		version: 1,
		models: { pinned: { provider: "openrouter", model: "google/gemini-2.5-flash", provider_options: { routing: "pinned", order: ["deepinfra"] } } },
		preferences: { council: { models: ["pinned"] } },
	});
	const chain = fallback.resolveLlmPreferenceChain("council", registry);
	assert.deepEqual(chain[0].providerRouting, { only: ["deepinfra"], order: ["deepinfra"], allow_fallbacks: false });
});

test("distribution prefers distinct identities then reuses entries", () => {
	writePrefs({
		version: 1,
		models: {
			a: { provider: "openrouter", model: "google/gemini-2.5-flash" },
			b: { provider: "deepseek", model: "deepseek-chat" },
		},
		preferences: { subagents: { models: ["a", "b"] } },
	});
	const two = fallback.distributeLlmPreferredModels("subagents", 2, registry);
	assert.deepEqual(two.map((c) => c.route), ["openrouter/google/gemini-2.5-flash", "deepseek/deepseek-chat"]);
	const five = fallback.distributeLlmPreferredModels("subagents", 5, registry);
	assert.equal(five.length, 5);
	assert.equal(five[2].route, "openrouter/google/gemini-2.5-flash");
	assert.equal(fallback.withLlmThinkingSuffix({ route: "p/m", dynamicThinking: true, explanation: [] }), "p/m");
	assert.equal(fallback.withLlmThinkingSuffix({ route: "p/m", thinking: "low", dynamicThinking: false, explanation: [] }), "p/m:low");
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

test("fuzzy resolution tolerates owner renames and bare ids without switching providers", () => {
	const live = [
		model("zai-org/GLM-5.3-Flash", "friendli", { baseUrl: "https://api.friendli.ai/serverless/v1" }),
		model("zai-org/GLM-5.3-Flash", "runinfra", { baseUrl: "https://api.runinfra.ai/v1" }),
		model("qwen/qwen3.8-flash", "orcarouter", { baseUrl: "https://api.orcarouter.ai/v1" }),
	];
	// Owner rename with preferred provider: z-ai/ spelled, zai-org/ live.
	assert.equal(fallback.fuzzyResolveModel("z-ai/glm-5.3-flash", live, "friendli"), "friendli/zai-org/GLM-5.3-Flash");
	// Bare id against a qualified provider query.
	assert.equal(fallback.fuzzyResolveModel("runinfra/glm-5-3-flash", live), "runinfra/zai-org/GLM-5.3-Flash");
	// Qualified queries never switch providers.
	assert.equal(fallback.fuzzyResolveModel("orcarouter/glm-5-3-flash", live), undefined);
	// Unqualified cross-owner matches stay ambiguous across providers.
	assert.equal(fallback.fuzzyResolveModel("z-ai/glm-5.3-flash", live), undefined);
	// Exact behavior unchanged.
	assert.equal(fallback.fuzzyResolveModel("zai-org/GLM-5.3-Flash", live, "friendli"), "friendli/zai-org/GLM-5.3-Flash");
	assert.equal(fallback.fuzzyResolveModel("no/such-model-anywhere", live, "friendli"), undefined);
});

test("unresolved chain entries diagnose the true gate", () => {
	const live = [model("zai-org/GLM-5.3-Flash", "friendli", { baseUrl: "https://api.friendli.ai/serverless/v1" })];
	const warnings = [];
	const origWarn = console.warn;
	console.warn = (msg) => { warnings.push(String(msg)); };
	try {
		writePrefs({
			version: 1,
			models: {
				paused: { provider: "runinfra", model: "glm-5-3-flash" },
				typo: { provider: "friendli", model: "zai-org/GLM-nope-9" },
			},
			preferences: { subagents: { models: ["paused", "typo"] } },
		});
		assert.deepEqual(fallback.resolveLlmPreferenceChain("subagents", live), []);
		const paused = warnings.find((w) => w.includes("runinfra/glm-5-3-flash"));
		assert.ok(paused, "paused entry warns");
		assert.match(paused, /has no models in this session's registry/);
		const typo = warnings.find((w) => w.includes("GLM-nope-9"));
		assert.ok(typo, "unknown-id entry warns");
		assert.match(typo, /among 1 live "friendli" model/);
	} finally {
		console.warn = origWarn;
	}
});

test("explicit provider-qualified models resolve across providers", () => {
	const live = [
		model("z-ai/glm-5.3-flash", "openrouter", { cost: undefined }),
		model("zai-org/GLM-5.3-Flash", "together", { baseUrl: "https://api.together.xyz/v1", cost: undefined }),
	];
	const parent = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
	// A qualified explicit request names its provider; the caller's preferred
	// provider must not veto it.
	assert.equal(
		fallback.resolveEffectiveSubagentModel("together/zai-org/GLM-5.3-Flash:max", undefined, parent, live, "openrouter", { source: "explicit" }),
		"together/zai-org/GLM-5.3-Flash:max",
	);
	// Bare ids keep the preferred-provider hard constraint.
	assert.throws(
		() => fallback.resolveEffectiveSubagentModel("zai-org/GLM-5.3-Flash", undefined, parent, live, "openrouter", { source: "explicit" }),
		/Unknown subagent model/,
	);
});

test("vendor-paused ids surface the vendor reason in chain diagnostics", () => {
	const live = [model("nemotron-3-5-lightning-30b", "runinfra", { baseUrl: "https://api.runinfra.ai/v1" })];
	const warnings = [];
	const origWarn = console.warn;
	console.warn = (msg) => { warnings.push(String(msg)); };
	try {
		writePrefs({
			version: 1,
			models: { paused: { provider: "runinfra", model: "glm-5-3-flash-v2" } },
			preferences: { subagents: { models: ["paused"] } },
		});
		fs.writeFileSync(
			path.join(root, "live-model-catalog.json"),
			JSON.stringify({ version: 1, providers: { runinfra: { ts: Date.now(), models: [], unavailable: { "glm-5-3-flash-v2": 'vendor availability "paused"' } } } }),
		);
		assert.deepEqual(fallback.resolveLlmPreferenceChain("subagents", live), []);
		const paused = warnings.find((w) => w.includes("glm-5-3-flash-v2"));
		assert.ok(paused, "paused entry warns");
		assert.match(paused, /vendor reports: vendor availability "paused"/);
	} finally {
		console.warn = origWarn;
		try { fs.unlinkSync(path.join(root, "live-model-catalog.json")); } catch {}
	}
});

test("explicit preferences pass tool requirements when catalog capability is unknown", () => {
	writePrefs({
		version: 1,
		models: {
			or_route: { provider: "openrouter", model: "google/gemini-2.5-flash" },
			other_provider: { provider: "deepseek", model: "deepseek-chat" },
		},
		preferences: { swarm: { models: ["or_route", "other_provider"] } },
	});
	// No free-route evidence is published in this file: catalog tool facts are
	// unknown for every route (and unknowable for non-OpenRouter/OrcaRouter
	// providers). Explicit configuration is the positive evidence, so the
	// chain keeps both entries instead of dropping to autonomous selection.
	const chain = fallback.resolveLlmPreferenceChain("swarm", registry, {
		requirements: { minContextWindow: 16384, minOutputTokens: 1024, toolCalling: true },
	});
	assert.deepEqual(chain.map((c) => c.route), [
		"openrouter/google/gemini-2.5-flash",
		"deepseek/deepseek-chat",
	]);
});

test("one malformed alias or role cannot discard otherwise valid preference chains", () => {
	writePrefs({ version: 1, models: {
		broken: null,
		badProvider: { provider: 7, model: 'fixture' },
		good: { provider: 'deepseek', model: 'deepseek-chat' },
	}, preferences: {
		council: { models: [null, 'bad alias!', 'good'] },
		subagents: { models: ['broken', 'badProvider', 'good'] },
		fusion: 'invalid list',
	} });
	assert.equal(prefs.loadLlmPreferences().ok, true);
	assert.ok(prefs.loadLlmPreferences().warnings.length >= 4);
	for (const role of ['council', 'subagents']) {
		assert.deepEqual(fallback.resolveLlmPreferenceChain(role, registry).map(row => row.route), ['deepseek/deepseek-chat']);
	}
});

test("Friendli provider fields preserve vendor namespaces even when they name another registered provider", () => {
	const live = [model('vendor/model-a', 'friendli'), model('model-a', 'vendor')];
	writePrefs({ models: { chosen: { provider: 'Friendli', model: 'vendor/model-a' } }, preferences: { subagents: ['chosen'] } });
	assert.equal(fallback.selectLlmPreferredModel('subagents', live).route, 'friendli/vendor/model-a');
	writePrefs({ models: { chosen: { provider: 'friendli', model: 'friendli/vendor/model-a:high' } }, preferences: { subagents: ['chosen'] } });
	const pick = fallback.selectLlmPreferredModel('subagents', live);
	assert.equal(pick.route, 'friendli/vendor/model-a');
	assert.equal(pick.thinking, 'high');
});

test("live subagents consistently honor role order through selection and candidate economy", () => {
	const preferred = model('vendor/preferred', 'friendli', { cost: { input: 10, output: 20 } });
	const second = model('vendor/backup', 'friendli', { cost: { input: 10, output: 20 } });
	const cheap = model('lab/cheap', 'openrouter', { cost: { input: 0.01, output: 0.02 } });
	const live = [preferred, second, cheap];
	writePrefs({ models: { first: { provider: 'friendli', model: preferred.id }, second: { provider: 'friendli', model: second.id } }, preferences: { subagents: ['first', 'second'] } });
	const parent = { provider: cheap.provider, id: cheap.id };
	const task = 'Inspect the source and report one bounded finding without editing';
	for (let attempt = 0; attempt < 20; attempt++) {
		const route = fallback.resolveSubagentModelOverride(undefined, parent, live, undefined, { task, sessionId: `session-${attempt % 2}` });
		assert.equal(route, preferred.fullId, 'frequency and free-route competition cannot demote the configured first choice');
		const candidates = fallback.buildModelCandidates(route, undefined, live, undefined, { origin: 'inherited', task });
		assert.deepEqual(candidates.slice(0, 2), [preferred.fullId, second.fullId]);
	}
	assert.deepEqual(fallback.buildModelCandidates(cheap.fullId, undefined, live, undefined, { origin: 'inherited', task }).slice(0, 2), [preferred.fullId, second.fullId]);
	assert.deepEqual(parent, { provider: cheap.provider, id: cheap.id }, 'selection never mutates main-session state');
});

test("preference selection works without pricing metadata and falls through actual capacity/quota gates", () => {
	const first = model('preferred', 'friendli', { cost: undefined, maxTokens: 32 });
	const second = model('backup', 'direct', { cost: undefined });
	const third = model('last', 'other', { cost: undefined });
	const live = [first, second, third];
	writePrefs({ models: {}, preferences: { subagents: live.map(m => ({ provider: m.provider, model: m.id })) } });
	const task = 'Inspect the source and summarize the observed behavior';
	assert.equal(fallback.resolveSubagentModelOverride(undefined, { provider: 'parent', id: 'model' }, live, undefined, { task }), second.fullId);
	const at = Date.now();
	fallback.setQuotaEventReader(() => [
		{ provider: 'direct', at: at - 1, kind: 'quota-exhausted' },
		{ provider: 'direct', at, kind: 'quota-exhausted' },
	]);
	try {
		assert.equal(fallback.resolveSubagentModelOverride(undefined, { provider: 'parent', id: 'model' }, live, undefined, { task }), third.fullId);
	} finally { fallback.setQuotaEventReader(undefined); }
});

test("free-only is enforced even with disabled economy or absent registry prices", async () => {
	const freeEvidence = await import(shared + 'free-route-evidence.ts');
	const paid = model('vendor/preferred', 'friendli', { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
	const free = model('lab/free', 'openrouter');
	const task = 'Use only free models to inspect the source and summarize one observation';
	writePrefs({ preferences: { subagents: [{ provider: paid.provider, model: paid.id }] } });
	freeEvidence.publishFreeEvidence([{ id: free.id, pricing: { prompt: '0', completion: '0' }, capabilities: { toolCalling: true, contextWindow: 65536, maxTokens: 8192 } }], freeEvidence.FREE_CATALOG_URL);
	try {
		for (const disabled of [true, false]) {
			fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, JSON.stringify({ enabled: !disabled }));
			const live = [paid, free].map(item => disabled ? item : { ...item, cost: undefined });
			const parent = { provider: paid.provider, id: paid.id };
			assert.equal(fallback.resolveSubagentModelOverride(undefined, parent, live, undefined, { task }), free.fullId);
			assert.deepEqual(fallback.buildModelCandidates(paid.fullId, undefined, live, undefined, { origin: 'inherited', task }), [free.fullId]);
			assert.throws(() => fallback.resolveSubagentModelOverride(undefined, parent, [live[0]], undefined, { task }), /free route|Free-only/);
			assert.throws(() => fallback.resolveSubagentModelOverride(paid.fullId, parent, live, undefined, { task, source: 'explicit' }), /free route|Free-only/);
			assert.throws(() => fallback.buildModelCandidates(paid.fullId, undefined, [live[0]], undefined, { origin: 'inherited', task }), /free route|Free-only/);
			for (const origin of ['explicit', 'configured']) {
				assert.throws(() => fallback.buildModelCandidates(paid.fullId, undefined, live, undefined, { origin, task }), /free route|Free-only/);
				assert.deepEqual(fallback.buildModelCandidates(free.fullId, [paid.fullId], live, undefined, { origin, task }), [free.fullId]);
			}
		}
	} finally { fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}'); }
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
  assert.deepEqual(fs.readFileSync(nested), beforeBadSave, "strict validation rejects the write without replacing valid JSON");

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
  assert.deepEqual(fs.readFileSync(nested), manualBytes, "a stale GUI revision leaves manual edits untouched");
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

test("malformed explicit backend restrictions are skipped instead of silently becoming automatic", () => {
  for (const providerOptions of [
    { routing: "pinned", order: [] },
    { routing: "pinned", order: "together" },
    { routing: "custom", only: "together" },
    { routing: "custom", ignore: [42] },
    { routing: "custom", order: ["together"], allow_fallbacks: "false" },
    { routing: "unknown", order: ["together"] },
    { routing: 7, order: ["together"] },
  ]) {
    writePrefs({ models: {}, preferences: { subagents: { models: [
      { provider: "openrouter", model: "google/gemini-2.5-flash", provider_options: providerOptions },
      { provider: "deepseek", model: "deepseek-chat" },
    ] } } });
    const skipped = [];
    const chain = fallback.resolveLlmPreferenceChain("subagents", registry, { onSkip: event => skipped.push(event) });
    assert.deepEqual(chain.map(item => item.route), ["deepseek/deepseek-chat"], JSON.stringify(providerOptions));
    assert.ok(skipped.some(event => /provider_options|pinned routing/.test(event.reason)));
  }
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

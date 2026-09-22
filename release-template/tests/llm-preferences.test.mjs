import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

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

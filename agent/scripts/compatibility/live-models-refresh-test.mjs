import {resolveOwnedCore} from "../lib/owned-core.mjs";
// Real registered refresh callbacks with isolated config and mocked HTTP only.
// node --experimental-strip-types scripts/bench/live-models-refresh-test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as drain, setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-test-"));
const oldDir = process.env.PI_CODING_AGENT_DIR;
const oldFetch = globalThis.fetch;
const oldProbePolicy = process.env.PI_MODEL_CAPABILITY_PROBES;
delete process.env.PI_MODEL_CAPABILITY_PROBES;
process.env.PI_CODING_AGENT_DIR = dir;
const cacheFile = path.join(dir, "live-model-catalog.json");
// pi-lens-ignore: ast-grep:unchecked-throwing-call-js
const readCache = () => JSON.parse(fs.readFileSync(cacheFile, "utf8"));
const seed = (providers = {}) =>
	fs.writeFileSync(
		cacheFile,
		JSON.stringify({
			version: 1,
			providers: Object.fromEntries(
				Object.entries(providers).map(([id, entry]) => [
					id,
					{ rawCompat: true, ...entry },
				]),
			),
		}),
	);
const oldModel = {
	id: "old",
	name: "old",
	reasoning: false,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const oldEntry = { ts: 1, models: [oldModel], rawCompat: true };
const oldFriendli = { ...oldModel, compat: { supportsReasoningEffort: false } };
const response = (body, status = 200) =>
	new Response(JSON.stringify(body), { status });
const context = (extra = {}) => ({
	allowNetwork: true,
	signal: new AbortController().signal,
	...extra,
});
try {
	fs.writeFileSync(path.join(dir, "models.json"), '{"providers":{}}');
	fs.writeFileSync(
		path.join(dir, "models-store.json"),
		JSON.stringify({ deepseek: { models: [oldModel] } }),
	);
	const providers = {};
    const handlers = {};
	const { default: register } = await import("../../extensions/live-models.ts");
	await register({
		registerProvider: (id, config) => {
			providers[id] = config;
		},
		on(name, handler) { handlers[name] = handler; },
	});
	const refresh = (id, ctx = context()) => providers[id].refreshModels(ctx);
    const savedOffline=process.env.PI_OFFLINE; delete process.env.PI_OFFLINE;
    let refreshed;
    handlers.before_agent_start({}, {hasUI:false,modelRegistry:{refresh: async options => {refreshed=options.providers;}}});
    await drain();
    if(savedOffline!==undefined)process.env.PI_OFFLINE=savedOffline;
    assert.ok(refreshed.includes("deepseek") && refreshed.includes("friendli"),"long-session discovery includes direct providers");
    seed();
    globalThis.fetch=async()=>response({data:[{id:"deepseek/deepseek-v4.1-flash",name:"Flash",context_length:1048576,top_provider:{max_completion_tokens:384000},architecture:{input_modalities:["text","image"]},pricing:{prompt:"0.0000003",completion:"0.0000012",input_cache_read:"0.000000006"},reasoning:{mandatory:false,default_enabled:true,supported_efforts:["low","high","max"]}}]});
    const freshFlash=(await refresh("openrouter"))[0];
    assert.equal(freshFlash.maxTokens,384000);
    assert.equal(freshFlash.thinkingLevelMap.off,"none","optional thinking must be disableable for economy");
    assert.equal(freshFlash.cost.cacheRead,0.006);


	// Stored/login credentials are resolved by core; every catalog honors them.
	const credentialProviders = ["openrouter", "orcarouter", "together", "friendli", "cerebras", "deepseek", "runinfra"];
	fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers:
		Object.fromEntries(credentialProviders.map((id) => [id, { apiKey: "TEST_configured-fixture" }]))
	}));
	for (const id of credentialProviders) {
		for (const resolved of [true, false]) {
			seed();
			const authorizations = [];
			globalThis.fetch = async (url, init) => {
				if (String(url).endsWith("/pricing")) return response({ data: [] });
				authorizations.push(new Headers(init?.headers).get("Authorization"));
				return response(id === "together" ? [{ id: "fixture", max_completion_tokens: 8192 }] : { data: [{ id: "fixture" }] });
			};
			await refresh(id, context(resolved ? { credential: { type: "api_key", key: "TEST_resolved-fixture" } } : {}));
			assert.deepEqual(authorizations,
				id === "cerebras" ? [null] : [`Bearer ${resolved ? "TEST_resolved-fixture" : "TEST_configured-fixture"}`], `${id} credential precedence`);
		}
	}
	fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: {
		friendli: { baseUrl: "https://proxy.invalid/v1", apiKey: "TEST_proxy-config-fixture" },
	} }));
	seed();
	globalThis.fetch = async (_url, init) => {
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer", "proxy credentials stay off canonical catalogs");
		return response({ data: [{ id: "public-fixture" }] });
	};
	assert.equal((await refresh("friendli", context({ credential: { type: "api_key", key: "TEST_proxy-resolved-fixture" } })))[0].id, "public-fixture");
	fs.writeFileSync(path.join(dir, "models.json"), '{"providers":{}}');

    // Public price units, explicit zero, and authenticated fallback on outage.
    seed();
    globalThis.fetch = async (url, init) => {
        assert.equal(new Headers(init?.headers).get("Authorization"), null);
        assert.equal(String(url), "https://api.cerebras.ai/public/v1/models");
        return response({data:[{id:"qwen",pricing:{prompt:"0.000002",completion:"0.000003"}},
            {id:"gpt-oss",pricing:{input:0.35,output:0.75,input_cache_read:"0"}}]});
    };
    let priced = await refresh("cerebras");
    assert.equal(priced[0].cost.input,2); assert.equal(priced[0].cost.cacheRead,2);
    assert.equal(priced[1].cost.input,0.35); assert.equal(priced[1].cost.cacheRead,0);
    seed();
    let fallbackCalls=0;
    globalThis.fetch = async (url, init) => {
        fallbackCalls++;
        if(String(url).includes('/public/')) return response({},403);
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer TEST_fallback-key");
        return response({data:[{id:"fallback"}]});
    };
    assert.equal((await refresh("cerebras",context({credential:{type:"api_key",key:"TEST_fallback-key"}})))[0].id,"fallback");
    assert.equal(fallbackCalls,2);
    seed({deepseek:{...oldEntry,models:[{...oldModel,id:"deepseek-v4-flash"}]}});
    assert.equal((await refresh("deepseek",context({allowNetwork:false})))[0].cost.input,0.3);
    // Live input prices supersede stale zero cache prices in the native store.
    fs.writeFileSync(path.join(dir,"models-store.json"),JSON.stringify({deepseek:{models:[oldModel]},together:{models:[{...oldModel,id:"priced",cost:{input:1,output:2,cacheRead:0,cacheWrite:0}}]}}));
    seed();globalThis.fetch=async()=>response([{id:"priced",pricing:{input:3,output:4}}]);
    assert.equal((await refresh("together"))[0].cost.cacheRead,3);
    fs.writeFileSync(path.join(dir,"models-store.json"),JSON.stringify({deepseek:{models:[oldModel]}}));

	seed({ openrouter: oldEntry });
	assert.equal((await refresh("openrouter", { ...context(), allowNetwork: false }))[0].compat.sendSessionAffinityHeaders, true);
	seed({ openrouter: { ...oldEntry, models: [{ ...oldModel, compat: { sendSessionAffinityHeaders: false } }] } });
	assert.equal((await refresh("openrouter", { ...context(), allowNetwork: false }))[0].compat.sendSessionAffinityHeaders, false);

	for (const id of ["friendli", "runinfra", "orcarouter"]) {
		for (const failure of ["http", "empty", "malformed"]) {
			seed({ [id]: oldEntry });
			let calls = 0;
			globalThis.fetch = async () => {
				calls++;
				if (failure === "http") return response({}, 503);
				return response({ data: failure === "empty" ? [] : {} });
			};
			assert.deepEqual(
				await refresh(id),
				[id === "friendli" ? oldFriendli : oldModel],
				`${id} ${failure}: stale models survive`,
			);
			assert.equal(readCache().providers[id].ts, 1, "failure must not renew TTL");
			globalThis.fetch = async (url) => {
				calls++;
				return response({
					data: String(url).endsWith("/pricing") ? [] : [{ id: "recovered" }],
				});
			};
			assert.equal((await refresh(id))[0].id, "recovered");
			assert.ok(calls >= 2, "recovery retries without force or six-hour wait");
			assert.ok(readCache().providers[id].ts > 1);
		}
	}

	seed();
	globalThis.fetch = async () => {
		throw new Error("offline");
	};
	assert.ok(
		(await refresh("orcarouter")).some((m) => m.id === "orcarouter/auto"),
	);
	assert.equal(
		readCache().providers.orcarouter,
		undefined,
		"cold fallback is not cached as fresh",
	);
	assert.deepEqual(
		(await refresh("deepseek")).filter(m => m.id === "old"),
		[oldModel],
		"native store survives cold network failure",
	);
	assert.equal(readCache().providers.deepseek, undefined);
    const flash = (await refresh("deepseek", context({allowNetwork:false}))).find(m => m.id === "deepseek-flash");
    assert.equal(flash.reasoning, true);
    assert.deepEqual(flash.input, ["text", "image"]);
    assert.equal(flash.maxTokens,384000);
    assert.equal(flash.contextWindow,1000000);
    assert.equal(flash.cost.input,0.3);
    assert.equal(flash.cost.cacheRead,0.006);
    assert.equal(flash.thinkingLevelMap.medium,"high");
    assert.equal(flash.compat.requiresReasoningContentOnAssistantMessages,true);


	seed({ friendli: { ...oldEntry, ts: Date.now() } });
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return response({ data: [{ id: "forced" }] });
	};
	assert.deepEqual(await refresh("friendli"), [oldFriendli]);
	assert.deepEqual(
		await refresh("friendli", context({ allowNetwork: false, force: true })),
		[oldFriendli],
	);
	assert.equal(calls, 0, "fresh and offline restore make no requests");
	assert.equal(
		(await refresh("friendli", context({ force: true })))[0].id,
		"forced",
	);
	assert.equal(calls, 1);

	seed({ friendli: oldEntry });
	const controller = new AbortController();
	globalThis.fetch = async () => {
		controller.abort();
		return response({ data: [{ id: "late" }] });
	};
	assert.deepEqual(
		await refresh("friendli", context({ signal: controller.signal })),
		[oldFriendli],
	);
	assert.equal(readCache().providers.friendli.ts, 1);

	globalThis.fetch = async () => {
		assert.fail("pre-aborted refresh must not fetch");
	};
	assert.deepEqual(
		await refresh("friendli", context({ signal: controller.signal })),
		[oldFriendli],
	);

	// Concurrent providers use the existing serialized merge, not last-writer wins.
	seed();
	globalThis.fetch = async () => response({ data: [{ id: "concurrent" }] });
	await Promise.all([refresh("friendli"), refresh("runinfra")]);
	assert.equal(readCache().providers.friendli.models[0].id, "concurrent");
	assert.equal(readCache().providers.runinfra.models[0].id, "concurrent");

	// A slow older response cannot overwrite a later successful refresh.
	seed({ friendli: oldEntry });
	let resolveOlder;
	globalThis.fetch = () => new Promise((resolve) => { resolveOlder = resolve; });
	const older = refresh("friendli", context({ force: true }));
	await delay(5);
	globalThis.fetch = async () => response({ data: [{ id: "newer-response" }] });
	await refresh("friendli", context({ force: true }));
	resolveOlder(response({ data: [{ id: "older-response" }] }));
	await older;
	assert.equal(readCache().providers.friendli.models[0].id, "newer-response");

	// Cancellation while another writer owns the cache never clears its lock,
	// mutates durable state or poisons the next publication in this process.
	seed({ friendli: oldEntry });
	const beforeLockAbort = fs.readFileSync(cacheFile, "utf8");
	const locked = `${cacheFile}.lock`;
	fs.mkdirSync(locked);
	fs.writeFileSync(path.join(locked, "owner"), String(process.pid));
	const waitingController = new AbortController();
	globalThis.fetch = async () => response({ data: [{ id: "cancelled-writer" }] });
	const waiting = refresh("friendli", context({ signal: waitingController.signal }));
	await drain();
	waitingController.abort();
	assert.deepEqual(await waiting, [oldFriendli]);
	assert.equal(fs.readFileSync(cacheFile, "utf8"), beforeLockAbort);
	assert.equal(fs.existsSync(locked), true);
	fs.rmSync(locked, { recursive: true });
	assert.equal((await refresh("friendli"))[0].id, "cancelled-writer");
	seed({ friendli: oldEntry });

	// An unwritable temporary target must not poison every subsequent write.
	fs.mkdirSync(`${cacheFile}.${process.pid}.tmp`);
	globalThis.fetch = async () => response({ data: [{ id: "disk-recovered" }] });
	assert.equal((await refresh("friendli"))[0].id, "disk-recovered");
	assert.equal(readCache().providers.friendli.ts, 1, "failed save must not renew freshness");
	fs.rmdirSync(`${cacheFile}.${process.pid}.tmp`);
	assert.equal((await refresh("friendli"))[0].id, "disk-recovered");

	// Normal refresh must never spend inference tokens to discover capabilities.
	seed({ together: oldEntry });
	let automaticProbes = 0;
	globalThis.fetch = async (_url, init) => {
		if (init?.method === "POST") automaticProbes++;
		return response([{ id: "future-no-probe", type: "chat" }]);
	};
	await refresh("together");
	await drain();
	assert.equal(automaticProbes, 0);
	process.env.PI_MODEL_CAPABILITY_PROBES = "1";
	// HTTP failures are unknown capability, not a permanent reasoning:false.
	seed({ together: oldEntry });
	globalThis.fetch = async (_url, init) =>
		init?.method === "POST"
			? response({}, 429)
			: response([{ id: "probe-rate-limited", type: "chat" }]);
	await refresh("together");
	await drain();
	assert.equal(
		readCache().providers.together.probes?.["probe-rate-limited"],
		undefined,
	);

	// Successful negative and positive probes still publish their capability.
	for (const reasoning of [false, true]) {
		seed({ together: oldEntry });
		globalThis.fetch = async (_url, init) => {
			if (init?.method !== "POST")
				return response([{ id: "probe-ok", type: "chat" }]);
			const message = reasoning
				? { reasoning_content: "thinking" }
				: { content: "hi" };
			return response({ choices: [{ message }] });
		};
		await refresh("together");
		await drain();
		assert.equal(readCache().providers.together.probes["probe-ok"].r, reasoning);
		let publicationRequests = 0;
		globalThis.fetch = async () => {
			publicationRequests++;
			throw new Error("cached publication must stay offline");
		};
		for (const extra of [{ allowNetwork: false }, {}]) {
			const [published] = await refresh("together", context(extra));
			assert.equal(published.reasoning, reasoning, "fresh/offline catalogs expose completed probe facts");
			assert.equal(published.compat.supportsReasoningEffort, reasoning);
			assert.equal(published.thinkingLevelMap?.medium, reasoning ? "medium" : undefined);
		}
		assert.equal(publicationRequests, 0, "published probe facts require no new request");
	}

	// Invalid successful HTTP responses are unknown, not evidence of no reasoning.
	seed({ together: oldEntry });
	globalThis.fetch = async (_url, init) => init?.method === "POST"
		? response({ choices: [] })
		: response([{ id: "probe-malformed", max_completion_tokens: 8192 }]);
	await refresh("together");
	await drain();
	assert.equal(readCache().providers.together.probes?.["probe-malformed"], undefined);

	// Native facts outrank probe experiments, and expired probes cannot invent capabilities.
	fs.writeFileSync(path.join(dir, "models-store.json"), JSON.stringify({
		deepseek: { models: [oldModel] },
		together: { models: [{ ...oldModel, id: "native-model" }] },
	}));
	seed({ together: { ...oldEntry, ts: Date.now(), models: [
		{ ...oldModel, id: "native-model" }, { ...oldModel, id: "expired-model" },
		{ ...oldModel, id: "positive-fact", reasoning: true },
	], probes: {
		"native-model": { r: true, ts: Date.now() },
		"expired-model": { r: true, ts: 1 },
		"positive-fact": { r: false, ts: Date.now() },
	} } });
	const evidence = await refresh("together", context({ allowNetwork: false }));
	assert.equal(evidence.find((model) => model.id === "native-model").reasoning, false);
	assert.equal(evidence.find((model) => model.id === "expired-model").reasoning, false);
	assert.equal(evidence.find((model) => model.id === "positive-fact").reasoning, true, "a tiny negative probe cannot disprove a positive capability fact");
	fs.writeFileSync(path.join(dir, "models-store.json"), JSON.stringify({ deepseek: { models: [oldModel] } }));

	// Do not spend opt-in probe tokens when their results cannot be persisted.
	seed({ together: oldEntry });
	fs.mkdirSync(`${cacheFile}.${process.pid}.tmp`);
	let wastedProbes = 0;
	globalThis.fetch = async (_url, init) => {
		if (init?.method === "POST") wastedProbes++;
		return response([{ id: "cannot-save", max_completion_tokens: 8192 }]);
	};
	assert.equal((await refresh("together"))[0].id, "cannot-save");
	await drain();
	assert.equal(wastedProbes, 0);
	fs.rmdirSync(`${cacheFile}.${process.pid}.tmp`);


	// A late probe enriches the current catalog and preserves other completed facts.
	seed({ together: oldEntry });
	let resolveProbe, pendingProbeRequests = 0;
	globalThis.fetch = async (_url, init) => init?.method === "POST"
		? new Promise((resolve) => { pendingProbeRequests++; resolveProbe = resolve; })
		: response(Array.from({ length: 3 }, () => ({ id: "late-probe", max_completion_tokens: 8192 })));
	await refresh("together");
	assert.equal(pendingProbeRequests, 1, "duplicate catalog ids share one capability experiment");
	const newer = { ...oldEntry, ts: Date.now(), models: [{ ...oldModel, id: "newer-catalog" }],
		probes: { "other-probe": { r: false, ts: Date.now() } } };
	seed({ together: newer });
	resolveProbe(response({ choices: [{ message: { reasoning_content: "yes" } }] }));
	await drain();
	assert.equal(readCache().providers.together.models[0].id, "newer-catalog");
	assert.equal(readCache().providers.together.probes["other-probe"].r, false);
	assert.equal(readCache().providers.together.probes["late-probe"].r, true);

	// Six in-flight requests abort; the rest of the queue never starts.
	seed({ together: oldEntry });
	const probes = new AbortController(),
		signals = [];
	globalThis.fetch = async (_url, init) => {
		if (init?.method !== "POST")
			return response(
				Array.from({ length: 20 }, (_, i) => ({
					id: `pending-${i}`,
					type: "chat",
				})),
			);
		signals.push(init.signal);
		return new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(init.signal.reason), {
				once: true,
			});
		});
	};
	await refresh("together", context({ signal: probes.signal }));
	assert.equal(signals.length, 6);
	probes.abort();
	await drain();
	assert.ok(signals.every((signal) => signal.aborted));
	assert.equal(signals.length, 6);
	assert.equal(readCache().providers.together.probes, undefined);
	// Abort after one successful probe: do not commit a cancelled pass's results.
	seed({ together: oldEntry });
	const partial = new AbortController();
	globalThis.fetch = async (_url, init) => {
		if (init?.method !== "POST")
			return response([
				{ id: "done", type: "chat" },
				{ id: "cancelled", type: "chat" },
			]);
		if (JSON.parse(init.body).model === "done")
			return response({ choices: [{ message: { reasoning_content: "yes" } }] });
		return new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(init.signal.reason), {
				once: true,
			});
		});
	};
	await refresh("together", context({ signal: partial.signal }));
	await drain();
	partial.abort();
	await drain();
	assert.equal(readCache().providers.together.probes, undefined);
	// Id-only fallback remains conservative without dumping catalog warnings to stderr.
	const warnings = [],
		oldWarn = console.warn;
	console.warn = (text) => warnings.push(text);
	try {
		seed();
		globalThis.fetch = async () =>
			response({
				data: [
					{ id: "future-cerebras" },
					{ id: "qwen-3.8-27b" },
					{ id: "qwen3-coder" },
					{ id: "gpt-oss-120b" },
				],
			});
		const models = await refresh("cerebras", context({ force: true }));
		assert.equal(models.find((m) => m.id === "qwen-3.8-27b").maxTokens, 65536);
		assert.equal(models.find((m) => m.id === "qwen3-coder").maxTokens, 65536);
		assert.equal(models.find((m) => m.id === "gpt-oss-120b").maxTokens, 32768);
		assert.equal(warnings.length, 0);
		assert.equal(models.find((m) => m.id === "future-cerebras").maxTokens, 8192);
		assert.ok(models.every((m) => m.compat.maxTokensField === "max_tokens"));
		const freshTs = readCache().providers.cerebras.ts;
		globalThis.fetch = async () => {
			throw new Error("outage");
		};
		for (const opts of [
			{},
			{ allowNetwork: false, force: true },
			{ force: true },
			{ signal: AbortSignal.abort() },
		]) {
			assert.ok(
				(await refresh("cerebras", context(opts))).every(
					(m) => m.compat.maxTokensField === "max_tokens",
				),
			);
			assert.equal(readCache().providers.cerebras.ts, freshTs);
		}
		assert.equal(warnings.length, 0, "catalog fallbacks never flood terminal stderr");
		seed({
			cerebras: {
				ts: Date.now(),
				models: [
					{ ...oldModel, id: "legacy-unknown", compat: { supportsStore: false } },
				],
			},
		});
		const cached = (
			await refresh("cerebras", context({ allowNetwork: false }))
		)[0];
		assert.equal(cached.compat.maxTokensField, "max_tokens");
		assert.equal(cached.compat.supportsStore, false);
		assert.equal(warnings.length, 0);
		globalThis.fetch = async () =>
			response({ data: [{ id: "future-deepseek" }] });
		await refresh("deepseek", context({ force: true }));
		assert.equal(warnings.length, 0);
		assert.ok(
			!warnings.some((w) => /deepseek\/old:/.test(w)),
			"real stored 8192 cap is not a fallback",
		);
		const core = resolveOwnedCore();
		const chat = await import(
			pathToFileURL(
				path.join(
					core,
					"../ai/dist/api/openai-completions.js",
				),
			)
		);
		for (const baseUrl of [
			"https://api.cerebras.ai/v1",
			"https://proxy.invalid/v1",
		]) {
			let body;
			const model = {
				...models.find((m) => m.id === "qwen-3.8-27b"),
				provider: "cerebras",
				api: "openai-completions",
				baseUrl,
			};
			const result = await chat
				.stream(
					model,
					{ messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
					{
						apiKey: "TEST_offline-fixture",
						maxTokens: 123,
						maxRetries: 0,
						fetch: async (_url, options) => {
							body = JSON.parse(options.body);
							return new Response(
								'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
								{ headers: { "content-type": "text/event-stream" } },
							);
						},
					},
				)
				.result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(body.max_tokens, 123);
			assert.equal(body.max_completion_tokens, undefined);
		}
	} finally {
		console.warn = oldWarn;
	}
	console.log(
		"PASS catalog recovery/cache/cancellation, id-only warnings, known caps, and real Cerebras/proxy max_tokens wire",
	);
} finally {
	globalThis.fetch = oldFetch;
	if (oldProbePolicy === undefined)
		delete process.env.PI_MODEL_CAPABILITY_PROBES;
	else process.env.PI_MODEL_CAPABILITY_PROBES = oldProbePolicy;
	if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldDir;
	fs.rmSync(dir, { recursive: true, force: true });
}

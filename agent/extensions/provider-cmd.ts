/**
 * /provider — select a serving provider (sub-provider) for an OpenRouter
 * model and persist the choice into models.json `modelOverrides`, affecting
 * real request routing (params.provider = compat.openRouterRouting is the
 * native wire path).
 *
 * WHY: OpenRouter serves most models from multiple providers with different
 * price/latency/throughput. The pin is persisted at the provider level so
 * any future extension recomposition still applies it last (modelOverrides
 * is the topmost layer in provider-composer).
 *
 * Subcommands (model arg optional — defaults to the currently selected
 * model):
 *   (bare)                 endpoints of the selected model -> interactive pin
 *   list [model]           all pins, or endpoints table for one model
 *   status                 current pins for every model
 *   order [model] <tag...> soft pin: preferred order, fallbacks allowed
 *   only [model] <tag...>  hard pin: no other provider may serve
 *   sort [model] <key>     pick best endpoint by price|throughput|uptime|latency
 *   clear <model>          remove the pin for a model (arg or selected)
 *   reset                  remove every pin
 *   json [model] <json>    raw compat.openRouterRouting value
 *
 * /provider is only meaningful for OpenRouter models: the pin is persisted
 * at providers.openrouter.modelOverrides and maps to the request-level
 * `provider` param. With no model selected the commands tell you to pick
 * one first (/model <id>).
 *
 * Wire: GET /api/v1/models/{id}/endpoints is public and lists every serving
 * provider with status/pricing/latency/throughput. `only`/`order` use exact
 * endpoint `tag` values (e.g. "z-ai/fp8", "cloudflare").
 */

import type {
	AutocompleteItem,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR: string =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const MODELS_JSON = join(AGENT_DIR, "models.json");
const FETCH_TIMEOUT_MS = 20_000;

const SUBCOMMANDS = [
	"list",
	"status",
	"order",
	"only",
	"sort",
	"clear",
	"reset",
	"json",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number] | undefined;

interface Endpoint {
	tag: string;
	provider_name?: string;
	quantization?: string;
	context_length?: number;
	max_completion_tokens?: number;
	pricing?: Record<string, string>;
	status?: number;
	uptime_last_30m?: number;
	uptime_month?: number;
	latency_last_30m?: number;
	throughput_last_30m?: number;
	supports_tool_choice?: boolean;
}

interface ModelsJson {
	providers?: Record<
		string,
		{
			modelOverrides?: Record<
				string,
				{ compat?: { openRouterRouting?: Record<string, unknown> } }
			>;
		}
	>;
}

// ── models.json access ────────────────────────────────────────────────

function readModelsJson(): ModelsJson {
	try {
		const value = JSON.parse(readFileSync(MODELS_JSON, "utf-8"));
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Invalid config object");
		return value as ModelsJson;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error("Cannot read models.json; configuration was not changed", {
			cause: error,
		});
	}
}

function writeModelsJson(json: ModelsJson): void {
	const tmp = `${MODELS_JSON}.provider-tmp`;
	writeFileSync(tmp, JSON.stringify(json, null, 2), { mode: 0o600 });
	// writeFileSync's mode applies only on create; harden a stale temp file too.
	chmodSync(tmp, 0o600);
	renameSync(tmp, MODELS_JSON);
}

function pinFor(
	json: ModelsJson,
	modelId: string,
): Record<string, unknown> | undefined {
	return json.providers?.openrouter?.modelOverrides?.[modelId]?.compat
		?.openRouterRouting;
}

function setPin(
	json: ModelsJson,
	modelId: string,
	routing: Record<string, unknown>,
): void {
	const providers = (json.providers ??= {});
	const openrouter = (providers.openrouter ??= {});
	const overrides = openrouter.modelOverrides ?? {};
	const override = Object.hasOwn(overrides, modelId)
		? overrides[modelId]
		: undefined;
	openrouter.modelOverrides = {
		...overrides,
		[modelId]: {
			...override,
			compat: { ...override?.compat, openRouterRouting: routing },
		},
	};
}

function removePin(json: ModelsJson, modelId: string | undefined): number {
	const overrides = json.providers?.openrouter?.modelOverrides;
	if (!overrides) return 0;
	let removed = 0;
	for (const key of modelId === undefined ? Object.keys(overrides) : [modelId]) {
		if (!Object.hasOwn(overrides, key)) continue;
		const override = overrides[key];
		if (!override?.compat || !Object.hasOwn(override.compat, "openRouterRouting"))
			continue;
		delete override.compat.openRouterRouting;
		if (Object.keys(override.compat).length === 0) delete override.compat;
		if (Object.keys(override).length === 0) delete overrides[key];
		removed++;
	}
	return removed;
}

/** Recompute the composed registry after pins changed. */
/**
 * Split command tokens into (model?, rest): the first token is treated as a
 * model only when it actually matches one, so `order Z.AI` with a selected
 * model parses Z.AI as a tag, while `order z-ai/glm-5.3-flash Z.AI` targets
 * the model explicitly.
 */
function splitModelArg(
	ctx: ExtensionCommandContext,
	tokens: string[],
): { modelQuery: string | undefined; rest: string[] } {
	if (tokens.length === 0) return { modelQuery: undefined, rest: [] };
	const first = tokens[0];
	if (first !== undefined && findModel(ctx, first)) {
		return { modelQuery: first, rest: tokens.slice(1) };
	}
	return { modelQuery: undefined, rest: tokens };
}

async function refreshRegistry(ctx: ExtensionCommandContext): Promise<void> {
	try {
		await ctx.modelRegistry.refresh({
			allowNetwork: false,
			providers: ["openrouter"],
		});
	} catch {
		// refresh failure must not hide the stored pin; the next natural
		// refresh/startup will pick it up.
	}
}

// ── Model / endpoint discovery ─────────────────────────────────────────

function findModel(ctx: ExtensionCommandContext, query: string) {
	const q = query.toLowerCase();
	const models = ctx.modelRegistry
		.getAll()
		.filter((m) => m.provider === "openrouter");
	const exact = models.find((m) => m.id.toLowerCase() === q);
	if (exact) return exact;
	const suffixes = models.filter((m) => m.id.toLowerCase().endsWith("/" + q));
	return suffixes.length === 1 ? suffixes[0] : undefined;
}

/**
 * Resolve the target model: explicit query wins, otherwise the session's
 * selected model. /provider only makes sense for OpenRouter models, so
 * anything else is rejected with guidance.
 */
function resolveModel(
	ctx: ExtensionCommandContext,
	modelQuery: string | undefined,
) {
	const model =
		modelQuery && modelQuery.trim() ? findModel(ctx, modelQuery) : ctx.model;
	if (!model) {
		ctx.ui.notify(
			modelQuery && modelQuery.trim()
				? `/provider: no model matching "${modelQuery}"`
				: "/provider: no model selected — pick one with /model <id>, or pass a model id",
			"warning",
		);
		return undefined;
	}
	if (model.provider !== "openrouter") {
		ctx.ui.notify(
			`/provider: only applies to OpenRouter models — ${model.provider}/${model.id} is not served by OpenRouter`,
			"warning",
		);
		return undefined;
	}
	return model;
}

async function fetchEndpointsOrWarn(
	ctx: ExtensionCommandContext,
	model: NonNullable<ReturnType<typeof resolveModel>>,
): Promise<Endpoint[] | undefined> {
	let eps: Endpoint[];
	try {
		eps = await fetchEndpoints(model.id);
	} catch (err) {
		ctx.ui.notify(`/provider: ${(err as Error).message}`, "error");
		return undefined;
	}
	if (eps.length === 0) {
		ctx.ui.notify(`/provider: no active endpoints for ${model.id}`, "warning");
		return undefined;
	}
	return eps;
}

async function fetchEndpoints(modelId: string): Promise<Endpoint[]> {
	const res = await fetch(
		// Model ids are URL-safe (letters/digits/-/./_/: plus the / separator);
		// encodeURIComponent would escape the slash and 404.
		`https://openrouter.ai/api/v1/models/${modelId}/endpoints`,
		{
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		},
	);
	if (!res.ok) throw new Error(`endpoints fetch failed (HTTP ${res.status})`);
	const body = (await res.json()) as { data?: { endpoints?: Endpoint[] } };
	if (!Array.isArray(body.data?.endpoints)) return [];
	return body.data.endpoints.filter((e) =>
		e && typeof e.tag === "string" && e.tag.trim().length > 0 &&
		!/[\u0000-\u001f\u007f]/u.test(e.tag) && (e.status ?? 0) === 0,
	);
}

function perMillion(v: unknown): number {
	if ((typeof v !== "string" && typeof v !== "number") || String(v).trim() === "") return Infinity;
	const n = Number(v) * 1_000_000;
	return Number.isFinite(n) && n >= 0 ? n : Infinity;
}

function endpointCost(e: Endpoint): number {
	return perMillion(e.pricing?.prompt) + perMillion(e.pricing?.completion);
}

function endpointLine(e: Endpoint): string {
	const latency = e.latency_last_30m;
	const tps = e.throughput_last_30m;
	const up = e.uptime_last_30m ?? e.uptime_month;
	return [
		e.tag,
		e.provider_name ?? "?",
		`$${priceText(e.pricing?.prompt)}/${priceText(e.pricing?.completion)}/M`,
		`ctx ${e.context_length ?? "?"}`,
		`ms ${latitude(latency)}`,
		tps ? `tps ${Math.round(tps)}` : "-",
		up === undefined ? "-" : `up ${up}%`,
		e.supports_tool_choice === false ? "no-tools" : "tools",
	].join(" · ");
}

function priceText(value: string | undefined): string {
	const price = perMillion(value);
	return Number.isFinite(price) ? price.toFixed(3) : "?";
}

function latitude(v: number | undefined): string {
	return v === undefined ? "?" : String(Math.round(v * 10) / 10);
}

function uptimeOf(e: Endpoint): number {
	return e.uptime_last_30m ?? e.uptime_month ?? 0;
}

function sortEndpoints(eps: Endpoint[], key: string): Endpoint[] {
	const sorted = [...eps];
	if (key === "price" || key === "cheapest") {
		sorted.sort((a, b) => endpointCost(a) - endpointCost(b));
	} else if (key === "throughput" || key === "tps") {
		sorted.sort(
			(a, b) => (b.throughput_last_30m ?? 0) - (a.throughput_last_30m ?? 0),
		);
	} else if (key === "uptime") {
		sorted.sort((a, b) => uptimeOf(b) - uptimeOf(a));
	} else {
		sorted.sort(
			(a, b) =>
				(a.latency_last_30m ?? Infinity) - (b.latency_last_30m ?? Infinity),
		);
	}
	return sorted;
}

// ── Persisted pin writing ─────────────────────────────────────────────

async function applyPin(
	ctx: ExtensionCommandContext,
	modelId: string,
	routing: Record<string, unknown>,
): Promise<void> {
	const json = readModelsJson();
	setPin(json, modelId, routing);
	writeModelsJson(json);
	ctx.ui.notify(`/provider: ${modelId} → ${JSON.stringify(routing)}`, "info");
	await refreshRegistry(ctx);
}

function describePin(pin: Record<string, unknown> | undefined): string {
	if (!pin) return "(native routing — no pin)";
	if (["only", "order", "ignore"].some((key) => Object.hasOwn(pin, key) && !endpointTags(pin[key])) ||
		Object.hasOwn(pin, "allow_fallbacks") && typeof pin.allow_fallbacks !== "boolean") return JSON.stringify(pin);
	const p = pin as {
		order?: string[];
		only?: string[];
		allow_fallbacks?: boolean;
	};
	const parts: string[] = [];
	if (endpointTags(p.only)) parts.push(`ONLY ${p.only.join(", ")}`);
	if (endpointTags(p.order)) parts.push(`order ${p.order.join(" → ")}`);
	if (p.allow_fallbacks) parts.push("fallbacks allowed");
	return parts.length > 0 ? parts.join(" · ") : JSON.stringify(pin);
}

function endpointTags(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((tag) => typeof tag === "string" && tag.trim().length > 0);
}

// ── Subcommand implementations ────────────────────────────────────────

async function cmdList(
	ctx: ExtensionCommandContext,
	modelQuery: string | undefined,
): Promise<void> {
	if (!modelQuery) {
		const json = readModelsJson();
		const pins = json.providers?.openrouter?.modelOverrides ?? {};
		const models = ctx.modelRegistry.getAll();
		const pinnedIds = Object.keys(pins).filter((id) =>
			Object.hasOwn(pins[id]?.compat ?? {}, "openRouterRouting"),
		);
		const total = models.filter((m) => m.provider === "openrouter").length;
		const pinned = pinnedIds
			.map((id) => {
				const m = models.find((x) => x.provider === "openrouter" && x.id === id);
				return `${id}${m ? "" : " (not in catalog!)"}\n    ${describePin(pins[id]?.compat?.openRouterRouting)}`;
			})
			.join("\n");
		ctx.ui.notify(
			`/provider: ${total} OpenRouter models in catalog, ${
				pinnedIds.length
			} pinned${pinned ? `\n\n${pinned}` : ""}`,
			"info",
		);
		return;
	}
	const model = resolveModel(ctx, modelQuery);
	if (!model) return;
	const eps = await fetchEndpointsOrWarn(ctx, model);
	if (!eps) return;
	const pin = describePin(pinFor(readModelsJson(), model.id));
	const lines = eps
		.map((e, i) => `${String(i + 1).padStart(2)}. ${endpointLine(e)}`)
		.join("\n");
	ctx.ui.notify(
		`/provider: ${model.id} — ${eps.length} active endpoints\npin: ${pin}\n\n${lines}`,
		"info",
	);
}

async function cmdStatus(ctx: ExtensionCommandContext): Promise<void> {
	await cmdList(ctx, undefined);
}

async function cmdOrder(
	ctx: ExtensionCommandContext,
	tokens: string[],
	hard: boolean,
): Promise<void> {
	const { modelQuery, rest } = splitModelArg(ctx, tokens);
	if (rest.length === 0) {
		ctx.ui.notify(
			"/provider: usage: order [model] <tag> [tag...] (or `only [model] <tag...>`)",
			"warning",
		);
		return;
	}
	const model = resolveModel(ctx, modelQuery);
	if (!model) return;
	const eps = await fetchEndpointsOrWarn(ctx, model);
	if (!eps) return;
	const known = new Set(eps.map((e) => e.tag));
	const tags = rest;
	const unknown = tags.filter((t) => !known.has(t));
	if (unknown.length > 0) {
		ctx.ui.notify(
			`/provider: unknown endpoint tags: ${unknown.join(", ")}`,
			"warning",
		);
		return;
	}
	const routing = hard ? { only: tags } : { order: tags, allow_fallbacks: true };
	await applyPin(ctx, model.id, routing);
}

async function cmdSort(
	ctx: ExtensionCommandContext,
	tokens: string[],
): Promise<void> {
	const { modelQuery, rest } = splitModelArg(ctx, tokens);
	const key = rest[0] ?? "price";
	if (!["price", "cheapest", "throughput", "tps", "uptime", "latency"].includes(key)) {
		ctx.ui.notify(`/provider: unknown sort key "${key}" — use price, latency, throughput or uptime`, "warning");
		return;
	}
	const model = resolveModel(ctx, modelQuery);
	if (!model) return;
	const eps = await fetchEndpointsOrWarn(ctx, model);
	if (!eps) return;
	const sorted = sortEndpoints(eps, key);
	const best = sorted[0]!;
	if ((key === "price" || key === "cheapest") && !Number.isFinite(endpointCost(best))) {
		ctx.ui.notify("/provider: no endpoint has complete valid pricing; routing was not changed", "warning");
		return;
	}
	await applyPin(ctx, model.id, {
		order: [best.tag],
		allow_fallbacks: true,
	});
	const top = sorted.slice(0, 5).map(endpointLine).join("\n");
	ctx.ui.notify(
		`/provider: ${model.id} pinned to ${best.tag} (by ${key})\n\n${top}`,
		"info",
	);
}

async function cmdClear(
	ctx: ExtensionCommandContext,
	modelQuery: string | undefined,
	allPins: boolean,
): Promise<void> {
	const json = readModelsJson();
	if (allPins) {
		const removed = removePin(json, undefined);
		if (removed === 0) {
			ctx.ui.notify("/provider: no pins to remove", "warning");
			return;
		}
		writeModelsJson(json);
		ctx.ui.notify(`/provider: removed all ${removed} pin(s)`, "info");
		await refreshRegistry(ctx);
		return;
	}
	const model = resolveModel(ctx, modelQuery);
	if (!model) return;
	if (removePin(json, model.id) === 0) {
		ctx.ui.notify(`/provider: no pin for ${model.id}`, "warning");
		return;
	}
	writeModelsJson(json);
	ctx.ui.notify(`/provider: removed pin for ${model.id}`, "info");
	await refreshRegistry(ctx);
}

async function cmdJson(
	ctx: ExtensionCommandContext,
	raw: string,
): Promise<void> {
	const prefix = raw.match(/^(\S+)\s+([\s\S]*)$/);
	const modelQuery =
		prefix && !raw.startsWith("{") && findModel(ctx, prefix[1]!)
			? prefix[1]
			: undefined;
	const jsonArg = modelQuery ? prefix![2]! : raw;
	const model = resolveModel(ctx, modelQuery);
	if (!model) return;
	let routing: unknown;
	try {
		routing = JSON.parse(jsonArg);
	} catch {
		ctx.ui.notify("/provider: invalid JSON", "warning");
		return;
	}
	if (
		typeof routing !== "object" ||
		routing === null ||
		Array.isArray(routing)
	) {
		ctx.ui.notify("/provider: routing value must be a JSON object", "warning");
		return;
	}
	const value = routing as Record<string, unknown>;
	for (const key of ["only", "order", "ignore"]) {
		if (Object.hasOwn(value, key) && !endpointTags(value[key])) {
			ctx.ui.notify(`/provider: routing ${key} must be an array of nonempty endpoint tags; configuration was not changed`, "warning");
			return;
		}
	}
	if (Object.hasOwn(value, "allow_fallbacks") && typeof value.allow_fallbacks !== "boolean") {
		ctx.ui.notify("/provider: routing allow_fallbacks must be a boolean; configuration was not changed", "warning");
		return;
	}
	await applyPin(ctx, model.id, routing as Record<string, unknown>);
}

// ── Interactive pick ───────────────────────────────────────────────────

async function cmdInteractive(ctx: ExtensionCommandContext): Promise<void> {
	const model = resolveModel(ctx, undefined);
	if (!model) return;
	const eps = await fetchEndpointsOrWarn(ctx, model);
	if (!eps) return;
	const options = eps.map((e) => endpointLine(e));
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`/provider: ${model.id} — ${eps.length} active endpoints\n\n${options.join("\n")}\n\ninteractive select needs a TUI; use /provider sort <price|latency|throughput|uptime> to pick automatically`,
			"info",
		);
		return;
	}
	const picked = await ctx.ui.select(
		`Select serving provider for ${model.id} (soft pin with fallback)`,
		options,
	);
	if (!picked) return;
	await applyPin(ctx, model.id, {
		order: [pickedTag(picked)],
		allow_fallbacks: true,
	});
	ctx.ui.notify(
		`/provider: ${model.id} → ${pickedTag(picked)} (soft pin)`,
		"info",
	);
}

function pickedTag(line: string): string {
	return line.split(" · ")[0]!.trim();
}

// ── Command registration ───────────────────────────────────────────────

async function handle(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const tokens = args
		.trim()
		.split(/[\s,]+/)
		.filter(Boolean);
	const sub = tokens[0] as Subcommand;
	const rest = tokens.slice(1);
	switch (sub) {
		case "list":
			await cmdList(ctx, rest[0]);
			return;
		case "status":
			await cmdStatus(ctx);
			return;
		case "order":
			await cmdOrder(ctx, rest, false);
			return;
		case "only":
			await cmdOrder(ctx, rest, true);
			return;
		case "sort":
			await cmdSort(ctx, rest);
			return;
		case "clear":
			await cmdClear(ctx, rest[0], false);
			return;
		case "reset":
			await cmdClear(ctx, undefined, true);
			return;
		case "json":
			await cmdJson(ctx, args.trimStart().slice(4).trimStart());
			return;
		case undefined:
			await cmdInteractive(ctx);
			return;
		default:
			ctx.ui.notify(
				`/provider: unknown subcommand "${sub}" — try ${SUBCOMMANDS.join(", ")}`,
				"warning",
			);
	}
}

function completions(argumentPrefix: string): AutocompleteItem[] | null {
	const tokens = argumentPrefix
		.trim()
		.split(/[\s,]+/)
		.filter(Boolean);
	if (tokens.length <= 1) {
		return SUBCOMMANDS.filter((s) => s.startsWith(tokens[0] ?? "")).map((s) => ({
			value: s,
			label: s,
		}));
	}
	return null;
}

export default async function registerProviderCommand(
	pi: ExtensionAPI,
): Promise<void> {
	const options = {
		description:
			"Select a serving provider for an OpenRouter model (persisted, affects routing). Alias: /or-provider",
		getArgumentCompletions: completions,
		handler: handle,
	};
	pi.registerCommand("provider", options);
	pi.registerCommand("or-provider", options);
}

/**
 * The model directory: public facts about models that a provider's own
 * `/models` endpoint usually leaves out (context and output limits, price,
 * reasoning, image input).
 *
 * Source: https://models.dev/api.json, a maintained public catalogue keyed by
 * provider. It is fetched without credentials at most once a day and distilled
 * to the few fields the harness uses. A provider is matched by the host of its
 * base URL first, so a provider the user named themselves still resolves.
 *
 * Where facts meet, a provider's own live catalogue row and the user's
 * models.json outrank the directory, and the directory outranks a generic
 * default. Facts are taken only from the matched provider's entry: the same
 * model has different limits and prices on different hosts.
 */

export const DIRECTORY_URL = "https://models.dev/api.json";
export const DIRECTORY_TTL_MS: number = 24 * 60 * 60 * 1000;
const MAX_PROVIDERS = 1_000;
const MAX_MODELS_PER_PROVIDER = 2_000;

export interface ModelCost { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface DirectoryFacts {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: ModelCost;
	/** False when the model produces no text (image, audio, video, embeddings). */
	chat?: false;
}
export interface DirectoryProvider { url?: string; models: Record<string, DirectoryFacts> }
export interface ModelDirectory {
	fetchedAt: number;
	providers: Record<string, DirectoryProvider>;
	/** The configured providers a saved copy was cut down to (see scopedDirectory). */
	scope?: string[];
}
/** A configured provider as the directory is asked about it: local id and base URL. */
export type ProviderAddress = readonly [id: string, baseUrl: string | undefined];
const addressKey = ([id, baseUrl]: ProviderAddress): string => `${id} ${baseUrl ?? ""}`;

/** Provider ids that differ between the harness and the directory. */
const DIRECTORY_IDS: Record<string, string> = { together: "togetherai" };

const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const limit = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const price = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const cleanId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function httpUrl(value: unknown): URL | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
	} catch {
		return undefined;
	}
}

function costFrom(input: unknown, output: unknown, cacheRead: unknown, cacheWrite: unknown): ModelCost | undefined {
	const base = price(input), out = price(output);
	if (base === undefined || out === undefined) return undefined;
	// With no listed cache price, cached tokens are billed as ordinary input.
	return { input: base, output: out, cacheRead: price(cacheRead) ?? base, cacheWrite: price(cacheWrite) ?? base };
}

function withLimits(facts: DirectoryFacts, contextWindow: number | undefined, maxTokens: number | undefined): DirectoryFacts {
	if (contextWindow) facts.contextWindow = contextWindow;
	if (maxTokens) facts.maxTokens = contextWindow ? Math.min(maxTokens, contextWindow) : maxTokens;
	return facts;
}

/** One directory model row, reduced to what the harness uses. */
function distillModel(row: unknown): DirectoryFacts | undefined {
	if (!isRecord(row)) return undefined;
	const facts = withLimits({}, limit(row.limit?.context), limit(row.limit?.output));
	if (typeof row.name === "string" && row.name.trim()) facts.name = row.name.trim().slice(0, 120);
	if (typeof row.reasoning === "boolean") facts.reasoning = row.reasoning;
	const inputs = strings(row.modalities?.input), outputs = strings(row.modalities?.output);
	if (inputs.length) facts.input = inputs.includes("image") ? ["text", "image"] : ["text"];
	if (outputs.length && !outputs.includes("text")) facts.chat = false;
	const cost = costFrom(row.cost?.input, row.cost?.output, row.cost?.cache_read, row.cost?.cache_write);
	if (cost) facts.cost = cost;
	return facts;
}

/** Validate and shrink the published directory (about 6 MB) to a few hundred kB. */
export function distillDirectory(raw: unknown, fetchedAt: number): ModelDirectory {
	if (!isRecord(raw)) throw new Error("Model directory must be an object keyed by provider");
	const providers: ModelDirectory["providers"] = Object.create(null);
	for (const [id, entry] of Object.entries(raw).slice(0, MAX_PROVIDERS)) {
		if (!cleanId(id) || !isRecord(entry) || !isRecord(entry.models)) continue;
		const models: DirectoryProvider["models"] = Object.create(null);
		for (const [modelId, row] of Object.entries(entry.models).slice(0, MAX_MODELS_PER_PROVIDER)) {
			const facts = cleanId(modelId) ? distillModel(row) : undefined;
			if (facts) models[modelId] = facts;
		}
		if (!Object.keys(models).length) continue;
		const url = httpUrl(entry.api);
		providers[id] = { ...(url ? { url: url.href } : {}), models };
	}
	if (!Object.keys(providers).length) throw new Error("Model directory has no usable provider");
	return { fetchedAt, providers };
}

/** Facts read back from disk are checked field by field: a damaged file can lose a fact, never plant one. */
function savedFacts(value: Record<string, any>): DirectoryFacts {
	const facts = withLimits({}, limit(value.contextWindow), limit(value.maxTokens));
	if (typeof value.name === "string" && value.name) facts.name = value.name.slice(0, 120);
	if (typeof value.reasoning === "boolean") facts.reasoning = value.reasoning;
	if (Array.isArray(value.input) && value.input.length) facts.input = value.input.includes("image") ? ["text", "image"] : ["text"];
	if (value.chat === false) facts.chat = false;
	const cost = isRecord(value.cost) ? costFrom(value.cost.input, value.cost.output, value.cost.cacheRead, value.cost.cacheWrite) : undefined;
	if (cost) facts.cost = cost;
	return facts;
}

/** A directory read back from disk: same shape checks as the network copy. */
export function parseDirectory(value: unknown): ModelDirectory | undefined {
	if (!isRecord(value) || !isRecord(value.providers) || limit(value.fetchedAt) === undefined) return undefined;
	const providers: ModelDirectory["providers"] = Object.create(null);
	for (const [id, entry] of Object.entries(value.providers)) {
		if (cleanId(id) && isRecord(entry) && isRecord(entry.models)) {
			const models: DirectoryProvider["models"] = Object.create(null);
			for (const [modelId, facts] of Object.entries(entry.models)) if (cleanId(modelId) && isRecord(facts)) models[modelId] = savedFacts(facts);
			providers[id] = { ...(httpUrl(entry.url) ? { url: entry.url } : {}), models };
		}
	}
	const scope = Array.isArray(value.scope) ? { scope: strings(value.scope) } : {};
	return Object.keys(providers).length || scope.scope ? { fetchedAt: value.fetchedAt, providers, ...scope } : undefined;
}

/**
 * The published directory covers every provider there is (about 9,000
 * models); a session needs the dozen it has configured. The saved copy keeps
 * only those and records which addresses it was cut for, so it loads in a few
 * milliseconds and a provider configured later is noticed as not covered.
 */
export function scopedDirectory(directory: ModelDirectory, wanted: readonly ProviderAddress[]): ModelDirectory {
	const providers: ModelDirectory["providers"] = Object.create(null);
	for (const [id, baseUrl] of wanted) {
		const entry = directoryProvider(directory, id, baseUrl);
		const name = entry && Object.keys(directory.providers).find((key) => directory.providers[key] === entry);
		if (name) providers[name] = entry;
	}
	return { fetchedAt: directory.fetchedAt, providers, scope: wanted.map(addressKey).sort() };
}

/** Whether a saved copy was cut with every one of these addresses in view. */
export function directoryCovers(directory: ModelDirectory, wanted: readonly ProviderAddress[]): boolean {
	return !directory.scope || wanted.every((address) => directory.scope!.includes(addressKey(address)));
}

const trimmedPath = (url: URL): string => url.pathname.replace(/\/+$/, "");

/**
 * The directory entry for a configured provider. The base URL decides: an
 * entry on the same host wins whatever the provider is called locally. An
 * entry with no published URL (a vendor SDK provider) is matched by id. An id
 * match on a different host is refused: that is someone's proxy, and its
 * limits and prices are its own.
 */
export function directoryProvider(directory: ModelDirectory | undefined, providerId: string, baseUrl?: string): DirectoryProvider | undefined {
	if (!directory) return undefined;
	let matches = matched.get(directory);
	if (!matches) matched.set(directory, matches = new Map());
	const key = `${providerId}\n${baseUrl ?? ""}`;
	if (!matches.has(key)) matches.set(key, matchProvider(directory, providerId, baseUrl));
	return matches.get(key);
}
/** One match per directory copy and provider: the catalog asks per model. */
const matched = new WeakMap<ModelDirectory, Map<string, DirectoryProvider | undefined>>();
function matchProvider(directory: ModelDirectory, providerId: string, baseUrl?: string): DirectoryProvider | undefined {
	const own = (id: string): DirectoryProvider | undefined => Object.hasOwn(directory.providers, id) ? directory.providers[id] : undefined;
	const named = own(providerId) ?? (Object.hasOwn(DIRECTORY_IDS, providerId) ? own(DIRECTORY_IDS[providerId]) : undefined);
	const base = httpUrl(baseUrl);
	if (!base) return named;
	const sameHost = Object.entries(directory.providers).flatMap(([id, entry]) => {
		const url = httpUrl(entry.url);
		return url && url.host === base.host ? [{ id, entry, path: trimmedPath(url) }] : [];
	});
	if (!sameHost.length) return named && !named.url ? named : undefined;
	const basePath = trimmedPath(base);
	const nested = (path: string) => path === basePath || path.startsWith(`${basePath}/`) || basePath.startsWith(`${path}/`);
	return (sameHost.find((candidate) => candidate.entry === named)
		?? sameHost.filter((candidate) => nested(candidate.path)).sort((a, b) => a.id.localeCompare(b.id))[0]
		?? sameHost.sort((a, b) => a.id.localeCompare(b.id))[0]).entry;
}

/** Directory facts for one model of a matched provider; ids compare without case. */
export function directoryFacts(provider: DirectoryProvider | undefined, modelId: string): DirectoryFacts | undefined {
	if (!provider) return undefined;
	if (Object.hasOwn(provider.models, modelId)) return provider.models[modelId];
	const lower = modelId.toLowerCase();
	const match = Object.keys(provider.models).find((id) => id.toLowerCase() === lower);
	return match ? provider.models[match] : undefined;
}

const NON_CHAT_TYPES = new Set(["embedding", "embeddings", "rerank", "reranker", "image", "moderation", "audio", "transcription", "tts", "video"]);

/**
 * What an OpenAI-compatible `/models` row says about itself. The standard row
 * is an id and nothing else; hosts that add limits use a handful of field
 * names, and only those are read. Anything absent stays absent.
 */
export function catalogRowFacts(row: unknown): DirectoryFacts {
	if (!isRecord(row)) return {};
	const first = (...values: unknown[]) => values.map(limit).find((value) => value !== undefined);
	const facts = withLimits({},
		first(row.context_length, row.context_window, row.max_context_length, row.limits?.max_context_length, row.top_provider?.context_length, row.metadata?.context_length),
		first(row.max_completion_tokens, row.max_output_tokens, row.limits?.max_completion_tokens, row.top_provider?.max_completion_tokens, row.metadata?.max_tokens));
	const name = [row.display_name, row.name].find((value) => typeof value === "string" && value.trim());
	if (name) facts.name = name.trim().slice(0, 120);
	const inputs = [...strings(row.input_modalities), ...strings(row.architecture?.input_modalities)];
	if (inputs.length) facts.input = inputs.includes("image") ? ["text", "image"] : ["text"];
	else if (typeof row.capabilities?.vision === "boolean") facts.input = row.capabilities.vision ? ["text", "image"] : ["text"];
	const parameters = strings(row.supported_parameters);
	if (typeof row.capabilities?.reasoning === "boolean") facts.reasoning = row.capabilities.reasoning;
	else if (parameters.length) facts.reasoning = parameters.includes("reasoning") || parameters.includes("reasoning_effort");
	const outputs = [...strings(row.output_modalities), ...strings(row.architecture?.output_modalities)];
	if (outputs.length && !outputs.includes("text") || typeof row.type === "string" && NON_CHAT_TYPES.has(row.type.toLowerCase())) facts.chat = false;
	// Two published price shapes: per-token strings (OpenRouter style) and per-million numbers under metadata.
	const perToken = (value: unknown) => typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) * 1_000_000 : undefined;
	const cost = costFrom(perToken(row.pricing?.prompt), perToken(row.pricing?.completion), perToken(row.pricing?.input_cache_read), perToken(row.pricing?.input_cache_write))
		?? costFrom(row.metadata?.pricing?.input_tokens, row.metadata?.pricing?.output_tokens, row.metadata?.pricing?.cache_read_tokens, undefined);
	if (cost) facts.cost = cost;
	return facts;
}

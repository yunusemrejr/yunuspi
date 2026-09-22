/**
 * Explicit model/provider preferences layered over the autonomous selector.
 *
 * This module owns ONLY the `~/.pi/settings/llm_preferences.json` document:
 * parsing, validation, alias resolution, role chains, thinking normalization
 * and provider-option translation. It never selects a model by itself and
 * never replaces the autonomous machinery.
 *
 * Resolution hierarchy (implemented by callers in model-fallback.ts,
 * assistance-plan.ts and autonomous-recovery.ts):
 *   1. applicable explicit preference in llm_preferences.json, in order;
 *   2. remaining configured preferences when one is unusable or fails;
 *   3. the existing autonomous selection when the file is missing, malformed,
 *      has no applicable preference, or every configured option fails.
 *
 * State vs policy: this file defines preferences and fallbacks. The running
 * main-session model is state owned by Pi persistence (last-model.ts); this
 * module must never silently become its source of truth. Main-session callers
 * consult the `main_session_fallback` chain only after the persisted
 * selection fails or is unavailable.
 *
 * Partial failure: one bad alias, unavailable provider, unsupported thinking
 * level or invalid model skips that entry only. Callers continue through the
 * chain and then fall back to autonomous selection.
 *
 * No harness imports (leaf module): registry/health/capability validation
 * lives with the existing owners in model-fallback.ts to avoid import cycles.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { THINKING_LEVELS, type ThinkingLevel } from "../../shared/model-info.ts";

export const LLM_PREFERENCES_ENV = "PI_LLM_PREFERENCES_FILE";
export const LLM_PREFERENCES_VERSION = 1;

/** Per-request OpenRouter backend control. Vocabulary matches the existing
 * `/provider` pins (provider-cmd.ts) and the wire path
 * `compat.openRouterRouting`; see providerOptionsToRouting(). */
export interface LlmProviderOptions {
	routing?: string;
	order?: unknown;
	allow_fallbacks?: unknown;
	sort?: unknown;
	only?: unknown;
	ignore?: unknown;
}

export interface LlmModelEntry {
	provider?: string;
	model?: string;
	thinking?: string;
	provider_options?: LlmProviderOptions;
}

export interface LlmPreferencesConfig {
	version: number;
	models: Record<string, LlmModelEntry>;
	preferences: Record<string, { models: Array<string | LlmModelEntry> }>;
	metadata?: Record<string, unknown>;
}

export interface LlmPreferencesLoad {
	ok: boolean;
	config?: LlmPreferencesConfig;
	reason?: string;
	path: string;
	missing?: boolean;
	warnings?: string[];
}

export function llmPreferencesPath(): string {
	const override = process.env[LLM_PREFERENCES_ENV]?.trim();
	if (override) return override;
	return path.join(os.homedir(), ".pi", "settings", "llm_preferences.json");
}

let cache: LlmPreferencesLoad | undefined;
let cacheKey: string | undefined;
let cacheStamp: string | undefined;

function stampOf(filePath: string): string {
	try {
		const stat = fs.statSync(filePath);
		return `${filePath}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
	} catch {
		return `${filePath}:missing`;
	}
}

export function clearLlmPreferencesCache(): void {
	cache = undefined;
	cacheKey = undefined;
	cacheStamp = undefined;
}

/** Load and validate the preference document. Never throws: malformed input
 * reports `{ ok: false, reason }` so callers fall back to autonomous logic. */
export function loadLlmPreferences(): LlmPreferencesLoad {
	const filePath = llmPreferencesPath();
	const stamp = stampOf(filePath);
	if (cache && cacheKey === filePath && cacheStamp === stamp) return cache;
	const miss = (reason: string, missing = false): LlmPreferencesLoad => {
		cacheKey = filePath; cacheStamp = stamp;
		return (cache = { ok: false, reason, path: filePath, ...(missing ? { missing: true } : {}) });
	};
	let raw: unknown;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size > 256 * 1024) return miss("preference file is not a regular file or exceeds 256 KiB");
		raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return miss("preference file not present; autonomous selection applies", true);
		return miss(`preference file unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return miss("preference file must be a JSON object");
	const doc = raw as Record<string, unknown>;
	if (doc.version !== undefined && doc.version !== LLM_PREFERENCES_VERSION)
		return miss(`unsupported llm_preferences version ${JSON.stringify(doc.version)}; expected ${LLM_PREFERENCES_VERSION}`);
	const warnings: string[] = [];
	const models = parseRegistry(doc.models, warnings);
	if (!models) return miss("preferences.models must be an object of alias to {provider, model, thinking?, provider_options?}");
	const preferences = parsePreferences(doc.preferences, warnings);
	if (!preferences) return miss("preferences.preferences must be an object of role to {models:[alias-or-entry]}");
	const metadata = doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata)
		? (doc.metadata as Record<string, unknown>) : undefined;
	cacheKey = filePath; cacheStamp = stamp;
	return (cache = { ok: true, config: { version: LLM_PREFERENCES_VERSION, models, preferences, ...(metadata ? { metadata } : {}) }, path: filePath, ...(warnings.length ? { warnings } : {}) });
}

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function cleanText(value: unknown, max = 512): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
	return text;
}

function parseEntry(value: unknown): LlmModelEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const model = cleanText(raw.model);
	const provider = cleanText(raw.provider, 128);
	if (raw.provider !== undefined && !provider) return undefined;
	if (!model && !provider) return undefined;
	const thinking = cleanText(raw.thinking, 32);
	const options = raw.provider_options && typeof raw.provider_options === "object" && !Array.isArray(raw.provider_options)
		? (raw.provider_options as LlmProviderOptions) : undefined;
	return { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(options ? { provider_options: options } : {}) };
}

function parseRegistry(value: unknown, warnings: string[]): Record<string, LlmModelEntry> | undefined {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, LlmModelEntry> = Object.create(null);
	for (const [alias, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!ALIAS_RE.test(alias)) { warnings.push("ignored an invalid model alias"); continue; }
		const parsed = parseEntry(entry);
		if (!parsed || !parsed.model) { warnings.push(`ignored invalid model alias ${JSON.stringify(alias)}`); continue; }
		out[alias] = parsed;
	}
	return out;
}

function parsePreferences(value: unknown, warnings: string[]): LlmPreferencesConfig["preferences"] | undefined {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: LlmPreferencesConfig["preferences"] = Object.create(null);
	for (const [role, spec] of Object.entries(value as Record<string, unknown>)) {
		const canonical = normalizePreferenceRole(role);
		if (!canonical) { warnings.push("ignored an invalid preference role"); continue; }
		const list = Array.isArray(spec) ? spec : (spec && typeof spec === "object" && !Array.isArray(spec)
			? (spec as Record<string, unknown>).models : undefined);
		if (!Array.isArray(list) || list.length > 64) { warnings.push(`ignored invalid preference list for ${canonical}`); continue; }
		const models: Array<string | LlmModelEntry> = [];
		for (const item of list) {
			if (typeof item === "string") {
				if (!ALIAS_RE.test(item.trim())) { warnings.push(`ignored invalid alias in ${canonical}`); continue; }
				models.push(item.trim());
				continue;
			}
			const parsed = parseEntry(item);
			if (!parsed || !parsed.model) { warnings.push(`ignored invalid model entry in ${canonical}`); continue; }
			models.push(parsed);
		}
		out[canonical] = { models };
	}
	return out;
}

/** Canonical role names. Unknown roles pass through cleaned so future
 * mechanisms can use this file without a code change. */
export function normalizePreferenceRole(role: unknown): string | undefined {
	if (typeof role !== "string") return undefined;
	const key = role.trim().toLowerCase().replace(/[-_\s]+/g, "");
	if (!key || key.length > 64 || /[^a-z0-9]/.test(key)) return undefined;
	switch (key) {
		case "mainsessionfallback":
		case "mainfallback":
		case "main":
			return "main_session_fallback";
		case "subagents":
		case "subagent":
			return "subagents";
		case "council":
		case "councils":
			return "council";
		case "swarm":
		case "swarms":
			return "swarm";
		case "fusion":
			return "fusion";
		case "qualityreview":
		case "qualityreviews":
			return "quality_review";
		case "projectreview":
		case "projectreviews":
			return "project_review";
		case "errorreview":
		case "errorreviews":
		case "bugreview":
		case "bugreviews":
			return "error_review";
		default:
			return key;
	}
}

/** Ordered entries for a role, aliases resolved. Unknown aliases are skipped
 * here (partial failure); registry/unusability checks happen at resolve time
 * in model-fallback.ts where the live registry is available. */
export function preferenceEntriesFor(role: string, config: LlmPreferencesConfig): LlmModelEntry[] {
	const canonical = normalizePreferenceRole(role) ?? role;
	const spec = config.preferences[canonical];
	if (!spec) return [];
	const out: LlmModelEntry[] = [];
	for (const item of spec.models) {
		if (typeof item === "string") {
			const entry = config.models[item];
			if (entry) out.push(entry);
			continue;
		}
		out.push(item);
	}
	return out;
}

export interface NormalizedThinking {
	/** Concrete harness level, or undefined when dynamic logic should decide. */
	thinking?: ThinkingLevel;
	dynamic: boolean;
	note?: string;
}

/** Harness thinking values plus `auto` (dynamic) and `none` (off). Omitted,
 * `auto` or unrecognized values keep the existing dynamic-thinking logic. */
export function normalizeThinking(value: unknown): NormalizedThinking {
	if (value === undefined || value === null || value === "") return { dynamic: true };
	if (typeof value !== "string") return { dynamic: true, note: "thinking is not a string; dynamic logic applies" };
	const key = value.trim().toLowerCase();
	if (!key || key === "auto" || key === "dynamic") return { dynamic: true };
	if (key === "none") return { thinking: "off", dynamic: false };
	if ((THINKING_LEVELS as readonly string[]).includes(key)) return { thinking: key as ThinkingLevel, dynamic: false };
	return { dynamic: true, note: `unknown thinking level ${JSON.stringify(value)}; dynamic logic applies` };
}

/**
 * Translate `provider_options` to the existing OpenRouter `compat`
 * vocabulary. `auto` (or omitted) preserves normal OpenRouter selection by
 * returning undefined. `pinned` becomes a hard pin, `custom` an ordered
 * preference — the same shapes `/provider order|only|json` persists.
 * Only meaningful for OpenRouter routes; other providers ignore it.
 */
export function providerOptionsToRouting(
	options: LlmProviderOptions | undefined,
	provider: string,
): { routing?: Record<string, unknown>; note?: string } {
	if (!options) return {};
	if (provider !== "openrouter") return { note: "provider_options applies to OpenRouter routes only" };
	const routing = typeof options.routing === "string" ? options.routing.trim().toLowerCase() : "auto";
	const slugs = (value: unknown): string[] | undefined => {
		if (value === undefined) return undefined;
		if (!Array.isArray(value)) return undefined;
		const out = value.filter((s): s is string => typeof s === "string" && !!s.trim() && s.length <= 128 && !/[\u0000-\u001f\u007f]/.test(s)).map(s => s.trim());
		return out.length ? out : undefined;
	};
	if (routing === "auto" || routing === "") return {};
	if (routing === "pinned") {
		const order = slugs(options.order);
		if (!order) return { note: "pinned routing needs a non-empty order list" };
		return { routing: { only: order, order, allow_fallbacks: false } };
	}
	if (routing === "custom") {
		const order = slugs(options.order);
		const allow = typeof options.allow_fallbacks === "boolean" ? options.allow_fallbacks : true;
		const out: Record<string, unknown> = { ...(order ? { order } : {}), allow_fallbacks: allow };
		const only = slugs(options.only);
		if (only) out.only = only;
		const ignore = slugs(options.ignore);
		if (ignore) out.ignore = ignore;
		if (typeof options.sort === "string" && options.sort.trim() && options.sort.length <= 32) out.sort = options.sort.trim();
		return { routing: out };
	}
	return { note: `unknown provider_options.routing ${JSON.stringify(options.routing)}; normal routing applies` };
}

/** Conservative role inference for ad-hoc subagent tasks: only explicit
 * review/council phrasing selects a specialized role; everything else uses
 * the `subagents` chain. Automatic dispatchers pass their role explicitly. */
export function inferPreferenceRole(task = ""): string {
	const text = task.slice(0, 32768).replace(/```[\s\S]*?```/g, " ").replace(/^\s*>.*$/gm, " ");
	if (/\bproject[ -]?reviews?\b/i.test(text)) return "project_review";
	if (/\b(error[ -]?reviews?|bug[ -]?reviews?|root[ -]?cause[ -]?reviews?)\b/i.test(text)) return "error_review";
	if (/\bquality[ -]?reviews?\b/i.test(text)) return "quality_review";
	if (/\bcouncils?\b/i.test(text)) return "council";
	return "subagents";
}

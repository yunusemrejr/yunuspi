/**
 * Normalized model identity.
 *
 * Provider, model, variant, free-tag, thinking level, and backend routing are
 * separate fields. A `:high` suffix is never left embedded in the model id
 * while a thinking field simultaneously claims "unknown" — and a `:free`
 * suffix is a routing tag, not part of the model name.
 *
 * Dependency-free and pure.
 */

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "unknown";

export interface NormalizedModelIdentity {
	provider: string;
	model: string;
	/** Variant qualifier after the model name (e.g. ":nitro" excluded below). */
	variant?: string;
	/** True when routed via a free tier/tag. */
	free: boolean;
	thinking: ThinkingLevel;
	/** Backend/endpoint routing qualifier when present. */
	backend?: string;
	/** Canonical full id without thinking suffix: provider/model[:variant]. */
	canonicalId: string;
}

const THINKING_SUFFIX = /:(off|low|medium|high)$/i;
const FREE_SUFFIX = /:free$/i;
/** Provider routing qualifiers that are not part of the model name. */
const BACKEND_QUALIFIERS = new Set(["nitro", "floor", "turbo"]);

function thinkingFromSuffix(suffix: string | undefined): ThinkingLevel {
	if (!suffix) return "unknown";
	const level = suffix.toLowerCase();
	if (level === "off" || level === "low" || level === "medium" || level === "high") return level;
	return "unknown";
}

/**
 * Split a route string into normalized identity. Accepts `provider/model`,
 * `provider/model:thinking`, `provider/model:free`, `provider/model:free:high`,
 * backend qualifiers, and bare model ids (provider "unknown").
 */
export function normalizeModelIdentity(route: string, backend?: string): NormalizedModelIdentity {
	const text = (route ?? "").trim();
	const withoutThinking = text.match(THINKING_SUFFIX);
	const thinking = thinkingFromSuffix(withoutThinking?.[1]);
	let rest = withoutThinking ? text.slice(0, withoutThinking.index) : text;
	const free = FREE_SUFFIX.test(rest);
	if (free) rest = rest.replace(FREE_SUFFIX, "");
	const slash = rest.indexOf("/");
	const provider = slash > 0 ? rest.slice(0, slash) : "unknown";
	let model = slash > 0 ? rest.slice(slash + 1) : rest;
	let variant: string | undefined;
	const colon = model.lastIndexOf(":");
	if (colon > 0) {
		const qualifier = model.slice(colon + 1);
		if (BACKEND_QUALIFIERS.has(qualifier.toLowerCase())) {
			backend = backend ?? qualifier.toLowerCase();
			model = model.slice(0, colon);
		} else if (qualifier) {
			variant = qualifier;
		}
	}
	const canonicalId = variant ? `${provider}/${model}:${variant}` : `${provider}/${model}`;
	return {
		provider,
		model,
		...(variant ? { variant } : {}),
		free,
		thinking,
		...(backend ? { backend } : {}),
		canonicalId,
	};
}

/** Render identity without loss: canonical id plus explicit tags. */
export function formatModelIdentity(identity: NormalizedModelIdentity): string {
	const tags: string[] = [];
	if (identity.free) tags.push("free");
	if (identity.thinking !== "unknown") tags.push(identity.thinking);
	if (identity.backend) tags.push(identity.backend);
	return tags.length ? `${identity.canonicalId} [${tags.join(", ")}]` : identity.canonicalId;
}

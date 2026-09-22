/** A canonical registry route with optional per-request provider routing.
 * `route` is always the real `provider/model` identifier, never an encoded ID. */
export interface ModelRouteCandidate {
	route: string;
	providerRouting?: Record<string, unknown>;
}

export const SUBAGENT_MODEL_ROUTE_CANDIDATE_ENV = "PI_SUBAGENT_MODEL_ROUTE_CANDIDATE";
// A strict preference can carry three lists of 32 provider slugs of 128
// characters. Transport must preserve every valid constraint from that schema.
export const MODEL_ROUTE_MAX_LENGTH = 768;
export const MODEL_ROUTE_ROUTING_MAX_LENGTH = 16 * 1024;
const MAX_CANDIDATE_ENV_BYTES = 20 * 1024;
const KNOWN_THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function routeOf(candidate: string | ModelRouteCandidate | undefined): string | undefined {
	return typeof candidate === "string" ? candidate : candidate?.route;
}

export function stableProviderRouting(value: Record<string, unknown> | undefined): string {
	const stable = (item: unknown): string => {
		if (Array.isArray(item)) return `[${item.map(stable).join(",")}]`;
		if (item && typeof item === "object") return `{${Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
		return JSON.stringify(item) ?? "null";
	};
	return stable(value ?? null);
}

export function modelRouteCandidateKey(candidate: ModelRouteCandidate): string {
	const route = candidate.route.trim();
	return `${route.toLowerCase()}\u0000${stableProviderRouting(candidate.providerRouting)}`;
}

export function normalizeModelRouteCandidate(candidate: string | ModelRouteCandidate): ModelRouteCandidate {
	return typeof candidate === "string" ? { route: candidate } : candidate;
}

/** Resolve retry index and its metadata in one place so foreground/background
 * launchers cannot pair a fallback model with the preceding attempt's pin. */
export function modelRouteCandidateAt(
	candidates: readonly ModelRouteCandidate[] | undefined,
	attemptIndex: number,
): ModelRouteCandidate | undefined {
	return Number.isSafeInteger(attemptIndex) && attemptIndex >= 0 ? candidates?.[attemptIndex] : undefined;
}

/** Encode only a registry route and bounded routing metadata for one child
 * process attempt. It carries no credentials and never selects a filesystem
 * path. */
export function encodeSubagentModelRouteCandidate(candidate: string | ModelRouteCandidate | undefined): string | undefined {
	if (!candidate) return undefined;
	const value = normalizeModelRouteCandidate(candidate);
	const match = /^(.*):([^/:]+)$/.exec(value.route);
	const route = match && KNOWN_THINKING_SUFFIXES.has(match[2]!.toLowerCase()) ? match[1]! : value.route;
	if (!route || route.length > MODEL_ROUTE_MAX_LENGTH || !route.includes("/") || /[\u0000-\u001f\u007f]/.test(route)) return undefined;
	const payload = {
		route,
		...(value.providerRouting ? { providerRouting: value.providerRouting } : {}),
	};
	try {
		const encoded = JSON.stringify(payload);
		return encoded.length <= MAX_CANDIDATE_ENV_BYTES && decodeSubagentModelRouteCandidate(encoded) ? encoded : undefined;
	} catch {
		return undefined;
	}
}

export function decodeSubagentModelRouteCandidate(value: string | undefined): ModelRouteCandidate | undefined {
	if (!value || value.length > MAX_CANDIDATE_ENV_BYTES) return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const candidate = parsed as Record<string, unknown>;
		if (typeof candidate.route !== "string" || candidate.route.length > MODEL_ROUTE_MAX_LENGTH || !candidate.route.includes("/") || /[\u0000-\u001f\u007f]/.test(candidate.route)) return undefined;
		if (candidate.providerRouting === undefined) return { route: candidate.route };
		if (!candidate.providerRouting || typeof candidate.providerRouting !== "object" || Array.isArray(candidate.providerRouting)) return undefined;
		const encodedRouting = JSON.stringify(candidate.providerRouting);
		if (encodedRouting.length > MODEL_ROUTE_ROUTING_MAX_LENGTH) return undefined;
		return { route: candidate.route, providerRouting: JSON.parse(encodedRouting) as Record<string, unknown> };
	} catch {
		return undefined;
	}
}

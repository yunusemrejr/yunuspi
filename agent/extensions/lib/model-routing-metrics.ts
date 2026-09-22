import { sessionObservability } from './session-observability.ts';
export type ModelRoutingLatencyKind = "configLoad" | "configSave" | "search";

interface LatencySeries {
	count: number;
	samples: number[];
}

interface RoutingMetricsState {
	latency: Record<ModelRoutingLatencyKind, LatencySeries>;
	attempts: number;
	fallbacks: number;
	lastFallback?: { from?: string; to: string; source: string; provider?: string; upstream?: string; at: number };
}

const GLOBAL_KEY = Symbol.for("yunus-pi.model-routing-metrics.v1");
const SAMPLE_LIMIT = 64;

function metricsState(): RoutingMetricsState {
	const root = sessionObservability() as any;
	if (!root[GLOBAL_KEY]) root[GLOBAL_KEY] = {
		latency: {
			configLoad: { count: 0, samples: [] },
			configSave: { count: 0, samples: [] },
			search: { count: 0, samples: [] },
		},
		attempts: 0,
		fallbacks: 0,
	};
	return root[GLOBAL_KEY]!;
}

function shortText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 192);
	return text || undefined;
}

/** Provider identity of a canonical `provider/model` route. */
function providerOf(route: unknown): string | undefined {
	const text = shortText(route);
	if (!text || !text.includes("/")) return undefined;
	return shortText(text.slice(0, text.indexOf("/")));
}

/** Bounded upstream-backend summary from a route's provider routing: the
 * pinned/preferred OpenRouter endpoint slugs, never task text. */
function upstreamOf(routing: unknown): string | undefined {
	if (!routing || typeof routing !== "object" || Array.isArray(routing)) return undefined;
	const record = routing as Record<string, unknown>;
	const slugs: string[] = [];
	for (const key of ["only", "order"]) {
		const value = record[key];
		if (!Array.isArray(value)) continue;
		for (const item of value.slice(0, 3)) {
			const slug = shortText(item);
			if (slug) slugs.push(slug);
		}
	}
	if (!slugs.length) return undefined;
	return shortText([...new Set(slugs)].join(", "));
}

export function recordModelRoutingLatency(kind: ModelRoutingLatencyKind, durationMs: number): void {
	if (!Number.isFinite(durationMs) || durationMs < 0) return;
	const series = metricsState().latency[kind];
	series.count++;
	series.samples.push(Math.min(durationMs, 60_000));
	if (series.samples.length > SAMPLE_LIMIT) series.samples.shift();
}

export function recordModelRoutingAttempt(input: {
	route?: string;
	fromRoute?: string;
	source: string;
	fallback: boolean;
	providerRouting?: Record<string, unknown>;
}): void {
	const state = metricsState();
	state.attempts++;
	if (!input.fallback) return;
	state.fallbacks++;
	const provider = providerOf(input.route);
	const upstream = upstreamOf(input.providerRouting);
	state.lastFallback = {
		...(shortText(input.fromRoute) ? { from: shortText(input.fromRoute) } : {}),
		to: shortText(input.route) ?? "unknown route",
		source: shortText(input.source) ?? "unknown",
		...(provider ? { provider } : {}),
		...(upstream ? { upstream } : {}),
		at: Date.now(),
	};
}

function summarize(series: LatencySeries) {
	const samples = [...series.samples].sort((a, b) => a - b);
	const meanMs = samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : undefined;
	const p95Ms = samples.length ? samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] : undefined;
	return {
		count: series.count,
		...(samples.length ? { lastMs: series.samples.at(-1), meanMs, p95Ms, sampleCount: samples.length } : {}),
	};
}

/** Bounded, process-local instrumentation; no task text or credentials are recorded. */
export function getModelRoutingMetrics() {
	const state = metricsState();
	return {
		latency: {
			configLoad: summarize(state.latency.configLoad),
			configSave: summarize(state.latency.configSave),
			search: summarize(state.latency.search),
		},
		routes: {
			attempts: state.attempts,
			fallbacks: state.fallbacks,
			fallbackPercent: state.attempts ? Math.round(state.fallbacks / state.attempts * 10_000) / 100 : 0,
			...(state.lastFallback ? { lastFallback: { ...state.lastFallback } } : {}),
		},
	};
}

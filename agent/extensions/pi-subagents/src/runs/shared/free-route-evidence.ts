/**
 * Free-route evidence — the canonical substrate for zero-cost assistance routing.
 *
 * One interpretation of "free" for every consumer (autonomous recovery group,
 * affordable-model selection, the automatic-free-assistant dispatch gate):
 * expected monetary inference cost of the SELECTED provider route is zero,
 * proven by the provider's own authoritative pricing metadata (fetched live,
 * never guessed from names or Pi's zero-default placeholders).
 *
 * Evidence file (free-route-evidence.json), version 2, one section per provider:
 *   { version: 2, providers: { openrouter: { source, fetchedAt, rows }, orcarouter: {...} } }
 * Each row: { provider, id, pricing, capabilities? }. v1 files (openrouter-only,
 * top-level rows) remain readable; writes are always v2.
 *
 * Proof semantics (freshness ladder):
 *   fresh         fetchedAt within FREE_EVIDENCE_TTL_MS (1h) — current catalog knowledge
 *   stale-bounded within the per-provider stale-while-revalidate bound — still proven,
 *                 because dispatch remains billing-safe (see below); confidence degraded
 *   expired       beyond the bound — fail closed, never resurrected as healthy
 * A transient 429/network failure never invalidates price evidence; the last
 * known-good section survives failed refreshes (publish happens only on a
 * successful authoritative fetch). Bounded windows only.
 *
 * Billing safety per provider:
 *   openrouter  dispatch injects provider.max_price = 0 on every dimension
 *               (capFreeRequest). OpenRouter enforces this server-side, so even
 *               stale price evidence cannot bill: a repriced route 402s instead.
 *               Stale bound is therefore long (7d).
 *   orcarouter  one-api-style gateway with no client-side price cap; free status
 *               rests entirely on its pricing catalog (is_free_tier + zero
 *               ratios), so the stale bound is short (24h ≈ 4 catalog refreshes).
 */

import { readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../shared/utils.ts";

export const FREE_CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const FREE_BASE_URL = "https://openrouter.ai/api/v1";
export const ORCA_BASE_URL = "https://api.orcarouter.ai/v1";
export const ORCA_LIVE_MODELS_URL = "https://api.orcarouter.ai/v1/models";
export const ORCA_PRICING_URL = "https://www.orcarouter.ai/api/pricing";
/** Fresh window: evidence counts as current catalog knowledge. */
export const FREE_EVIDENCE_TTL_MS = 60 * 60 * 1000;
/** Stale-while-revalidate bounds per provider (see module doc for the asymmetry). */
export const FREE_EVIDENCE_STALE_OK_MS = 7 * 24 * 60 * 60 * 1000;
export const ORCA_EVIDENCE_STALE_OK_MS = 24 * 60 * 60 * 1000;

/** Only these sources may publish evidence for their provider. */
const PROVIDER_SOURCES: Record<string, string> = {
	openrouter: FREE_CATALOG_URL,
	orcarouter: ORCA_PRICING_URL,
};
const STALE_OK_MS: Record<string, number> = {
	openrouter: FREE_EVIDENCE_STALE_OK_MS,
	orcarouter: ORCA_EVIDENCE_STALE_OK_MS,
};

export interface FreeRouteCapabilities {
	/** Provider catalog addition time, Unix milliseconds. NOT a model release date. */
	catalogAddedAt?: number;
	/** Input context window in tokens, when the catalog reports one. */
	contextWindow?: number;
	/** Maximum output tokens, when the catalog reports one. */
	maxTokens?: number;
	/** Input modalities from the catalog, e.g. ["text","image"]. */
	inputModalities?: string[];
	/** tools parameter advertised by the catalog. */
	toolCalling?: boolean;
	/** response_format/structured_outputs advertised by the catalog. */
	structuredOutput?: boolean;
	/** reasoning parameter advertised by the catalog. */
	reasoning?: boolean;
}

export interface FreeRouteRow {
	provider: string;
	id: string;
	pricing: Record<string, unknown>;
	capabilities?: FreeRouteCapabilities;
}

export interface ProviderEvidence {
	source: string;
	fetchedAt: number;
	rows: FreeRouteRow[];
}

/** v2 file shape; v1 files (openrouter rows at the top level) normalize on read. */
export interface FreeEvidence {
	version: 2;
	source: string;
	fetchedAt: number;
	/** Legacy mirror of the openrouter section (also kept in v2 files). */
	rows: FreeRouteRow[];
	providers: Record<string, ProviderEvidence>;
}

type Route = { provider: string; id: string; api?: string; baseUrl?: string; cost?: { tiers?: unknown[] } };

export type FreeProof = "fresh" | "stale-bounded" | "none";

export interface FreeRouteVerdict {
	proven: boolean;
	proof: FreeProof;
	/** Machine-readable reason when not proven (and for proven-stale degradation). */
	reason?: string;
	capabilities?: FreeRouteCapabilities;
	evidenceAgeMs?: number;
}

const evidencePath = () => join(getAgentDir(), "free-route-evidence.json");

/** Zero as number, zero as string, or a structure whose every leaf is zero. */
function zero(v: unknown): boolean {
	if (typeof v === "number") return v === 0;
	if (typeof v === "string") return /^0+(?:\.0+)?$/.test(v);
	if (Array.isArray(v)) return v.every(zero);
	if (v && typeof v === "object") return Object.values(v).every(zero);
	return false;
}

/**
 * OpenRouter free-proof: the two core metered inference charges must be
 * explicitly present and zero, and every other declared charge must be zero.
 * Verified live (2026-09-07): OpenRouter free rows ship exactly
 * {prompt:"0",completion:"0"} — request/image keys are ABSENT, which means
 * "no such charge", not "unknown nonzero". Missing prompt/completion still
 * fails closed; any present non-zero fee (request, image, web_search, …)
 * fails closed. Nested zero-priced structures (e.g. all-zero overrides
 * tiers) pass; any non-zero leaf rejects the route.
 */
export function zeroPricing(p: Record<string, unknown>): boolean {
	if (!["prompt", "completion"].every((k) => Object.hasOwn(p, k) && zero(p[k]))) return false;
	return Object.values(p).every(zero);
}

/** OrcaRouter rows carry normalized per-million rates; free means every rate is an explicit zero. */
function orcaZeroRates(p: Record<string, unknown>): boolean {
	return ["input", "output", "cacheRead", "cacheWrite"].every((k) => Object.hasOwn(p, k) && zero(p[k])) && Object.values(p).every(zero);
}

/** Shape check only: the owning provider is stamped by the publisher/reader, never trusted from the row. */
function validRow(row: unknown): row is Omit<FreeRouteRow, "provider"> & { provider?: string } {
	const r = row as FreeRouteRow;
	return (
		!!r &&
		typeof r === "object" &&
		typeof r.id === "string" &&
		r.id.trim().length > 0 &&
		!!r.pricing &&
		typeof r.pricing === "object" &&
		!Array.isArray(r.pricing)
	);
}

let evidenceCache: {key:string; value:FreeEvidence} | undefined;
/** Accept v1 (openrouter-only top-level rows) and v2 files; anything else is unreadable. */
export function readFreeEvidence(): FreeEvidence | undefined {
	try {
		const file = evidencePath();
		const info = statSync(file);
		if (!info.isFile() || info.size > 4 * 1024 * 1024) { evidenceCache=undefined; return undefined; }
		const key = `${file}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
		if (evidenceCache?.key === key) return evidenceCache.value;
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const sections: Record<string, ProviderEvidence> = {};
		if (parsed.version === 2 && parsed.providers && typeof parsed.providers === "object") {
			for (const [provider, section] of Object.entries(parsed.providers as Record<string, unknown>)) {
				const s = section as Partial<ProviderEvidence> | undefined;
				if (!s || typeof s !== "object") continue;
				if (s.source !== PROVIDER_SOURCES[provider]) continue;
				const fetchedAt = (s as { fetchedAt?: unknown }).fetchedAt;
				if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) continue;
				const rows = Array.isArray(s.rows)
					? (s.rows as unknown[]).filter(validRow).map((r) => ({ ...r, provider }))
					: [];
				sections[provider] = { source: s.source, fetchedAt, rows };
			}
		} else if (parsed.version === 1 && parsed.source === FREE_CATALOG_URL) {
			const fetchedAt = parsed.fetchedAt;
			if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) return undefined;
			const rows = Array.isArray(parsed.rows) ? (parsed.rows as unknown[]).filter(validRow).map((r) => ({ ...r, provider: "openrouter" })) : [];
			sections.openrouter = { source: FREE_CATALOG_URL, fetchedAt, rows };
		}
		if (!Object.keys(sections).length) return undefined;
		const orca = sections.openrouter ?? { source: FREE_CATALOG_URL, fetchedAt: 0, rows: [] };
		const value: FreeEvidence = { version: 2, source: orca.source, fetchedAt: orca.fetchedAt, rows: orca.rows, providers: sections };
		// One parsed immutable snapshot per file revision; ranking hundreds of
		// routes must not repeatedly parse the same catalog or mutate its facts.
		const pending:object[]=[value];
		while(pending.length){const node=pending.pop()!;if(Object.isFrozen(node))continue;Object.freeze(node);for(const item of Object.values(node))if(item && typeof item === "object")pending.push(item);}
		evidenceCache={key,value};
		return value;
	} catch {
		return undefined;
	}
}

function mergeWrite(section: ProviderEvidence, provider: string, now: number): void {
	// Sync read-modify-write: atomic per process (tmp+rename); a cross-process
	// race can at worst revert one provider's section to its previous published
	// state — still-valid evidence, bounded staleness — never a corrupt file.
	let providers: Record<string, ProviderEvidence> = {};
	try {
		const prior = readFreeEvidence();
		if (prior?.providers) providers = { ...prior.providers };
	} catch {
		/* no prior evidence */
	}
	providers[provider] = section;
	const openrouter = providers.openrouter ?? { source: FREE_CATALOG_URL, fetchedAt: 0, rows: [] };
	const merged: FreeEvidence = {
		version: 2,
		source: openrouter.source,
		fetchedAt: openrouter.fetchedAt,
		rows: openrouter.rows,
		providers,
	};
	const tmp = `${evidencePath()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
	renameSync(tmp, evidencePath());
}

/** Only called after a successful, non-redirecting official live catalog fetch. Never from merged/store caches. */
export function publishFreeEvidence(rows: unknown[], source: string, now = Date.now()): void {
	publishProviderFreeEvidence("openrouter", rows, source, now);
}

/** Publish one provider's section from its allowlisted authoritative source. */
export function publishProviderFreeEvidence(provider: string, rows: unknown[], source: string, now = Date.now()): void {
	if (PROVIDER_SOURCES[provider] === undefined || source !== PROVIDER_SOURCES[provider]) throw new Error("Untrusted free pricing source");
	const clean = (Array.isArray(rows) ? rows : []).filter(validRow).map((r) => ({
		provider,
		id: r.id,
		pricing: r.pricing,
		...(r.capabilities ? { capabilities: r.capabilities } : {}),
	}));
	mergeWrite({ source, fetchedAt: now, rows: clean }, provider, now);
}

const routeIndexes = new WeakMap<ProviderEvidence, Map<string, FreeRouteRow[]>>();
function rowsForRoute(section:ProviderEvidence, id:string):FreeRouteRow[] {
	// Only our immutable file snapshots may be indexed; caller-supplied
	// mutable test/inspection evidence is evaluated as supplied each time.
	if(!Object.isFrozen(section))return section.rows.filter(row=>row.id===id);
	let index=routeIndexes.get(section);
	if(!index){index=new Map();for(const row of section.rows){const prior=index.get(row.id);if(prior)prior.push(row);else index.set(row.id,[row]);}routeIndexes.set(section,index);}
	return index.get(id) ?? [];
}

/** Proof for one candidate route against current evidence. */
export function proveFreeRoute(
	model: Route | undefined,
	evidence: FreeEvidence | null | undefined = readFreeEvidence(),
	now = Date.now(),
): FreeRouteVerdict {
	if (!model || model.api !== "openai-completions") return { proven: false, proof: "none", reason: "wire-not-openai-completions" };
	let providerEvidence: ProviderEvidence | undefined;
	if (model.provider === "openrouter") {
		if (model.baseUrl?.replace(/\/$/, "") !== FREE_BASE_URL) return { proven: false, proof: "none", reason: "wire-not-official-openrouter-endpoint" };
		if (model.cost?.tiers?.length) return { proven: false, proof: "none", reason: "tiered-pricing-not-flat-free" };
		providerEvidence = evidence?.providers?.openrouter;
	} else if (model.provider === "orcarouter") {
		if (model.baseUrl?.replace(/\/$/, "") !== ORCA_BASE_URL) return { proven: false, proof: "none", reason: "wire-not-official-orcarouter-endpoint" };
		providerEvidence = evidence?.providers?.orcarouter;
	} else {
		return { proven: false, proof: "none", reason: "provider-not-free-assisted" };
	}
	if (!providerEvidence) return { proven: false, proof: "none", reason: `no-evidence-for-${model.provider}` };
	const age = now - providerEvidence.fetchedAt;
	if (!Number.isFinite(providerEvidence.fetchedAt) || providerEvidence.fetchedAt > now) return { proven: false, proof: "none", reason: "evidence-timestamp-invalid" };
	const staleOk = STALE_OK_MS[model.provider] ?? 0;
	if (age >= staleOk) return { proven: false, proof: "none", reason: "evidence-expired", evidenceAgeMs: age };
	const matches = rowsForRoute(providerEvidence, model.id);
	if (matches.length === 0) return { proven: false, proof: "none", reason: "route-not-free-in-catalog", evidenceAgeMs: age };
	if (matches.length !== 1) return { proven: false, proof: "none", reason: "ambiguous-route-in-catalog", evidenceAgeMs: age };
	const row = matches[0]!;
	const zeroOk = model.provider === "orcarouter" ? orcaZeroRates(row.pricing) : zeroPricing(row.pricing);
	if (!zeroOk) return { proven: false, proof: "none", reason: "pricing-not-zero", evidenceAgeMs: age };
	return {
		proven: true,
		proof: age < FREE_EVIDENCE_TTL_MS ? "fresh" : "stale-bounded",
		...(age >= FREE_EVIDENCE_TTL_MS ? { reason: "evidence-stale-but-bounded" } : {}),
		...(row.capabilities ? { capabilities: row.capabilities } : {}),
		evidenceAgeMs: age,
	};
}

export function isProvenFreeRoute(model: Route | undefined, evidence: FreeEvidence | null | undefined = readFreeEvidence(), now = Date.now()): boolean {
	return proveFreeRoute(model, evidence ?? null, now).proven;
}

/** Capability facts share the existing catalog evidence, including paid rows.
 * Unlike billing-safe stale free evidence, automatic model replacement requires
 * fresh facts, an exact unambiguous route, and the official wire origin. */
export function catalogRouteCapabilities(model: Route, evidence: FreeEvidence | null | undefined = readFreeEvidence(), now = Date.now()): FreeRouteCapabilities | undefined {
	const baseUrl = model.provider === "openrouter" ? FREE_BASE_URL : model.provider === "orcarouter" ? ORCA_BASE_URL : undefined;
	if (!baseUrl || model.api !== "openai-completions" || model.baseUrl?.replace(/\/$/, "") !== baseUrl) return undefined;
	const section = evidence?.providers?.[model.provider];
	if (!section || section.source !== PROVIDER_SOURCES[model.provider] || !Number.isFinite(section.fetchedAt) || section.fetchedAt > now || now - section.fetchedAt >= FREE_EVIDENCE_TTL_MS) return undefined;
	const rows = rowsForRoute(section, model.id);
	return rows.length === 1 ? rows[0]!.capabilities : undefined;
}

/** Consumer capability requirements: REQUIRED = hard filter, everything else ranks. */
export interface FreeRouteRequirements {
	/** Half-open UTC catalog addition interval; absent dates never satisfy it. */
	catalogAddedAfter?: number;
	catalogAddedBefore?: number;
	minContextWindow?: number;
	minOutputTokens?: number;
	toolCalling?: boolean;
	structuredOutput?: boolean;
	reasoning?: boolean;
	imageInput?: boolean;
}

export interface FreeRouteCandidate {
	route: string;
	provider: string;
	id: string;
	free: boolean;
	proof: FreeProof;
	evidenceAgeMs?: number;
	capabilities?: FreeRouteCapabilities;
	eligible: boolean;
	/** Rejection reasons (machine-readable); empty when eligible. */
	reasons: string[];
	/** Lower is better; assigned to eligible candidates in rank order. */
	rank?: number;
}

export type FreeAssistanceState =
	| "AVAILABLE"
	| "DEGRADED_ONE_ROUTE"
	| "NO_COMPATIBLE_FREE_ROUTE"
	| "DISCOVERY_STALE"
	| "AUTH_REQUIRED"
	| "RATE_LIMITED";

export interface FreeRouteReport {
	state: FreeAssistanceState;
	/** Human-readable failure category when state is not AVAILABLE/DEGRADED. */
	category?: string;
	candidates: FreeRouteCandidate[];
}

/**
 * Fit reasons for one proven-free candidate. Registry facts (contextWindow /
 * maxTokens) outrank the catalog snapshot; capability flags come from the
 * evidence row. A requirement that cannot be verified at all (no fact
 * anywhere) rejects — missing evidence is not satisfaction.
 */
function fitReasons(
	model: { contextWindow?: number; maxTokens?: number } | undefined,
	cap: FreeRouteCapabilities | undefined,
	req: FreeRouteRequirements,
): string[] {
	const reasons: string[] = [];
	if (req.catalogAddedAfter !== undefined || req.catalogAddedBefore !== undefined) {
		const date = cap?.catalogAddedAt;
		if (typeof date !== "number" || !Number.isSafeInteger(date) || date <= 0) reasons.push("catalog-added-date-unknown");
		else if ((req.catalogAddedAfter !== undefined && (!Number.isFinite(req.catalogAddedAfter) || date < req.catalogAddedAfter))
			|| (req.catalogAddedBefore !== undefined && (!Number.isFinite(req.catalogAddedBefore) || date >= req.catalogAddedBefore))) reasons.push("outside-catalog-added-interval");
	}
	const ctx = typeof model?.contextWindow === "number" ? model.contextWindow : cap?.contextWindow;
	const out = typeof model?.maxTokens === "number" ? model.maxTokens : cap?.maxTokens;
	if (req.minContextWindow !== undefined && !(typeof ctx === "number" && ctx >= req.minContextWindow)) reasons.push("context-below-minimum");
	if (req.minOutputTokens !== undefined && !(typeof out === "number" && out >= req.minOutputTokens)) reasons.push("output-below-minimum");
	if (req.toolCalling && cap?.toolCalling !== true) reasons.push("missing-capability:tool-calling");
	if (req.structuredOutput && cap?.structuredOutput !== true) reasons.push("missing-capability:structured-output");
	if (req.reasoning && cap?.reasoning !== true) reasons.push("missing-capability:reasoning");
	if (req.imageInput && !cap?.inputModalities?.includes("image")) reasons.push("missing-capability:image-input");
	return reasons;
}

const PROOF_RANK: Record<FreeProof, number> = { fresh: 0, "stale-bounded": 1, none: 2 };

/**
 * One concise inspectable report: per candidate — free?, proof level, evidence
 * age, capabilities, eligibility, rejection reasons, rank; plus the aggregate
 * free-assistance state. Pure: reads only the passed models + evidence.
 */
export function describeFreeRoutes(
	models: Array<Route & { contextWindow?: number; maxTokens?: number }>,
	opts: { requirements?: FreeRouteRequirements; evidence?: FreeEvidence | null; now?: number } = {},
): FreeRouteReport {
	const now = opts.now ?? Date.now();
	const evidence = (opts.evidence === undefined ? readFreeEvidence() : opts.evidence) ?? null;
	const candidates: FreeRouteCandidate[] = models.map((model) => {
		const verdict = proveFreeRoute(model, evidence, now);
		const reasons: string[] = [];
		if (!verdict.proven && verdict.reason) reasons.push(verdict.reason);
		if (verdict.proven) reasons.push(...fitReasons(model, verdict.capabilities, opts.requirements ?? {}));
		return {
			route: `${model.provider}/${model.id}`,
			provider: model.provider,
			id: model.id,
			free: verdict.proof !== "none",
			proof: verdict.proof,
			...(verdict.evidenceAgeMs !== undefined ? { evidenceAgeMs: verdict.evidenceAgeMs } : {}),
			...(verdict.capabilities ? { capabilities: verdict.capabilities } : {}),
			eligible: reasons.length === 0,
			reasons,
		};
	});
	const eligible = candidates.filter((c) => c.eligible).sort(
		(a, b) =>
			PROOF_RANK[a.proof] - PROOF_RANK[b.proof] ||
			(b.capabilities?.contextWindow ?? 0) - (a.capabilities?.contextWindow ?? 0) ||
			a.route.localeCompare(b.route),
	);
	eligible.forEach((c, i) => { c.rank = i + 1; });
	let state: FreeAssistanceState;
	let category: string | undefined;
	if (eligible.length >= 2) state = "AVAILABLE";
	else if (eligible.length === 1) state = "DEGRADED_ONE_ROUTE";
	else {
		const freeRows = candidates.filter((c) => c.free);
		if (!evidence || !Object.keys(evidence.providers).length) {
			state = "DISCOVERY_STALE";
			category = "no free-route evidence yet (no successful authoritative catalog fetch)";
		} else if (!freeRows.length) {
			state = "NO_COMPATIBLE_FREE_ROUTE";
			const expired = candidates.some((c) => c.reasons.includes("evidence-expired"));
			category = expired
				? "last-known-good free evidence expired with no fresh discovery"
				: "catalog has no zero-cost route matching the request";
		} else {
			state = "NO_COMPATIBLE_FREE_ROUTE";
			category = "free routes exist but none satisfies the requested capabilities";
		}
	}
	return { state, ...(category !== undefined ? { category } : {}), candidates };
}

/** Distribute `count` children over the ranked eligible routes; reuse a route when children outnumber distinct routes. */
export function distributeChildren(routes: FreeRouteCandidate[], count: number): FreeRouteCandidate[] {
	if (!Number.isSafeInteger(count) || count < 0 || count > 64) throw new TypeError("child count must be an integer from 0 to 64");
	const ranked = routes.filter(r=>r.eligible).slice().sort((a,b)=>(a.rank??Infinity)-(b.rank??Infinity)||a.route.localeCompare(b.route));
	const unique = [...new Map(ranked.map(r=>[r.route,r])).values()];
	const first: FreeRouteCandidate[] = [], rest: FreeRouteCandidate[] = [], providers = new Set<string>();
	for (const route of unique) {if(providers.has(route.provider))rest.push(route);else {providers.add(route.provider);first.push(route);}}
	const ordered = [...first,...rest];
	if (!ordered.length) return [];
	return Array.from({ length: count }, (_, i) => ordered[i % ordered.length]!);
}

/** Preserve user provider restrictions; disallow model-array/plugin routing and cap all billable dimensions. */
export function capFreeRequest(payload: Record<string, any>, model: Route): Record<string, unknown> {
	if (!proveFreeRoute(model).proven || payload.model !== model.id || payload.models !== undefined || payload.route !== undefined || payload.plugins !== undefined) throw Object.assign(new Error("Free dispatch refused: expired/unbound price evidence or alternate routing"), { code: "PI_AUTONOMOUS_REQUEST_DENIED" });
	if (model.provider === "openrouter") {
		// OpenRouter enforces max_price server-side: zero on every dimension makes
		// over-billing impossible even if local evidence is stale.
		return { ...payload, provider: { ...payload.provider, max_price: { ...payload.provider?.max_price, prompt: 0, completion: 0, request: 0, image: 0 } } };
	}
	// OrcaRouter (one-api-style relay): no OpenRouter provider-routing object;
	// injecting unknown gateway fields risks a hard 400. Free status rests on
	// the published pricing-catalog evidence and its short stale bound.
	return { ...payload };
}

/**
 * Structured route-selection observability.
 *
 * Quality gates, price caps, provider health, preferences, and fallback logic
 * stay exactly as strict — but their failure reasons are orthogonal. "Too
 * expensive", "quality evidence unknown", "context too small", "missing image
 * support", "tool schema incompatible", "provider cooling", and "quota
 * exhausted" are separate rejection dimensions per candidate, never one
 * generic "no route passed". Recovery is deterministic because each dimension
 * maps to a distinct fix.
 *
 * Every automatic child selection also persists a bounded decision record:
 * candidate pool, exclusion reasons, preference role, free/paid status, price
 * evidence, quality evidence, required capabilities, context/output needs,
 * backend/tool compatibility, health, and the final choice. `/used` and
 * `/metrics` explain decisions from this record — never by re-inferring logs.
 *
 * Dependency-free and pure. Persistence is the caller's job (bounded file or
 * session event); this module only builds the record.
 */

export type RejectionDimension =
	| "price"
	| "quality-evidence"
	| "context"
	| "output"
	| "modality"
	| "tool-schema"
	| "backend-compat"
	| "provider-cooling"
	| "quota"
	| "authorization"
	| "reliability-history"
	| "excluded"
	| "structured-output";

export interface CandidateRejection {
	route: string;
	dimensions: RejectionDimension[];
	/** Per-dimension machine-readable detail, same keys as dimensions. */
	detail: Partial<Record<RejectionDimension, string>>;
}

export interface CandidateSummary {
	route: string;
	free: boolean;
	freeProof?: string;
	paidEligible?: boolean;
	priceEvidence?: string;
	qualityEvidence?: string;
	backend?: string;
	toolCompatible?: boolean;
	healthy?: boolean;
}

export interface RouteDecisionRecord {
	version: 1;
	/** Unix milliseconds. */
	at: number;
	/** Short hash of the task text (never the task itself). */
	taskHash?: string;
	/** Preference role that drove selection (e.g. automatic, economy, pinned). */
	preferenceRole?: string;
	freeOnly?: boolean;
	requiredCapabilities?: Record<string, string | number | boolean>;
	candidates: CandidateSummary[];
	rejections: CandidateRejection[];
	choice?: string;
	choiceReason?: string;
	/** Parent route used as quality/reference baseline, if any. */
	parentBaseline?: string;
}

const MAX_CANDIDATES = 64;
const MAX_DETAIL = 160;

function truncate(value: string): string {
	return value.length > MAX_DETAIL ? `${value.slice(0, MAX_DETAIL - 1)}…` : value;
}

function sanitizeRoute(route: string): string {
	return /^[a-z0-9_.:/@+-]{1,200}$/i.test(route) ? route : "invalid-route";
}

export interface DecisionInput {
	taskHash?: string;
	preferenceRole?: string;
	freeOnly?: boolean;
	requiredCapabilities?: Record<string, string | number | boolean>;
	candidates: CandidateSummary[];
	rejections?: CandidateRejection[];
	choice?: string;
	choiceReason?: string;
	parentBaseline?: string;
	at?: number;
}

/** Build a bounded, JSON-safe decision record. */
export function recordRouteDecision(input: DecisionInput): RouteDecisionRecord {
	const candidates = input.candidates.slice(0, MAX_CANDIDATES).map((candidate) => ({
		route: sanitizeRoute(candidate.route),
		free: candidate.free === true,
		...(candidate.freeProof ? { freeProof: truncate(String(candidate.freeProof)) } : {}),
		...(candidate.paidEligible === undefined ? {} : { paidEligible: candidate.paidEligible === true }),
		...(candidate.priceEvidence ? { priceEvidence: truncate(String(candidate.priceEvidence)) } : {}),
		...(candidate.qualityEvidence ? { qualityEvidence: truncate(String(candidate.qualityEvidence)) } : {}),
		...(candidate.backend ? { backend: truncate(String(candidate.backend)) } : {}),
		...(candidate.toolCompatible === undefined ? {} : { toolCompatible: candidate.toolCompatible === true }),
		...(candidate.healthy === undefined ? {} : { healthy: candidate.healthy === true }),
	}));
	const rejections = (input.rejections ?? []).slice(0, MAX_CANDIDATES).map((rejection) => ({
		route: sanitizeRoute(rejection.route),
		dimensions: [...new Set(rejection.dimensions)].slice(0, 12),
		detail: Object.fromEntries(
			Object.entries(rejection.detail ?? {}).map(([dimension, text]) => [dimension, truncate(String(text))]),
		) as CandidateRejection["detail"],
	}));
	return {
		version: 1,
		at: Number.isFinite(input.at) ? Number(input.at) : Date.now(),
		...(input.taskHash ? { taskHash: truncate(String(input.taskHash)) } : {}),
		...(input.preferenceRole ? { preferenceRole: truncate(String(input.preferenceRole)) } : {}),
		...(input.freeOnly === undefined ? {} : { freeOnly: input.freeOnly === true }),
		...(input.requiredCapabilities ? { requiredCapabilities: input.requiredCapabilities } : {}),
		candidates,
		rejections,
		...(input.choice ? { choice: sanitizeRoute(input.choice) } : {}),
		...(input.choiceReason ? { choiceReason: truncate(String(input.choiceReason)) } : {}),
		...(input.parentBaseline ? { parentBaseline: sanitizeRoute(input.parentBaseline) } : {}),
	};
}

/**
 * Render one candidate's rejection as orthogonal dimensions. Consumers map
 * each dimension to its own recovery (see recovery-advisor.ts).
 */
export function formatCandidateRejection(rejection: CandidateRejection): string {
	if (!rejection.dimensions.length) return `${rejection.route}: passed local gates; rejected by a compounded pool constraint`;
	return `${rejection.route}: ${rejection.dimensions.map((dimension) => {
		const text = rejection.detail[dimension];
		return text ? `${dimension} (${text})` : dimension;
	}).join("; ")}`;
}

/** Deterministic recovery hint per rejection dimension. */
export function recoveryHintForDimension(dimension: RejectionDimension): string {
	switch (dimension) {
		case "price": return "choose an eligible authorized route within caps or authorize a higher budget";
		case "quality-evidence": return "supply verified benchmark evidence or keep the work in the parent";
		case "context": return "reduce child context (fresh mode, pruned fork, artifact handoff)";
		case "output": return "raise the answer reserve route bound or split the work into staged summaries";
		case "modality": return "route to an image-capable model or drop image evidence from the child brief";
		case "tool-schema": return "project tool schemas for the backend or narrow the child tool subset";
		case "backend-compat": return "switch to an already-authorized compatible backend";
		case "provider-cooling": return "wait out the cooldown or use a healthy provider for the same model";
		case "quota": return "use a non-exhausted provider or authorize more quota";
		case "authorization": return "re-authorize the provider credentials; never reroute silently past dead keys";
		case "reliability-history": return "prefer a route with healthier recent outcomes";
		case "excluded": return "remove the exclusion or pick a non-excluded route";
		case "structured-output": return "relax the structured-output contract or pick a route advertising it";
	}
}

/**
 * Explainable coordination decisions.
 *
 * Single helper vs swarm vs fusion vs council is persisted with its reasons:
 * separability, uncertainty, competing hypotheses, implementation risk,
 * expected benefit, and cost envelope. Invocation stays exactly as capable —
 * it just stops being mechanical and becomes debuggable.
 *
 * Dependency-free and pure.
 */

export type CoordinationMode = "single" | "swarm" | "fusion" | "council";

export interface CoordinationFactors {
	/** The work splits into independent scopes (0..1). */
	separability: number;
	/** Outcome uncertainty without parallel exploration (0..1). */
	uncertainty: number;
	/** Genuinely competing hypotheses need independent runs (0..1). */
	competingHypotheses: number;
	/** Implementation risk if done without review/council (0..1). */
	implementationRisk: number;
	/** Expected benefit of parallel structure over a single run (0..1). */
	expectedBenefit: number;
	/** Max parallel members the cost envelope admits. */
	costEnvelope: number;
	/** Independent scopes identified (bounded labels, no prose). */
	scopes?: string[];
}

export interface CoordinationDecision {
	version: 1;
	mode: CoordinationMode;
	members: number;
	factors: CoordinationFactors;
	reasons: string[];
	at: number;
}

const clamp01 = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/**
 * Decide the coordination mode from explicit factors. Thresholds are
 * conservative: single wins ties, and cost envelope caps membership.
 */
export function decideCoordination(factors: CoordinationFactors, at = Date.now()): CoordinationDecision {
	const separability = clamp01(factors.separability);
	const uncertainty = clamp01(factors.uncertainty);
	const competing = clamp01(factors.competingHypotheses);
	const risk = clamp01(factors.implementationRisk);
	const benefit = clamp01(factors.expectedBenefit);
	const envelope = Math.max(1, Math.min(16, Math.floor(factors.costEnvelope) || 1));
	const scopes = (factors.scopes ?? []).filter((scope): scope is string => typeof scope === "string").map((scope) => scope.slice(0, 120)).slice(0, 16);
	const reasons: string[] = [];

	let mode: CoordinationMode = "single";
	let members = 1;
	if (risk >= 0.7 && (uncertainty >= 0.5 || competing >= 0.5)) {
		mode = "council";
		members = Math.min(envelope, 3);
		reasons.push(`implementation risk ${risk} with uncertainty ${uncertainty}/competing ${competing}: deliberate before acting`);
	} else if (competing >= 0.6 && benefit >= 0.4) {
		mode = "fusion";
		members = Math.min(envelope, Math.max(2, scopes.length || 2));
		reasons.push(`competing hypotheses ${competing} with expected benefit ${benefit}: independent answers, then synthesize`);
	} else if (separability >= 0.6 && benefit >= 0.3 && (scopes.length >= 2 || envelope >= 2)) {
		mode = "swarm";
		members = Math.min(envelope, Math.max(2, scopes.length || 2));
		reasons.push(`separability ${separability} across ${scopes.length || "multiple"} scopes with benefit ${benefit}: parallelize`);
	} else {
		reasons.push(`single run suffices (separability ${separability}, benefit ${benefit}, risk ${risk})`);
	}
	reasons.push(`cost envelope admits ${envelope}; members ${members}`);
	return {
		version: 1,
		mode,
		members,
		factors: { separability, uncertainty, competingHypotheses: competing, implementationRisk: risk, expectedBenefit: benefit, costEnvelope: envelope, ...(scopes.length ? { scopes } : {}) },
		reasons,
		at,
	};
}

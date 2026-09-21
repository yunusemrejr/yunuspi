/**
 * Skill routing precision and suggestion-lifecycle telemetry.
 *
 * The 161-workflow catalog and lazy loading stay. Ranking gains a precision
 * layer: action intent + file/domain evidence outrank bare keyword overlap, so
 * "GitHub", "presentation layer", or "AI assistant" no longer trigger
 * repo-presentation, PowerPoint-authoring, or generic AI skills when the task
 * is source-code auditing. Suggestions stay advisory — precision, not volume.
 *
 * Suggestion lifecycle is tracked explicitly: suggested, inspected preview,
 * not relevant after inspection, deferred, opened partially, fully opened,
 * applied. Telemetry without forced usage.
 *
 * Micro-intelligence helpers (Needle, Jev, Smol, Kompress) graduate from
 * "offered" to "useful": eligible, invoked, accepted, rejected, fallback,
 * latency, token/cost effect, and whether the main-model decision changed. A
 * helper that correctly skips irrelevant work is functioning — invocation
 * count is never the goal. Smol/Kompress ineligibility carries structured
 * reasons instead of bare `ineligible`.
 *
 * Dependency-free and pure.
 */

export type SkillSuggestionState =
	| "suggested"
	| "inspected-preview"
	| "not-relevant"
	| "deferred"
	| "opened-partially"
	| "fully-opened"
	| "applied";

export interface SkillSuggestion {
	skill: string;
	state: SkillSuggestionState;
	/** Why it was suggested (intent + evidence, bounded). */
	reason?: string;
	at?: number;
}

export interface SkillLifecycleLedger {
	version: 1;
	suggestions: SkillSuggestion[];
}

export function recordSkillSuggestion(ledger: SkillLifecycleLedger, skill: string, state: SkillSuggestionState, reason?: string): SkillLifecycleLedger {
	const suggestions = ledger.suggestions.filter((entry) => entry.skill !== skill);
	suggestions.push({
		skill: skill.slice(0, 128),
		state,
		...(reason ? { reason: reason.slice(0, 280) } : {}),
		at: Date.now(),
	});
	return { version: 1, suggestions: suggestions.slice(-256) };
}

/** Precision score for a candidate skill: intent match × evidence match. */
export interface SkillPrecisionInput {
	skill: string;
	/** Requested action from the structured task intent. */
	requestedAction?: string;
	/** Task text sample for file/domain evidence. */
	text?: string;
	/** Files already known relevant (paths, not contents). */
	files?: string[];
	/** Base keyword score from the existing routes (0..1). */
	keywordScore?: number;
}

export interface SkillPrecision {
	skill: string;
	score: number;
	intentMatch: boolean;
	evidenceMatch: boolean;
	reason: string;
}

/** Skills whose keyword triggers are known-overbroad without evidence. */
const EVIDENCE_GATED: Array<{ skill: string; needs: RegExp; evidence: string }> = [
	{ skill: "github-repo-presentation", needs: /\b(license|contributing|code of conduct|issue template|codeowners|repo health|open-source readiness)\b/i, evidence: "repo-health artifact or explicit request" },
	{ skill: "github-readme-authoring", needs: /\breadme\b/i, evidence: "README scope" },
	{ skill: "presentation-authoring", needs: /\b(powerpoint|pptx|odp|slide deck|impress)\b|\bslides?\b(?![^a-z]*(?:carousel|css|slider))/i, evidence: "slide-deck artifact, not UI presentation layer" },
	{ skill: "word-document-authoring", needs: /\b(docx|odt|word document|writer)\b/i, evidence: "document artifact" },
	{ skill: "spreadsheet-authoring", needs: /\b(xlsx|spreadsheet|workbook|pivot)\b/i, evidence: "spreadsheet artifact" },
];

const ACTION_AFFINITY: Record<string, string[]> = {
	implement: ["coding-practices", "debugging", "property-based-testing", "type-driven-design"],
	review: ["code-review", "debugging", "systems-security", "web-security"],
	investigate: ["debugging", "research", "data-lineage-validation"],
	plan: ["api-design", "software-engineering-wisdom", "type-driven-design"],
	operate: ["ubuntu-operations", "linux", "git-github"],
};

/**
 * Re-rank a keyword candidate by intent + evidence. Overbroad keyword matches
 * without file/domain evidence are demoted (never removed — advisory).
 */
export function precisionRankSkill(input: SkillPrecisionInput): SkillPrecision {
	const text = (input.text ?? "").slice(0, 8192);
	const files = (input.files ?? []).slice(0, 64).join("\n");
	const haystack = `${text}\n${files}`;
	const gated = EVIDENCE_GATED.find((entry) => entry.skill === input.skill);
	const evidenceMatch = gated ? gated.needs.test(haystack) : true;
	const affinities = ACTION_AFFINITY[input.requestedAction ?? ""] ?? [];
	const intentMatch = affinities.includes(input.skill) || !gated;
	const base = Math.min(1, Math.max(0, input.keywordScore ?? 0.5));
	let score = base;
	if (gated && !evidenceMatch) score = base * 0.25;
	else if (intentMatch && affinities.includes(input.skill)) score = Math.min(1, base + 0.2);
	return {
		skill: input.skill,
		score: Math.round(score * 1000) / 1000,
		intentMatch,
		evidenceMatch,
		reason: gated
			? evidenceMatch ? `keyword + ${gated.evidence}` : `keyword only; needs ${gated.evidence}`
			: intentMatch ? `action intent ${input.requestedAction ?? "unknown"}` : "keyword only",
	};
}

export type MicroIntelHelper = "needle" | "jev" | "smol" | "kompress" | string;

export type MicroIntelOutcome = "eligible" | "invoked" | "accepted" | "rejected" | "fallback" | "skipped-correctly";

export type SmolKompressIneligibility =
	| "input-shape-unsupported"
	| "too-small-to-benefit"
	| "protected-content"
	| "already-compact"
	| "latency-budget-exceeded"
	| "confidence-too-low"
	| "model-unavailable";

export interface MicroIntelSample {
	helper: string;
	outcome: MicroIntelOutcome;
	/** Whether the main-model decision changed because of the helper. */
	decisionChanged?: boolean;
	latencyMs?: number;
	/** Negative means tokens/cost saved. */
	tokenDelta?: number;
	costDeltaUsd?: number;
	ineligibility?: SmolKompressIneligibility;
	at: number;
}

export interface MicroIntelLedger {
	version: 1;
	samples: MicroIntelSample[];
}

export function recordMicroIntel(
	ledger: MicroIntelLedger,
	sample: Omit<MicroIntelSample, "at"> & { at?: number },
): MicroIntelLedger {
	const samples = [...ledger.samples, {
		helper: String(sample.helper).slice(0, 64),
		outcome: sample.outcome,
		...(sample.decisionChanged === undefined ? {} : { decisionChanged: sample.decisionChanged }),
		...(sample.latencyMs === undefined ? {} : { latencyMs: sample.latencyMs }),
		...(sample.tokenDelta === undefined ? {} : { tokenDelta: sample.tokenDelta }),
		...(sample.costDeltaUsd === undefined ? {} : { costDeltaUsd: sample.costDeltaUsd }),
		...(sample.ineligibility ? { ineligibility: sample.ineligibility } : {}),
		at: sample.at ?? Date.now(),
	}];
	return { version: 1, samples: samples.slice(-512) };
}

export interface MicroIntelUsefulness {
	helper: string;
	eligible: number;
	invoked: number;
	accepted: number;
	rejected: number;
	fallback: number;
	skippedCorrectly: number;
	decisionChanged: number;
	totalTokenDelta: number;
	/** Accepted-or-correctly-skipped over invoked-or-eligible: usefulness, not volume. */
	usefulness: number;
}

/** Usefulness per helper: correct skips and accepted assists count; raw invocations do not. */
export function summarizeMicroIntelUsefulness(ledger: MicroIntelLedger): MicroIntelUsefulness[] {
	const byHelper = new Map<string, MicroIntelSample[]>();
	for (const sample of ledger.samples) {
		const list = byHelper.get(sample.helper) ?? [];
		list.push(sample);
		byHelper.set(sample.helper, list);
	}
	return [...byHelper.entries()].map(([helper, samples]) => {
		const count = (outcome: MicroIntelOutcome) => samples.filter((sample) => sample.outcome === outcome).length;
		const eligible = count("eligible");
		const invoked = count("invoked");
		const accepted = count("accepted");
		const rejected = count("rejected");
		const fallback = count("fallback");
		const skippedCorrectly = count("skipped-correctly");
		const decisionChanged = samples.filter((sample) => sample.decisionChanged === true).length;
		const totalTokenDelta = samples.reduce((sum, sample) => sum + (sample.tokenDelta ?? 0), 0);
		const denominator = eligible + invoked + accepted + rejected + fallback + skippedCorrectly;
		const usefulness = denominator ? (accepted + skippedCorrectly) / denominator : 0;
		return {
			helper,
			eligible,
			invoked,
			accepted,
			rejected,
			fallback,
			skippedCorrectly,
			decisionChanged,
			totalTokenDelta,
			usefulness: Math.round(usefulness * 1000) / 1000,
		};
	});
}

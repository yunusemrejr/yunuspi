/**
 * Output capacity provenance, evidence budgets, and resumable completion.
 *
 * Model capacity and effective runtime budget are different facts. Every route
 * tracks: provider-advertised maximum output, catalog-derived value, local
 * override, conservative fallback, child-config cap, request-hook cap, final
 * wire cap when observable, and the actual stop cause. A bare 8192 that came
 * from a fallback or config default is labeled as such — never presented as
 * provider capability.
 *
 * Output budgets are planned from the child task (report shape, file count,
 * evidence density, structured-output constraints). Large audits persist
 * intermediate artifacts or staged summaries instead of fitting everything
 * into one final response.
 *
 * Truncated children are resumable: substantial work plus session/evidence
 * state continues with a synthesis-only follow-up instead of restarting the
 * investigation. Recovery of existing work outranks relaunch.
 *
 * Dependency-free and pure.
 */

export type CapacitySource =
	| "provider-advertised"
	| "catalog"
	| "local-override"
	| "conservative-fallback"
	| "child-config"
	| "request-hook"
	| "wire-cap"
	| "unknown";

export interface OutputCapacityInput {
	/** Provider-advertised maximum output tokens (live provider evidence). */
	advertised?: number;
	/** Catalog-derived max output (stored pricing/catalog evidence). */
	catalog?: number;
	/** Explicit local override. */
	override?: number;
	/** Conservative fallback when nothing is known (default 8192, labeled). */
	fallback?: number;
	/** Child-configured ceiling. */
	childCap?: number;
	/** Request-hook imposed ceiling. */
	hookCap?: number;
	/** Final wire cap when observable (e.g. max_tokens actually sent). */
	wireCap?: number;
	/** Actual stop cause when the run finished. */
	stopCause?: string;
}

export interface OutputCapacityProvenance {
	effective: number;
	effectiveSource: CapacitySource;
	advertised?: number;
	catalog?: number;
	override?: number;
	fallback?: number;
	childCap?: number;
	hookCap?: number;
	wireCap?: number;
	stopCause?: string;
	/** True when the effective value is a guess, not provider evidence. */
	isFallback: boolean;
}

export const CONSERVATIVE_OUTPUT_FALLBACK = 8192;

function sane(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Resolve the effective output budget with full provenance. Ceilings
 * (child-config, hook, wire) narrow from above; the base comes from the
 * strongest available evidence. Fallbacks are labeled, never disguised.
 */
export function resolveOutputCapacity(input: OutputCapacityInput = {}): OutputCapacityProvenance {
	const advertised = sane(input.advertised);
	const catalog = sane(input.catalog);
	const override = sane(input.override);
	const fallback = sane(input.fallback) ?? CONSERVATIVE_OUTPUT_FALLBACK;
	const childCap = sane(input.childCap);
	const hookCap = sane(input.hookCap);
	const wireCap = sane(input.wireCap);

	let effective: number;
	let effectiveSource: CapacitySource;
	if (override !== undefined) {
		effective = override;
		effectiveSource = "local-override";
	} else if (advertised !== undefined) {
		effective = advertised;
		effectiveSource = "provider-advertised";
	} else if (catalog !== undefined) {
		effective = catalog;
		effectiveSource = "catalog";
	} else {
		effective = fallback;
		effectiveSource = "conservative-fallback";
	}
	for (const [cap, source] of [[childCap, "child-config"], [hookCap, "request-hook"], [wireCap, "wire-cap"]] as const) {
		if (cap !== undefined && cap < effective) {
			effective = cap;
			effectiveSource = source;
		}
	}
	return {
		effective,
		effectiveSource,
		...(advertised === undefined ? {} : { advertised }),
		...(catalog === undefined ? {} : { catalog }),
		...(override === undefined ? {} : { override }),
		fallback,
		...(childCap === undefined ? {} : { childCap }),
		...(hookCap === undefined ? {} : { hookCap }),
		...(wireCap === undefined ? {} : { wireCap }),
		...(input.stopCause ? { stopCause: String(input.stopCause).slice(0, 64) } : {}),
		isFallback: effectiveSource === "conservative-fallback",
	};
}

export interface EvidenceBudgetInput {
	reportShape?: "verdict" | "findings" | "audit" | "implementation" | "summary";
	fileCount?: number;
	expectedFindings?: number;
	structuredOutput?: boolean;
	/** Total context available to the child. */
	contextWindow?: number;
	/** Prompt tokens already committed (brief + instructions + schemas). */
	promptTokens?: number;
}

export interface EvidenceBudget {
	/** Tokens for source reading / tool results. */
	reading: number;
	/** Tokens for reasoning scratch. */
	reasoning: number;
	/** Tokens reserved for the final answer. */
	answer: number;
	/** Whether the plan needs staged artifacts (evidence exceeds one response). */
	needsStaging: boolean;
	/** Suggested intermediate artifact count, 0 when direct return fits. */
	stagedArtifacts: number;
}

/**
 * Allocate separate budgets for reading, reasoning, and answering. When the
 * evidence set outgrows one response, the plan says so explicitly (staged
 * artifacts) instead of consuming answer headroom unpredictably.
 */
export function planEvidenceBudget(input: EvidenceBudgetInput = {}): EvidenceBudget {
	const shape = input.reportShape ?? "findings";
	const files = Math.max(0, Math.min(10000, input.fileCount ?? 0));
	const findings = Math.max(0, Math.min(10000, input.expectedFindings ?? Math.ceil(files / 2)));
	const perFileRead = shape === "audit" ? 1500 : shape === "findings" ? 800 : 400;
	const perFindingWrite = shape === "audit" ? 220 : 140;
	const reading = Math.ceil(files * perFileRead + findings * 60);
	const answer = Math.ceil(1024 + findings * perFindingWrite + (input.structuredOutput ? 512 : 0));
	const reasoning = Math.ceil((reading + answer) * 0.25);
	const contextWindow = sane(input.contextWindow) ?? 0;
	const promptTokens = Math.max(0, input.promptTokens ?? 0);
	const total = promptTokens + reading + reasoning + answer;
	const fits = contextWindow <= 0 || total <= contextWindow * 0.85;
	const stagedArtifacts = fits ? 0 : Math.min(16, Math.max(1, Math.ceil(total / Math.max(1, contextWindow * 0.5)) - 1));
	return { reading, reasoning, answer, needsStaging: !fits, stagedArtifacts };
}

export interface HandoffPlan {
	/** Bounded evidence artifact path/identifier the child should write. */
	artifact?: string;
	/** Compact parent-facing summary requirements. */
	summary: { maxChars: number; includeEvidenceIds: boolean };
	strategy: "direct" | "artifact-plus-summary" | "staged-summaries";
	reason: string;
}

/**
 * Artifact-based handoff for large investigations: the child writes a bounded
 * evidence artifact plus a compact summary; the parent selectively inspects
 * the artifact. Direct textual returns stay the default when they fit.
 */
export function planArtifactHandoff(budget: EvidenceBudget, options: { artifactPath?: string } = {}): HandoffPlan {
	if (!budget.needsStaging) {
		return {
			summary: { maxChars: 12000, includeEvidenceIds: true },
			strategy: "direct",
			reason: "evidence fits one response; direct textual return",
		};
	}
	if (budget.stagedArtifacts <= 1) {
		return {
			...(options.artifactPath ? { artifact: options.artifactPath.slice(0, 512) } : {}),
			summary: { maxChars: 6000, includeEvidenceIds: true },
			strategy: "artifact-plus-summary",
			reason: "evidence exceeds one response; bounded artifact plus compact summary",
		};
	}
	return {
		...(options.artifactPath ? { artifact: options.artifactPath.slice(0, 512) } : {}),
		summary: { maxChars: 4000, includeEvidenceIds: true },
		strategy: "staged-summaries",
		reason: `${budget.stagedArtifacts} staged summaries; final synthesis reads artifacts, not raw evidence`,
	};
}

export interface ResumeInput {
	/** Whether the attempt produced usable artifacts/session/tool evidence. */
	hasArtifacts: boolean;
	hasSessionState: boolean;
	hasPartialResults: boolean;
	truncation: "none" | "length-stop" | "answer-budget" | "structural-cutoff";
	acceptance: "none" | "pending" | "passed" | "failed";
}

export interface ResumePlan {
	resumable: boolean;
	/** Continuation asks only for the missing synthesis/output. */
	continuationScope: "synthesis-only" | "partial-redo" | "full-restart";
	instructions: string;
}

/**
 * Make truncated completion resumable. Substantial work + retained state
 * continues with a synthesis-only follow-up; only truly empty attempts
 * restart. Recovering existing work outranks relaunching.
 */
export function planResume(input: ResumeInput): ResumePlan {
	const productive = input.hasArtifacts || input.hasSessionState || input.hasPartialResults;
	if (input.truncation === "none" && input.acceptance !== "failed") {
		return { resumable: false, continuationScope: "full-restart", instructions: "no truncation or acceptance gap; nothing to resume" };
	}
	if (productive && input.truncation !== "none") {
		return {
			resumable: true,
			continuationScope: "synthesis-only",
			instructions: "continue the retained session: synthesize the existing evidence into the missing final output; do not re-run the investigation",
		};
	}
	if (productive) {
		return {
			resumable: true,
			continuationScope: "partial-redo",
			instructions: "inspect the retained artifacts and partial results; redo only the missing or rejected portion",
		};
	}
	return { resumable: false, continuationScope: "full-restart", instructions: "no usable retained state; restart with a narrower scope or larger budget" };
}

/**
 * Child-specific route requirements.
 *
 * A child is routed against ITS OWN workload — not the parent's full
 * capabilities. A bounded read-only child must not inherit the parent model's
 * context window, output ceiling, reasoning capability, image support, or
 * other modalities. Parent capability survives only as a quality/reference
 * baseline where a comparison is genuinely needed.
 *
 * Inputs per launch: estimated prompt size, context mode, expected evidence
 * volume, tool-schema overhead, output reserve, modalities, tool-calling
 * support, and reasoning requirements.
 *
 * Dependency-free and pure.
 */

import { extractTaskIntent, type TaskIntent } from "./task-intent-model.ts";

/** How much parent state the child carries. Drives context requirements. */
export type ChildContextMode = "fresh" | "pruned-fork" | "full-fork" | "artifact-only";

export type ReasoningNeed = "required" | "preferred" | "unneeded";

export interface ChildWorkloadEstimate {
	/** Estimated child prompt in tokens (brief + instructions + tools). */
	estimatedPromptTokens: number;
	/** How the child is launched. Defaults to "fresh". */
	contextMode?: ChildContextMode;
	/** Expected tool-result / evidence volume in tokens. */
	expectedEvidenceTokens?: number;
	/** Serialized tool-schema overhead in tokens. */
	toolSchemaTokens?: number;
	/** Reserved final-answer tokens. */
	outputReserveTokens?: number;
	/** Modalities the child must consume (subset of ["text", "image"]). */
	modalities?: string[];
	/** Whether the child must call tools. Defaults to true. */
	toolCalling?: boolean;
	/** Reasoning requirement. Defaults from task intent. */
	reasoning?: ReasoningNeed;
	/** Whether structured output is contractually required. */
	structuredOutput?: boolean;
}

export interface ChildRouteRequirements {
	minContextWindow: number;
	minOutputTokens: number;
	reasoning: boolean;
	inputModalities?: string[];
	toolCalling: boolean;
	structuredOutput: boolean;
	contextMode: ChildContextMode;
	/** How each bound was derived; "parent-*" entries are baselines, never gates. */
	provenance: Record<string, string>;
}

const CHARS_PER_TOKEN = 4;
/** Headroom so the child is not routed at exactly 100% of window. */
const WINDOW_HEADROOM = 1.25;
const MIN_CONTEXT_FLOOR = 4096;
const MIN_OUTPUT_FLOOR = 512;

export interface PromptSizeInput {
	briefChars?: number;
	instructionChars?: number;
	fileCount?: number;
	avgFileChars?: number;
	evidenceChars?: number;
	toolCount?: number;
	avgToolSchemaTokens?: number;
	contextMode?: ChildContextMode;
	/** Parent prompt tokens, only when forking parent state. */
	parentPromptTokens?: number;
	/** Fraction of parent state retained by a pruned fork (0..1). */
	pruneRetention?: number;
}

/**
 * Estimate the child prompt in tokens from the actual launch shape. Fork modes
 * add parent state; fresh/artifact-only children carry only their brief.
 */
export function estimateChildPromptTokens(input: PromptSizeInput): number {
	const mode = input.contextMode ?? "fresh";
	const brief = Math.ceil((input.briefChars ?? 0) / CHARS_PER_TOKEN);
	const instructions = Math.ceil((input.instructionChars ?? 0) / CHARS_PER_TOKEN);
	const files = Math.ceil(((input.fileCount ?? 0) * (input.avgFileChars ?? 0)) / CHARS_PER_TOKEN);
	const evidence = Math.ceil((input.evidenceChars ?? 0) / CHARS_PER_TOKEN);
	const tools = (input.toolCount ?? 0) * (input.avgToolSchemaTokens ?? 0);
	let prompt = brief + instructions + files + evidence + tools;
	if (mode === "full-fork") {
		prompt += Math.max(0, input.parentPromptTokens ?? 0);
	} else if (mode === "pruned-fork") {
		const retention = Math.min(1, Math.max(0, input.pruneRetention ?? 0.25));
		prompt += Math.ceil(Math.max(0, input.parentPromptTokens ?? 0) * retention);
	}
	return Math.max(0, Math.ceil(prompt));
}

export interface OutputReserveInput {
	/** Expected report shape: compact findings vs full audit. */
	reportShape?: "verdict" | "findings" | "audit" | "implementation" | "summary";
	fileCount?: number;
	/** Expected findings density: findings per file. */
	evidenceDensity?: number;
	structuredOutput?: boolean;
	/** Caller-supplied floor (child config caps apply later as ceilings). */
	minimum?: number;
}

/**
 * Plan the child's answer reserve from the requested report shape — not from
 * the parent's output ceiling. Large audits stage through artifacts rather
 * than demanding one giant final response (see output-budget.ts).
 */
export function estimateOutputReserve(input: OutputReserveInput = {}): number {
	const shape = input.reportShape ?? "findings";
	const baseReserve: Record<string, number> = {
		verdict: 512,
		summary: 1024,
		findings: 2048,
		audit: 4096,
		implementation: 4096,
	};
	const perFile = shape === "audit" ? 256 : shape === "findings" ? 128 : 64;
	const density = Math.min(8, Math.max(0.25, input.evidenceDensity ?? 1));
	const reserve = Math.ceil(
		(baseReserve[shape] ?? 2048) + (input.fileCount ?? 0) * perFile * density + (input.structuredOutput ? 512 : 0),
	);
	return Math.max(MIN_OUTPUT_FLOOR, input.minimum ?? 0, reserve);
}

function reasoningFromIntent(intent: TaskIntent | undefined, explicit: ReasoningNeed | undefined): { need: boolean; note: string } {
	if (explicit === "required") return { need: true, note: "caller-required reasoning" };
	if (explicit === "unneeded") return { need: false, note: "caller-marked non-reasoning workload" };
	const action = intent?.requestedAction;
	if (explicit === "preferred") return { need: false, note: "reasoning preferred by caller; not a hard gate" };
	if (action === "implement" || action === "plan" || action === "operate") {
		return { need: false, note: "implementation workloads prefer reasoning but do not require it" };
	}
	if (action === "investigate" || action === "review") {
		return { need: false, note: "read-only investigation routes without a reasoning gate" };
	}
	return { need: false, note: "no reasoning requirement" };
}

/**
 * Build the child's route requirements from the actual launch. Every bound
 * derives from the child's workload; nothing is inherited from the parent
 * model's registry row.
 */
export function buildChildRouteRequirements(
	workload: ChildWorkloadEstimate,
	intent?: TaskIntent,
): ChildRouteRequirements {
	const mode = workload.contextMode ?? "fresh";
	const prompt = Math.max(0, Math.ceil(workload.estimatedPromptTokens));
	const evidence = Math.max(0, Math.ceil(workload.expectedEvidenceTokens ?? 0));
	const schema = Math.max(0, Math.ceil(workload.toolSchemaTokens ?? 0));
	const reserve = Math.max(MIN_OUTPUT_FLOOR, Math.ceil(workload.outputReserveTokens ?? 2048));
	const minContextWindow = Math.max(MIN_CONTEXT_FLOOR, Math.ceil((prompt + evidence + schema + reserve) * WINDOW_HEADROOM));
	const reasoning = reasoningFromIntent(intent, workload.reasoning);
	const modalities = (workload.modalities ?? ["text"]).filter((modality) => modality === "text" || modality === "image");
	const provenance: Record<string, string> = {
		minContextWindow: `child prompt ${prompt} + evidence ${evidence} + tool schemas ${schema} + answer reserve ${reserve}, x${WINDOW_HEADROOM} headroom (${mode})`,
		minOutputTokens: `child answer reserve ${reserve}`,
		reasoning: reasoning.note,
		toolCalling: workload.toolCalling === false ? "child makes no tool calls" : "child calls tools",
	};
	if (modalities.includes("image")) provenance.inputModalities = "child consumes images";
	return {
		minContextWindow,
		minOutputTokens: reserve,
		reasoning: reasoning.need,
		toolCalling: workload.toolCalling !== false,
		structuredOutput: workload.structuredOutput === true,
		contextMode: mode,
		...(modalities.includes("image") ? { inputModalities: ["text", "image"] as string[] } : {}),
		provenance,
	};
}

const IMAGE_CUES = /\b(screenshots?|images?|pictures?|photos?|vision|multimodal|png|jpe?g|gif|webp|svg|bmp|attached (?:files?|images?|media))\b/i;
const NON_VISUAL_IMAGE = /\b(docker|disk|container|iso|vm|machine|factory|system|base)\s+image/i;

/** Detect vision input needs from task text. Container/disk images are not vision. */
export function detectImageNeed(task: string): boolean {
	const text = (task ?? "").slice(0, 8192).replace(NON_VISUAL_IMAGE, " ");
	return IMAGE_CUES.test(text);
}

export interface ChildRequirementsFromTaskExtras {
	contextMode?: ChildContextMode;
	toolCount?: number;
	avgToolSchemaTokens?: number;
	fileCount?: number;
	evidenceChars?: number;
	instructionChars?: number;
	parentPromptTokens?: number;
	reportShape?: "verdict" | "findings" | "audit" | "implementation" | "summary";
	modalities?: string[];
	toolCalling?: boolean;
	reasoning?: ReasoningNeed;
	structuredOutput?: boolean;
}

/**
 * Build child requirements from task text plus launch facts. Used by callers
 * that resolve a route before the full launch plan exists (model fallback,
 * preflight); richer callers build ChildWorkloadEstimate directly.
 */
export function childRequirementsFromTask(task: string, extras: ChildRequirementsFromTaskExtras = {}): ChildRouteRequirements {
	const intent = extractTaskIntent(task ?? "");
	const mode = extras.contextMode ?? "fresh";
	// Prompt excludes tool schemas here: they ride separately as toolSchemaTokens
	// so route requirements can show the wire overhead on its own line.
	const prompt = estimateChildPromptTokens({
		briefChars: (task ?? "").length,
		instructionChars: extras.instructionChars ?? 4000,
		fileCount: extras.fileCount ?? 0,
		evidenceChars: extras.evidenceChars ?? 0,
		toolCount: 0,
		contextMode: mode,
		parentPromptTokens: extras.parentPromptTokens,
	});
	const shape = extras.reportShape ?? (intent.requestedAction === "implement" ? "implementation"
		: intent.requestedAction === "review" || intent.requestedAction === "investigate" ? "findings"
			: intent.requestedAction === "operate" ? "verdict" : "findings");
	const modalities = extras.modalities ?? (detectImageNeed(task) ? ["text", "image"] : ["text"]);
	return buildChildRouteRequirements({
		estimatedPromptTokens: prompt,
		contextMode: mode,
		expectedEvidenceTokens: Math.ceil((extras.evidenceChars ?? 0) / CHARS_PER_TOKEN),
		toolSchemaTokens: (extras.toolCount ?? 6) * (extras.avgToolSchemaTokens ?? 220),
		outputReserveTokens: estimateOutputReserve({ reportShape: shape, fileCount: extras.fileCount ?? 0, structuredOutput: extras.structuredOutput }),
		modalities,
		toolCalling: extras.toolCalling,
		reasoning: extras.reasoning,
		structuredOutput: extras.structuredOutput,
	}, intent);
}

/**
 * Compare child requirements against a parent/reference route for diagnostics.
 * The parent is a quality baseline only: a smaller child requirement is normal
 * and never a rejection reason.
 */
export function compareAgainstParentBaseline(
	requirements: ChildRouteRequirements,
	parent: { contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: string[] },
): string[] {
	const notes: string[] = [];
	if (typeof parent.contextWindow === "number" && requirements.minContextWindow < parent.contextWindow) {
		notes.push(`child needs ${requirements.minContextWindow} context vs parent ${parent.contextWindow}: routed smaller by design`);
	}
	if (typeof parent.maxTokens === "number" && requirements.minOutputTokens < parent.maxTokens) {
		notes.push(`child reserves ${requirements.minOutputTokens} output vs parent ${parent.maxTokens}: routed smaller by design`);
	}
	if (parent.reasoning === true && !requirements.reasoning) {
		notes.push("parent reasons; child workload does not require reasoning");
	}
	if (parent.input?.includes("image") && !requirements.inputModalities?.includes("image")) {
		notes.push("parent consumes images; child workload is text-only");
	}
	return notes;
}

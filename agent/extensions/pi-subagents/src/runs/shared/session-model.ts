/** Every subagent and reviewer runs on the parent session's own model.
 * There is no per-call, per-agent, per-role or fallback model: the child gets
 * the session's provider/id, and its own effort controller (Jev) picks the
 * thinking level from the session's ceiling. */
import { splitKnownThinkingSuffix, type ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";

export type { AvailableModelInfo };

/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
	provider: string;
	id: string;
}

export function normalizeParentModel(model: unknown): ParentModel | undefined {
	if (!model || typeof model !== "object") return undefined;
	const candidate = model as { provider?: unknown; id?: unknown };
	if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") return undefined;
	if (!candidate.provider || !candidate.id) return undefined;
	return { provider: candidate.provider, id: candidate.id };
}

/** The child's model route: the session's own provider/id. An explicit
 * `provider/id` keeps each session's children on that session's model instead
 * of the shared settings default another open session may have changed. */
export function sessionChildModel(parentModel: ParentModel | undefined): string {
	if (!parentModel) throw new Error("Subagents run on the session's model, and this session has no model selected.");
	return `${parentModel.provider}/${parentModel.id}`;
}

export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colon = model.lastIndexOf(":");
	if (colon < 0) return splitKnownThinkingSuffix(model);
	const parsed = splitKnownThinkingSuffix(`${model.slice(0, colon)}:${model.slice(colon + 1).toLowerCase()}`);
	return parsed.thinkingSuffix ? parsed : { baseModel: model, thinkingSuffix: "" };
}

export function formatSubagentModelVerificationError(expectedModel: string, observedModel: string, availableModels: AvailableModelInfo[] | undefined): string | undefined {
	if (!availableModels || availableModels.length === 0) return undefined;
	const expectedBase = splitThinkingSuffix(expectedModel).baseModel;
	const observedBase = splitThinkingSuffix(observedModel).baseModel;
	if (expectedBase === observedBase) return undefined;
	const expectedEntry = availableModels.find((entry) => entry.fullId === expectedBase);
	if (expectedEntry) {
		if (expectedEntry.id === observedBase) return undefined;
		const expectedIdLeaf = expectedEntry.id.slice(expectedEntry.id.lastIndexOf("/") + 1);
		const expectedFullIdLeaf = expectedEntry.fullId.slice(expectedEntry.fullId.lastIndexOf("/") + 1);
		if (expectedIdLeaf === observedBase || expectedFullIdLeaf === observedBase) return undefined;
	}
	return `model_verification_failed: child reported a different model than the session model. Expected '${expectedModel}' but observed '${observedModel}'.`;
}

/**
 * Failures reported as `<tool> failed (exit N): ...` or `<tool> failed with
 * exit code N` come from a tool call inside the child's task, not from the
 * provider/model, however network-flavored their details read. Tool names
 * include namespaced forms like `mcp.server/write`.
 */
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

/**
 * Context-overflow signals: the input was too large for the model's context
 * window, so rerunning the same input cannot succeed. Callers treat overflow
 * as terminal and surface a clear "input too large" error.
 */
const CONTEXT_OVERFLOW_PATTERNS = [
	/context(?: length| window| limit)? (?:exceed|overflow|too long)/i,
	/maximum context length/i,
	/too many tokens/i,
	/token limit/i,
	/context_length_exceeded/i,
	/length_required/i,
	/maximum.*tokens/i,
	/prompt.*too long/i,
	/input.*too long/i,
	/exceeded.*context/i,
	/context.*overflow/i,
];

export function isContextOverflow(error: string | undefined): boolean {
	if (!error) return false;
	if (TOOL_FAILURE_PREFIX.test(error.trim())) return false;
	return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(error));
}

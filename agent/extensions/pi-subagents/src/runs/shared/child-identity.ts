import type { AsyncStatus, NestedRunSummary } from "../../shared/types.ts";

export type AsyncStatusStep = NonNullable<AsyncStatus["steps"]>[number];

export interface ResolvedAsyncStatusChild {
	index: number;
	step: AsyncStatusStep;
	id: string;
	nested?: NestedRunSummary;
}

export type AsyncStatusChildResolution =
	| { ok: true; child: ResolvedAsyncStatusChild }
	| { ok: false; code: "not_found" | "ambiguous"; message: string };

export function asyncStatusChildIdentity(step: AsyncStatusStep, index: number): string {
	return step.workflowKey ?? step.runId ?? `step:${index}`;
}

export function asyncStatusChildIdentityCandidates(step: AsyncStatusStep, index: number): string[] {
	return [...new Set([step.workflowKey, step.runId, `step:${index}`].filter((value): value is string => typeof value === "string" && value.length > 0))];
}

export function resolveAsyncStatusChild(
	status: Pick<AsyncStatus, "runId" | "steps">,
	childId: string,
	options: { includeNested?: boolean } = {},
): AsyncStatusChildResolution {
	const matches: ResolvedAsyncStatusChild[] = [];
	for (const [index, step] of (status.steps ?? []).entries()) {
		if (asyncStatusChildIdentityCandidates(step, index).includes(childId)) {
			matches.push({ index, step, id: asyncStatusChildIdentity(step, index) });
		}
		if (options.includeNested) {
			const findNested = (children: readonly NestedRunSummary[] | undefined): void => {
				for (const nested of children ?? []) {
					if (nested.id === childId) matches.push({ index, step, id: nested.id, nested });
					findNested(nested.children);
				}
			};
			findNested(step.children);
		}
	}
	if (matches.length === 1) return { ok: true, child: matches[0]! };
	if (matches.length > 1) return { ok: false, code: "ambiguous", message: `Child '${childId}' is ambiguous under async run '${status.runId}'.` };
	return { ok: false, code: "not_found", message: `Child '${childId}' was not found under async run '${status.runId}'.` };
}

export function isStoppableAsyncStatusStep(step: AsyncStatusStep): boolean {
	return step.status === "pending" || step.status === "running";
}

export interface ChildTaskIdentity {
	/** Stable task id: retries/resumes keep this id and bump `attempt`. */
	taskId: string;
	/** Human-readable label from the child-specific task (never the shared brief). */
	label: string;
	todoId?: string;
	scopeId?: string;
	parentGoal?: string;
	description?: string;
	attempt: number;
}

export interface ChildTaskIdentityInput {
	runId?: string;
	index?: number;
	/** The child-specific task text (before common context is appended). */
	childTask?: string;
	sharedBrief?: string;
	label?: string;
	todoId?: string;
	scopeId?: string;
	parentGoal?: string;
	description?: string;
	attempt?: number;
	workflowKey?: string;
	childId?: string;
}

/**
 * Generate the visible child label from the child-specific task BEFORE common
 * context is added. Shared briefs must not overwrite the visible identity:
 * "task #4 automatic Luka live search" stays visible as that task.
 */
export function labelChildTask(childTask: string | undefined, fallback = "child task"): string {
	const text = (childTask ?? "").replace(/\s+/g, " ").trim();
	if (!text) return fallback;
	// First meaningful clause: cut at sentence boundaries and framework
	// scaffolding ("Task #4: ..." keeps its body — colons do not split).
	const clause = text.split(/(?<=[.;!?])\s+|\s+---\s+/)[0] ?? text;
	const cleaned = clause
		.replace(/^(task\s*#?\d+[:\s-]+)?(please\s+)?/i, (prefix) => (/task\s*#?\d+/i.test(prefix) ? `${prefix.trim()} ` : ""))
		.trim();
	const label = (cleaned || text).slice(0, 96).trim();
	return label || fallback;
}

function sanitizeId(value: string | undefined, max = 160): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 1024 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
	return trimmed.slice(0, max);
}

/**
 * Build the stable child task identity. Identity binds retries: a replacement
 * run keeps the same taskId with attempt+1 instead of becoming an anonymous
 * new run. Recovery notes reference taskId — never "the third anonymous
 * child".
 */
export function buildChildTaskIdentity(input: ChildTaskIdentityInput): ChildTaskIdentity {
	const attempt = Number.isSafeInteger(input.attempt) && (input.attempt as number) > 0 ? (input.attempt as number) : 1;
	// Legacy contract (session-metrics record()): workflowKey binds before
	// childId. Transcript-derived identity must key identically or ledger
	// aggregates diverge from footer/metrics counters on the same rows.
	const explicit = sanitizeId(input.workflowKey) ?? sanitizeId(input.childId);
	const runId = sanitizeId(input.runId, 128);
	const index = Number.isSafeInteger(input.index) ? (input.index as number) : undefined;
	const taskId = explicit
		?? (runId !== undefined && index !== undefined ? `${runId}#${index}` : undefined)
		?? runId
		?? `task-${index ?? 0}`;
	const label = sanitizeId(input.label, 160) ?? labelChildTask(input.childTask);
	return {
		taskId,
		label,
		...(sanitizeId(input.todoId) ? { todoId: sanitizeId(input.todoId) } : {}),
		...(sanitizeId(input.scopeId) ? { scopeId: sanitizeId(input.scopeId) } : {}),
		...(sanitizeId(input.parentGoal, 280) ? { parentGoal: sanitizeId(input.parentGoal, 280) } : {}),
		...(sanitizeId(input.description ?? input.childTask, 280) ? { description: sanitizeId(input.description ?? input.childTask, 280) } : {}),
		attempt,
	};
}

/** Bind a retry/resume to the same logical task with a bumped attempt. */
export function nextAttemptIdentity(identity: ChildTaskIdentity): ChildTaskIdentity {
	return { ...identity, attempt: identity.attempt + 1 };
}

/**
 * Todo <-> subagent <-> review linkage.
 *
 * Todos are the stable logical work graph: a todo owns child attempts,
 * background jobs, council decisions, test checkpoints, and review rounds —
 * all referencing the todo id instead of requiring post-hoc inference.
 *
 * When a delegated task is recovered in the parent, ownership updates
 * atomically: owner/execution mode, recovery reason, evidence, replacement
 * run, and completion state change together. A todo never says "closed in
 * parent" while its authoritative execution field still says `subagent`.
 *
 * Structural typing keeps this module dependency-free; it operates on the
 * shared Task shape without importing the todo tool package.
 */

export type TodoExecution = "self" | "subagent" | "swarm" | "fusion";

export interface LinkableTask {
	id: number;
	status?: string;
	owner?: string;
	execution?: TodoExecution;
	evidence?: string;
	refs?: string[];
	runId?: string;
	metadata?: Record<string, unknown>;
}

function cleanRef(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 256 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
	return trimmed;
}

function addRefs(task: LinkableTask, refs: string[]): string[] {
	const merged = [...(task.refs ?? [])];
	for (const ref of refs) {
		const cleaned = cleanRef(ref);
		if (cleaned && !merged.includes(cleaned)) merged.push(cleaned);
	}
	return merged.slice(-128);
}

export interface RecoveryOwnershipInput {
	/** Why the work moved (bounded, no prompts). */
	reason: string;
	/** Evidence summary for the todo record. */
	evidence?: string;
	/** Replacement run id when a new attempt was spawned. */
	replacementRunId?: string;
	/** Replacement child task id (stable logical identity). */
	replacementTaskId?: string;
	/** Completion state after recovery. */
	completed?: boolean;
}

/**
 * Atomically move a delegated todo to parent execution. Owner, execution
 * mode, recovery reason, evidence, replacement run, and completion state are
 * set in one update — never partially.
 */
export function applyRecoveryOwnership<T extends LinkableTask>(task: T, input: RecoveryOwnershipInput): T {
	const reason = input.reason.slice(0, 280);
	const refs = addRefs(task, [
		`recovery:${reason}`,
		...(input.replacementTaskId && cleanRef(`child:${input.replacementTaskId}`) ? [`child:${input.replacementTaskId}`] : []),
	]);
	return {
		...task,
		owner: "parent",
		execution: "self",
		status: input.completed === true ? "completed" : (task.status ?? "in-progress"),
		...(input.evidence ? { evidence: input.evidence.slice(0, 2000) } : {}),
		...(input.replacementRunId && cleanRef(input.replacementRunId) ? { runId: input.replacementRunId } : {}),
		refs,
		metadata: {
			...(task.metadata ?? {}),
			recoveredInParent: true,
			recoveryReason: reason,
		},
	};
}

export interface AttemptLinkInput {
	runId?: string;
	attempt?: number;
	childTaskId: string;
	route?: string;
}

/** Link a child attempt to its owning todo. Retries append; nothing is overwritten. */
export function linkAttemptToTodo<T extends LinkableTask>(task: T, input: AttemptLinkInput): T {
	const attempt = Number.isSafeInteger(input.attempt) ? input.attempt as number : 1;
	const refs = addRefs(task, [
		`child:${input.childTaskId}#${attempt}`,
		...(input.runId && cleanRef(`run:${input.runId}`) ? [`run:${input.runId}`] : []),
		...(input.route && cleanRef(`route:${input.route}`) ? [`route:${input.route}`] : []),
	]);
	return {
		...task,
		refs,
		...(input.runId && cleanRef(input.runId) ? { runId: input.runId } : {}),
	};
}

export interface ReviewLinkInput {
	reviewId: string;
	kind?: string;
	coverage?: string;
}

/** Link a review round to its owning todo. */
export function linkReviewToTodo<T extends LinkableTask>(task: T, input: ReviewLinkInput): T {
	const refs = addRefs(task, [
		`review:${input.reviewId}`,
		...(input.kind && cleanRef(`review-kind:${input.kind}`) ? [`review-kind:${input.kind}`] : []),
		...(input.coverage && cleanRef(`coverage:${input.coverage}`) ? [`coverage:${input.coverage}`] : []),
	]);
	return { ...task, refs };
}

export interface CheckpointLinkInput {
	kind: "test" | "council" | "job" | "artifact";
	id: string;
}

/** Link test checkpoints, council decisions, background jobs, artifacts. */
export function linkCheckpointToTodo<T extends LinkableTask>(task: T, input: CheckpointLinkInput): T {
	const ref = cleanRef(`${input.kind}:${input.id}`);
	if (!ref) return task;
	return { ...task, refs: addRefs(task, [ref]) };
}

/** All child task ids owned by this todo (from refs, no inference). */
export function childTasksOfTodo(task: LinkableTask): string[] {
	return [...new Set((task.refs ?? [])
		.filter((ref) => ref.startsWith("child:"))
		.map((ref) => ref.slice("child:".length).split("#")[0]!)
		.filter(Boolean))];
}

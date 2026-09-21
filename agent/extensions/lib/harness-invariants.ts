/**
 * Harness integrity invariant checker.
 *
 * Detects contradictions between surfaces that must share one canonical store:
 * aggregate says stopped but detail says failed; logical child count differs
 * from reconstructed rows; cost unknown but rendered as zero; terminal child
 * still counted active; retry linked to the wrong task; acceptance failure
 * without execution evidence; model suffix disagreeing with the thinking
 * field. Findings surface as harness-integrity warnings — never silent.
 *
 * Dependency-free and pure. Shapes are structural so embedded collectors,
 * reports, and diagnostics can all be checked without importing each other.
 */

export interface InvariantInput {
	ledger?: {
		tasks: Array<{
			taskId: string;
			state: string;
			attempts: Array<{ attempt: number; state: string; runId?: string; execution?: { status?: string }; acceptance?: { status?: string } }>;
			execution?: { status?: string };
			acceptance?: { status?: string };
		}>;
	};
	aggregate?: { stopped?: number; failed?: number; completed?: number; running?: number; active?: number };
	renderedRows?: Array<{ taskId?: string; state?: string }>;
	cost?: { unknown?: boolean; seen?: boolean; formatted?: string; total?: number };
	models?: Array<{ route?: string; thinking?: string[] }>;
}

export interface InvariantViolation {
	id: string;
	severity: "warning" | "error";
	message: string;
}

const TERMINAL = new Set(["stopped", "completed", "failed"]);

/** Check cross-surface invariants; empty means consistent. */
export function checkHarnessInvariants(input: InvariantInput): InvariantViolation[] {
	const violations: InvariantViolation[] = [];
	const tasks = input.ledger?.tasks ?? [];

	// Aggregate vs logical-task detail.
	if (input.aggregate) {
		const byState = new Map<string, number>();
		for (const task of tasks) byState.set(task.state, (byState.get(task.state) ?? 0) + 1);
		for (const [field, state] of [["stopped", "stopped"], ["failed", "failed"], ["completed", "completed"], ["running", "running"]] as const) {
			const expected = (input.aggregate as Record<string, number | undefined>)[field];
			if (expected !== undefined && expected !== (byState.get(state) ?? 0)) {
				violations.push({
					id: "aggregate-detail-mismatch",
					severity: "error",
					message: `aggregate ${field}=${expected} disagrees with logical-task detail (${byState.get(state) ?? 0} ${state})`,
				});
			}
		}
		const activeDetail = tasks.filter((task) => !TERMINAL.has(task.state)).length;
		if (input.aggregate.active !== undefined && input.aggregate.active !== activeDetail) {
			violations.push({
				id: "active-count-mismatch",
				severity: "error",
				message: `aggregate active=${input.aggregate.active} disagrees with non-terminal logical tasks (${activeDetail})`,
			});
		}
	}

	// Rendered rows vs canonical tasks.
	if (input.renderedRows) {
		if (input.renderedRows.length !== tasks.length) {
			violations.push({
				id: "row-count-mismatch",
				severity: "warning",
				message: `rendered ${input.renderedRows.length} child rows for ${tasks.length} logical tasks; say "unresolved linkage", not "omitted"`,
			});
		}
		for (const row of input.renderedRows) {
			const task = tasks.find((candidate) => candidate.taskId === row.taskId);
			if (row.taskId && !task) {
				violations.push({ id: "row-without-task", severity: "warning", message: `rendered row ${row.taskId} has no logical task` });
			} else if (task && row.state && row.state !== task.state) {
				violations.push({
					id: "row-state-mismatch",
					severity: "error",
					message: `row ${row.taskId} renders ${row.state} but the logical task is ${task.state}`,
				});
			}
		}
	}

	// Terminal children must not be counted active; retries bind to one task.
	const runOwners = new Map<string, string>();
	for (const task of tasks) {
		for (const attempt of task.attempts) {
			if (attempt.runId) {
				const owner = runOwners.get(attempt.runId);
				if (owner && owner !== task.taskId) {
					violations.push({
						id: "retry-wrong-task",
						severity: "error",
						message: `run ${attempt.runId} linked to ${task.taskId} but already owned by ${owner}`,
					});
				} else {
					runOwners.set(attempt.runId, task.taskId);
				}
			}
		}
		if (task.acceptance?.status === "failed" && (task.execution?.status === "none" || task.execution?.status === undefined)) {
			violations.push({
				id: "acceptance-without-execution",
				severity: "error",
				message: `task ${task.taskId} failed acceptance with no execution evidence`,
			});
		}
	}

	// Cost: unknown must never render as zero.
	if (input.cost) {
		const rendered = input.cost.formatted ?? "";
		if (input.cost.unknown === true && /^\$0(?:\.0+)?(?:\s|$)/.test(rendered)) {
			violations.push({
				id: "unknown-cost-as-zero",
				severity: "error",
				message: `cost is unknown but rendered as ${rendered}; unknown is first-class, never $0`,
			});
		}
	}

	// Model suffix vs thinking field.
	for (const model of input.models ?? []) {
		const match = (model.route ?? "").match(/:(off|low|medium|high)$/i);
		const declared = (model.thinking ?? []).filter(Boolean);
		if (match && declared.length && !declared.some((level) => level.toLowerCase() === match[1]!.toLowerCase())) {
			violations.push({
				id: "thinking-suffix-mismatch",
				severity: "warning",
				message: `route ${model.route} suffix :${match[1]} disagrees with thinking [${declared.join(", ")}]`,
			});
		}
	}

	return violations.slice(0, 64);
}

/** Render violations as harness-integrity warnings for diagnostics UIs. */
export function formatInvariantWarnings(violations: InvariantViolation[]): string[] {
	return violations.map((violation) => `harness-integrity [${violation.severity}]: ${violation.message}`);
}

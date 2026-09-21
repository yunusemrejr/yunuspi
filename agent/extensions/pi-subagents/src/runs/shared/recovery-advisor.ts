/**
 * Cause-specific, route-specific recovery advisor.
 *
 * One generic recovery message for structurally different failures is a bug.
 * Each failure category maps to its own fix:
 *   invalid schema      -> fix the wire schema or switch backend
 *   provider overload   -> retry a permitted fallback
 *   budget block        -> choose an eligible authorized route
 *   output truncation   -> resume or split the work
 *   acceptance failure  -> inspect the result
 *   context overflow    -> reduce context
 *
 * Deterministic request-shape failures (invalid parameters, unsupported
 * schemas, malformed structured-output contracts, unsupported provider
 * fields) are never retried unchanged: recovery must modify the payload,
 * backend, tool subset, or budget first — on every provider path.
 *
 * Logical-task recovery precedes model retry: usable artifacts, session
 * state, tool evidence, or partial results are recovered before any
 * replacement is spawned. Parallel-group recovery touches failed logical
 * tasks only; successful and still-running siblings are preserved.
 *
 * Dependency-free and pure.
 */
import { mayRetryShape, type FailureCause } from "./failure-cause.ts";
import { planResume } from "./output-budget.ts";
import type { LogicalChildTask } from "./child-ledger.ts";

export type RecoveryAction =
	| "fix-wire-schema"
	| "switch-backend"
	| "retry-fallback"
	| "choose-eligible-route"
	| "resume"
	| "split-work"
	| "inspect-result"
	| "reduce-context"
	| "wait-retry"
	| "recover-artifacts"
	| "authorize-or-fund"
	| "check-permissions"
	| "fix-dependency"
	| "abandon";

export interface RecoveryAdvice {
	actions: RecoveryAction[];
	/** Deterministic explanation; safe for user-visible recovery notes. */
	reason: string;
	/** Recovery stays bound to this logical task (never an anonymous run). */
	taskId?: string;
	/** Suggested replacement attempt number when a relaunch is advised. */
	replacementAttempt?: number;
	/** Whether the payload/shape must change before any retry. */
	mustChangeShape: boolean;
}

export interface RecoveryContext {
	taskId?: string;
	attempt?: number;
	backend?: string;
	authorizedBackends?: string[];
	hasArtifacts?: boolean;
	hasSessionState?: boolean;
	hasPartialResults?: boolean;
	currentShapeHash?: string;
	previousShapeHash?: string;
}

export function adviseRecovery(cause: FailureCause, context: RecoveryContext = {}): RecoveryAdvice {
	const taskId = context.taskId;
	const attempt = Number.isSafeInteger(context.attempt) ? (context.attempt as number) : 1;
	const productive = context.hasArtifacts === true || context.hasSessionState === true || context.hasPartialResults === true;
	const alternateBackend = (context.authorizedBackends ?? []).find((backend) => backend !== context.backend);

	const shapeGate = cause.deterministicShape
		? mayRetryShape(cause, context.previousShapeHash, context.currentShapeHash)
		: { allowed: cause.retryable, reason: cause.retryable ? "transient" : "not retryable" };

	switch (cause.category) {
		case "schema-incompatible":
		case "unsupported-field":
			return {
				actions: alternateBackend ? ["fix-wire-schema", "switch-backend"] : ["fix-wire-schema"],
				reason: `deterministic request-shape failure on ${cause.backend ?? context.backend ?? "backend"}${cause.tool ? ` (tool ${cause.tool})` : ""}${cause.schemaField ? ` at ${cause.schemaField}` : ""}: project a compatible wire schema or narrow the tool subset; ${shapeGate.reason}`,
				taskId,
				mustChangeShape: true,
			};
		case "invalid-request":
			return {
				actions: alternateBackend ? ["fix-wire-schema", "switch-backend"] : ["fix-wire-schema"],
				reason: `invalid request shape (${cause.providerCode ?? "provider validation"}): modify payload, backend, or tool subset before retry; ${shapeGate.reason}`,
				taskId,
				mustChangeShape: true,
			};
		case "overload":
		case "rate-limit":
			return {
				actions: alternateBackend ? ["retry-fallback", "switch-backend"] : ["wait-retry"],
				reason: `${cause.category} on ${cause.backend ?? context.backend ?? "provider"}: retry a permitted fallback route; same-model elsewhere stays eligible`,
				taskId,
				replacementAttempt: attempt + 1,
				mustChangeShape: false,
			};
		case "transport":
		case "timeout":
			return {
				actions: productive ? ["recover-artifacts", "retry-fallback"] : ["retry-fallback"],
				reason: `${cause.category}: ${productive ? "recover retained evidence first, then " : ""}retry; no provider-shape change needed`,
				taskId,
				replacementAttempt: productive ? undefined : attempt + 1,
				mustChangeShape: false,
			};
		case "output-truncated": {
			const resume = planResume({
				hasArtifacts: context.hasArtifacts === true,
				hasSessionState: context.hasSessionState === true,
				hasPartialResults: productive,
				truncation: cause.truncation,
				acceptance: cause.acceptance,
			});
			return {
				actions: resume.resumable ? (resume.continuationScope === "synthesis-only" ? ["resume"] : ["resume", "split-work"]) : ["split-work"],
				reason: `truncated (${cause.truncation}): ${resume.instructions}`,
				taskId,
				mustChangeShape: false,
			};
		}
		case "context-overflow":
			return {
				actions: ["reduce-context", "split-work"],
				reason: "context overflow: reduce child context (fresh mode, pruned fork, artifact handoff) or split the work",
				taskId,
				replacementAttempt: attempt + 1,
				mustChangeShape: true,
			};
		case "budget-exhausted":
			return {
				actions: ["choose-eligible-route"],
				reason: "budget block: choose an eligible authorized route within caps; retrying the same route cannot help",
				taskId,
				mustChangeShape: true,
			};
		case "quota":
			return {
				actions: alternateBackend ? ["switch-backend"] : ["authorize-or-fund"],
				reason: "quota exhausted: use a non-exhausted authorized provider or fund the account",
				taskId,
				mustChangeShape: true,
			};
		case "auth":
			return {
				actions: ["authorize-or-fund"],
				reason: "dead credentials: re-authorize; never retry or reroute silently",
				taskId,
				mustChangeShape: true,
			};
		case "acceptance":
			return {
				actions: productive ? ["inspect-result", "resume"] : ["inspect-result"],
				reason: `execution produced output that failed acceptance (${cause.acceptance}): inspect the result; do not relaunch blindly`,
				taskId,
				mustChangeShape: false,
			};
		case "permission":
			return {
				actions: ["check-permissions"],
				reason: "permission failure: check authorization; retrying unchanged cannot help",
				taskId,
				mustChangeShape: true,
			};
		case "dependency":
		case "process-signal":
			return {
				actions: ["fix-dependency"],
				reason: `${cause.category}: repair the environment or dependency, then relaunch`,
				taskId,
				replacementAttempt: attempt + 1,
				mustChangeShape: false,
			};
		case "interrupted":
			return {
				actions: ["resume"],
				reason: "interrupted but recoverable: resume the retained session",
				taskId,
				mustChangeShape: false,
			};
		case "stopped":
			return {
				actions: [],
				reason: "intentionally stopped: no recovery",
				taskId,
				mustChangeShape: false,
			};
		case "unknown":
		case "none":
		default:
			return {
				actions: productive ? ["recover-artifacts", "inspect-result"] : ["inspect-result"],
				reason: `unclassified outcome: ${productive ? "recover retained evidence, then " : ""}inspect before deciding`,
				taskId,
				mustChangeShape: false,
			};
	}
}

/**
 * Parallel-group recovery scope: failed logical tasks only. Successful and
 * still-running children are preserved automatically — they are never
 * relaunched because a sibling failed.
 */
export function recoveryScope(tasks: readonly LogicalChildTask[]): { recover: LogicalChildTask[]; preserved: LogicalChildTask[] } {
	const recover: LogicalChildTask[] = [];
	const preserved: LogicalChildTask[] = [];
	for (const task of tasks) {
		if (task.state === "failed" || task.state === "paused") recover.push(task);
		else preserved.push(task);
	}
	return { recover, preserved };
}

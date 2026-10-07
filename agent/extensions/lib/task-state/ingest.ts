/**
 * Task State Graph — deterministic ingest mapping.
 *
 * Pure translators from harness happenings to graph events. No I/O, no model
 * calls, no clock reads (callers pass `ts`). Every emitted event carries a
 * stable idempotent id so replays and double delivery are no-ops.
 */
import { createHash } from "node:crypto";
import { tokenizeSimple } from "../bash-routing.ts";
import type {
	TaskEntityKind,
	TaskEntityStatus,
	TaskEvent,
	TaskLinkKind,
	TaskProvenance,
	TaskRefs,
	EntityUpsertEvent,
	EntityStatusEvent,
	LinkEvent,
} from "./types.ts";

export function stableId(parts: Array<string | number | undefined | null>): string {
	return createHash("sha256")
		.update(parts.map((part) => String(part ?? "")).join("\0"))
		.digest("hex")
		.slice(0, 24);
}

const clip = (value: unknown, max: number): string =>
	String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function taskIdFor(sessionId: string, epoch: number): string {
	return `task-${stableId([sessionId]).slice(0, 8)}-${Math.max(0, Math.floor(epoch))}`;
}

/** Normalize a failure message into a repeatable family key. */
export function failureFamily(message: string): string {
	const normalized = String(message ?? "")
		.toLowerCase()
		.replace(/[0-9a-f]{7,40}/g, "#")
		.replace(/\d+(\.\d+)+/g, "#")
		.replace(/\b\d+\b/g, "#")
		.replace(/["']/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);
	return `fam-${stableId([normalized]).slice(0, 12)}`;
}

export interface EntityInput {
	id: string;
	kind: TaskEntityKind;
	status?: TaskEntityStatus;
	title: string;
	detail?: string;
	provenance: TaskProvenance;
	refs?: TaskRefs;
	family?: string;
}

export interface IngestContext {
	sessionId: string;
	taskId: string;
	ts: number;
}

export function upsertEvent(ctx: IngestContext, entity: EntityInput, dedup = ""): EntityUpsertEvent {
	return {
		eventId: `ev-${stableId(["upsert", entity.id, dedup || entity.title])}`,
		ts: ctx.ts,
		sessionId: ctx.sessionId,
		taskId: ctx.taskId,
		kind: "entity-upsert",
		entity: {
			id: entity.id,
			kind: entity.kind,
			status: entity.status ?? "active",
			title: clip(entity.title, 500),
			detail: entity.detail === undefined ? undefined : clip(entity.detail, 2000),
			provenance: entity.provenance,
			refs: entity.refs,
			family: entity.family,
		},
	};
}

export function statusEvent(
	ctx: IngestContext,
	entityId: string,
	status: TaskEntityStatus,
	why = "",
): EntityStatusEvent {
	return {
		eventId: `ev-${stableId(["status", entityId, status, why])}`,
		ts: ctx.ts,
		sessionId: ctx.sessionId,
		taskId: ctx.taskId,
		kind: "entity-status",
		entityId,
		status,
		why: why ? clip(why, 280) : undefined,
	};
}

export function linkEvent(
	ctx: IngestContext,
	from: string,
	to: string,
	link: TaskLinkKind,
): LinkEvent {
	return {
		eventId: `ev-${stableId(["link", from, link, to])}`,
		ts: ctx.ts,
		sessionId: ctx.sessionId,
		taskId: ctx.taskId,
		kind: "link",
		from,
		to,
		link,
	};
}

export type FollowupMode = "new-task" | "followup" | "correction";

const NEW_TASK_CUES =
	/\b(?:new task|fresh task|different task|start over from scratch|forget (?:everything|all|the) (?:above|previous)|unrelated (?:question|task|request))\b/i;
const CORRECTION_CUES =
	/\b(?:actually|instead(?: of)?|correction|my mistake|i meant|should have said|no[,!]?\s+(?:don't|do not|not|use|plain)|scratch that|revert that|change of plans?)\b/i;

/**
 * Follow-up vs new-task classification. Reuses the prompt-analysis relation
 * vocabulary when the caller already has it; otherwise falls back to small
 * deterministic cues. Defaults to follow-up: a small follow-up must never
 * erase earlier scope.
 */
export function classifyUserInput(
	text: string,
	relation?: string,
): { mode: FollowupMode; reason: string } {
	const rel = String(relation ?? "").trim().toLowerCase();
	if (rel === "unrelated" || rel === "replace" || rel === "interrupt") {
		return { mode: "new-task", reason: `prompt-analysis relation ${rel}` };
	}
	if (rel === "correct") return { mode: "correction", reason: "prompt-analysis relation correct" };
	if (rel) return { mode: "followup", reason: `prompt-analysis relation ${rel}` };
	const input = String(text ?? "");
	if (NEW_TASK_CUES.test(input)) return { mode: "new-task", reason: "explicit new-task cue" };
	if (CORRECTION_CUES.test(input)) return { mode: "correction", reason: "correction cue" };
	return { mode: "followup", reason: "default continuity" };
}

const tokenSet = (text: string): Set<string> =>
	new Set(String(text ?? "").toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);

function overlap(a: string, b: string): number {
	const left = tokenSet(a);
	const right = tokenSet(b);
	if (!left.size || !right.size) return 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared += 1;
	return shared / Math.max(left.size, right.size);
}

export interface LedgerRequirement {
	id: string;
	text: string;
}

/**
 * Requirement entities from requirement-ledger items. Ids stay aligned with
 * the ledger (`R#`) so projections and the ledger never disagree about which
 * requirement is which; the requirement text hash disambiguates reuse.
 */
export function requirementEvents(
	ctx: IngestContext,
	items: readonly LedgerRequirement[],
	mode: FollowupMode,
	priorRequirements: ReadonlyMap<string, string> = new Map(),
): TaskEvent[] {
	const events: TaskEvent[] = [];
	for (const item of items) {
		const id = `req-${ctx.taskId}-${item.id}`;
		events.push(upsertEvent(ctx, {
			id,
			kind: "requirement",
			status: "active",
			title: `${item.id}: ${clip(item.text, 220)}`,
			detail: clip(item.text, 800),
			provenance: "literal-user",
			refs: { requirementId: item.id },
		}, `${ctx.taskId}:${item.id}:${stableId([item.text])}`));
		events.push(linkEvent(ctx, id, ctx.taskId, "child-of"));
		if (mode === "correction" && !priorRequirements.has(id)) {
			// A correction supersedes the prior requirement it overlaps most,
			// preserving history instead of silently deleting it.
			let best = "";
			let bestScore = 0;
			for (const [priorId, priorText] of priorRequirements) {
				if (priorId === id) continue;
				const score = overlap(item.text, priorText);
				if (score > bestScore) {
					bestScore = score;
					best = priorId;
				}
			}
			if (best && bestScore >= 0.25) {
				events.push(linkEvent(ctx, id, best, "supersedes"));
			} else {
				events.push(upsertEvent(ctx, {
					id: `gap-${stableId([ctx.taskId, item.id, "correction-target"])}`,
					kind: "gap",
					status: "active",
					title: `Correction ${item.id} has no clear prior-state target`,
					detail: clip(item.text, 500),
					provenance: "main-agent",
				}, `correction-gap:${ctx.taskId}:${item.id}`));
			}
		}
	}
	return events;
}

export function inferredConstraintEvents(
	ctx: IngestContext,
	inferred: ReadonlyArray<{ text: string; confidence: number }>,
): TaskEvent[] {
	return inferred.slice(0, 8).map((item) =>
		upsertEvent(ctx, {
			id: `icon-${stableId([ctx.taskId, item.text])}`,
			kind: "inferred-constraint",
			status: "proposed",
			title: clip(item.text, 240),
			detail: `Advisory inference, not a literal user constraint. Stated confidence ${Number(item.confidence).toFixed(2)}.`,
			provenance: "prompt-analysis",
		}, `inferred:${ctx.taskId}:${stableId([item.text])}`),
	);
}

/** Todo tool results become linked work entities; the todo tool still owns planning. */
export function todoEvents(
	ctx: IngestContext,
	tasks: ReadonlyArray<{ id: number; title?: string; status?: string }>,
): TaskEvent[] {
	const events: TaskEvent[] = [];
	for (const task of tasks.slice(0, 64)) {
		if (!Number.isSafeInteger(task.id)) continue;
		const id = `todo-${ctx.taskId}-${task.id}`;
		const status: TaskEntityStatus =
			task.status === "completed" ? "implemented"
			: task.status === "in_progress" ? "active"
			: task.status === "deleted" ? "invalidated"
			: "proposed";
		events.push(upsertEvent(ctx, {
			id,
			kind: "work",
			status,
			title: clip(task.title ?? `todo ${task.id}`, 240),
			provenance: "main-agent",
			refs: { todoId: task.id },
		}, `todo:${ctx.taskId}:${task.id}:${task.status ?? ""}`));
		events.push(linkEvent(ctx, id, ctx.taskId, "child-of"));
	}
	return events;
}

/** File mutations bump file versions and record the change + affected file. */
export function fileWriteEvents(
	ctx: IngestContext,
	input: { path?: unknown; toolCallId?: string; contentHash?: string },
	fileVersion: number,
): TaskEvent[] {
	if (typeof input.path !== "string" || !input.path) return [];
	const file = input.path.slice(0, 512);
	const changeId = `chg-${stableId([ctx.taskId, file, String(input.toolCallId ?? ctx.ts)])}`;
	const artifactId = `file-${stableId([ctx.taskId, file])}`;
	return [
		{
			eventId: `ev-${stableId(["file-version", ctx.taskId, file, fileVersion])}`,
			ts: ctx.ts,
			sessionId: ctx.sessionId,
			taskId: ctx.taskId,
			kind: "file-version",
			file,
			version: fileVersion,
			hash: typeof input.contentHash === "string" ? input.contentHash.slice(0, 64) : undefined,
			toolCallId: typeof input.toolCallId === "string" ? input.toolCallId : undefined,
		},
		upsertEvent(ctx, {
			id: changeId,
			kind: "tool-exec",
			status: "implemented",
			title: `edit ${file}`,
			provenance: "tool-output",
			refs: { file, fileVersion, toolCallId: typeof input.toolCallId === "string" ? input.toolCallId : undefined },
		}, `change:${ctx.taskId}:${file}:${String(input.toolCallId ?? ctx.ts)}`),
		upsertEvent(ctx, {
			id: artifactId,
			kind: "artifact",
			status: "active",
			title: file,
			provenance: "tool-output",
			refs: { file, fileVersion },
		}, `artifact:${ctx.taskId}:${file}`),
		linkEvent(ctx, changeId, artifactId, "affects"),
		linkEvent(ctx, changeId, ctx.taskId, "child-of"),
	];
}

/**
 * A test-like command is one whose whole point is to check the build, so a
 * passing run of it is evidence and clears the goal's unverified-write debt.
 * A check receipt requires a literal invocation with an observable exit:
 *
 * - Package managers are one family. A pnpm/yarn/bun project must earn a
 *   receipt on the same terms as an npm one; when only `npm` matched, those
 *   projects could never clear the completion gate and the session wedged.
 * - The shared shell tokenizer distinguishes command argv from quoted text.
 *   Only a single command or the existing `cd <dir> &&` wrapper qualifies.
 *   Pipelines, status masking and non-verifying flags produce no passing
 *   receipt, while execution itself remains under the native tool's control.
 */
const RUNNER = /^(?:vitest|jest|eslint|tsc|biome|pytest|tox|mypy|ruff|phpstan|phpunit)$/;
const CHECK_TASK = /^(?:test|tests|check|lint|typecheck|build)(?::[\w.-]+)?$/;
const NON_VERIFY_FLAG = /^(?:--watch(?:All)?(?:=true)?|-w|--help|-h|--version|--listTests|--collect-only|--list(?:-tests)?|-list|--passWithNoTests|--dry-run|--no-run|--if-present|-DskipTests(?:=true)?|-Dmaven\.test\.skip(?:=true)?)$/;

export function isTestLikeCommand(command: string): boolean {
	const raw = String(command ?? "").trim();
	if (!raw || raw.length > 2000) return false;
	// Align with project check receipts: one literal command, optionally after
	// `cd <dir> &&`. Quoted/escaped operators are arguments, never separators.
	const parts: string[] = [];
	let start = 0;
	for (const match of raw.matchAll(/"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\\[\s\S]|&&/g)) {
		if (match[0] !== "&&") continue;
		parts.push(raw.slice(start, match.index)); start = match.index! + 2;
	}
	parts.push(raw.slice(start));
	if (parts.length > 2) return false;
	if (parts.length === 2) {
		const prefix = tokenizeSimple(parts[0].trim());
		if (prefix?.length !== 2 || prefix[0] !== "cd") return false;
	}
	const argv = tokenizeSimple(parts.at(-1)!.trim());
	if (!argv?.length) return false;
	const index = argv.findIndex(token => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
	if (index < 0) return false;
	const tokens = argv.slice(index);
	if (tokens.some(token => NON_VERIFY_FLAG.test(token))) return false;
	const executable = tokens[0].split("/").at(-1)!;
	const args = tokens.slice(1);
	if (RUNNER.test(executable)) return true;
	if (/^(?:npm|pnpm|yarn|bun)$/.test(executable)) {
		const task = args[0] === "run" ? args[1] : args[0];
		return CHECK_TASK.test(task ?? "") || task === "t" || (args[0] === "dlx" && RUNNER.test(args[1] ?? ""));
	}
	if (executable === "npx" || executable === "bunx") return RUNNER.test(args[args[0] === "--no-install" ? 1 : 0] ?? "");
	if (/^(?:mvn|gradlew?|make|just|composer|cargo|go|swift|dotnet|rake|meson|ninja)$/.test(executable)) return CHECK_TASK.test(args[0] ?? "");
	if (executable === "deno") return /^(?:test|check|lint|fmt)$/.test(args[0] ?? "");
	if (/^python3?(?:\.\d+)?$/.test(executable)) return args[0] === "-m" && /^(?:pytest|unittest|tox|ruff|mypy)$/.test(args[1] ?? "");
	return executable === "node" && args[0] === "--test";
}

/** Bash results become attempt/evidence/failure entities with family keys.
 * `pending` marks a launch whose command has not produced a result yet (`bg_run`
 * returns a task id immediately), so a check command is recorded as an attempt
 * without minting a passing-check fact that nothing has confirmed. */
export function bashResultEvents(
	ctx: IngestContext,
	input: { command?: unknown; toolCallId?: string; failed: boolean; excerpt?: string; pending?: boolean },
): TaskEvent[] {
	const command = typeof input.command === "string" ? input.command : "";
	const callId = typeof input.toolCallId === "string" && input.toolCallId ? input.toolCallId : stableId([command, ctx.ts]);
	const attemptId = `att-${stableId([ctx.taskId, callId])}`;
	const events: TaskEvent[] = [
		upsertEvent(ctx, {
			id: attemptId,
			kind: "attempt",
			status: input.failed ? "failed" : input.pending ? "active" : "implemented",
			title: clip(command || "bash", 240),
			detail: clip(input.excerpt ?? "", 800),
			provenance: "tool-output",
			refs: { toolCallId: callId, testCommand: command.slice(0, 300) || undefined },
		}, `attempt:${ctx.taskId}:${callId}:${input.failed ? "failed" : input.pending ? "pending" : "completed"}`),
		linkEvent(ctx, attemptId, ctx.taskId, "child-of"),
	];
	if (input.failed) {
		const family = failureFamily(`${command}\n${input.excerpt ?? ""}`);
		const failureId = `fail-${stableId([ctx.taskId, family, callId])}`;
		events.push(upsertEvent(ctx, {
			id: failureId,
			kind: "failure",
			status: "failed",
			title: clip(input.excerpt || command || "command failed", 240),
			provenance: "tool-output",
			refs: { toolCallId: callId, testCommand: command.slice(0, 300) || undefined },
			family,
		}, `failure:${ctx.taskId}:${callId}`));
		events.push(linkEvent(ctx, failureId, attemptId, "caused-by"));
	} else if (isTestLikeCommand(command) && !input.pending) {
		const evidenceId = `evi-${stableId([ctx.taskId, callId])}`;
		events.push(upsertEvent(ctx, {
			id: evidenceId,
			kind: "evidence",
			status: "active",
			title: `passing check: ${clip(command, 160)}`,
			detail: clip(input.excerpt ?? "", 800),
			provenance: "test-result",
			refs: { toolCallId: callId, testCommand: command.slice(0, 300) || undefined },
		}, `evidence:${ctx.taskId}:${callId}`));
		events.push(linkEvent(ctx, evidenceId, attemptId, "evidences"));
	}
	return events;
}

/** Child results are written back with subagent provenance, never auto-verified. */
export function subagentResultEvents(
	ctx: IngestContext,
	input: { runId: string; agent?: string; ok: boolean; status?: TaskEntityStatus; entityId?: string; nativeRunId?: string; toolCallId?: string; summary?: string; files?: string[] },
): TaskEvent[] {
	const id = input.entityId ?? `child-${stableId([ctx.taskId, input.runId])}`;
	const status = input.status ?? (input.ok ? "implemented" : "failed");
	const events: TaskEvent[] = [
		upsertEvent(ctx, {
			id,
			kind: "child",
			status,
			title: `${clip(input.agent ?? "subagent", 80)} run ${clip(input.runId, 40)}`,
			detail: clip(input.summary ?? "", 1200),
			provenance: "subagent",
			refs: { childRunId: (input.nativeRunId ?? input.runId).slice(0, 120), toolCallId: input.toolCallId },
		}, `child:${ctx.taskId}:${input.runId}:${status}`),
		linkEvent(ctx, id, ctx.taskId, "child-of"),
	];
	for (const file of (input.files ?? []).slice(0, 16)) {
		const artifactId = `file-${stableId([ctx.taskId, file])}`;
		events.push(upsertEvent(ctx, {
			id: artifactId,
			kind: "artifact",
			status: "active",
			title: String(file).slice(0, 512),
			provenance: "subagent",
			refs: { file: String(file).slice(0, 512) },
		}, `artifact:${ctx.taskId}:${file}`));
		events.push(linkEvent(ctx, id, artifactId, "relates-to"));
	}
	return events;
}

/** Reviewer findings attach to entities; disagreement stays representable. */
export function findingEvents(
	ctx: IngestContext,
	input: {
		reviewId: string;
		kind: "observer" | "watchmaker" | "review-council" | "guardian" | "expert-director";
		blocker: boolean;
		note: string;
		targets?: string[];
	},
): TaskEvent[] {
	const provenance: TaskProvenance =
		input.kind === "observer" ? "observer"
		: input.kind === "watchmaker" ? "watchmaker"
		: input.kind === "guardian" ? "guardian"
		: input.kind === "expert-director" ? "expert-director"
		: "review-council";
	const id = `find-${stableId([ctx.taskId, input.reviewId, input.note])}`;
	const events: TaskEvent[] = [
		upsertEvent(ctx, {
			id,
			kind: "finding",
			status: input.blocker ? "blocked" : "active",
			title: clip(input.note, 240),
			provenance,
			refs: { reviewId: input.reviewId.slice(0, 120) },
		}, `finding:${ctx.taskId}:${input.reviewId}:${stableId([input.note])}`),
	];
	for (const target of (input.targets ?? []).slice(0, 8)) {
		events.push(linkEvent(ctx, id, target, "challenges"));
	}
	return events;
}

export function completionClaimEvents(
	ctx: IngestContext,
	input: { claimId: string; blocked: boolean; reason: string; requirementIds?: string[] },
): TaskEvent[] {
	const id = `claim-${stableId([ctx.taskId, input.claimId])}`;
	const events: TaskEvent[] = [
		upsertEvent(ctx, {
			id,
			kind: "completion-claim",
			status: input.blocked ? "blocked" : "active",
			title: input.blocked ? "completion refused: verification unresolved" : "completion claimed",
			detail: clip(input.reason, 1200),
			provenance: "main-agent",
		}, `claim:${ctx.taskId}:${input.claimId}`),
		linkEvent(ctx, id, ctx.taskId, "child-of"),
	];
	for (const req of (input.requirementIds ?? []).slice(0, 32)) {
		events.push(linkEvent(ctx, id, req, "relates-to"));
	}
	return events;
}

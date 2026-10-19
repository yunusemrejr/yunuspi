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
		eventId: `ev-${stableId(["status", entityId, status, why, ctx.ts])}`,
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
		}, `todo:${ctx.taskId}:${task.id}:${task.status ?? ""}:${clip(task.title ?? `todo ${task.id}`, 240)}:${ctx.ts}`));
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
const RUNNER = /^(?:vitest|jest|eslint|tsc|biome|pytest|tox|mypy|ruff|phpstan|phpunit|ctest|rspec|rubocop)$/;
const CHECK_TASK = /^(?:test|tests|check|lint|typecheck|build|verify)(?::[\w.-]+)?$/;
const NON_VERIFY_FLAG = /^(?:--watch(?:All)?(?:=true)?|-w|--help|-h|--version|--listTests|--collect-only|--list(?:-tests)?|-list|--passWithNoTests|--dry-run|--no-run|--if-present|-DskipTests(?:=true)?|-Dmaven\.test\.skip(?:=true)?)$/;

/** Output filter that keeps a check's exit observable only with pipefail. */
export const PIPED_FILTER = /\s*\|\s*(?:tail|head)(?:\s+-n)?\s+-?\d+\s*$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIX_LIMIT = 4;
const SHELL_OPERATORS = "|&;<>()`";
export type CheckPrefix = { cd?: string; env: string[]; command: string; pipefail: boolean };

/** Quote-aware words from the start of a command, stopping before the first
 * unquoted operator (`rest` is that offset). `$` and `~` stay literal text.
 * Null on an unbalanced quote. */
function scanWords(text: string): { words: { value: string; start: number; end: number }[]; rest: number } | null {
	const words: { value: string; start: number; end: number }[] = [];
	let value = "", start = -1, quote: string | null = null, i = 0;
	for (; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && i + 1 < text.length) value += text[++i];
			else value += c;
			continue;
		}
		if (c === " " || c === "\t") {
			if (start >= 0) words.push({ value, start, end: i });
			value = ""; start = -1; continue;
		}
		if (SHELL_OPERATORS.includes(c)) break;
		if (start < 0) start = i;
		if (c === "'" || c === '"') quote = c;
		else if (c === "\\" && i + 1 < text.length) value += text[++i];
		else value += c;
	}
	if (quote) return null;
	if (start >= 0) words.push({ value, start, end: i });
	return { words, rest: i };
}

/** Argv of one simple command. Leading NAME=VALUE words may carry `$`, `~` and
 * quotes (values are literal, never expanded); the command itself must still
 * pass tokenizeSimple, which rejects expansion and every operator. */
export function commandArgv(text: string): string[] | null {
	const trimmed = text.trim();
	const scan = scanWords(trimmed);
	if (!scan) return null;
	const k = scan.words.findIndex(w => !ASSIGNMENT.test(w.value));
	if (k < 0) return scan.rest < trimmed.length ? null : scan.words.map(w => w.value);
	const command = tokenizeSimple(trimmed.slice(scan.words[k].start));
	if (!command) return null;
	return [...scan.words.slice(0, k).map(w => w.value), ...command];
}

/** Split on unquoted `&&` and `;`, keeping each separator and part offset. */
function splitSequence(command: string): { parts: string[]; seps: string[]; starts: number[] } {
	const parts: string[] = [], seps: string[] = [], starts = [0];
	let start = 0;
	for (const match of command.matchAll(/"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\\[\s\S]|&&|;/g)) {
		if (match[0] !== "&&" && match[0] !== ";") continue;
		parts.push(command.slice(start, match.index)); seps.push(match[0]);
		start = match.index! + match[0].length; starts.push(start);
	}
	parts.push(command.slice(start));
	return { parts, seps, starts };
}

/** Peels the harmless prefixes a model writes before a check, at most four
 * `cd DIR &&`, `export NAME=VALUE` (then `;` or `&&`) and `set -[eu]*o
 * pipefail` segments, plus leading inline `NAME=VALUE` words. Assignment values
 * are kept as literal text in `env`, in order, so they still key the receipt.
 * Null when the command holds `$(`, a backtick or a newline anywhere. */
export function peelCheckPrefix(command: string): CheckPrefix | null {
	if (/[`\r\n]|\$\(/.test(command)) return null;
	const { parts, seps, starts } = splitSequence(command);
	const env: string[] = [];
	let cd: string | undefined, pipefail = false, index = 0, peeled = 0;
	for (; index < parts.length - 1 && peeled < PREFIX_LIMIT; index++) {
		const scan = scanWords(parts[index]);
		if (!scan?.words.length || scan.rest < parts[index].length) break;
		const argv = scan.words.map(w => w.value);
		const raw = scan.words.map(w => parts[index].slice(w.start, w.end));
		const sep = seps[index];
		if (argv[0] === "cd" && argv.length === 2 && sep === "&&" && cd === undefined && !parts[index].includes("$")) cd = parts[index].trim();
		else if (argv[0] === "export" && argv.length > 1 && argv.slice(1).every(a => ASSIGNMENT.test(a))) env.push(...raw.slice(1));
		else if (argv.length === 3 && argv[0] === "set" && /^-[eu]*o$/.test(argv[1]) && argv[2] === "pipefail") pipefail = true;
		else break;
		peeled++;
	}
	let remainder = command.slice(starts[index]).trim();
	const scan = scanWords(remainder);
	const k = scan ? scan.words.findIndex(w => !ASSIGNMENT.test(w.value)) : -1;
	if (scan && k > 0) {
		env.push(...scan.words.slice(0, k).map(w => remainder.slice(w.start, w.end)));
		remainder = remainder.slice(scan.words[k].start);
	}
	return { cd, env, command: remainder, pipefail };
}

/** Rebuilds the peeled command as `cd DIR && NAME=VALUE... command`, the shape
 * the receipt key is computed from. `command` overrides the peeled remainder.
 * PATH only locates the runner, so `PATH=... npm test` is the same check as a
 * planned `npm test`; other assignments (APP_TEST_MODE=2) stay in the identity. */
export function joinCheckBody(prefix: CheckPrefix, command = prefix.command): string {
	return [...(prefix.cd ? [`${prefix.cd} &&`] : []), ...prefix.env.filter(assignment => !assignment.startsWith("PATH=")), command].join(" ").trim();
}

function isSingleTestStep(step: string): boolean {
	const argv = commandArgv(step.trim());
	if (!argv?.length) return false;
	const index = argv.findIndex(token => !ASSIGNMENT.test(token));
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
	if ((executable === "uv" || executable === "poetry") && args[0] === "run") return RUNNER.test(args[1] ?? "");
	if (executable === "bundle" && args[0] === "exec") return RUNNER.test(args[1] ?? "") || (args[1] === "rake" && CHECK_TASK.test(args[2] ?? "test"));
	if (/^(?:mvn|gradlew?|make|just|composer|cargo|go|swift|dotnet|rake|meson|ninja)$/.test(executable)) return CHECK_TASK.test(args[0] ?? "");
	if (executable === "deno") return /^(?:test|check|lint|fmt)$/.test(args[0] ?? "");
	if (/^python3?(?:\.\d+)?$/.test(executable)) return args[0] === "-m" && /^(?:pytest|unittest|tox|ruff|mypy)$/.test(args[1] ?? "");
	if (executable === "node") {
		if (args[0] === "--test") return true;
		const script = args.find(arg => !arg.startsWith("-")) ?? "";
		return /(?:^|\/)(?:[\w.-]+\.(?:test|spec)\.(?:[cm]?js|tsx?)|(?:verify-harness|check-public)\.m?js)$/.test(script);
	}
	return false;
}

export function isTestLikeCommand(command: string): boolean {
	const raw = String(command ?? "").trim();
	if (!raw || raw.length > 2000) return false;
	const peeled = peelCheckPrefix(raw);
	if (!peeled) return false;
	// `2>&1` never masks the exit. A `| tail|head N` filter does, unless the
	// same command sets pipefail in its own prefix.
	let remainder = peeled.command;
	const filter = PIPED_FILTER.exec(remainder);
	if (filter) {
		if (!peeled.pipefail) return false;
		remainder = remainder.slice(0, filter.index);
	}
	const body = joinCheckBody(peeled, remainder.replace(/\s+2>&1\s*$/, "").trim());
	const parts: string[] = [];
	let start = 0;
	for (const match of body.matchAll(/"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\\[\s\S]|&&/g)) {
		if (match[0] !== "&&") continue;
		parts.push(body.slice(start, match.index)); start = match.index! + 2;
	}
	parts.push(body.slice(start));
	if (parts.length > 4) return false;
	for (let i = 0; i < parts.length - 1; i++) {
		const prefix = tokenizeSimple(parts[i].trim());
		const isCd = prefix?.length === 2 && prefix[0] === "cd";
		if (!isCd && !isSingleTestStep(parts[i])) return false;
	}
	return isSingleTestStep(parts.at(-1)!);
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
		kind: "observer" | "review-council" | "guardian" | "expert-director";
		blocker: boolean;
		note: string;
		targets?: string[];
	},
): TaskEvent[] {
	const provenance: TaskProvenance =
		input.kind === "observer" ? "observer"
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

/**
 * Goal state — a durable definition of done for the tasks that matter.
 *
 * `/goal <text>` turns a demand into numbered acceptance criteria that only
 * count once they carry evidence, survive compaction and resume, and keep the
 * session working until every criterion is met, waived, or the agent reports a
 * real blocker. Pure and I/O-free: the extension owns persistence, delivery and
 * the tool. Loops are impossible by construction: continuations are bounded
 * and stop at the first continuation that produces no new evidence.
 */
import { extractRequirements } from "./requirement-ledger.ts";
import { completionGateReceipts, type GateDecision, type GateReceipt } from "./completion-gate.ts";

export type CriterionStatus = "open" | "met" | "waived";
export type GoalStatus = "active" | "paused" | "achieved" | "blocked" | "cleared";

export interface GoalCriterion {
	id: string;
	text: string;
	status: CriterionStatus;
	evidence?: string;
}

export interface GoalState {
	version: 1;
	id: string;
	text: string;
	status: GoalStatus;
	criteria: GoalCriterion[];
	/** Continuations issued for this goal. */
	nudges: number;
	/** Progress fingerprint at the last continuation; equal now means the last continuation achieved nothing. */
	progressMark: string;
	/** Consecutive continuations without new evidence. */
	stalls: number;
	/** Why the goal is blocked, stalled or achieved; shown to the user. */
	note?: string;
	createdAt: number;
	updatedAt: number;
	/** Native writes and the latest revision covered by a successful check. */
	verification?: { revision: number; checked: number };
}

export const MAX_CRITERIA = 12;
export const MAX_NUDGES = 6;
export const MAX_STALLS = 2;
const MAX_TEXT = 600;
const MIN_EVIDENCE = 12;
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.{4,})$/;
const VERIFY_ID = "V";
const VERIFY_TEXT = "Result checked end to end against the real artifact (tests run, app launched, output inspected, diff read), not only asserted.";

const clip = (text: string, max = MAX_TEXT) => {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Long prompts reach the model verbatim (the offload system was retired for that reason), so a goal keeps its
 * text as typed, line breaks included; only a runaway paste is bounded. Short forms below are for display. */
export const MAX_GOAL_TEXT = 20_000;
const verbatim = (text: string) => {
	const raw = String(text ?? "").replace(/\r\n?/g, "\n").trim();
	return raw.length > MAX_GOAL_TEXT ? `${raw.slice(0, MAX_GOAL_TEXT - 1)}…` : raw;
};

/** A new goal with criteria seeded from the user's own words plus a mandatory verification criterion. */
export function createGoal(text: string, now = Date.now()): GoalState {
	const goalText = verbatim(text);
	const listed = String(text ?? "").split(/\r?\n/).map((line) => LIST_ITEM.exec(line)?.[1]).filter((item): item is string => !!item);
	const prose = String(text ?? "").split(/\r?\n/).filter((line) => !LIST_ITEM.test(line)).join(" ");
	const extracted = [...(prose.trim() ? extractRequirements(prose).items : []), ...listed].slice(0, MAX_CRITERIA - 2);
	const items = extracted.length ? extracted : [clip(goalText, 240)];
	const criteria: GoalCriterion[] = items.map((item, index) => ({ id: `C${index + 1}`, text: clip(item, 240), status: "open" }));
	criteria.push({ id: VERIFY_ID, text: VERIFY_TEXT, status: "open" });
	return { version: 1, id: `g${now.toString(36)}`, text: goalText, status: "active", criteria, nudges: 0, progressMark: "", stalls: 0, createdAt: now, updatedAt: now };
}

export type GoalCommand =
	| { kind: "set"; text: string }
	| { kind: "status" }
	| { kind: "pause" | "resume" | "clear" | "done" | "retry" }
	| { kind: "criteria"; items: string[] };

const SUBCOMMANDS = new Set(["pause", "resume", "clear", "done", "retry", "status"]);

/** `/goal` argument grammar; anything that is not a subcommand is the goal text. */
export function parseGoalArgs(args: string): GoalCommand {
	const text = String(args ?? "").trim();
	if (!text) return { kind: "status" };
	const [head, ...rest] = text.split(/\s+/);
	const word = head.toLowerCase();
	if (SUBCOMMANDS.has(word) && rest.length === 0) return { kind: word as "status" };
	if (word === "stop" && rest.length === 0) return { kind: "clear" };
	if (word === "criteria" && rest.length) {
		const items = text.slice(head.length).trim().split(/\s*(?:;|\n)\s*/).map((item) => clip(item, 240)).filter((item) => item.length >= 4);
		if (items.length) return { kind: "criteria", items: items.slice(0, MAX_CRITERIA - 1) };
	}
	return { kind: "set", text };
}

const isLive = (goal: GoalState | undefined): goal is GoalState => !!goal && (goal.status === "active" || goal.status === "paused");
export const goalIsLive = isLive;

const open = (goal: GoalState) => goal.criteria.filter((criterion) => criterion.status === "open");

/** Fingerprint of everything that counts as progress: evidence state, not chatter. */
export function progressMark(goal: GoalState): string {
	return JSON.stringify(goal.criteria.map((criterion) => [criterion.id, criterion.status, criterion.evidence ?? ""]));
}

/** Replace the open criteria (met and waived ones keep their record). The verification criterion always remains. */
export function setCriteria(goal: GoalState, items: readonly string[], now = Date.now()): GoalState {
	const settled = goal.criteria.filter((criterion) => criterion.status !== "open" && criterion.id !== VERIFY_ID);
	const verify = goal.criteria.find((criterion) => criterion.id === VERIFY_ID) ?? { id: VERIFY_ID, text: VERIFY_TEXT, status: "open" as const };
	let counter = goal.criteria.reduce((max, criterion) => Math.max(max, Number(/^C(\d+)$/.exec(criterion.id)?.[1] ?? 0)), 0);
	const known = new Set(settled.map((criterion) => criterion.text.toLowerCase()));
	const added: GoalCriterion[] = [];
	for (const item of items) {
		const text = clip(item, 240);
		if (text.length < 4 || known.has(text.toLowerCase())) continue;
		known.add(text.toLowerCase());
		added.push({ id: `C${++counter}`, text, status: "open" });
	}
	// `verify` is last, so a plain slice dropped it exactly when the list filled up —
	// the one moment the end-to-end check matters most. Reserve its slot up front.
	const room = MAX_CRITERIA - 1;
	const kept = settled.slice(0, room);
	const criteria = [...kept, ...added.slice(0, room - kept.length), verify];
	return { ...goal, criteria, updatedAt: now };
}

export interface EvidenceOutcome {
	goal: GoalState;
	error?: string;
}

/** Record evidence for one criterion. Evidence must say what was observed, so a bare "done" is refused. */
export function recordEvidence(goal: GoalState, id: string, status: "met" | "waived", evidence: string, now = Date.now()): EvidenceOutcome {
	const criterion = goal.criteria.find((entry) => entry.id.toLowerCase() === String(id ?? "").trim().toLowerCase());
	if (!criterion) return { goal, error: `No criterion ${JSON.stringify(id)}. Open: ${open(goal).map((entry) => entry.id).join(", ") || "none"}.` };
	const text = clip(evidence, 500);
	const observed = /[\d:/.\\]|\b(?:pass|fail|ok|exit|screenshot|diff|line|file|test|render|output|log|status|http)\w*/i.test(text);
	if (text.length < MIN_EVIDENCE || (status === "met" && !observed)) {
		return { goal, error: `Evidence for ${criterion.id} must state what was observed (command and result, file and line, screenshot finding, status code), not just that it is done.` };
	}
	const criteria = goal.criteria.map((entry) => (entry.id === criterion.id ? { ...entry, status, evidence: text } : entry));
	return { goal: { ...goal, criteria, updatedAt: now } };
}

export interface CompletionContext {
	/** Files were written or edited after the last passing verification command. */
	unverifiedWrites: number;
	/** Native write revision distinguishes fresh debt from a previously refused edit. */
	writeRevision?: number;
	/** Verification receipts already refused once, so the same request becomes a recorded waiver. */
	refused: ReadonlySet<string>;
	verification?: readonly GateReceipt[];
}

/** Completion is refused once per distinct set of gaps; the same call repeated is a recorded waiver so the user is never deadlocked. */
export function goalCompletionGate(goal: GoalState, context: CompletionContext): GateDecision {
	const receipts: GateReceipt[] = open(goal).map((criterion) => ({
		source: "goal", id: criterion.id, state: "open", line: `${criterion.id} open: ${criterion.text}`,
	}));
	if (context.unverifiedWrites > 0) {
		receipts.push({
			source: "goal", id: "writes", revision: String(context.writeRevision ?? goal.verification?.revision ?? 0), state: "unverified", count: context.unverifiedWrites,
			line: `${context.unverifiedWrites} file change(s) since the last passing test/build/run; verify again before claiming completion`,
		});
	}
	return completionGateReceipts("plan-complete", [...receipts, ...(context.verification ?? [])], context.refused);
}

export function complete(goal: GoalState, waived: boolean, now = Date.now()): GoalState {
	return { ...goal, status: "achieved", note: waived ? "Completed with recorded waiver of unresolved items." : undefined, updatedAt: now };
}

/** A direct rejection of the just-completed work reopens its evidence. Plain
 * questions and unrelated new tasks do not silently create or resume goals. */
export function reopenRejectedGoal(goal: GoalState | undefined, correction: string, now = Date.now()): GoalState | undefined {
  if (goal?.status !== 'achieved' || !rejectsCompletedWork(correction)) return undefined;
  return { ...goal, status: 'active', text: clip(`${goal.text}\nLatest user correction: ${correction}`, MAX_GOAL_TEXT),
    criteria: goal.criteria.map(({evidence, ...criterion}) => ({ ...criterion, status: 'open' as const })), nudges: 0, stalls: 0, progressMark: '', note: undefined, updatedAt: now };
}
export function rejectsCompletedWork(correction: string): boolean {
  return (/\b(?:this|it|output|result|video|film|animation|render|image)\b/i.test(correction) || /^\s*(?:please )?(?:remake|redo)\b/i.test(correction)) && /\b(?:not (?:good|right|done|finished)|terrible|remake|redo|fix (?:it|this)|looks? (?:ugly|bad)|still (?:bad|broken))\b/i.test(correction);
}

export function block(goal: GoalState, reason: string, now = Date.now()): GoalState {
	return { ...goal, status: "blocked", note: clip(reason, 400), updatedAt: now };
}

export interface StopDecision {
	goal: GoalState;
	/** Text to send as the continuation, when the session should keep working. */
	nudge?: string;
	/** User-facing line when the gate gives up or finishes. */
	notice?: { level: "info" | "warning"; text: string };
}

export interface StopContext {
	/** Stop reason of the last assistant message. Only a clean stop is a candidate for continuation. */
	lastStop: string | undefined;
	hasPendingMessages: boolean;
}

/** Decide, once the agent has settled, whether the goal needs another turn. */
export function stopGate(goal: GoalState | undefined, context: StopContext, now = Date.now()): StopDecision | undefined {
	if (!goal || goal.status !== "active") return undefined;
	if (context.lastStop === "aborted") {
		return { goal: { ...goal, status: "paused", note: "Paused after an interrupt.", updatedAt: now }, notice: { level: "info", text: `Goal paused after your interrupt. /goal resume continues it (${open(goal).length} criteria open).` } };
	}
	if (context.hasPendingMessages || context.lastStop !== "stop") return undefined;
	const remaining = open(goal);
	const mark = progressMark(goal);
	const stalled = goal.nudges > 0 && mark === goal.progressMark;
	const stalls = stalled ? goal.stalls + 1 : 0;
	if (stalls >= MAX_STALLS) {
		const note = `No new evidence across ${stalls} continuations; ${remaining.length} criteria still open.`;
		return { goal: { ...goal, status: "blocked", stalls, note, updatedAt: now }, notice: { level: "warning", text: `Goal stalled: ${note} /goal retry gives it another ${MAX_STALLS} attempts, /goal clear drops it.` } };
	}
	if (goal.nudges >= MAX_NUDGES) {
		const note = `Continuation budget of ${MAX_NUDGES} used with ${remaining.length} criteria still open.`;
		return { goal: { ...goal, status: "blocked", note, updatedAt: now }, notice: { level: "warning", text: `Goal paused: ${note} /goal retry continues.` } };
	}
	const next: GoalState = { ...goal, nudges: goal.nudges + 1, progressMark: mark, stalls, updatedAt: now };
	return { goal: next, nudge: continuationPrompt(next) };
}

function continuationPrompt(goal: GoalState): string {
	const remaining = open(goal);
	const lines = remaining.length
		? [`The goal is not finished: ${remaining.length} criteria have no evidence yet.`, ...remaining.map((criterion) => `- ${criterion.id}: ${criterion.text}`),
			"Do the remaining work now. Verify each criterion with a real check (run the tests or the program, open the rendered output, read the diff), then record it with goal({action:\"met\", id, evidence}) quoting what you observed.",
			"If a criterion is unnecessary or impossible, goal({action:\"waive\", id, evidence}) with the reason. If only the user can unblock you, call goal({action:\"blocked\", reason}) and stop."]
		: ["Every criterion has evidence. Call goal({action:\"complete\", summary}) to close the goal; it re-checks that nothing changed since the last verification."];
	return `[goal ${goal.id}, continuation ${goal.nudges}/${MAX_NUDGES}] ${lines.join("\n")}`;
}

/** Ephemeral per-turn context: the definition of done, kept tiny. */
export function goalAnchor(goal: GoalState | undefined): string | undefined {
	if (!goal || goal.status !== "active") return undefined;
	const rows = goal.criteria.map((criterion) => `${criterion.status === "open" ? "[ ]" : criterion.status === "met" ? "[x]" : "[~]"} ${criterion.id} ${criterion.text}`);
	return `[Goal ${goal.id} — set by the user; the session continues until every criterion has evidence]\n${clip(goal.text, 400)}\n${rows.join("\n")}\nRecord evidence with the goal tool as each criterion is verified; do not stop or claim completion before then.`;
}

/** The message that starts work on a freshly set goal; the marker stages the goal tool. */
export function goalKickoff(goal: GoalState): string {
	return `[goal-tracked ${goal.id}] Goal: ${goal.text}\n\nAcceptance criteria (refine with goal({action:"criteria", items:[…]}) if they miss something; keep it to what the user asked):\n${goal.criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`).join("\n")}\n\nWork autonomously until all are verified with evidence.`;
}

export function goalSummary(goal: GoalState | undefined): string {
	if (!goal || goal.status === "cleared") return "No goal set. /goal <what you want done> starts one.";
	const met = goal.criteria.filter((criterion) => criterion.status !== "open").length;
	const header = `Goal ${goal.id} [${goal.status}] ${met}/${goal.criteria.length} criteria settled, ${goal.nudges} continuation(s)${goal.note ? ` — ${goal.note}` : ""}`;
	return [header, clip(goal.text, 300), ...goal.criteria.map((criterion) => `  ${criterion.status === "open" ? "[ ]" : criterion.status === "met" ? "[x]" : "[~]"} ${criterion.id} ${criterion.text}${criterion.evidence ? ` — ${criterion.evidence}` : ""}`)].join("\n");
}

/** Latest persisted goal on a session branch (entries are whole-state snapshots). */
export function restoreGoal(entries: readonly any[]): GoalState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "custom" && entry.customType === "goal-state-v1" && entry.data?.version === 1) return entry.data as GoalState;
	}
	return undefined;
}

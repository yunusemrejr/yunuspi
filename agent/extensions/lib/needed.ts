/**
 * The needed check: while an agent works, its recent tool calls are held
 * against the request it was given (the person's last typed message for the
 * main agent, the brief for a worker). When a cheap local sign says the work
 * may have left the request, the decision model is asked one question: is
 * this a detour? Only a confident yes gives the agent one short note. The
 * check never blocks a tool call and stays quiet when the model is unsure,
 * slow or down.
 *
 * Identical calls in a row belong to the loop guard (lib/stall-core.ts); the
 * signs here count a call that repeats after something else happened between.
 * `PI_NEEDED=0` turns the check off; `PI_NEEDED_P` moves the 0.75 bar
 * (0.5 to 0.99).
 */
import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { isPassiveCall } from "./stall-core.ts";
import { commandMayProduceFiles } from "./deliverable-ledger.ts";
import { isMutatingToolResult } from "../reminders.ts";

/** True unless the person switched the check off. */
export const neededOn = (): boolean => process.env.PI_NEEDED !== "0";

const DEFAULT_THRESHOLD = 0.75;

/** The probability a detour answer needs before a note is given. */
export function neededThreshold(env: Record<string, string | undefined> = process.env): number {
	const value = Number(env.PI_NEEDED_P);
	return Number.isFinite(value) && value >= 0.5 && value <= 0.99 ? value : DEFAULT_THRESHOLD;
}

export type StepKind = "read" | "write" | "run" | "launch" | "other";
export type SignName = "failing" | "rerun" | "spread" | "dry" | "long";

export interface Step {
	tool: string;
	kind: StepKind;
	/** What a person recognises: the command, the path or the search pattern. */
	label: string;
	/** Hash of the tool and its normalised command or path. */
	key: string;
	/** First two path segments relative to the working folder, or `outside/...`. */
	place: string;
	failed: boolean;
	/** True for an edit and for a shell command the reminders caution classifies as mutating. */
	changes: boolean;
}

export interface Sign {
	sign: SignName;
	n: number;
}

const MAX_STEPS = 40;
const FAILING_AT = 3;
const RERUN_AT = 3;
const SPREAD_WINDOW = 20;
const SPREAD_PLACES = 5;
const DRY_AT = 25;
const LONG_AT = { main: 20, worker: 30 };
const BARE_NOTE_AT = 4;
const MUTE_STEPS = 20;
const ASK_GAP_MS = 60_000;
const COOLDOWN_STEPS = 15;
const COOLDOWN_MS = [5, 10, 20].map((minutes) => minutes * 60_000);
/** After a question that got no usable answer the agent's next question waits this long. */
const UNANSWERED_WAIT_MS = 5 * 60_000;
const MAX_REQUEST = 1_200;
const LABEL_CHARS = 100;
const NOTE_CHARS = 200;
const RECENT_FOR_MODEL = 12;
const RECENT_IN_NOTE = 3;

const READ_TOOLS = new Set([
	"read", "grep", "find", "ls", "read_many", "symbol_search", "module_report", "read_symbol", "read_enclosing",
	"project_report", "web_search", "fetch_content", "web_probe", "code_search", "ast_grep_search", "ast_grep_outline",
]);
const WRITE_TOOLS = new Set(["edit", "write", "apply_patch", "multi_edit", "notebook_edit"]);
const RUN_TOOLS = new Set(["bash", "powershell"]);

/** Request, brief and labels enter a note through here: one line, no way to forge the frame around them. */
export function plain(text: unknown, max = Number.POSITIVE_INFINITY): string {
	const clean = String(text ?? "").replace(/<\/?[a-zA-Z][^>]*>/g, " ").replace(/[«»]/g, "").replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function placeOf(path: string, cwd: string): string {
	const relativePath = isAbsolute(path) ? relative(cwd, path) : path;
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		const outside = path.split(/[\\/]/).filter(Boolean).slice(0, 2).join("/");
		return `outside/${outside}`;
	}
	return relativePath.split(/[\\/]/).filter((part) => part && part !== ".").slice(0, 2).join("/") || ".";
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The place a looking-up shell command reads in: its first file operand (after the pattern for grep and rg, the subcommand for git). */
function lookupPlace(command: string, cwd: string): string {
	const [name, ...words] = command.split(/\s*(?:&&|\|\||[;|])\s*/)[0].split(" ").filter(Boolean);
	let operands = words.filter((word) => !word.startsWith("-"));
	if (name === "git") operands = operands.slice(1);
	if (name === "grep" || name === "rg") operands = operands.slice(1);
	const operand = operands[0]?.replace(/^["']|["']$/g, "");
	return operand ? placeOf(operand, cwd) : ".";
}

/** The step a tool call is, or undefined for a poll that carries no direction. */
export function stepOf(event: { toolName: string; input?: Record<string, unknown>; isError?: boolean }, cwd: string): Step | undefined {
	const input = event.input && typeof event.input === "object" ? event.input : {};
	const tool = event.toolName;
	// Waiting and status polls are not direction; launching a worker is work, only its status polls are waiting.
	if (isPassiveCall({ toolName: tool === "subagent" ? "" : tool, input })) return undefined;
	const command = plain(input.command);
	const lookup = RUN_TOOLS.has(tool) && command !== "" && !commandMayProduceFiles(command);
	const kind: StepKind = lookup ? "read" : RUN_TOOLS.has(tool) ? "run" : WRITE_TOOLS.has(tool) ? "write" : READ_TOOLS.has(tool) ? "read" : tool === "subagent" ? "launch" : "other";
	const path = text(input.path) || text(input.file_path) || text(input.file);
	const target = path || plain(input.pattern) || plain(input.query) || plain(input.url);
	const label = plain(kind === "run" ? command : target || command || tool, LABEL_CHARS);
	const place = path ? placeOf(path, cwd) : lookup ? lookupPlace(command, cwd) : kind === "read" ? (text(input.url) || text(input.query) ? "web" : ".") : "";
	return {
		tool,
		kind,
		label,
		key: createHash("sha256").update(`${tool}\0${kind === "run" ? command : target || command}`).digest("hex").slice(0, 16),
		place,
		failed: event.isError === true,
		changes: kind === "write" || isMutatingToolResult(tool, input),
	};
}

/** Steps with a call that repeats the one before it folded into one: that case is the loop guard's. */
function withoutImmediateRepeats(steps: readonly Step[]): Step[] {
	return steps.filter((step, index) => index === 0 || step.key !== steps[index - 1].key);
}

const mostOf = (counts: Map<string, number>): number => Math.max(0, ...counts.values());

/** The same command failed this many times in the window, whatever happened between. */
function failingCount(steps: readonly Step[]): number {
	const failed = new Map<string, number>();
	for (const step of withoutImmediateRepeats(steps)) if (step.kind === "run" && step.failed) failed.set(step.key, (failed.get(step.key) ?? 0) + 1);
	return mostOf(failed);
}

/** The same command ran this many times with no change between the first and the last. */
function rerunCount(steps: readonly Step[]): number {
	const ran = new Map<string, number>();
	let best = 0;
	for (const step of withoutImmediateRepeats(steps)) {
		if (step.changes) ran.clear();
		else if (step.kind === "run") {
			ran.set(step.key, (ran.get(step.key) ?? 0) + 1);
			best = Math.max(best, mostOf(ran));
		}
	}
	return best;
}

/** Separate places the last 20 steps read in. */
function spreadCount(steps: readonly Step[]): number {
	return new Set(steps.slice(-SPREAD_WINDOW).filter((step) => step.kind === "read").map((step) => step.place)).size;
}

export interface SignInput {
	/** The recent steps, at most 40, oldest first. */
	steps: readonly Step[];
	/** Steps since the request, the agent's last change or its last worker launch. */
	sinceChange: number;
	/** Steps since this agent was last judged, or since the request. */
	sinceJudged: number;
	worker: boolean;
	/** A worker whose brief says it only reads is never called dry; the main agent never is (`long` covers it). */
	readsOnly: boolean;
	/** Signs the decision model has just cleared. */
	muted: ReadonlySet<SignName>;
}

/** The first sign that holds, in the order failing, rerun, spread, dry, long. */
export function findSign(input: SignInput): Sign | undefined {
	const candidates: Sign[] = [
		{ sign: "failing", n: failingCount(input.steps) },
		{ sign: "rerun", n: rerunCount(input.steps) },
		{ sign: "spread", n: spreadCount(input.steps) },
		{ sign: "dry", n: input.worker && !input.readsOnly ? input.sinceChange : 0 },
		{ sign: "long", n: input.sinceJudged },
	];
	const at: Record<SignName, number> = { failing: FAILING_AT, rerun: RERUN_AT, spread: SPREAD_PLACES, dry: DRY_AT, long: input.worker ? LONG_AT.worker : LONG_AT.main };
	return candidates.find((candidate) => !input.muted.has(candidate.sign) && candidate.n >= at[candidate.sign]);
}

/** A brief that says the worker only reads, searches or reports. */
export function briefReadsOnly(brief: string): boolean {
	return /\b(?:read[- ]only|only (?:read|reads|reading|search|searches|report|reports)|(?:do not|don't|never) (?:edit|modify|change|write)|no (?:edits|changes|writes)|without (?:editing|modifying|changing|writing))\b/i.test(brief);
}

const SIGN_WORDS: Record<SignName, (n: number) => string> = {
	failing: (n) => `the same command has failed ${n} times`,
	rerun: (n) => `the same command ran ${n} times with nothing changed between`,
	spread: (n) => `reading across ${n} separate places`,
	dry: (n) => `${n} steps with nothing changed`,
	long: (n) => `${n} steps since the last check of direction`,
};

/** The note, exactly as the agent reads it. */
export function neededNote(worker: boolean, request: string, steps: readonly Step[], sign: Sign): string {
	const last = steps.slice(-RECENT_IN_NOTE).map((step) => step.label).join("; ");
	const words = SIGN_WORDS[sign.sign](sign.n);
	return worker
		? `Is this needed? Your brief: «${plain(request, NOTE_CHARS)}». Your last steps: ${last} (${words}). If they serve the brief, say why in one line and carry on. If not, leave this direction: do what the brief asks next, or hand back what blocks you.`
		: `Is this needed? The request: «${plain(request, NOTE_CHARS)}». Your last steps: ${last} (${words}). If they serve the request, say why in one line and carry on. If not, leave this direction and take the next step the request itself needs.`;
}

const LINE_PREFIX: Record<StepKind, (step: Step) => string> = {
	read: (step) => (RUN_TOOLS.has(step.tool) ? "shell" : "read"),
	write: () => "edit",
	run: () => "shell",
	launch: () => "worker",
	other: (step) => step.tool,
};

/** What the model reads: the request, the last steps as numbered lines, the sign in words. */
export function detourState(request: string, steps: readonly Step[], sign: Sign): { request: string; recentSteps: string; sign: string } {
	return {
		request: plain(request, MAX_REQUEST),
		recentSteps: steps.slice(-RECENT_FOR_MODEL).map((step, index) => `${index + 1}. ${LINE_PREFIX[step.kind](step)}: ${step.label}${step.failed ? " (failed)" : ""}`).join("\n"),
		sign: SIGN_WORDS[sign.sign](sign.n),
	};
}

/** Asks the decision model how likely a detour is; undefined when no usable answer came in time. */
export type DetourAsk = (state: ReturnType<typeof detourState>) => Promise<number | undefined>;

export interface NeededOptions {
	/** True inside a subagent process: the request is its brief and the worker wording applies. */
	worker: boolean;
	ask: DetourAsk;
	now?: () => number;
}

export class Needed {
	private readonly worker: boolean;
	private readonly ask: DetourAsk;
	private readonly now: () => number;
	private requestText = "";
	private steps: Step[] = [];
	private count = 0;
	private changedAt = 0;
	private judgedAt = 0;
	private askedAtMs = Number.NEGATIVE_INFINITY;
	private notes = 0;
	private quietUntilMs = 0;
	private quietUntilStep = 0;
	private readonly mutedUntil = new Map<SignName, number>();
	private asking = false;

	constructor(options: NeededOptions) {
		this.worker = options.worker;
		this.ask = options.ask;
		this.now = options.now ?? Date.now;
	}

	/** The person's typed message: it replaces the request and starts the check over. A worker keeps its first brief. */
	request(message: string): void {
		const request = plain(message, MAX_REQUEST);
		if (!request || (this.worker && this.requestText)) return;
		this.reset();
		this.requestText = request;
	}

	/** Forget everything: the session ended or switched. */
	end(): void {
		this.reset();
	}

	private reset(): void {
		this.requestText = "";
		this.steps = [];
		this.count = 0;
		this.changedAt = 0;
		this.judgedAt = 0;
		this.askedAtMs = Number.NEGATIVE_INFINITY;
		this.notes = 0;
		this.quietUntilMs = 0;
		this.quietUntilStep = 0;
		this.mutedUntil.clear();
	}

	/** Record a finished tool call; returns the note when the agent should read one with this result. */
	async observe(event: { toolName: string; input?: Record<string, unknown>; isError?: boolean }, cwd: string): Promise<string> {
		if (!neededOn() || !this.requestText) return "";
		const step = stepOf(event, cwd);
		if (!step) return "";
		this.steps.push(step);
		if (this.steps.length > MAX_STEPS) this.steps.shift();
		this.count++;
		if (step.changes || step.kind === "launch") this.changedAt = this.count;

		const muted = new Set<SignName>([...this.mutedUntil].filter(([, until]) => until >= this.count).map(([sign]) => sign));
		const sign = findSign({
			steps: this.steps,
			sinceChange: this.count - this.changedAt,
			sinceJudged: this.count - this.judgedAt,
			worker: this.worker,
			readsOnly: this.worker && briefReadsOnly(this.requestText),
			muted,
		});
		const now = this.now();
		if (!sign || this.asking || this.count < this.quietUntilStep || now < this.quietUntilMs || now - this.askedAtMs < ASK_GAP_MS) return "";

		this.askedAtMs = now;
		this.judgedAt = this.count;
		const request = this.requestText;
		const steps = [...this.steps];
		const probability = await this.askOnce(detourState(request, steps, sign));
		if (request !== this.requestText) return "";
		if (probability === undefined) {
			this.quietUntilMs = Math.max(this.quietUntilMs, now + UNANSWERED_WAIT_MS);
			return (sign.sign === "failing" || sign.sign === "rerun") && sign.n >= BARE_NOTE_AT ? this.give(request, steps, sign) : "";
		}
		if (probability >= neededThreshold()) return this.give(request, steps, sign);
		this.mutedUntil.set(sign.sign, this.count + MUTE_STEPS);
		return "";
	}

	private async askOnce(state: ReturnType<typeof detourState>): Promise<number | undefined> {
		this.asking = true;
		try {
			return await this.ask(state);
		} catch {
			return undefined;
		} finally {
			this.asking = false;
		}
	}

	private give(request: string, steps: readonly Step[], sign: Sign): string {
		this.quietUntilStep = this.count + COOLDOWN_STEPS;
		this.quietUntilMs = Math.max(this.quietUntilMs, this.now() + COOLDOWN_MS[Math.min(this.notes, COOLDOWN_MS.length - 1)]);
		this.notes++;
		return neededNote(this.worker, request, steps, sign);
	}
}

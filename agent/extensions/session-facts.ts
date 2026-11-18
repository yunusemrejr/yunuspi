/**
 * Session facts — one stored, model-only line at each human message: local
 * time, session spend, context occupancy, prompt-cache hits and the last run's
 * time and cost. A message that
 * asks for speed adds the haste sentence to that same line, once; a request that
 * names a subject adds the installed guides that match it (at most three).
 *
 * The line is returned once from before_agent_start and stored in the session,
 * so later requests replay the same bytes. Regenerating it per request would
 * change the prompt prefix every step and re-bill the whole transcript; a
 * figure that is not known is left out of the line, never invented.
 *
 * A run is everything the session does after one message from the user. The
 * extension owns the run's soft budget (`run.softMinutes`, `run.softUsd`, both
 * from lib/team.ts): when one passes, the model gets one advisory note; at
 * twice the budget, one closing note. A note is a message of its own, sent
 * after the tool results in hand and shown in the transcript: text appended
 * to a tool result reads as part of a file, and a model rightly distrusts
 * instructions it finds there. Nothing is stopped or refused. The live run is
 * shared with cost-governor's /budget through Symbol.for("yunus-pi.run.v1").
 *
 * Child processes (PI_SUBAGENT_CHILD=1) register nothing.
 */
import type { ExtensionAPI } from "@yunuspi/coding-agent";
import { collectSessionCost, collectSessionMetrics } from "@yunuspi/coding-agent/session-accounting";
import { DEFAULT_TEAM_CONFIG, loadTeamConfig, type RunBudget } from "./lib/team.ts";
import { resolveTimeZone } from "./lib/session-signals.ts";
import { goalUserWords } from "./lib/goal-state.ts";
import { goalAssignment } from "./lib/presets.ts";
import { catalogSkills, matchingGuides, type CatalogSkill } from "./lib/skill-review.ts";

const RUN_STATE = Symbol.for("yunus-pi.run.v1");
const CUSTOM_TYPE = "session-facts";
const BUDGET_NOTE_TYPE = "run-budget";
const HURRY_NOTE_TYPE = "session-hurry";
/** Events further apart than this are idle time, not run time. */
const GAP_MS = 10 * 60_000;

/** A message asking for speed, in English or Turkish. */
const HURRY_PATTERNS: RegExp[] = [
	/\brush\b/,
	/\bhurry\b/,
	/\bbe quick\b/,
	/\bquickly\b/,
	/\bfaster\b/,
	/\basap\b/,
	/\btaking (?:too|so) long\b/,
	/\bwe don'?t have all day\b/,
	/\bno time\b/,
	/\bacele\b/,
	/çabuk/,
	/\bhızlı ol\b/,
	/\bhemen\b/,
	/\buzun sürdü/,
	/\bvakit yok\b/,
];

/**
 * True when the message asks for speed. Code is not prose, and a technical
 * term that merely contains one of the words ("faster-whisper") is not a
 * request to hurry.
 */
export function hurryRequested(text: unknown): boolean {
	if (typeof text !== "string" || !text) return false;
	const prose = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/faster[-_](?:whisper|than)/gi, " ");
	// Turkish lowercases I to ı: fold both spellings so an upper-case message matches too.
	const folded = prose.replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase();
	return HURRY_PATTERNS.some((pattern) => pattern.test(folded));
}

/** Granted once, with the message that asked for speed. */
export const HURRY_NOTE =
	"The user wants speed now. Finish the open demands with the fewest steps: no new surveys, no optional checks or polish, one final check of what changed, then report. Stop subagents whose part is no longer needed.";

/** Whole minutes, rounded; at least 1 once the run has any time. */
export function wholeMinutes(ms: number): number {
	return ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0;
}

const compactTokens = (tokens: number): string =>
	tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(2))}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(Math.round(tokens));

/** Spend as people read it: `$1.24`, `$0.034`, `$0.0004`; empty for an amount that rounds to nothing. */
const money = (usd: number): string => {
	const text = usd >= 0.1 ? usd.toFixed(2) : usd >= 0.001 ? usd.toFixed(3) : usd.toFixed(4);
	return Number(text) > 0 ? `$${text}` : "";
};

/** `Sat 14 Nov 2026, 16:02 (Europe/Istanbul).` in the session's own zone. */
function nowText(now: Date, zone: string): string {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: zone,
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
	}).formatToParts(now);
	const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
	return `Now: ${pick("weekday")} ${pick("day")} ${pick("month")} ${pick("year")}, ${time} (${zone}).`;
}

export interface SessionFactsInput {
	now: Date;
	zone: string;
	/** Measured session spend; absent when no price is known or the plan is flat. */
	usd?: number;
	/** `context 41k of 128k tokens`. */
	context?: string;
	/** Share of prompt tokens served from the provider cache. */
	cachePercent?: number;
	lastRun?: { minutes: number; usd?: number };
	/** Installed guides that match the request; the line is left out when there are none. */
	guides?: readonly CatalogSkill[];
}

/** `name: description clipped at a word (file)`, as the facts line lists a guide. */
function guideText(skill: CatalogSkill): string {
	const flat = skill.description.replace(/\s+/g, " ").trim();
	const description = flat.length > 110 ? `${flat.slice(0, 109).replace(/\s+\S*$/, "")}…` : flat;
	return `${skill.name}: ${description} (${skill.file})`;
}

/** The stored facts line: unknown figures drop out, the time is always there. */
export function sessionFactsText(input: SessionFactsInput): string {
	const pieces = [
		input.usd === undefined ? "" : money(input.usd),
		input.context ?? "",
		input.cachePercent === undefined ? "" : `cache hits ${Math.round(input.cachePercent)}%`,
	].filter(Boolean);
	let line = nowText(input.now, input.zone);
	if (pieces.length) line += ` Session: ${pieces.join(", ")}.`;
	if (input.lastRun) {
		const spend = input.lastRun.usd === undefined ? "" : money(input.lastRun.usd);
		line += ` Last run: ${input.lastRun.minutes} min${spend ? `, ${spend}` : ""}.`;
	}
	const guides = input.guides?.length
		? `\nGuides that match this request (read the ones that bear on it before choosing the approach): ${input.guides.map(guideText).join("; ")}`
		: "";
	return line + guides;
}

/**
 * The guides that fit what the user asked. A goal kickoff is matched on the
 * goal sentence only: its criteria and standards would match every skill. The
 * line is advisory, so a failure here leaves it out and not the facts.
 */
function matchingGuidesFor(event: any): CatalogSkill[] {
	try {
		const prompt = typeof event?.prompt === "string" ? event.prompt : "";
		const words = goalUserWords(prompt);
		return matchingGuides(catalogSkills(event), words === undefined ? prompt : goalAssignment(words));
	} catch {
		return [];
	}
}

/** Spend in a budget note; `$?` when no price is known. */
const noteSpend = (usd: number | undefined): string => (usd === undefined ? "$?" : money(usd) || "$0");

/** Only the limits that are switched on. */
export const limitText = (limits: RunBudget, joiner: string): string =>
	[limits.softMinutes > 0 ? `${limits.softMinutes} min` : "", limits.softUsd > 0 ? `$${Math.round(limits.softUsd * 100) / 100 === limits.softUsd ? limits.softUsd.toFixed(2) : limits.softUsd}` : ""]
		.filter(Boolean)
		.join(joiner);

/** The one note per budget level; level 2 is twice the budget. */
export function runBudgetNote(level: 1 | 2, minutes: number, usd: number | undefined, limits: RunBudget): string {
	if (level === 2) return `[run budget] ${minutes} min and ${noteSpend(usd)} since the user's last message, twice the soft budget. Focus on the remaining requested work and the checks it needs. Reuse current evidence and report any genuine blocker.`;
	return `[run budget] You do not have much time left: this run has worked for ${minutes} min and spent ${noteSpend(usd)} since the user's last message (budget: ${limitText(limits, " or ")}). Finish the item in hand, complete and verify every demand of the user that is still open, start nothing new that was not asked for, and report what is done, what is not and the next step.`;
}

interface Run {
	/** Session spend when the user's message arrived; 0 before anything was priced. */
	startedUsd: number | undefined;
	limits: RunBudget;
	activeMs: number;
	lastEventAt: number;
	/** Spend of this run as last measured. */
	usd: number | undefined;
	/** Budget level already noted: 0 none, 1 first limit, 2 twice the budget. */
	noted: 0 | 1 | 2;
	/** True between the end of the agent's work and its next start: waiting for the user is not run time. */
	resting: boolean;
}

export default function sessionFacts(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let run: Run | undefined;
	let runOwner: object | undefined;
	let measured: { manager: object; revision: number; usd?: number } | undefined;
	let lastRun: { minutes: number; usd?: number } | undefined;
	/**
	 * True while the last input was a human message that no run has started
	 * for yet. A steering or follow-up message joins the run in progress
	 * without a new start, and a refused prompt never starts one; neither may
	 * leave its line behind for a message the harness sends later.
	 */
	let pending: { signal?: AbortSignal } | undefined;
	/** True once the speed note reached this run, on either path. */
	let hurrySent = false;

	const entriesOf = (ctx: any): any[] => {
		try {
			const entries = ctx?.sessionManager?.getAccountingEntries?.() ?? ctx?.sessionManager?.getEntries?.();
			if (Array.isArray(entries)) return entries;
			const branch = ctx?.sessionManager?.getBranch?.();
			return Array.isArray(branch) ? branch : [];
		} catch {
			return [];
		}
	};
	/** Measured session spend; undefined when the price or the plan makes it unknown. */
	const sessionUsd = (ctx: any, entries?: any[]): number | undefined => {
		try {
			const manager = ctx?.sessionManager;
			if (manager?.isAccountingIncomplete?.()) return undefined;
			const revision = manager?.getAccountingEntriesRevision?.();
			if (measured && measured.manager === manager && measured.revision === revision) return measured.usd;
			const cost = collectSessionCost(entries ?? entriesOf(ctx));
			const usd = cost.seen ? cost.total : undefined;
			if (Number.isSafeInteger(revision)) measured = { manager, revision, usd };
			return usd;
		} catch {
			return undefined;
		}
	};
	const refreshUsd = (total: number | undefined): number | undefined => {
		if (!run) return undefined;
		run.usd = total === undefined || run.startedUsd === undefined ? undefined : Math.max(0, total - run.startedUsd);
		return run.usd;
	};
	/** Count the time since the last event of this run; a longer gap is idle. */
	const touch = (): void => {
		if (!run) return;
		const now = Date.now();
		const gap = now - run.lastEventAt;
		if (!run.resting && gap > 0 && gap <= GAP_MS) run.activeMs += gap;
		run.lastEventAt = now;
	};

	// /budget reads the live run from here; each extension has its own copy of
	// this module, so the symbol on globalThis is the one shared place.
	const readRun = (ctx?: any) => {
		if (!run || ctx && ctx.sessionManager !== runOwner) return undefined;
		if (ctx) {
			touch();
			refreshUsd(sessionUsd(ctx));
		}
		return { minutes: wholeMinutes(run.activeMs), usd: run.usd, limits: run.limits, budget: limitText(run.limits, " / ") };
	};
	(globalThis as any)[RUN_STATE] = readRun;

	const reset = (): void => {
		run = undefined;
		runOwner = undefined;
		measured = undefined;
		lastRun = undefined;
		pending = undefined;
		hurrySent = false;
	};
	pi.on("session_start", reset);
	pi.on("session_switch", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", () => {
		reset();
		try {
			if ((globalThis as any)[RUN_STATE] === readRun) delete (globalThis as any)[RUN_STATE];
		} catch {
			/* a closing session leaves no state behind that matters */
		}
	});

	pi.on("input", (event: any) => {
		try {
			if (event?.source === "extension") {
				pending = undefined;
				return undefined;
			}
			const steer = (event?.source === "interactive" || event?.source === "rpc") && Boolean(event?.streamingBehavior);
			if (steer) {
				if (!hurrySent && hurryRequested(event?.originalText ?? event?.text)) {
					hurrySent = true;
					void Promise.resolve(
						pi.sendMessage({ customType: HURRY_NOTE_TYPE, content: HURRY_NOTE, display: false }, { deliverAs: "steer" }),
					).catch(() => { /* optional guidance */ });
				}
				return undefined;
			}
			pending = { signal: event?.signal };
		} catch {
			/* facts are advisory; a failure must not break the prompt */
		}
		return undefined;
	});

	pi.on("before_agent_start", (event: any, ctx: any) => {
		try {
			touch();
			if (run) run.resting = false;
			const input = pending;
			pending = undefined;
			if (!input || input.signal?.aborted) return undefined;
			const entries = entriesOf(ctx);
			const spend = sessionUsd(ctx, entries);
			if (run) {
				const lastSpend = refreshUsd(spend);
				lastRun = { minutes: wholeMinutes(run.activeMs), ...(lastSpend === undefined ? {} : { usd: lastSpend }) };
			}
			let limits: RunBudget = DEFAULT_TEAM_CONFIG.run;
			try { limits = loadTeamConfig(ctx?.cwd ?? process.cwd()).run; } catch { /* use defaults */ }
			hurrySent = false;
			run = { startedUsd: ctx?.sessionManager?.isAccountingIncomplete?.() ? undefined : spend ?? 0, limits, activeMs: 0, lastEventAt: Date.now(), usd: undefined, noted: 0, resting: false };
			runOwner = ctx?.sessionManager;
			const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
			const window = Number(ctx?.model?.contextWindow);
			const tokens = usage?.tokens === null ? Number.NaN : Number(usage?.tokens);
			const context = Number.isFinite(tokens) && tokens > 0 && Number.isFinite(window) && window > 0
				? `context ${compactTokens(tokens)} of ${compactTokens(window)} tokens`
				: undefined;
			let cachePercent: number | undefined;
			try {
				const metrics = collectSessionMetrics(entries);
				if (metrics.cacheRead > 0 && metrics.cacheRate !== null) cachePercent = metrics.cacheRate;
			} catch {
				/* no usable cache data: the figure stays out */
			}
			const content = sessionFactsText({
				now: new Date(),
				zone: resolveTimeZone().zone,
				usd: spend,
				context,
				cachePercent,
				lastRun,
				guides: matchingGuidesFor(event),
			});
			const hurry = hurryRequested(event?.prompt) ? `\n${HURRY_NOTE}` : "";
			if (hurry) hurrySent = true;
			return { message: { customType: CUSTOM_TYPE, content: content + hurry, display: false } };
		} catch {
			return undefined;
		}
	});

	pi.on("turn_end", (_event: any, ctx: any) => {
		try {
			touch();
			if (run) refreshUsd(sessionUsd(ctx));
		} catch {
			/* timing is advisory */
		}
	});
	pi.on("agent_end", () => {
		pending = undefined;
		try {
			touch();
			if (run) run.resting = true;
			// The run is over: a run the harness starts next may be hurried again.
			hurrySent = false;
		} catch {
			/* timing is advisory */
		}
	});

	pi.on("tool_result", (_event: any, ctx: any) => {
		try {
			if (!run) return undefined;
			touch();
			const limits = run.limits;
			if (limits.softMinutes <= 0 && limits.softUsd <= 0) return undefined;
			if (run.noted >= 2) return undefined;
			const activeMs = run.activeMs;
			const minutes = wholeMinutes(run.activeMs);
			const usd = limits.softUsd > 0 || activeMs >= limits.softMinutes * 60_000
				? refreshUsd(sessionUsd(ctx))
				: run.usd;
			const passed = (factor: number): boolean =>
				(limits.softMinutes > 0 && activeMs >= limits.softMinutes * factor * 60_000) ||
				(limits.softUsd > 0 && usd !== undefined && usd >= limits.softUsd * factor);
			let level: 1 | 2 | undefined;
			if (passed(2)) level = 2;
			else if (passed(1)) level = 1;
			// Each level is noted once. A run that passes both thresholds before
			// its next tool result gets the closing note only; the first note
			// would be out of date already.
			if (!level || level <= run.noted) return undefined;
			run.noted = level;
			void Promise.resolve(
				pi.sendMessage({ customType: BUDGET_NOTE_TYPE, content: runBudgetNote(level, minutes, usd, limits), display: true }, { deliverAs: "steer" }),
			).catch(() => {
				/* a note that could not be queued changes nothing about the run */
			});
		} catch {
			/* the budget is advisory */
		}
		return undefined;
	});
}

/**
 * ask_advisor — one question to a stronger model: the one configured as
 * `team.advisor`, or the second-opinion model configured as `team.consultant`.
 *
 * The model sees only the question: no conversation, no tools. It is a side
 * call, not a turn: its spend is recorded as auxiliary model usage so /cost
 * shows it under that model's route.
 *
 * The tool is registered once: at session start, or at the next message after
 * team.advisor or team.consultant changes from off to a model (the one change
 * to the tool list the provider's prompt cache pays for). It is never removed;
 * when its target goes off a call is refused. The optional `to` parameter
 * ("advisor" or "consultant") exists only when a consultant was set at
 * registration; without it, or without `to`, the advisor answers, or the
 * consultant when no advisor is set. Child processes never get the tool: their
 * model should not spend on a second opinion the parent cannot see.
 *
 * Limits, counted per target: the advisor 3 per run (everything after one
 * human message) and 12 per session, the consultant 2 and 6; one call at a
 * time. The counts are read back from the session entries on every start (the
 * run's from those after the latest human message), and a call is entered
 * before it is sent, so a reload does not hand out fresh budget.
 *
 * A consultant on the ChatGPT subscription spends the weekly quota that every
 * session shares. The account-wide figure cannot say who moved it, so the
 * breaker is a coarse guard: consultant calls stop once the quota has moved
 * `team.subscriptionPoints` points since the session began (0 switches that
 * off), or is used up (lib/codex-usage.ts keeps the readings). The per-target
 * count limits are what keep the consultant's own spend small.
 */
import { randomUUID } from "node:crypto";
import { StringEnum } from "@yunuspi/ai";
import { Type } from "typebox";
import { effortLevelForTier } from "./lib/effort-policy.mjs";
import { askJev } from "./lib/jev-client.ts";
import { askTypedDecision } from "./lib/micro-intelligence/jev-decisions.ts";
import { CODEX_PROVIDER, codexSessionDelta, codexSessionOverBudget, readCodexUsageFor, sessionIdOf } from "./lib/codex-usage.ts";
import { loadTeamConfig, resolveModelSetting, type TeamSettings } from "./lib/team.ts";
import { intersectThinkingCeilings, sessionThinkingCeiling } from "./pi-subagents/src/shared/thinking-ceiling.ts";

export const ADVISOR_ENTRY = "advisor-v1";
const TARGETS = ["advisor", "consultant"] as const;
type Target = (typeof TARGETS)[number];
const LIMITS: Readonly<Record<Target, { run: number; session: number }>> = { advisor: { run: 3, session: 12 }, consultant: { run: 2, session: 6 } };
const MAX_QUESTION = 1_500;
/** The answer allowance; reasoning shares it, so a thinking model gets headroom. */
const ANSWER_TOKENS = 1_200;
const THINKING_HEADROOM = 4_096;
const DEADLINE_MS = 180_000;
/** The advisor thinks at this level unless the decision model finds the question simple. */
const BASE_LEVEL = "medium";
/** A slow judge falls back to the base level rather than delay the question. */
const JEV_TIMEOUT_MS = 3_500;
const SYSTEM =
	"You advise another model that is in the middle of a task. Answer in at most 120 words: the recommendation first, then the reason, then the one risk to watch.";
const ASK_WHEN =
	"Ask when its judgment can change the outcome: before committing to an approach on a hard or costly task, after two failed attempts at the same problem, before reporting a large piece of work as done. Never for a fact a lookup answers.";
const BRIEF = "It sees only the question: state the goal, what is known, the options and the one thing to decide.";

/** The tool description for the targets set at registration. */
function descriptionFor(advisor: boolean, consultant: boolean): string {
	if (!consultant) return `Put one question (at most 1,500 characters) to a stronger model and get a few lines back. ${BRIEF} ${ASK_WHEN} 3 per run, 12 per session.`;
	const limits = (target: Target) => `${LIMITS[target].run} per run, ${LIMITS[target].session} per session`;
	if (!advisor) {
		return `Put one question (at most 1,500 characters) to a second-opinion model and get a few lines back. ${BRIEF} Ask a few questions, sparingly, and never hand it work: it answers, you do the task. ${ASK_WHEN} ${limits("consultant")}.`;
	}
	return `Put one question (at most 1,500 characters) to a stronger model and get a few lines back. ${BRIEF} Ask a few questions, sparingly, and never hand it work. ${ASK_WHEN} \`to\` picks who answers: the advisor (${limits("advisor")}) or the consultant, a second opinion from another model (${limits("consultant")}).`;
}

/** A team model setting names a model unless it is "off" (or missing). */
const isSet = (setting: string | undefined): setting is string => !!setting && setting !== "off";

const routeOf = (model: any) => `${model?.provider}/${model?.id}`;

/**
 * Thinking level of one question: the base level, or lower when the decision
 * model (Jev) finds the question simple; never above the session's own ceiling.
 * When Jev cannot answer the base level stands.
 */
async function questionLevel(pi: any, ctx: any, question: string, signal: AbortSignal): Promise<string> {
	let ceiling: string = BASE_LEVEL;
	try {
		const session = sessionThinkingCeiling(ctx?.sessionManager?.getBranch?.(), pi.getThinkingLevel?.());
		ceiling = intersectThinkingCeilings(BASE_LEVEL, session) ?? BASE_LEVEL;
		if (ceiling === "off") return ceiling;
		const judged = await askTypedDecision(
			"effort-tier",
			{ state: { request: question } },
			{ judge: (site, state, questions, options) => askJev(site, state, questions, { pi, signal: options?.signal, timeoutMs: JEV_TIMEOUT_MS }), signal },
		);
		const tier = judged.ok ? judged.verdict?.tier : undefined;
		return tier === "easy" || tier === "moderate" ? effortLevelForTier(tier, ceiling) : ceiling;
	} catch {
		return ceiling;
	}
}

/**
 * What a reload counts back from the session's entries, per target: the whole
 * session, and the run (the calls after the latest human message). A call
 * leaves its entry before it is sent and a second one with its outcome; both
 * carry the call's id and count once, so a call lost midway still spent its
 * slot. An entry from before targets existed was the advisor's.
 */
function recordedCalls(ctx: any): { session: Record<Target, number>; run: Record<Target, number> } {
	const zero = (): Record<Target, number> => ({ advisor: 0, consultant: 0 });
	const counts = { session: zero(), run: zero() };
	try {
		const entries = ctx?.sessionManager?.getEntries?.() ?? [];
		const seen = new Set<string>();
		for (const entry of entries) {
			if (entry?.type === "message" && entry.message?.role === "user") {
				counts.run = zero();
				continue;
			}
			if (entry?.type !== "custom" || entry.customType !== ADVISOR_ENTRY) continue;
			const id = entry.data?.id;
			if (typeof id === "string") {
				if (seen.has(id)) continue;
				seen.add(id);
			}
			const target: Target = entry.data?.target === "consultant" ? "consultant" : "advisor";
			counts.session[target]++;
			counts.run[target]++;
		}
	} catch {
		/* An unreadable history counts as none: the in-process count still limits. */
	}
	return counts;
}

/** The target a call goes to, or the reason it cannot: `to` when given, else the advisor, else the consultant. */
function targetOf(to: unknown, team: Pick<TeamSettings, "advisor" | "consultant">): { target: Target } | { refusal: string } {
	if (to !== undefined && !TARGETS.includes(to as Target)) return { refusal: `to must be "advisor" or "consultant".` };
	const target: Target = (to as Target | undefined) ?? (isSet(team.advisor) ? "advisor" : isSet(team.consultant) ? "consultant" : "advisor");
	return !isSet(team[target])
		? { refusal: `team.${target} is off; set ${target === "advisor" ? "an advisor" : "a consultant"} model with /team.` }
		: { target };
}

export default function advisorExtension(pi: any) {
	let registered = false;
	const runUsed: Record<Target, number> = { advisor: 0, consultant: 0 };
	const sessionUsed: Record<Target, number> = { advisor: 0, consultant: 0 };
	let inFlight = false;

	const refuse = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

	const record = (data: any) => {
		try {
			pi.appendEntry?.(ADVISOR_ENTRY, data);
		} catch {
			/* The limit counter stays right in-process; a lost entry only undercounts after a reload. */
		}
	};

	/** One accepted question to one target; the caller holds the in-flight claim. */
	const consult = async (target: Target, setting: string, points: number, asked: string, signal: AbortSignal | undefined, ctx: any) => {
		const available = ctx?.modelRegistry?.getAvailable?.() ?? [];
		const route = resolveModelSetting(setting, available);
		const model = route && available.find((candidate: any) => routeOf(candidate) === route);
		if (!route || !model) {
			return refuse(`team.${target} is set to '${setting}', which is not among the available models. Pick another with /team.`);
		}
		const onSubscription = model.provider === CODEX_PROVIDER;
		const sessionId = sessionIdOf(ctx);
		if (target === "consultant" && onSubscription) {
			// A session that never read the quota has no baseline yet; read it before the first call, not after.
			if (sessionId && codexSessionDelta(sessionId) === undefined) await readCodexUsageFor(ctx, { signal });
			if (codexSessionOverBudget(sessionId, points)) {
				return refuse(`The consultant runs on the ChatGPT subscription, and the weekly quota has moved ${points} or more points since this session began (or is spent), so no more consultant calls.`);
			}
		}

		runUsed[target]++;
		sessionUsed[target]++;
		const id = randomUUID();
		// Before the send: a reload that lands mid-call still finds the slot spent.
		record({ id, at: Date.now(), route, target, status: "pending" });
		const usage = (status: string, raw?: any) => {
			try {
				pi.appendEntry?.("auxiliary-model-usage-v1", {
					id,
					owner: target,
					provider: model.provider,
					model: model.id,
					status,
					...(raw === undefined ? {} : { usage: raw }),
				});
			} catch {
				/* Accounting never discards an answer. */
			}
		};
		const timeout = AbortSignal.timeout(DEADLINE_MS);
		const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const thinking = model.reasoning === true && model.thinkingLevelMap?.medium !== null;
		const ceiling = ANSWER_TOKENS + (thinking ? THINKING_HEADROOM : 0);
		usage("pending");
		const level = thinking ? await questionLevel(pi, ctx, asked, bounded) : "off";
		let response: any;
		let failure: { error: unknown } | undefined;
		try {
			response = await ctx.modelRegistry.completeSimple(
				model,
				{ systemPrompt: SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: asked }], timestamp: Date.now() }] },
				{
					signal: bounded,
					maxRetries: 0,
					maxTokens: Math.min(ceiling, Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : ceiling),
					...(level !== "off" ? { reasoning: level } : {}),
				},
			);
		} catch (error) {
			failure = { error };
		}
		// The call may have spent quota whatever its outcome. The reading is taken in the
		// background, so the answer is not held back and the next call's breaker sees it a moment later.
		if (onSubscription) void readCodexUsageFor(ctx, { force: true });
		if (failure) {
			usage(bounded.aborted ? "cancelled" : "failed");
			record({ id, at: Date.now(), route, target, status: "failed" });
			return refuse(`The ${target} call failed: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`);
		}
		if (bounded.aborted || ["error", "aborted"].includes(response?.stopReason)) {
			usage(bounded.aborted ? "cancelled" : "failed", response?.usage);
			record({ id, at: Date.now(), route, target, status: "failed" });
			const why = bounded.aborted ? "was cancelled or timed out" : `failed: ${String(response?.errorMessage ?? response?.stopReason).slice(0, 300)}`;
			return refuse(`The ${target} call ${why}.`);
		}
		usage("completed", response?.usage);
		const text = (response?.content ?? [])
			.filter((part: any) => part?.type === "text")
			.map((part: any) => part.text)
			.join("\n")
			.trim();
		if (!text) {
			record({ id, at: Date.now(), route, target, status: "failed" });
			return refuse(
				response?.stopReason === "length"
					? `The ${target} spent its whole output allowance before answering; try a shorter question.`
					: `The ${target} returned no text.`,
			);
		}
		record({ id, at: Date.now(), route, target, status: "answered" });
		return {
			content: [{ type: "text", text: response?.stopReason === "length" ? `${text}\n\n(Answer cut at the 1,200-token cap.)` : text }],
		};
	};

	const offerTool = (ctx: any) => {
		if (registered || process.env.PI_SUBAGENT_CHILD === "1") return;
		let team: Pick<TeamSettings, "advisor" | "consultant">;
		try {
			team = loadTeamConfig(ctx?.cwd ?? process.cwd()).team;
		} catch {
			// Invalid team settings are reported where they are edited; an optional tool stays absent.
			return;
		}
		if (!isSet(team.advisor) && !isSet(team.consultant)) return;
		registered = true;
		// The schema is fixed here: a consultant added later is reached after the next start.
		const withTarget = isSet(team.consultant);
		pi.registerTool({
			name: "ask_advisor",
			label: "Ask Advisor",
			description: descriptionFor(isSet(team.advisor), withTarget),
			parameters: Type.Object(
				{
					question: Type.String({
						description: "One question, at most 1,500 characters: the goal, what is known, the options and the one thing to decide.",
					}),
					...(withTarget
						? {
								to: Type.Optional(
									StringEnum(TARGETS, {
										description: "Who answers: advisor, the configured advisor, or consultant, the second-opinion model (for example GPT Astra on the ChatGPT subscription). Left out, the advisor answers, or the consultant when no advisor is set.",
									}),
								),
							}
						: {}),
				},
				{ additionalProperties: false },
			),
			async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: unknown, ctx: any) {
				const question = typeof params?.question === "string" ? params.question : "";
				const asked = question.trim();
				if (question.length > MAX_QUESTION) {
					return refuse(`The question is ${question.length} characters; ask_advisor accepts at most 1,500 characters.`);
				}
				if (!asked) return refuse("ask_advisor needs a question.");
				if (inFlight) return refuse("Another ask_advisor call is still running; one at a time.");

				const team = loadTeamConfig(ctx?.cwd ?? process.cwd()).team;
				const chosen = targetOf(params?.to, team);
				if ("refusal" in chosen) return refuse(chosen.refusal);
				const { target } = chosen;
				const limits = LIMITS[target];
				const prefix = target === "consultant" ? "Consultant: " : "";
				if (runUsed[target] >= limits.run) return refuse(`${prefix}${limits.run} per run reached. Ask again after the next user message.`);
				if (sessionUsed[target] >= limits.session) return refuse(`${prefix}${limits.session} per session reached.`);

				inFlight = true;
				try {
					return await consult(target, team[target], team.subscriptionPoints, asked, signal, ctx);
				} finally {
					inFlight = false;
				}
			},
		});
	};

	const reseed = (_event: any, ctx: any) => {
		const counts = recordedCalls(ctx);
		for (const target of TARGETS) {
			sessionUsed[target] = counts.session[target];
			runUsed[target] = counts.run[target];
		}
	};
	pi.on("session_start", (event: any, ctx: any) => {
		// A reload of the same session must not hand out fresh session budget.
		reseed(event, ctx);
		offerTool(ctx);
	});
	// A settings file read per human message is all it costs to notice a new advisor or consultant.
	pi.on("before_agent_start", (_event: any, ctx: any) => offerTool(ctx));

	// A human message starts a new run; extension-delivered messages do not.
	pi.on("input", (event: any) => {
		if (event?.source !== "extension") for (const target of TARGETS) runUsed[target] = 0;
	});
	pi.on("session_switch", reseed);
	pi.on("session_tree", reseed);
}

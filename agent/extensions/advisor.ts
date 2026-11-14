/**
 * ask_advisor — one question to the stronger model configured as `team.advisor`.
 *
 * The advisor sees only the question: no conversation, no tools. It is a side
 * call, not a turn: its spend is recorded as auxiliary model usage so /cost
 * shows it under the advisor's route.
 *
 * The tool is registered once: at session start, or at the next message after
 * team.advisor changes from off to a model (the one change to the tool list the
 * provider's prompt cache pays for). It is never removed; when the advisor goes
 * off a call is refused. Child processes never get it: their model should not
 * spend on a second opinion the parent cannot see.
 *
 * Limits: 3 per run (a run is everything after one human message), 12 per
 * session, one at a time. The session count is read back from the session
 * entries on every start, so a reload does not hand out fresh budget.
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { effortLevelForTier } from "./lib/effort-policy.mjs";
import { askJev } from "./lib/jev-client.ts";
import { askTypedDecision } from "./lib/micro-intelligence/jev-decisions.ts";
import { loadTeamConfig } from "./lib/team.ts";
import { intersectThinkingCeilings, sessionThinkingCeiling } from "./pi-subagents/src/shared/thinking-ceiling.ts";

export const ADVISOR_ENTRY = "advisor-v1";
const OWNER = "advisor";
const MAX_QUESTION = 1_500;
const PER_RUN = 3;
const PER_SESSION = 12;
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
const DESCRIPTION =
	"Put one question (at most 1,500 characters) to a stronger model and get a few lines back. It sees only the question: state the goal, what is known, the options and the one thing to decide. Ask when its judgment can change the outcome: before committing to an approach on a hard or costly task, after two failed attempts at the same problem, before reporting a large piece of work as done. Never for a fact a lookup answers. 3 per run, 12 per session.";

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

/** Every accepted call leaves one entry; a reload counts them back. */
function recordedCalls(ctx: any): number {
	try {
		const entries = ctx?.sessionManager?.getEntries?.() ?? [];
		return entries.filter((entry: any) => entry?.type === "custom" && entry.customType === ADVISOR_ENTRY).length;
	} catch {
		return 0;
	}
}

export default function advisorExtension(pi: any) {
	let registered = false;
	let runUsed = 0;
	let sessionUsed = 0;
	let inFlight = false;

	const refuse = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

	const record = (data: any) => {
		try {
			pi.appendEntry?.(ADVISOR_ENTRY, data);
		} catch {
			/* The limit counter stays right in-process; a lost entry only undercounts after a reload. */
		}
	};

	const offerTool = (ctx: any) => {
		if (registered || process.env.PI_SUBAGENT_CHILD === "1") return;
		let advisor = "off";
		try {
			advisor = loadTeamConfig(ctx?.cwd ?? process.cwd()).team.advisor;
		} catch {
			// Invalid team settings are reported where they are edited; an optional tool stays absent.
			return;
		}
		if (advisor === "off") return;
		registered = true;
		pi.registerTool({
			name: "ask_advisor",
			label: "Ask Advisor",
			description: DESCRIPTION,
			parameters: Type.Object(
				{
					question: Type.String({
						description: "One question, at most 1,500 characters: the goal, what is known, the options and the one thing to decide.",
					}),
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
				if (runUsed >= PER_RUN) return refuse(`${PER_RUN} per run reached. Ask again after the next user message.`);
				if (sessionUsed >= PER_SESSION) return refuse(`${PER_SESSION} per session reached.`);

				const advisor = loadTeamConfig(ctx?.cwd ?? process.cwd()).team.advisor;
				if (advisor === "off") return refuse("team.advisor is off; set an advisor model with /team.");
				const model = ctx?.modelRegistry?.getAvailable?.().find((candidate: any) => routeOf(candidate) === advisor);
				if (!model) {
					return refuse(`team.advisor is set to '${advisor}', which is not among the available models. Pick another with /team.`);
				}

				runUsed++;
				sessionUsed++;
				inFlight = true;
				const id = randomUUID();
				const usage = (status: string, raw?: any) => {
					try {
						pi.appendEntry?.("auxiliary-model-usage-v1", {
							id,
							owner: OWNER,
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
					usage(bounded.aborted ? "cancelled" : "failed");
					record({ at: Date.now(), route: advisor, status: "failed" });
					inFlight = false;
					return refuse(`The advisor call failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				inFlight = false;
				if (bounded.aborted || ["error", "aborted"].includes(response?.stopReason)) {
					usage(bounded.aborted ? "cancelled" : "failed", response?.usage);
					record({ at: Date.now(), route: advisor, status: "failed" });
					const why = bounded.aborted ? "was cancelled or timed out" : `failed: ${String(response?.errorMessage ?? response?.stopReason).slice(0, 300)}`;
					return refuse(`The advisor call ${why}.`);
				}
				usage("completed", response?.usage);
				const text = (response?.content ?? [])
					.filter((part: any) => part?.type === "text")
					.map((part: any) => part.text)
					.join("\n")
					.trim();
				if (!text) {
					record({ at: Date.now(), route: advisor, status: "failed" });
					return refuse(
						response?.stopReason === "length"
							? "The advisor spent its whole output allowance before answering; try a shorter question."
							: "The advisor returned no text.",
					);
				}
				record({ at: Date.now(), route: advisor, status: "answered" });
				return {
					content: [{ type: "text", text: response?.stopReason === "length" ? `${text}\n\n(Answer cut at the 1,200-token cap.)` : text }],
				};
			},
		});
	};

	pi.on("session_start", (_event: any, ctx: any) => {
		// A reload of the same session must not hand out fresh session budget.
		sessionUsed = recordedCalls(ctx);
		runUsed = 0;
		offerTool(ctx);
	});
	// A settings file read per human message is all it costs to notice a new advisor.
	pi.on("before_agent_start", (_event: any, ctx: any) => offerTool(ctx));

	// A human message starts a new run; extension-delivered messages do not.
	pi.on("input", (event: any) => {
		if (event?.source !== "extension") runUsed = 0;
	});
	const reseed = (_event: any, ctx: any) => {
		sessionUsed = recordedCalls(ctx);
		runUsed = 0;
	};
	pi.on("session_switch", reseed);
	pi.on("session_tree", reseed);
}

/**
 * Cost governor — keep long sessions affordable without changing the work.
 *
 * Three measured costs dominate a long DeepSeek session:
 *   1. a growing request prefix that is re-read on every step;
 *   2. full-prefix cache misses after a resume, model switch or a changing
 *      request head (each one re-bills the whole transcript);
 *   3. unbounded tool output that is paid once as input and then again as
 *      cache-read context on every later step.
 *
 * This extension owns one policy for all three:
 *   * fold old history at a stable turn boundary into a deterministic digest
 *     when the request view grows past a budget, and re-fold only when the
 *     tail has grown materially — so the provider prefix stays cacheable;
 *   * cap a single bash/search result while keeping both ends and a spill of
 *     the full output for exact follow-up;
 *   * a soft USD budget that switches to economy mode (smaller context budget,
 *     smaller tool cap, one concise instruction) instead of stopping work.
 *
 * No inference, no extra model call, no background task. Folding is lossless
 * for the durable session and the file system; only the request projection is
 * smaller. `/budget` reports the current policy and spend.
 *
 * Kill switches:
 *   PI_CONTEXT_GOVERNOR=off          disable folding, caps and budget
 *   PI_CONTEXT_BUDGET=<tokens>       fold threshold (default 100000)
 *   PI_CONTEXT_KEEP=<tokens>         recent tail kept verbatim (default 20000)
 *   PI_TOOL_RESULT_MAX=<chars>       bash/search result cap (default 24000)
 *   PI_COST_BUDGET_USD=<amount|off>  soft budget (default 0.10)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@yunuspi/coding-agent";
import {
	applyFold,
	capText,
	createFold,
	estimateMessagesTokens,
	messageKey,
	type FoldState,
	type GovernedMessage,
} from "./lib/context-governor.ts";

const FOLD_ENTRY = "context-fold-v1";
const DIGEST_TYPE = "context-fold";
const NOTICE_TYPE = "cost-governor-notice";

const DEFAULT_CONTEXT_BUDGET = 100_000;
const DEFAULT_KEEP_RECENT = 20_000;
const DEFAULT_DIGEST_TOKENS = 900;
const DEFAULT_TOOL_MAX = 24_000;
const MIN_FOLD_GROWTH = 12_000;
const HYSTERESIS = 8_000;
const DEFAULT_BUDGET_USD = 0.1;
const ECONOMY_CONTEXT_BUDGET = 60_000;
const RESUME_CONTEXT_BUDGET = 60_000;
const ECONOMY_TOOL_MAX = 10_000;

const enabled = () => String(process.env.PI_CONTEXT_GOVERNOR ?? "").toLowerCase() !== "off";

const positiveInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

const positiveUsd = (value: string | undefined, fallback: number): number => {
	if (value === undefined || value === "") return fallback;
	if (/^(?:off|none|disabled)$/i.test(value)) return 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
};

const contextBudget = () => positiveInt(process.env.PI_CONTEXT_BUDGET, DEFAULT_CONTEXT_BUDGET, 8_000, 900_000);
const keepRecent = () => positiveInt(process.env.PI_CONTEXT_KEEP, DEFAULT_KEEP_RECENT, 2_000, 200_000);
const toolResultMax = () => positiveInt(process.env.PI_TOOL_RESULT_MAX, DEFAULT_TOOL_MAX, 1_000, 400_000);
const defaultBudgetUsd = () => positiveUsd(process.env.PI_COST_BUDGET_USD, DEFAULT_BUDGET_USD);

interface Totals {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number;
	inputCost: number;
	outputCost: number;
	cacheCost: number;
	lastPromptTokens: number;
}

const emptyTotals = (): Totals => ({
	turns: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	reasoning: 0,
	cost: 0,
	inputCost: 0,
	outputCost: 0,
	cacheCost: 0,
	lastPromptTokens: 0,
});

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

const fmtTokens = (value: number): string => {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(Math.round(value));
};

const fmtUsd = (value: number): string => {
	if (!Number.isFinite(value) || value <= 0) return "$0";
	if (value < 0.0001) return `$${value.toExponential(2)}`;
	return `$${value.toFixed(4)}`;
};

const flat = (value: unknown, limit = 1_200): string =>
	String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, limit);

function usageTotals(usage: any): { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number; inputCost: number; outputCost: number; cacheCost: number } {
	const input = num(usage?.input);
	const output = num(usage?.output);
	const cacheRead = num(usage?.cacheRead);
	const cacheWrite = num(usage?.cacheWrite);
	const reasoning = num(usage?.reasoning);
	const cost = usage?.cost && typeof usage.cost === "object" ? usage.cost : {};
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning,
		cost: num(cost.total),
		inputCost: num(cost.input),
		outputCost: num(cost.output),
		cacheCost: num(cost.cacheRead),
	};
}

function addUsage(totals: Totals, usage: any): void {
	const row = usageTotals(usage);
	totals.turns += 1;
	totals.input += row.input;
	totals.output += row.output;
	totals.cacheRead += row.cacheRead;
	totals.cacheWrite += row.cacheWrite;
	totals.reasoning += row.reasoning;
	totals.cost += row.cost;
	totals.inputCost += row.inputCost;
	totals.outputCost += row.outputCost;
	totals.cacheCost += row.cacheCost;
	totals.lastPromptTokens = row.input + row.cacheRead + row.cacheWrite;
}

function isFoldState(value: unknown): value is FoldState {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return row.version === 1 && typeof row.digest === "string" && typeof row.cutoffKey === "string" && typeof row.foldedTokens === "number";
}

function spillDir(ctx: any): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
	let id = "session";
	try {
		id = String(ctx?.sessionManager?.getSessionId?.() ?? "session").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "session";
	} catch {
		/* a private spill directory does not depend on a session id */
	}
	return path.join(agentDir, "context-spill", id);
}

function writeSpill(text: string, ctx: any): string | undefined {
	try {
		const dir = spillDir(ctx);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const hash = createHash("sha256").update(text).digest("hex").slice(0, 20);
		const file = path.join(dir, `${hash}.txt`);
		if (!fs.existsSync(file)) fs.writeFileSync(file, text, { mode: 0o600 });
		return file;
	} catch {
		return undefined;
	}
}

export default function costGovernorExtension(pi: ExtensionAPI): void {
	if (!enabled()) return;

	let fold: FoldState | undefined;
	let totals = emptyTotals();
	let foldCount = 0;
	let foldedTotalTokens = 0;
	let toolCaps = 0;
	let toolCharsSaved = 0;
	let lastModelKey = "";
	let budgetUsd = defaultBudgetUsd();
	let budgetOverride: number | undefined;
	let economy = false;
	let noticeLevel = 0;
	let lastViewSignature = "";
	let lastView: GovernedMessage[] | undefined;
	let resumed = false;
	let initialized = false;

	const currentBudget = (): number => (budgetOverride !== undefined ? budgetOverride : budgetUsd);

	const effectiveContextBudget = (model: any): number => {
		let configured = economy ? Math.min(contextBudget(), ECONOMY_CONTEXT_BUDGET) : contextBudget();
		if (resumed) configured = Math.min(configured, RESUME_CONTEXT_BUDGET);
		const window = num(model?.contextWindow);
		if (window <= 0) return configured;
		// Never fold a small window down to something that cannot hold the
		// recent turn plus a digest; 50% of the window is a safe working cap.
		const cap = Math.max(12_000, Math.floor(window * 0.5));
		return Math.min(configured, cap);
	};

	const effectiveKeep = (budget: number): number => Math.max(4_000, Math.min(keepRecent(), Math.floor(budget / 2)));

	const effectiveToolMax = (toolName: string): number => {
		const base = economy ? Math.min(toolResultMax(), ECONOMY_TOOL_MAX) : toolResultMax();
		if (toolName === "grep" || toolName === "find" || toolName === "ls") return Math.min(base, 10_000);
		if (toolName === "bash" || toolName === "powershell") return base;
		return 0; // read/write/edit/test tools keep their structured contract
	};

	const notify = (ctx: any, text: string) => {
		try {
			if (ctx?.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(text, "info");
			else if (typeof console !== "undefined") console.log(text);
		} catch {
			/* a cost notice must never break a turn */
		}
	};

	const reset = () => {
		fold = undefined;
		totals = emptyTotals();
		foldCount = 0;
		foldedTotalTokens = 0;
		toolCaps = 0;
		toolCharsSaved = 0;
		lastModelKey = "";
		budgetOverride = undefined;
		economy = false;
		noticeLevel = 0;
		lastViewSignature = "";
		lastView = undefined;
		resumed = false;
		initialized = false;
	};

	const restore = (ctx: any) => {
		reset();
		let latest: FoldState | undefined;
		const entries = (() => {
			try {
				return ctx?.sessionManager?.getBranch?.() ?? [];
			} catch {
				return [];
			}
		})();
		for (const entry of entries) {
			if (entry?.type === "message" && entry.message?.role === "assistant" && entry.message.usage) addUsage(totals, entry.message.usage);
			if (entry?.type === "custom" && entry.customType === FOLD_ENTRY && isFoldState(entry.data)) latest = entry.data;
		}
		if (latest) {
			fold = latest;
			foldCount = 1;
			foldedTotalTokens = Math.max(0, latest.foldedTokens);
		}
		resumed = totals.turns > 0;
		initialized = true;
		if (currentBudget() > 0 && totals.cost >= currentBudget()) economy = true;
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_switch", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_compact", () => {
		fold = undefined;
		foldCount = 0;
		foldedTotalTokens = 0;
		lastView = undefined;
		lastViewSignature = "";
	});
	pi.on("model_select", () => {
		// A smaller window can make the cached view illegal; re-evaluate the
		// fold against the new effective budget on the next request.
		lastView = undefined;
		lastViewSignature = "";
	});

	const maybeEconomy = (ctx: any): boolean => {
		const budget = currentBudget();
		if (budget <= 0 || economy) return false;
		if (totals.cost < budget) return false;
		economy = true;
		noticeLevel = 1;
		notify(ctx, `Cost governor: session spend ${fmtUsd(totals.cost)} reached the soft budget ${fmtUsd(budget)}. Economy mode is on (smaller context and tool caps); work continues.`);
		return true;
	};

	pi.on("message_end", (event: any, ctx: any) => {
		const message = event?.message;
		if (message?.role !== "assistant" || !message.usage) return;
		addUsage(totals, message.usage);
		const modelKey = `${message.provider ?? ""}/${message.model ?? ""}`;
		if (modelKey !== lastModelKey) lastModelKey = modelKey;
		const activated = maybeEconomy(ctx);
		if (activated) {
			lastView = undefined;
			lastViewSignature = "";
		}
		if (!activated && economy && noticeLevel === 1 && totals.cost >= currentBudget() * 2) {
			lastView = undefined;
			lastViewSignature = "";
			noticeLevel = 2;
			notify(ctx, `Cost governor: session spend ${fmtUsd(totals.cost)} is now more than twice the soft budget. Keep the work moving with targeted reads and batched commands; verification still applies.`);
		}
	});

	const withNotice = (messages: GovernedMessage[]): GovernedMessage[] => {
		if (!economy && noticeLevel === 0) return messages;
		const notice = noticeLevel > 0
			? `[cost-governor] Economy mode: session spend is near or above the soft budget. Batch independent reads, searches and test runs; do not re-read unchanged files or repeat a passing check; keep reasoning on routine tool continuations brief. Continue the task and verify it; do not stop early.`
			: undefined;
		if (!notice) return messages;
		const already = messages.some((message) => message.role === "custom" && message.customType === NOTICE_TYPE);
		if (already) return messages;
		return [...messages, { role: "custom", customType: NOTICE_TYPE, content: notice, display: false, timestamp: 0 }];
	};

	pi.on("context", (event: any, ctx: any) => {
		if (!initialized) restore(ctx);
		const messages = event.messages as GovernedMessage[];
		const signature = `${messages.length}:${messageKey(messages[messages.length - 1])}`;
		if (signature === lastViewSignature && lastView) return { messages: lastView };
		const budget = effectiveContextBudget(ctx?.model);
		resumed = false;
		const keep = effectiveKeep(budget);
		const digestTokens = budget < 40_000 ? 500 : DEFAULT_DIGEST_TOKENS;

		if (fold) {
			const view = applyFold(messages, fold);
			if (view) {
				const viewTokens = estimateMessagesTokens(view);
				const tailGrew = viewTokens > budget + HYSTERESIS;
				if (!tailGrew) {
					const result = withNotice(view);
					lastView = result;
					lastViewSignature = signature;
					return { messages: result };
				}
				const next = createFold(messages, { budgetTokens: budget, keepRecentTokens: keep, digestTokens });
				if (next && next.fold.foldedTokens >= fold.foldedTokens + Math.min(MIN_FOLD_GROWTH, Math.max(1, Math.floor(budget / 4)))) {
					fold = next.fold;
					foldCount += 1;
					foldedTotalTokens += next.fold.foldedTokens;
					try {
						pi.appendEntry(FOLD_ENTRY, { ...next.fold, at: Date.now() });
					} catch {
						/* persistence is useful, not required for this turn */
					}
					const result = withNotice(next.messages);
					lastView = result;
					lastViewSignature = signature;
					return { messages: result };
				}
				const result = withNotice(view);
				lastView = result;
				lastViewSignature = signature;
				return { messages: result };
			}
			fold = undefined;
		}

		const total = estimateMessagesTokens(messages);
		if (total <= budget) {
			lastViewSignature = signature;
			lastView = undefined;
			return undefined;
		}
		const result = createFold(messages, { budgetTokens: budget, keepRecentTokens: keep, digestTokens });
		if (!result) {
			lastViewSignature = signature;
			lastView = undefined;
			return undefined;
		}
		fold = result.fold;
		foldCount += 1;
		foldedTotalTokens += result.fold.foldedTokens;
		try {
			pi.appendEntry(FOLD_ENTRY, { ...result.fold, at: Date.now() });
		} catch {
			/* persistence is useful, not required for this turn */
		}
		const view = withNotice(result.messages);
		lastView = view;
		lastViewSignature = signature;
		return { messages: view };
	});

	pi.on("tool_result", async (event: any, ctx: any) => {
		const cap = effectiveToolMax(String(event?.toolName ?? ""));
		if (!cap) return undefined;
		const content = Array.isArray(event.content) ? event.content : [];
		const textBlocks = content.filter((part: any) => part?.type === "text" && typeof part.text === "string");
		if (!textBlocks.length) return undefined;
		const fullText = textBlocks.map((part: any) => part.text).join("\n\n");
		if (fullText.length <= cap) return undefined;
		let fullPath: string | undefined = typeof event.details?.fullOutputPath === "string" ? event.details.fullOutputPath : undefined;
		if (!fullPath) fullPath = writeSpill(fullText, ctx);
		const marker = `\n\n[... context governor: ${fullText.length - cap > 0 ? fullText.length - cap : fullText.length} chars omitted from this ${event.toolName} result to protect the context budget. Full output: ${fullPath ?? "unavailable; re-run a narrower command"} — use read with offset/limit if the exact content is needed.]\n\n`;
		const capped = capText(fullText, cap, marker);
		if (!capped.capped) return undefined;
		toolCaps += 1;
		toolCharsSaved += fullText.length - capped.text.length;
		const images = content.filter((part: any) => part?.type === "image");
		return { content: [...images, { type: "text", text: capped.text }] };
	});

	pi.registerCommand("budget", {
		description: "Show session spend, cache efficiency and cost-governor status; /budget <usd|off|reset> sets the soft budget",
		handler: async (args: string, ctx: any) => {
			const arg = String(args ?? "").trim();
			if (arg) {
				if (/^(?:off|none|disabled)$/i.test(arg)) {
					budgetOverride = 0;
					economy = false;
					noticeLevel = 0;
					lastView = undefined;
					lastViewSignature = "";
					notify(ctx, "Cost governor: soft budget disabled for this session; context/tool caps remain active.");
					return;
				}
				if (/^(?:reset|default)$/i.test(arg)) {
					budgetOverride = undefined;
					budgetUsd = defaultBudgetUsd();
					economy = totals.cost >= budgetUsd && budgetUsd > 0;
					noticeLevel = economy ? 1 : 0;
					lastView = undefined;
					lastViewSignature = "";
					notify(ctx, `Cost governor: soft budget reset to ${budgetUsd > 0 ? fmtUsd(budgetUsd) : "off"}.`);
					return;
				}
				const parsed = Number(arg);
				if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
					notify(ctx, "Usage: /budget [<usd>|off|reset]");
					return;
				}
				budgetOverride = parsed;
				economy = parsed > 0 && totals.cost >= parsed;
				noticeLevel = economy ? 1 : 0;
				lastView = undefined;
				lastViewSignature = "";
				notify(ctx, `Cost governor: soft budget set to ${parsed > 0 ? fmtUsd(parsed) : "off"} for this session.`);
				return;
			}
			const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
			const hit = prompt > 0 ? (totals.cacheRead / prompt) * 100 : 0;
			const budget = currentBudget();
			const status = budget > 0 ? `${fmtUsd(totals.cost)} / ${fmtUsd(budget)} (${Math.min(999, Math.round((totals.cost / budget) * 100))}%)` : `${fmtUsd(totals.cost)} / off`;
			const lines = [
				`Cost governor · ${status}${economy ? " · economy mode" : ""}`,
				`Model: ${ctx?.model?.provider ?? "?"}/${ctx?.model?.id ?? "?"} · window ${fmtTokens(num(ctx?.model?.contextWindow))} · context ${fmtTokens(totals.lastPromptTokens)}`,
				`Turns: ${totals.turns} · input ${fmtTokens(totals.input)} · output ${fmtTokens(totals.output)} · cache read ${fmtTokens(totals.cacheRead)} (${hit.toFixed(1)}% hit) · reasoning ${fmtTokens(totals.reasoning)}`,
				`Cost split: input ${fmtUsd(totals.inputCost)} · output ${fmtUsd(totals.outputCost)} · cache ${fmtUsd(totals.cacheCost)} · total ${fmtUsd(totals.cost)}`,
				`Context: budget ${fmtTokens(effectiveContextBudget(ctx?.model))} · keep ${fmtTokens(effectiveKeep(effectiveContextBudget(ctx?.model)))} · folds ${foldCount} (${fmtTokens(foldedTotalTokens)} folded)`,
				`Tool caps: ${toolCaps} result(s), ${fmtTokens(Math.round(toolCharsSaved / 4))} estimated tokens kept out of the request`,
				"Policy: fold old turns deterministically at a stable boundary; cap bash/search output with full-output spill; soft budget tightens caps only. /budget off disables the budget, PI_CONTEXT_GOVERNOR=off disables the governor.",
			];
			notify(ctx, lines.join("\n"));
		},
	});
}

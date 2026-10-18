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
 * Cache-first: a mid-session rewrite invalidates the provider's prefix cache,
 * so a DeepSeek route (any provider serving a DeepSeek model) folds only near
 * the model window, never at a flat 100k. A resume still trims the first call
 * because that prefix is already cold. Other routes keep the original budget.
 *
 * Kill switches:
 *   PI_CONTEXT_GOVERNOR=off          disable folding, caps and budget
 *   PI_CONTEXT_BUDGET=<tokens>       explicit fold threshold (overrides cache-first)
 *   PI_CONTEXT_KEEP=<tokens>         recent tail kept verbatim (default 20000)
 *   PI_TOOL_RESULT_MAX=<chars>       bash/search result cap (default 24000)
 *   PI_COST_BUDGET_USD=<amount|off>  soft budget (default 0.10)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@yunuspi/coding-agent";
import { createReadToolDefinition } from "@yunuspi/coding-agent";
import { Type } from "typebox";
import { createEffortController } from "./lib/effort-policy.mjs";
import { thinkingChangeBreaksPromptCache } from "./lib/adaptive-execution.ts";
import { sessionObservability } from "./lib/session-observability.ts";
import { createCacheSentinel, describeCacheMisses } from "./lib/cache-sentinel.ts";
import { cacheProfileFor } from "./lib/lean-policy.ts";
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
const DEEPSEEK_WINDOW_FRACTION = 0.8;
const OTHER_WINDOW_FRACTION = 0.5;
const DEFAULT_KEEP_RECENT = 20_000;
const DEFAULT_DIGEST_TOKENS = 900;
const DEFAULT_TOOL_MAX = 24_000;
const MIN_FOLD_GROWTH = 12_000;
const HYSTERESIS = 8_000;
const DEFAULT_BUDGET_USD = 0.1;
const ECONOMY_CONTEXT_BUDGET = 60_000;
const RESUME_CONTEXT_BUDGET = 60_000;
const READ_MANY_MAX_FILES = 6;
const READ_MANY_TOTAL_CHARS = 64_000;
const READ_MANY_FILE_CHARS = 24_000;
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

const configuredContextBudget = (): number | undefined => {
	const raw = process.env.PI_CONTEXT_BUDGET;
	if (raw === undefined || raw === "") return undefined;
	return positiveInt(raw, DEFAULT_CONTEXT_BUDGET, 8_000, 900_000);
};
const keepRecent = () => positiveInt(process.env.PI_CONTEXT_KEEP, DEFAULT_KEEP_RECENT, 2_000, 200_000);
const toolResultMax = () => positiveInt(process.env.PI_TOOL_RESULT_MAX, DEFAULT_TOOL_MAX, 1_000, 400_000);
const defaultBudgetUsd = () => positiveUsd(process.env.PI_COST_BUDGET_USD, DEFAULT_BUDGET_USD);

/** Automatic prefix-cache routes: the model id catches DeepSeek served by
 *  DeepInfra, Alibaba, OpenRouter and other provider aliases. */
const cacheFirstRoute = (model: any): boolean => {
	const provider = String(model?.provider ?? "").toLowerCase();
	const id = String(model?.id ?? "").toLowerCase();
	return provider.includes("deepseek") || id.includes("deepseek");
};

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

	// Batched independent inspection: one model request instead of one per file.
	// The individual read tool remains the owner of path safety, image handling
	// and its own truncation; this tool only batches calls and bounds the sum.
	pi.registerTool({
		name: "read_many",
		label: "Read several files",
		description: "Read two to six independent files in one call. Use this for broad inspection instead of serializing one read per turn. Each file is bounded; a capped file names its spill and can be continued with read offset/limit.",
		promptSnippet: "Read several independent files in one turn",
		promptGuidelines: [
			"Use read_many for two to six independent file inspections; use read for one file or a long specific range.",
			"Batch independent work in one turn: a single read_many or several parallel tool calls are cheaper than one file per turn.",
		],
		parameters: Type.Object({
			files: Type.Array(Type.Object({
				path: Type.String({ minLength: 1, maxLength: 4096, description: "File path relative to the working directory or absolute." }),
				offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based first line." })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Maximum lines." })),
			}), { minItems: 2, maxItems: READ_MANY_MAX_FILES, description: "Two to six files to read in one request." }),
		}),
		async execute(toolCallId: string, input: any, signal: any, _onUpdate: any, ctx: any) {
			const files = Array.isArray(input?.files) ? input.files.slice(0, READ_MANY_MAX_FILES) : [];
			if (files.length < 2) return { content: [{ type: "text", text: "read_many requires two to six files; use read for one file." }], isError: true };
			const readTool = createReadToolDefinition(ctx?.cwd || process.cwd());
			const sections: string[] = [];
			const images: any[] = [];
			const details: any[] = [];
			let total = 0;
			let failed = 0;
			for (let index = 0; index < files.length; index++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const spec = files[index] || {};
				const requested = typeof spec.path === "string" ? spec.path.slice(0, 4096) : "";
				if (!requested) {
					failed += 1;
					sections.push(`### <missing path>\nERROR: path is required`);
					details.push({ path: "", error: "path is required" });
					continue;
				}
				try {
					const result = await readTool.execute(`${toolCallId}:${index}`, {
						path: requested,
						...(Number.isSafeInteger(spec.offset) && spec.offset > 0 ? { offset: spec.offset } : {}),
						...(Number.isSafeInteger(spec.limit) && spec.limit > 0 ? { limit: Math.min(2000, spec.limit) } : {}),
					}, signal, undefined, ctx);
					const text = (result?.content || []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
					const resultImages = (result?.content || []).filter((part: any) => part?.type === "image");
					let content = text;
					let truncated = false;
					const remaining = READ_MANY_TOTAL_CHARS - total;
					const budget = Math.min(READ_MANY_FILE_CHARS, remaining);
					if (budget < 1000) {
						sections.push(`### ${requested}\n[read_many aggregate budget exhausted; continue with read path="${requested}"]`);
						details.push({ path: requested, chars: 0, skipped: true });
						continue;
					}
					if (content.length > budget) {
						const spill = writeSpill(content, ctx);
						const marker = `\n\n[... read_many capped this file at ${budget} chars; full output: ${spill ?? "unavailable"}. Continue with read path="${requested}" offset=...]\n\n`;
						content = capText(content, budget, marker).text;
						truncated = true;
					}
					total += content.length;
					sections.push(`### ${requested}\n${content}`);
					images.push(...resultImages);
					details.push({ path: requested, chars: content.length, truncated, ...(result?.details?.fullOutputPath ? { fullOutputPath: result.details.fullOutputPath } : {}) });
				} catch (error) {
					failed += 1;
					const message = error instanceof Error ? error.message : String(error);
					sections.push(`### ${requested}\nERROR: ${message.slice(0, 300)}`);
					details.push({ path: requested, error: message.slice(0, 300) });
				}
			}
			return {
				content: [{ type: "text", text: sections.join("\n\n") }, ...images],
				details: { files: details, totalChars: total },
				...(failed === files.length ? { isError: true } : {}),
			};
		},
	});

	let fold: FoldState | undefined;
	let totals = emptyTotals();
	const sentinel = createCacheSentinel();
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
	let effortCeiling: string | undefined;
	let effort: ReturnType<typeof createEffortController> | undefined;
	let effortManual = false;
	let effortInitialized = false;
	let effortAuto: string | undefined;
	let effortNoticeSent = false;
	let lastUserText = "";
	const effortPending: string[] = [];
	const adaptiveEffortEnabled = String(process.env.PI_ADAPTIVE_EFFORT ?? "").toLowerCase() !== "off";

	const currentBudget = (): number => (budgetOverride !== undefined ? budgetOverride : budgetUsd);

	const effectiveContextBudget = (model: any): number => {
		const window = num(model?.contextWindow);
		const cacheFirst = cacheFirstRoute(model);
		const explicit = configuredContextBudget();
		let configured = explicit
			?? (cacheFirst && window > 0 ? Math.floor(window * DEEPSEEK_WINDOW_FRACTION) : DEFAULT_CONTEXT_BUDGET);
		// Economy mode keeps rewriting the prefix cheap on other routes; on a
		// cache-first route a rewrite costs more than it saves, so only the
		// tool cap and effort policy change there.
		if (economy && !cacheFirst) configured = Math.min(configured, ECONOMY_CONTEXT_BUDGET);
		// A resumed prefix is already cold, so its first call can still trim.
		if (resumed) configured = Math.min(configured, RESUME_CONTEXT_BUDGET);
		if (window <= 0) return configured;
		// Never fold a small window down to something that cannot hold the
		// recent turn plus a digest. DeepSeek keeps its automatic prefix cache
		// valid up to 80% of the window; other routes stay at the safer 50%.
		const cap = Math.max(12_000, Math.floor(window * (cacheFirst ? DEEPSEEK_WINDOW_FRACTION : OTHER_WINDOW_FRACTION)));
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
		sentinel.reset();
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
		effortCeiling = undefined;
		effort = undefined;
		effortManual = false;
		effortInitialized = false;
		effortAuto = undefined;
		effortNoticeSent = false;
		lastUserText = "";
		effortPending.length = 0;
	};

	const initEffort = () => {
		let level = "high";
		try {
			const current = pi.getThinkingLevel();
			if (typeof current === "string") level = current;
		} catch {
			/* a host without a thinking selector keeps the default */
		}
		effortCeiling = level;
		effort = createEffortController({ level, floor: "high", maxStepDown: 2, stepDownAfter: 1, enabled: adaptiveEffortEnabled });
		effortManual = false;
		effortInitialized = true;
		effortAuto = undefined;
		effortNoticeSent = false;
	};

	const applyEffort = (level: string | undefined, ctx?: any) => {
		if (!level) return;
		let current = "";
		try {
			current = String(pi.getThinkingLevel());
		} catch {
			return;
		}
		if (current === level) return;
		effortPending.push(level);
		try {
			pi.setThinkingLevel(level as any);
			effortAuto = level;
			try { sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.("effort.change", { from: current, to: level, reason: level === effortCeiling ? "economy mode restored" : "economy mode" }); } catch { /* visibility only */ }
			if (ctx && effortCeiling && level !== effortCeiling && !effortNoticeSent) {
				effortNoticeSent = true;
				notify(ctx, `Cost governor: economy mode is setting routine tool continuations to ${level} thinking; deep, judgment, error and large-change turns keep ${effortCeiling}. Set PI_ADAPTIVE_EFFORT=off to disable.`);
			}
		} catch {
			const index = effortPending.lastIndexOf(level);
			if (index >= 0) effortPending.splice(index, 1);
		}
	};

	const restoreEffort = (ctx?: any) => {
		if (effortAuto && effortCeiling) applyEffort(effortCeiling, ctx);
		effortAuto = undefined;
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
		initEffort();
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
	pi.on("session_shutdown", () => {
		// Never persist the economy step-down as the user's chosen level.
		restoreEffort();
	});
	pi.on("model_select", () => {
		// A smaller window can make the cached view illegal; re-evaluate the
		// fold against the new effective budget on the next request.
		lastView = undefined;
		lastViewSignature = "";
	});
	pi.on("input", (event: any, ctx: any) => {
		if (!effortInitialized || event?.source === "extension") return;
		const text = typeof event?.originalText === "string" ? event.originalText : event?.text;
		if (typeof text === "string" && text.trim()) lastUserText = text.slice(0, 8_000);
		effort?.reset();
		// A new human turn starts from the configured level again; only goal
		// continuations and tool steps inherit the economy step-down.
		if (effortAuto && effortCeiling) applyEffort(effortCeiling, ctx);
	});
	pi.on("thinking_level_select", (event: any) => {
		const pending = effortPending.indexOf(String(event?.level ?? ""));
		if (pending >= 0) {
			effortPending.splice(pending, 1);
			return;
		}
		if (!effortInitialized) return;
		// The initial level selection is the ceiling, not a manual override.
		if (totals.turns === 0) {
			effortCeiling = String(event.level);
			effort = createEffortController({ level: effortCeiling, floor: "high", maxStepDown: 2, stepDownAfter: 1, enabled: adaptiveEffortEnabled });
			return;
		}
		// A human selection or another controller wins; the economy policy stays
		// out of the way for the rest of this session.
		effortManual = true;
		effortCeiling = String(event.level);
		effort = createEffortController({ level: effortCeiling, floor: "high", maxStepDown: 2, stepDownAfter: 1, enabled: adaptiveEffortEnabled });
		effortAuto = undefined;
	});
	pi.on("turn_end", (event: any, ctx: any) => {
		if (!adaptiveEffortEnabled || !economy || effortManual || !effort || !effortCeiling) return;
		// Where a thinking change re-bills the cached prefix (Anthropic, Qwen templates, DeepSeek) the step-down costs more than it saves.
		if (thinkingChangeBreaksPromptCache(ctx?.model)) return;
		const message = event?.message;
		if (message?.role !== "assistant") return;
		const calls = Array.isArray(message.content) ? message.content.filter((block: any) => block?.type === "toolCall") : [];
		const tools = calls.map((call: any) => String(call.name ?? "")).filter(Boolean);
		const paths = new Set<string>();
		for (const call of calls) {
			const name = String(call?.name ?? "");
			const args = call?.arguments && typeof call.arguments === "object" ? call.arguments : {};
			if (name === "edit" || name === "write" || name === "bulk_edit") {
				if (typeof args.path === "string") paths.add(args.path);
				if (Array.isArray(args.files)) for (const file of args.files) if (typeof file === "string") paths.add(file);
				if (Array.isArray(args.edits)) for (const edit of args.edits) if (typeof edit?.path === "string") paths.add(edit.path);
			}
		}
		const errors = (Array.isArray(event?.toolResults) ? event.toolResults : []).filter((result: any) => result?.isError === true).length;
		const advice = effort.advise({ tools, errors, files: paths.size, userText: lastUserText });
		const desired = advice.difficulty === "routine" && advice.mechanical ? advice.level : effortCeiling;
		if (desired && desired !== effortCeiling) applyEffort(desired, ctx);
		else if (effortAuto && effortCeiling) applyEffort(effortCeiling, ctx);
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

	// Observation only: fingerprint the outgoing request so a cache miss can be named, never alter it.
	pi.on("before_provider_request", (event: any, ctx: any) => {
		try {
			const provider = String(ctx?.model?.provider ?? ""), id = String(ctx?.model?.id ?? "");
			sentinel.request(event?.payload, `${provider}/${id}`, Date.now(), cacheProfileFor(provider, id).ttlSeconds * 1000);
		} catch {
			/* diagnostics never break a request */
		}
		return undefined;
	});

	pi.on("message_end", (event: any, ctx: any) => {
		const message = event?.message;
		if (message?.role !== "assistant" || !message.usage) return;
		try {
			const cost = ctx?.model?.cost;
			const premium = Math.max(0, num(cost?.input) - num(cost?.cacheRead));
			const miss = sentinel.response(message.usage, premium, Date.now(), message.usage.cacheReadReported !== false);
			if (miss && miss.rebilledTokens >= 20_000) pi.appendEntry?.("cache-miss-v1", { ...miss, route: `${ctx?.model?.provider ?? ""}/${ctx?.model?.id ?? ""}` });
		} catch {
			/* diagnostics never break a turn */
		}
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
					restoreEffort(ctx);
					notify(ctx, "Cost governor: soft budget disabled for this session; context/tool caps remain active and the configured thinking level is restored.");
					return;
				}
				if (/^(?:reset|default)$/i.test(arg)) {
					budgetOverride = undefined;
					budgetUsd = defaultBudgetUsd();
					economy = totals.cost >= budgetUsd && budgetUsd > 0;
					noticeLevel = economy ? 1 : 0;
					lastView = undefined;
					lastViewSignature = "";
					if (!economy) restoreEffort(ctx);
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
				if (!economy) restoreEffort(ctx);
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
				describeCacheMisses(sentinel.summary(), fmtTokens, fmtUsd),
				`Cost split: input ${fmtUsd(totals.inputCost)} · output ${fmtUsd(totals.outputCost)} · cache ${fmtUsd(totals.cacheCost)} · total ${fmtUsd(totals.cost)}`,
				`Context: budget ${fmtTokens(effectiveContextBudget(ctx?.model))} · ${cacheFirstRoute(ctx?.model) ? "cache-first, fold only near the window" : "fold at budget"} · keep ${fmtTokens(effectiveKeep(effectiveContextBudget(ctx?.model)))} · folds ${foldCount} (${fmtTokens(foldedTotalTokens)} folded)`,
				`Tool caps: ${toolCaps} result(s), ${fmtTokens(Math.round(toolCharsSaved / 4))} estimated tokens kept out of the request`,
				`Adaptive effort: ${adaptiveEffortEnabled ? "economy-only" : "off"}${effortAuto ? ` · auto ${effortAuto}` : ""}${effortManual ? " · manual override" : ""} · ceiling ${effortCeiling ?? "?"}`,
				"Policy: DeepSeek routes (any provider) are cache-first and fold only near the window so the automatic prefix cache stays warm; other routes fold at the budget. Folding is deterministic at a stable boundary; bash/search output is capped with a full-output spill; a soft budget tightens caps and, in economy mode only, lowers routine tool-continuation thinking while deep/error/large-change turns keep the configured ceiling. /budget off restores the configured level, PI_CONTEXT_GOVERNOR=off disables the governor, PI_ADAPTIVE_EFFORT=off disables economy thinking.",
			];
			notify(ctx, lines.join("\n"));
		},
	});
}

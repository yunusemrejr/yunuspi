import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { getAgentDir, type ExtensionContext } from "@yunuspi/coding-agent";
import { Text } from "@yunuspi/tui";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { persistSubagentCost } from "./session-cost.ts";
import { stripAcceptanceReport } from "../runs/shared/acceptance.ts";
import {
	buildDoubleDirective,
	buildDoubleReconcileTask,
	buildDoubleStreamTask,
	DOUBLE_RECOMMENDED_LIMITS,
	doubleContextFits,
	doubleDirectiveDigest,
	doublePairLabel,
	doublePairSameRoute,
	doubleRouteLabel,
	formatDoubleStatus,
	isDoubleAcknowledgement,
	isDoubleTransientFailure,
	mergeDoubleGaps,
	packageDoubleStreams,
	parseCustomDoubleArgs,
	parseDoubleCommandArgs,
	type DoubleModelRef,
	type DoublePair,
	type DoubleSharedContext,
	type DoubleStreamId,
	type DoubleStreamOutcome,
	type DoubleStreamStatus,
} from "../../../lib/double.ts";
import { extractRequirements } from "../../../lib/requirement-ledger.ts";
import { peerReviewerNotes, publishReviewerNote, registerPlannerStatus, reviewerLabel, reviewerSessionKey } from "../../../lib/reviewer-board.ts";
import { recentUnreliableRoutes } from "../runs/shared/run-history.ts";
import { doubleEconomyBlock, loadLastPair, pairKey, parseStoredPair, resolveDoubleModel, saveLastPair, serializePair, type DoubleRegistryModel } from "./double-pair.ts";
import type { DoublePairPickerOptions } from "../slash/double-pair-picker.ts";

/**
 * Double mode — harness adapter.
 *
 * The portable mechanism (prompts, packaging, directive shape) lives in
 * `extensions/lib/double.ts` and knows nothing about this harness. This
 * module only binds it to native seams: the subagent executor for the two
 * inference streams, `before_agent_start` for turn injection, the shared
 * cost/lifecycle ledgers for accounting, and status/progress UI for
 * observability. No parallel launcher, router, or accounting exists here.
 *
 * Two modes share one runner. `/double` runs the session model twice;
 * `/custom-double` runs two models the user picked (any providers), each pinned
 * to its own route, with the reconciliation on a third choice (A, B or the
 * session model). A pair never substitutes a route either.
 *
 * Flow per user turn while ON:
 *   1. Pin the route(s) (provider/id + thinking); never substitute.
 *   2. Prepare one shared context packet; launch stream A, then stream B once
 *      A has made its first progress (its prompt prefix is cached by then; a
 *      bounded wait covers silent routes), with fork context and a read-only
 *      tool ceiling. A and B prompts share every byte except their closing angle.
 *   3. Reconcile via one lightweight same-route pass (compare → challenge →
 *      reconcile → commit); degrade deterministically when it cannot run.
 *   4. Inject exactly one directive message; the normal turn weighs it against
 *      the user's own words. The system prompt is never modified: an override
 *      alternating with harness wakes (which skip Double) would invalidate the
 *      whole cached conversation on every flip.
 */
export const DOUBLE_RUNNER = Symbol.for("yunus-pi.double-runner.v1");
export const DOUBLE_PROGRESS = "double-progress";
export const DOUBLE_DIRECTIVE_TYPE = "double-directive";
const DOUBLE_MODE_ENTRY = "double-mode-v1";

type Model = NonNullable<ExtensionContext["model"]>;
type Launch = (
	id: string,
	params: SubagentParamsLike,
	signal: AbortSignal,
	onUpdate: ((update: unknown) => void) | undefined,
	ctx: ExtensionContext,
) => Promise<any>;

export const DOUBLE_LIMITS = Object.freeze({
	deadlineMs: 240_000,
	/** Per-stream ceiling; the shared deadline still bounds the slowest peer. */
	streamMs: 150_000,
	/** Lightweight reconciliation ceiling, well under one stream budget. */
	synthesisMs: 60_000,
	/** Stream B starts when A reports its first progress (its shared prefix is then cached) or after this wait. */
	warmWaitMs: 6_000,
	tokensPerStream: 96_000,
	tokensReconcile: 32_000,
	toolsPerStream: 16,
	toolsReconcile: 2,
	maxTaskChars: DOUBLE_RECOMMENDED_LIMITS.maxTaskChars,
	maxStreamChars: DOUBLE_RECOMMENDED_LIMITS.maxStreamTextChars,
	maxReconcileChars: DOUBLE_RECOMMENDED_LIMITS.maxReconcileChars,
	maxDirectiveChars: DOUBLE_RECOMMENDED_LIMITS.maxDirectiveChars,
});

/**
 * Deliberately narrow: streams investigate and propose, the parent executes.
 * Intersected with the read-only automatic-free-assistant tool list, so the
 * effective child tools are exactly these five. denyExtensions stays false
 * because git_info is extension-provided; the agent itself carries no
 * bash/edit/write/commit tools, git authority is read-only, and "subagent"
 * is absent so children cannot nest or re-enter Double.
 */
export const DOUBLE_READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "git_info"];

export interface DoubleRunnerDeps {
	launch: Launch;
	now?: () => number;
	/** Override of DOUBLE_LIMITS.warmWaitMs; 0 launches both streams together. */
	warmWaitMs?: number;
	/** Directory that remembers the last confirmed custom pair; defaults to the agent directory. */
	agentDir?: () => string | undefined;
	/** Routes whose recent automatic runs mostly failed to finish (the popup marks them); defaults to the run ledger. */
	unreliableRoutes?: () => ReadonlySet<string>;
	/** Why the subagent economy policy would refuse a chosen model as a stream (defaults to the live policy). */
	economyBlock?: (model: DoubleRegistryModel) => string | undefined;
	/** The `/custom-double` popup; defaults to the TUI picker. Resolves to the confirmed pair. */
	pickPair?: (ctx: ExtensionContext, options: Omit<DoublePairPickerOptions, "done">) => Promise<DoublePair | undefined>;
}

async function pickPairInTui(ctx: ExtensionContext, options: Omit<DoublePairPickerOptions, "done">): Promise<DoublePair | undefined> {
	const { DoublePairPicker } = await import("../slash/double-pair-picker.ts");
	const result = await ctx.ui.custom<{ confirmed: boolean; pair?: DoublePair }>(
		(tui, theme, keybindings, done) => new DoublePairPicker(tui, theme, keybindings, { ...options, done }),
		{ overlay: false },
	);
	return result?.confirmed ? result.pair : undefined;
}

/** Other reviewers' recent notes, as evidence both streams see identically (cache order is kept). */
function reviewerNotesBlock(notes: ReadonlyArray<{ reviewer: string; note: string; at: number }>, at: number): string {
	const rows = notes.slice(0, 3).map((peer) => {
		const minutes = Math.max(0, Math.round((at - peer.at) / 60_000));
		const text = peer.note.replace(/\s+/g, " ").trim().slice(0, 280);
		return `- ${reviewerLabel(peer.reviewer)}, ${minutes < 1 ? "under a minute" : `${minutes} min`} ago: ${text}`;
	});
	return rows.length
		? `Notes other harness reviewers already gave the agent this session (advisory evidence, newest first; check them against what you observe):\n${rows.join("\n")}`
		: "";
}

const visibleText = (value: unknown, limit: number) =>
	typeof value === "string" ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "").slice(0, limit) : "";

export function renderDoubleProgress(message: any, options: { expanded?: boolean } = {}) {
	const advice = visibleText(message.details?.advice, 2500);
	return new Text(
		visibleText(message.content, 500)
			+ (advice ? `\n${options.expanded ? advice : advice.slice(0, 220) + (advice.length > 220 ? "… Expand for the full Double note." : "")}` : ""),
		0,
		0,
	);
}

function cleanBody(result: any, maxChars: number): string {
	const candidates: unknown[] = [result?.finalOutput, result?.output];
	if (Array.isArray(result?.messages)) {
		for (const message of result.messages.slice().reverse()) {
			if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			candidates.push(message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n"));
		}
	}
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const body = stripAcceptanceReport(candidate).trim();
		if (!body || /^NO_USEFUL_FINDINGS[.!]?$/i.test(body)) continue;
		return body.slice(0, maxChars);
	}
	return "";
}

function resultRow(result: any): any | undefined {
	const rows = Array.isArray(result?.details?.results) ? result.details.results : [];
	if (result?.isError || rows.length !== 1 || !rows[0] || rows[0].exitCode !== 0 || rows[0].error || rows[0].stopped || rows[0].timedOut || rows[0].interrupted) return undefined;
	return rows[0];
}

function rawResultRow(result: any): any | undefined {
	const rows = Array.isArray(result?.details?.results) ? result.details.results : [];
	return rows.length === 1 ? rows[0] : undefined;
}

function failureSuffix(result: any, row: any): string {
	const contentText = Array.isArray(result?.content)
		? result.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n")
		: undefined;
	// Child watchdog telemetry is JSON, not a cause; the classified exit is.
	const category = typeof row?.cause?.category === "string" && row.cause.category !== "unknown" ? row.cause.category : undefined;
	const classified = category ? `${category}${Number.isInteger(row?.exitCode) ? ` (exit ${row.exitCode})` : ""}` : undefined;
	const excerpt = [result?.error, result?.message, result?.details?.error, contentText, classified, typeof row?.error === "string" ? row.error : undefined]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0 && !/^\s*\{"type":"subagent\./.test(value))
		.map((value) => value.replace(/\s+/g, " ").trim().slice(0, 180))[0];
	return excerpt ? ` Underlying failure: ${excerpt}` : "";
}

const FORK_THINKING_DOWNGRADE_MARKER = "fork context forced thinking off";

/**
 * Same-route verification, not assumption: compares the pinned route and
 * thinking level against what a Double pass actually returned. A substituted
 * pass stays usable but visibly degraded — the gap survives into progress,
 * status and the final directive header.
 */
function detectDoubleSubstitutions(label: string, route: string, thinking: string | undefined, result: any, row: any): { kinds: string[]; gap: string } {
	const gaps: string[] = [];
	const kinds: string[] = [];
	if (typeof row?.model === "string" && row.model !== route) {
		kinds.push("route");
		gaps.push(`${label} ran on ${row.model} instead of the pinned ${route}; its analysis is still independent.`);
	}
	const forcedThinkingOff = thinking !== "off" && Array.isArray(result?.content)
		&& result.content.some((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.includes(FORK_THINKING_DOWNGRADE_MARKER));
	const returnedThinking = typeof row?.thinking === "string" ? row.thinking : undefined;
	if (thinking !== undefined) {
		if (forcedThinkingOff) {
			kinds.push("thinking");
			gaps.push(`${label} ran with thinking off instead of the pinned level ${thinking} (fork transcript sanitized); its analysis is still independent.`);
		} else if (returnedThinking !== undefined && returnedThinking !== thinking) {
			kinds.push("thinking");
			gaps.push(`${label} ran with thinking ${returnedThinking} instead of the pinned level ${thinking}; its analysis is still independent.`);
		}
	}
	return { kinds, gap: mergeDoubleGaps(gaps) };
}

/** Retry gate: the deadline check lives at the call site; this judges cause. */
/** A relaunch shorter than the attempt that ran out of time cannot finish
 * what that attempt could not; it would only spend the remaining deadline. */
function isDoubleRetryable(reason: string, row: any, elapsedMs: number, retryWindowMs: number): boolean {
	const timedOut = row?.timedOut === true || /\btim(?:e|ed)\s?out\b/i.test(reason);
	if (timedOut) return retryWindowMs >= elapsedMs;
	return isDoubleTransientFailure(reason);
}

async function boundedAwait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort: (() => void) | undefined;
	try {
		if (signal.aborted) {
			void work.catch(() => {});
			throw signal.reason ?? new Error("Double run cancelled.");
		}
		return await Promise.race([
			work,
			new Promise<T>((_resolve, reject) => {
				abort = () => reject(signal.reason ?? new Error("Double run cancelled."));
				signal.addEventListener("abort", abort!, { once: true });
			}),
		]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}

function appendLifecycle(pi: any, runId: string, status: string, row?: any): void {
	try {
		pi.appendEntry("subagent-lifecycle-v1", {
			runId,
			mode: "single",
			state: status,
			results: [{
				index: 0,
				status,
				...Object.fromEntries(["agent", "label", "scopeId", "model", "runId"].flatMap((key) => typeof row?.[key] === "string" ? [[key, row[key]]] : [])),
				...(Number.isSafeInteger(row?.attempt) ? { attempt: row.attempt } : {}),
			}],
		});
	} catch { /* lifecycle telemetry cannot change the turn result */ }
}

function appendCost(pi: any, sessionFile: string | null | undefined, runId: string, row: any, state: string): void {
	if (!sessionFile) return;
	try {
		persistSubagentCost(pi, { currentSessionId: sessionFile, completionOwnerId: runId }, {
			sessionId: sessionFile,
			completionOwnerId: runId,
			runId,
			mode: "single",
			state,
			results: [row ?? { index: 0, exitCode: 1, error: true }],
		});
	} catch { /* accounting remains unknown when the session sink is unavailable */ }
}

function modelRefOf(model: unknown): DoubleModelRef | undefined {
	const value = model as { provider?: unknown; id?: unknown } | null | undefined;
	if (!value || typeof value.provider !== "string" || !value.provider.trim()
		|| typeof value.id !== "string" || !value.id.trim()) return undefined;
	return { provider: value.provider.trim(), id: value.id.trim() };
}

function skillNamesOf(systemPromptOptions: any): string[] {
	const skills = systemPromptOptions?.skills;
	if (!Array.isArray(skills)) return [];
	const names: string[] = [];
	for (const skill of skills.slice(0, 64)) {
		if (typeof skill === "string" && skill.trim()) names.push(skill.trim());
		else if (skill && typeof skill === "object" && typeof (skill as any).name === "string" && (skill as any).name.trim()) {
			names.push((skill as any).name.trim());
		}
	}
	return [...new Set(names)].slice(0, 32);
}

function toolNamesOf(pi: any): string[] {
	try {
		const tools = pi.getActiveTools?.();
		if (!Array.isArray(tools)) return [];
		return tools.filter((name): name is string => typeof name === "string" && Boolean(name.trim())).slice(0, 64);
	} catch {
		return [];
	}
}

export function registerDoubleMode(pi: any, deps: DoubleRunnerDeps): void {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	if (!deps || typeof deps.launch !== "function") return;
	const now = deps.now ?? Date.now;
	const previous = (globalThis as any)[DOUBLE_RUNNER];
	previous?.dispose?.();
	const lifetime = new AbortController();
	let sessionEpoch = 0;
	let enabled = false;
	/** Set by `/custom-double`; absent means the twin mode (the session model twice). */
	let pair: DoublePair | undefined;
	let capabilityWarned = false;
	let acknowledgementNoted = false;
	let pairNotice: string | undefined;
	let pairUnavailableWarned = false;

	// The streams launch through the executor, not through the model-facing tool, so what matters is that the
	// capability is registered. First-turn tool staging deactivates `subagent` for direct (small) tasks; reading
	// the active set would silently turn the explicit mode off exactly there and name the wrong cause.
	const subagentCapability = (): boolean => {
		try {
			const registered: unknown = pi.getAllTools?.();
			if (Array.isArray(registered)) return registered.some((tool: any) => (typeof tool === "string" ? tool : tool?.name) === "subagent");
			const active: unknown = pi.getActiveTools?.();
			return Array.isArray(active) && active.includes("subagent");
		} catch {
			return false;
		}
	};
	const doubleEnabled = () => enabled && (process.env.PI_DOUBLE ?? "on").toLowerCase() !== "off";
	// While the mode is on, a footer chip says so between prompts too: Double pays for three model passes
	// on every prompt, and a mode that persists across resumes must never be forgotten silently.
	let sessionModelId: string | undefined;
	const idleStatus = (): string | undefined => doubleEnabled()
		? pair ? `Double ON · A ${pair.a.id} ∥ B ${pair.b.id}` : `Double ON · ${sessionModelId ? `${sessionModelId} ×2` : "×2"}`
		: undefined;
	const showIdleStatus = (ctx: any): void => {
		try { sessionModelId = modelRefOf(ctx?.model)?.id ?? sessionModelId; ctx?.ui?.setStatus?.("double", idleStatus()); } catch { /* the footer is optional */ }
	};
	// Double's own streams run as automatic-free-assistant, so their outcomes are exactly this ledger:
	// the popup warns before a route that keeps failing to finish is chosen again.
	const unreliable = (): ReadonlySet<string> => { try { return (deps.unreliableRoutes ?? (() => recentUnreliableRoutes("automatic-free-assistant")))(); } catch { return new Set(); } };
	const agentDir = () => { try { return (deps.agentDir ?? getAgentDir)(); } catch { return undefined; } };
	// Reviewers read this as evidence: the session already runs a deliberation before every prompt.
	const disposePlannerStatus = registerPlannerStatus("double", () => doubleEnabled()
		? `ON${pair ? ` (custom pair ${doublePairLabel(pair)})` : " (the session model, twice)"}: every user prompt is analyzed by two independent streams and reconciled into one planning directive before the agent starts. Do not advise repeating that deliberation; its directive is planning advice the agent holds, not its own reasoning.`
		: undefined);

	for (const event of ["session_start", "session_switch", "session_tree", "session_fork"]) {
		pi.on?.(event, () => { sessionEpoch++; });
	}
	pi.registerMessageRenderer?.(DOUBLE_PROGRESS, renderDoubleProgress);

	// Extension-generated wakes (reminders, background results) are the harness
	// continuing its own work, not a new user prompt; they must not pay for
	// another twin-stream pass. Input is serialized, so the latest input event
	// is the one that owns the before_agent_start that follows it.
	let inputFromExtension = false;
	pi.on?.("input", (event: any) => { inputFromExtension = event?.source === "extension"; return undefined; });

	pi.on?.("session_start", (_event: any, ctx: any) => {
		enabled = false;
		pair = undefined;
		pairNotice = undefined;
		pairUnavailableWarned = false;
		capabilityWarned = false;
		acknowledgementNoted = false;
		try {
			const entries = ctx?.sessionManager?.getEntries?.() ?? [];
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (entry?.type === "custom" && entry?.customType === DOUBLE_MODE_ENTRY) {
					const data = (entry as any)?.data;
					enabled = data?.enabled === true;
					if (enabled && data?.pair !== undefined) {
						pair = parseStoredPair(data.pair);
						if (!pair) pairNotice = "Double: the saved custom pair could not be read, so this session doubles the session model instead. Run /custom-double to choose two models again.";
					}
					break;
				}
			}
		} catch { /* an unreadable ledger leaves Double off */ }
		showIdleStatus(ctx);
	});

	const setEnabled = (next: boolean, ctx: any, nextPair?: DoublePair): void => {
		enabled = next;
		pair = next ? nextPair : undefined;
		pairNotice = undefined;
		try {
			pi.appendEntry(DOUBLE_MODE_ENTRY, { enabled: next, at: now(), ...(pair ? { pair: serializePair(pair) } : {}) });
		} catch { /* in-memory state still governs this session */ }
		try {
			// Streams start at a prompt; turning Double on mid-run changes nothing
			// until then (measured: a session enabled it mid-task and never ran it).
			let busy = false;
			try { busy = next && ctx?.isIdle?.() === false; } catch { /* idle state is optional */ }
			ctx?.ui?.notify?.(formatDoubleStatus(next, modelRefOf(ctx?.model), pair) + (busy ? "\nStarts with your next prompt; the running turn continues single." : ""), "info");
		} catch { /* notification is optional */ }
		showIdleStatus(ctx);
	};

	const availableModels = async (ctx: any): Promise<DoubleRegistryModel[]> => {
		const registry = ctx?.modelRegistry;
		try {
			// Reloading models.json is local; the bound keeps a stuck refresh from hanging the command.
			await Promise.race([Promise.resolve(registry?.refresh?.()), new Promise((resolve) => setTimeout(resolve, 2_000).unref?.())]);
		} catch { /* the last loaded choices still serve */ }
		try {
			const models = registry?.getAvailable?.();
			return Array.isArray(models) ? models : [];
		} catch {
			return [];
		}
	};

	pi.registerCommand("double", {
		description: "Toggle Double mode: twin first-pass streams (A ∥ B) of the current model + one reconcile pass, committed into a single directive",
		argumentHint: "[on|off|status]",
		handler(args: string, ctx: any) {
			let intent: "toggle" | "on" | "off" | "status";
			try {
				intent = parseDoubleCommandArgs(args);
			} catch (error) {
				ctx?.ui?.notify?.(error instanceof Error ? error.message : "Usage: /double [on|off|status]", "error");
				return;
			}
			if (intent === "status") {
				ctx?.ui?.notify?.(formatDoubleStatus(doubleEnabled(), modelRefOf(ctx?.model), pair), "info");
				return;
			}
			// `/double` always means the session model twice; a custom pair is chosen with /custom-double.
			setEnabled(intent === "on" ? true : intent === "off" ? false : !doubleEnabled(), ctx);
		},
	});

	pi.registerCommand("custom-double", {
		description: "Double mode with two models you choose, each from any provider: search and pick A and B in a popup; every request is analyzed by both and reconciled into one directive",
		argumentHint: "[provider/model[:thinking] provider/model[:thinking]] [reconcile=a|b|session] | on | off | status",
		async handler(args: string, ctx: any) {
			const notify = (text: string, level: "info" | "warning" | "error" = "info") => { try { ctx?.ui?.notify?.(text, level); } catch { /* notification is optional */ } };
			let intent: ReturnType<typeof parseCustomDoubleArgs>;
			try {
				intent = parseCustomDoubleArgs(args);
			} catch (error) {
				notify(error instanceof Error ? error.message.replace(/^parseCustomDoubleArgs: /, "") : "Usage: /custom-double", "error");
				return;
			}
			if (intent.kind === "status") {
				notify(formatDoubleStatus(doubleEnabled(), modelRefOf(ctx?.model), pair));
				return;
			}
			if (intent.kind === "off") {
				setEnabled(false, ctx);
				return;
			}
			if ((process.env.PI_DOUBLE ?? "on").toLowerCase() === "off") {
				notify("Double is disabled for this process (PI_DOUBLE=off).", "warning");
				return;
			}
			const models = await availableModels(ctx);
			if (models.length === 0) {
				notify("No models are available to choose from. Connect a provider with /login first.", "error");
				return;
			}
			const sessionRef = modelRefOf(ctx?.model);
			let sessionTokens: number | undefined;
			try {
				const used = ctx?.getContextUsage?.()?.tokens;
				if (typeof used === "number" && Number.isFinite(used)) sessionTokens = used;
			} catch { /* unknown usage marks nothing */ }
			let sessionThinking: string | undefined;
			try {
				const level = pi.getThinkingLevel?.();
				if (typeof level === "string" && level.trim()) sessionThinking = level.trim();
			} catch { /* the models fall back to their own default thinking */ }
			const economyBlock = deps.economyBlock ?? doubleEconomyBlock;
			const adopt = (next: DoublePair) => {
				setEnabled(true, ctx, next);
				saveLastPair(agentDir(), next);
				if (doublePairSameRoute(next)) notify("Both slots use the same model, so this is /double with separate thinking levels.");
				// The executor refuses such a route before it runs; say so now, with the command that lifts it.
				for (const [slot, ref] of [["A", next.a], ["B", next.b]] as const) {
					const model = models.find((candidate) => candidate.provider === ref.provider && candidate.id === ref.id);
					const why = model ? (() => { try { return economyBlock(model); } catch { return undefined; } })() : undefined;
					if (why) notify(`Stream ${slot} (${ref.provider}/${ref.id}) will be unavailable: ${why}. Run /subagents-economy allow ${ref.provider}/${ref.id} to use it.`, "warning");
				}
			};
			const remembered = pair ?? loadLastPair(agentDir());
			if (intent.kind === "pair") {
				const resolved = [intent.a, intent.b].map((token) => resolveDoubleModel(token, models, { sessionProvider: sessionRef?.provider, sessionThinking }));
				const errors = resolved.flatMap((row, index) => row.ok ? [] : [`${index === 0 ? "A" : "B"}: ${row.error}`]);
				if (errors.length) {
					notify(`Custom Double unchanged. ${errors.join(" ")}`, "error");
					return;
				}
				adopt({ a: (resolved[0] as { ref: DoubleModelRef }).ref, b: (resolved[1] as { ref: DoubleModelRef }).ref, reconcile: intent.reconcile ?? "a" });
				return;
			}
			// Only routes that can run now are offered back: a prefill must never smuggle an unavailable model into Start.
			const runnable = (ref: DoubleModelRef | undefined) => ref && models.some((model) => model.provider === ref.provider && model.id === ref.id) ? ref : undefined;
			const usable = remembered && runnable(remembered.a) && runnable(remembered.b) ? remembered : undefined;
			if (intent.kind === "resume" && usable) {
				adopt(usable);
				return;
			}
			const pickPair = deps.pickPair ?? (ctx?.hasUI !== false && typeof ctx?.ui?.custom === "function" ? pickPairInTui : undefined);
			if (!pickPair) {
				notify("The model popup needs an interactive session. Name both models instead: /custom-double provider/model provider/model", "warning");
				return;
			}
			let chosen: DoublePair | undefined;
			try {
				chosen = await pickPair(ctx, {
					models,
					...(remembered ? { initial: { a: runnable(remembered.a), b: runnable(remembered.b), reconcile: remembered.reconcile } } : {}),
					...(sessionRef ? { session: sessionRef } : {}),
					...(sessionThinking ? { sessionThinking } : {}),
					unreliable: unreliable(),
					economyBlock: (model) => { try { return economyBlock(model); } catch { return undefined; } },
					...(typeof sessionTokens === "number" ? { sessionTokens } : {}),
				});
			} catch (error) {
				notify(`Custom Double picker failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`, "error");
				return;
			}
			if (!chosen) {
				notify(`Custom Double unchanged. ${formatDoubleStatus(doubleEnabled(), modelRefOf(ctx?.model), pair)}`);
				return;
			}
			adopt(chosen);
		},
	});

	pi.on?.("before_agent_start", async (event: any, ctx: ExtensionContext) => {
		if (!doubleEnabled()) return undefined;
		if ((globalThis as any)[DOUBLE_RUNNER] !== runner) return undefined;
		if (inputFromExtension) return undefined;
		const prompt = typeof event?.prompt === "string" ? event.prompt : "";
		if (!prompt.trim()) return undefined;
		if (isDoubleAcknowledgement(prompt)) {
			// Nothing new to analyze twice; the streams would only re-read the transcript.
			if (!acknowledgementNoted) {
				acknowledgementNoted = true;
				try { (ctx as any)?.ui?.notify?.("Double: a bare acknowledgement needs no twin pass; this turn continues single.", "info"); } catch {}
			}
			return undefined;
		}
		const ref = modelRefOf(ctx?.model);
		if (!ref) return undefined;
		let route: string;
		try {
			route = doubleRouteLabel(ref);
		} catch {
			return undefined;
		}
		if (ctx?.signal?.aborted || lifetime.signal.aborted) return undefined;
		if (!subagentCapability()) {
			if (!capabilityWarned) {
				capabilityWarned = true;
				try { (ctx as any)?.ui?.notify?.("Double mode needs the subagent capability; this turn continues single.", "warning"); } catch {}
			}
			return undefined;
		}

		if (pairNotice) {
			const text = pairNotice;
			pairNotice = undefined;
			try { (ctx as any)?.ui?.notify?.(text, "warning"); } catch {}
		}
		if (pair) {
			// A pair is pinned: a route that can no longer run is reported, never swapped for another.
			let missing: string | undefined;
			try {
				const models = (ctx as any)?.modelRegistry?.getAvailable?.();
				if (Array.isArray(models)) {
					missing = [pair.a, pair.b].map((candidate) => doubleRouteLabel(candidate))
						.find((label) => !models.some((model: any) => `${model?.provider}/${model?.id}` === label));
				}
			} catch { /* an unreadable registry leaves the pair to the executor's own checks */ }
			if (missing) {
				if (!pairUnavailableWarned) {
					pairUnavailableWarned = true;
					try { (ctx as any)?.ui?.notify?.(`Custom Double: ${missing} is not available right now, so this turn continues single. Run /custom-double to choose again.`, "warning"); } catch {}
				}
				return undefined;
			}
		}

		let sessionFile: string | null | undefined;
		let identity: string;
		try {
			sessionFile = ctx.sessionManager?.getSessionFile?.();
			identity = JSON.stringify([ctx.cwd, ctx.sessionManager?.getSessionId?.(), sessionFile]);
		} catch {
			return undefined;
		}
		// A brand-new session writes its file only after the first reply, and a fork needs that file and a
		// leaf. The first prompt has no earlier conversation to fork anyway (the stream task carries the
		// request), so the streams start fresh instead of both failing with "Parent session file does not exist".
		let forkable = false;
		try { forkable = Boolean(sessionFile) && fs.statSync(sessionFile as string).isFile() && Boolean(ctx.sessionManager?.getLeafId?.()); } catch { forkable = false; }
		const capturedEpoch = sessionEpoch;
		const ownsSession = () => {
			try {
				return capturedEpoch === sessionEpoch
					&& JSON.stringify([ctx.cwd, ctx.sessionManager?.getSessionId?.(), ctx.sessionManager?.getSessionFile?.()]) === identity;
			} catch {
				return false;
			}
		};

		let thinking: string | undefined;
		try {
			const level = pi.getThinkingLevel?.();
			if (typeof level === "string" && level.trim()) thinking = level.trim();
		} catch { /* the child falls back to its default thinking */ }
		// The pinned route is provider + model + thinking; verification below
		// compares each pass against this same triple.
		if (thinking) ref.thinking = thinking;
		const activePair = pair;
		type RouteSpec = { route: string; thinking: string | undefined };
		const sessionSpec: RouteSpec = { route, thinking };
		const specOf = (model: DoubleModelRef): RouteSpec => ({ route: doubleRouteLabel(model), thinking: model.thinking });
		const specs: Record<DoubleStreamId, RouteSpec> = activePair
			? { A: specOf(activePair.a), B: specOf(activePair.b) }
			: { A: sessionSpec, B: sessionSpec };
		const reconcileSpec: RouteSpec = !activePair ? sessionSpec
			: activePair.reconcile === "a" ? specs.A : activePair.reconcile === "b" ? specs.B : sessionSpec;
		// A forked stream reads the whole transcript. Two chosen models may not both hold it (the twin always
		// does: it is the session model), so a route that cannot is skipped with a stated reason instead of
		// failing at the provider, and a reconciliation that cannot fit runs on the session model.
		let sessionTokens: number | undefined;
		try {
			const used = (ctx as any)?.getContextUsage?.()?.tokens;
			if (typeof used === "number" && Number.isFinite(used)) sessionTokens = used;
		} catch { /* unknown usage counts as fitting */ }
		let registryModels: any[] | undefined;
		try {
			const listed = (ctx as any)?.modelRegistry?.getAvailable?.();
			if (Array.isArray(listed)) registryModels = listed;
		} catch { /* an unreadable registry leaves every route to the executor's own checks */ }
		const windowOf = (spec: RouteSpec): number | undefined => registryModels?.find((model) => `${model?.provider}/${model?.id}` === spec.route)?.contextWindow;
		const holdsFork = (spec: RouteSpec) => !activePair || doubleContextFits(windowOf(spec), sessionTokens);
		const tooSmall = (spec: RouteSpec) => `${spec.route} has a ${Math.round((windowOf(spec) ?? 0) / 1000)}k-token window and the session transcript it must read is about ${Math.round((sessionTokens ?? 0) / 1000)}k tokens`;
		const reconcileRun: RouteSpec = holdsFork(reconcileSpec) ? reconcileSpec : sessionSpec;
		const reconcileSwapGap = reconcileRun === reconcileSpec ? "" : `Reconciliation ran on the session model ${route} because ${tooSmall(reconcileSpec)}.`;

		// What the other reviewers already told the agent is evidence neither stream can see in the
		// transcript; both streams get the identical block, so cache order is untouched.
		const boardKey = reviewerSessionKey(ctx);
		let boardNotes = "";
		try { if (boardKey) boardNotes = reviewerNotesBlock(peerReviewerNotes(boardKey, "double", now()), now()); } catch { /* notes only add evidence */ }
		// One shared packet for both streams: immutable context is prepared
		// once, so the two launches differ only in their stream identity.
		const shared: DoubleSharedContext = {
			...(typeof ctx.cwd === "string" && ctx.cwd ? { cwd: ctx.cwd } : {}),
			toolNames: toolNamesOf(pi),
			skillNames: skillNamesOf(event?.systemPromptOptions),
			extra: [
				activePair
					? `Double mode is ON (custom pair): stream A runs ${specs.A.route}${specs.A.thinking ? ` (thinking: ${specs.A.thinking})` : ""}; stream B runs ${specs.B.route}${specs.B.thinking ? ` (thinking: ${specs.B.thinking})` : ""}. The agent that acts on the reconciled directive runs ${route}${thinking ? ` (thinking: ${thinking})` : ""}.`
					: `Active model: ${route}${thinking ? ` (thinking: ${thinking})` : ""}. Double mode is ON for this session; both streams use this same route.`,
				forkable ? "" : "This is the session's first prompt, so there is no earlier conversation yet and you start without a forked transcript.",
				boardNotes,
			].filter(Boolean).join("\n"),
		};
		// Deterministic requirement anchor from the user's own words, shared by both streams, the
		// reconciliation and the directive so every stage is checked against the same list.
		let requirements: string[] = [];
		try { requirements = extractRequirements(prompt).items.slice(0, 8); } catch { /* the literal prompt stays authoritative */ }
		let streamTaskA: string;
		let streamTaskB: string;
		try {
			streamTaskA = buildDoubleStreamTask({ stream: "A", task: prompt, requirements, context: shared, ...(activePair ? { pair: activePair } : {}), maxTaskChars: DOUBLE_LIMITS.maxTaskChars }).task;
			streamTaskB = buildDoubleStreamTask({ stream: "B", task: prompt, requirements, context: shared, ...(activePair ? { pair: activePair } : {}), maxTaskChars: DOUBLE_LIMITS.maxTaskChars }).task;
		} catch {
			return undefined;
		}

		const controller = new AbortController();
		const deadlineTimer = setTimeout(() => controller.abort(new Error("Double deadline reached.")), DOUBLE_LIMITS.deadlineMs);
		deadlineTimer.unref?.();
		const deadlineAt = now() + DOUBLE_LIMITS.deadlineMs;
		const signal = AbortSignal.any([controller.signal, lifetime.signal, ...(ctx.signal ? [ctx.signal] : [])]);
		const current = () => !signal.aborted && ownsSession() && (globalThis as any)[DOUBLE_RUNNER] === runner;

		const statusToken = {};
		let statusOwner: object | undefined = statusToken;
		const setStatus = (text: string | undefined) => {
			if (statusOwner !== statusToken || !ownsSession()) return;
			try { (ctx as any)?.ui?.setStatus?.("double", text ?? idleStatus()); } catch { /* UI is optional */ }
		};
		const progress = (phase: string, status: string, elapsedMs?: number, advice?: string) => {
			if (!ownsSession() || statusOwner !== statusToken) return;
			const detail = [phase, status, elapsedMs === undefined ? "" : `${Math.round(elapsedMs / 1000)}s`].filter(Boolean).join(" · ");
			try {
				const delivery = pi.sendMessage?.({
					customType: DOUBLE_PROGRESS,
					content: `Double: ${visibleText(detail, 420)}`,
					display: true,
					excludeFromContext: true,
					details: { phase, status, ...(advice ? { advice: visibleText(advice, 2500) } : {}) },
				}, { triggerTurn: false });
				void Promise.resolve(delivery).catch(() => { /* display persistence cannot change the turn */ });
			} catch { /* visible diagnostics cannot change the turn */ }
		};

		const launchParams = (task: string, timeoutMs: number, tokens: number, tools: number, label: string, spec: RouteSpec): SubagentParamsLike => ({
			agent: "automatic-free-assistant",
			// The subagent tool has no per-run thinking field (its `thinking` is for watchdog.configure only), so the
			// pinned level travels as the model's own suffix; without it the child silently runs the agent default, off.
			// "off" is the absence of a suffix: the executor strips it because providers reject a literal ":off".
			model: spec.thinking && spec.thinking !== "off" ? `${spec.route}:${spec.thinking}` : spec.route,
			modelOrigin: "explicit",
			context: forkable ? "fork" : "fresh",
			async: false,
			foregroundOnly: true,
			acceptance: { level: "none", reason: "Double advisory pass; the parent commits to one reconciled path." },
			capabilityCeiling: {
				version: 1,
				allowedTools: DOUBLE_READ_ONLY_TOOLS,
				denyExtensions: false,
				sources: ["double-mode-read-only"],
			},
			task,
			usageBudget: { tokens: { hard: Math.max(1, tokens) } },
			timeoutMs,
			maxRuntimeMs: timeoutMs,
			toolBudget: { hard: Math.max(1, tools), soft: Math.max(0, tools - 1) },
			artifacts: false,
			output: false,
			includeProgress: false,
			suppressRoutineResultIntercom: true,
		});

		const settleLate = (runId: string, identity: Record<string, unknown>, work: Promise<any>) => {
			void work.then((late) => {
				if (!ownsSession()) return;
				const lateRow = rawResultRow(late);
				const settled = {
					...identity,
					...lateRow,
					...(typeof late?.details?.runId === "string" ? { runId: late.details.runId } : {}),
					stopped: true,
				};
				appendLifecycle(pi, runId, "stopped", settled);
				appendCost(pi, sessionFile, runId, settled, "stopped");
			}, () => { /* no usage to add */ });
		};

		// Each stream attempt leaves 30s of the shared deadline for reconciliation.
		const streamWindow = () => Math.min(DOUBLE_LIMITS.streamMs, Math.max(1, Math.floor(deadlineAt - now()) - 30_000));

		const runStream = async (stream: DoubleStreamId, task: string, onProgress?: () => void): Promise<DoubleStreamOutcome> => {
			const startedAt = now();
			const scopeId = stream === "A" ? "double-A" : "double-B";
			const label = `Double stream ${stream}`;
			const spec = specs[stream];
			if (!holdsFork(spec)) {
				const gap = `${label} was not started: ${tooSmall(spec)}.`;
				progress(label, "unavailable", 0, gap);
				return { stream, status: "failed", text: "", gap, elapsedMs: 0, attempts: 0 };
			}
			progress(label, "started");
			setStatus(`Double ${stream} · running ∥ peer running`);
			const gaps: string[] = [];
			let attempts = 0;
			// At most one relaunch, and only when the first attempt left no
			// usable text for a reason that a retry could plausibly repair.
			for (let attempt = 1; attempt <= 2; attempt += 1) {
				if (!current() && !signal.aborted) return { stream, status: "cancelled", text: "", gap: `${label} did not start: the session moved on.`, elapsedMs: now() - startedAt, attempts };
				if (signal.aborted || now() >= deadlineAt) {
					return { stream, status: "cancelled", text: "", gap: `${label} was cancelled before returning usable text.`, elapsedMs: now() - startedAt, attempts };
				}
				if (attempt === 2 && gaps.length === 0) break;
				attempts = attempt;
				const runId = `double-${stream === "A" ? "a" : "b"}-${randomUUID()}`;
				const identity = { index: 0, agent: "automatic-free-assistant", attempt, label, scopeId, model: spec.route };
				if (current()) appendCost(pi, sessionFile, runId, { ...identity, status: "running" }, "running");
				let work: Promise<any> | undefined;
				try {
					const timeoutMs = streamWindow();
					work = deps.launch(runId, launchParams(task, timeoutMs, DOUBLE_LIMITS.tokensPerStream, DOUBLE_LIMITS.toolsPerStream, label, spec), signal, onProgress ? () => onProgress() : undefined, ctx);
					const result = await boundedAwait(work, signal);
					const returnedRow = rawResultRow(result);
					const rawRow = {
						...identity,
						...returnedRow,
						...(typeof result?.details?.runId === "string" ? { runId: result.details.runId } : {}),
						...(!returnedRow ? { exitCode: 1, error: result?.details?.launchFailure ?? result?.error ?? true } : {}),
					};
					const row = resultRow(result) ? rawRow : undefined;
					const text = row ? cleanBody(row, DOUBLE_LIMITS.maxStreamChars) : "";
					if (!row || !text) {
						const state = signal.aborted || !ownsSession() ? "stopped" : "failed";
						if (ownsSession()) {
							appendLifecycle(pi, runId, state, rawRow);
							appendCost(pi, sessionFile, runId, rawRow ?? row, state);
						}
						const reason = signal.aborted
							? `${label} was cancelled before returning usable text.`
							: `${label} failed or returned no usable advisory text.${failureSuffix(result, rawRow)}`;
						// One relaunch only when the failure is plausibly
						// transient and enough deadline remains for it.
						if (attempt === 1 && !signal.aborted && ownsSession() && now() + 15_000 < deadlineAt && isDoubleRetryable(reason, rawRow, now() - startedAt, streamWindow())) {
							gaps.push(reason);
							progress(label, "retrying", now() - startedAt, reason);
							continue;
						}
						if (!signal.aborted) progress(label, "unavailable", now() - startedAt, reason);
						return { stream, status: signal.aborted || !ownsSession() ? "cancelled" : "failed", text: "", gap: mergeDoubleGaps([...gaps, reason]) || reason, elapsedMs: now() - startedAt, attempts };
					}
					if (ownsSession()) {
						appendLifecycle(pi, runId, "completed", row);
						appendCost(pi, sessionFile, runId, row, "completed");
					}
					// Same-route pinning is verified, not assumed: a
					// substituted stream stays usable but visibly degraded.
					// The gap must survive packaging into the directive.
					const substituted = detectDoubleSubstitutions(label, spec.route, spec.thinking, result, rawRow);
					const status: DoubleStreamStatus = substituted.kinds.length ? "partial" : "complete";
					progress(label, substituted.kinds.length ? `completed · ${substituted.kinds.join("+")} substituted` : "completed", now() - startedAt, text);
					return {
						stream,
						status,
						text,
						...(substituted.gap ? { gap: substituted.gap } : {}),
						elapsedMs: now() - startedAt,
						attempts,
					};
				} catch (error) {
					if (ownsSession()) {
						const failed = { ...identity, exitCode: 1, error: error instanceof Error ? error.message : "Double stream launch failed" };
						const state = signal.aborted || !ownsSession() ? "stopped" : "failed";
						appendLifecycle(pi, runId, state, failed);
						appendCost(pi, sessionFile, runId, failed, state);
						if (signal.aborted && work) settleLate(runId, identity, work);
					}
					const reason = signal.aborted
						? `${label} was cancelled before returning usable text.`
						: `Double stream ${stream} unavailable: ${error instanceof Error ? error.message.slice(0, 180) : "launch failed"}.`;
					if (attempt === 1 && !signal.aborted && ownsSession() && now() + 15_000 < deadlineAt && isDoubleRetryable(reason, undefined, now() - startedAt, streamWindow())) {
						gaps.push(reason);
						progress(label, "retrying", now() - startedAt, reason);
						continue;
					}
					if (!signal.aborted) progress(label, "unavailable", now() - startedAt, reason);
					return { stream, status: signal.aborted || !ownsSession() ? "cancelled" : "failed", text: "", gap: mergeDoubleGaps([...gaps, reason]) || reason, elapsedMs: now() - startedAt, attempts };
				}
			}
			return { stream, status: "failed", text: "", gap: mergeDoubleGaps(gaps) || `${label} produced no usable text.`, elapsedMs: now() - startedAt, attempts };
		};

		const runReconcile = async (outcomeA: DoubleStreamOutcome, outcomeB: DoubleStreamOutcome): Promise<{ text: string; gap: string }> => {
			let reconcileTask: string;
			try {
				reconcileTask = buildDoubleReconcileTask({ task: prompt, requirements, outcomeA, outcomeB, ...(activePair ? { pair: activePair } : {}), maxTaskChars: DOUBLE_LIMITS.maxTaskChars, maxStreamTextChars: DOUBLE_LIMITS.maxStreamChars }).task;
			} catch {
				return { text: "", gap: "" };
			}
			const startedAt = now();
			const label = "Double reconciliation";
			progress("Reconciliation", "started");
			setStatus("Double · reconciling A ∥ B");
			const runId = `double-reconcile-${randomUUID()}`;
			const identity = { index: 0, agent: "automatic-free-assistant", attempt: 1, label, scopeId: "double-reconcile", model: reconcileRun.route };
			if (current()) appendCost(pi, sessionFile, runId, { ...identity, status: "running" }, "running");
			let work: Promise<any> | undefined;
			try {
				const remaining = Math.max(1, Math.floor(deadlineAt - now()));
				const timeoutMs = Math.min(DOUBLE_LIMITS.synthesisMs, remaining);
				work = deps.launch(runId, launchParams(reconcileTask, timeoutMs, DOUBLE_LIMITS.tokensReconcile, DOUBLE_LIMITS.toolsReconcile, label, reconcileRun), signal, undefined, ctx);
				const result = await boundedAwait(work, signal);
				const returnedRow = rawResultRow(result);
				const rawRow = {
					...identity,
					...returnedRow,
					...(typeof result?.details?.runId === "string" ? { runId: result.details.runId } : {}),
					...(!returnedRow ? { exitCode: 1, error: result?.details?.launchFailure ?? result?.error ?? true } : {}),
				};
				const row = resultRow(result) ? rawRow : undefined;
				const text = row ? cleanBody(row, DOUBLE_LIMITS.maxReconcileChars) : "";
				if (ownsSession()) {
					const state = row && text ? "completed" : signal.aborted || !ownsSession() ? "stopped" : "failed";
					appendLifecycle(pi, runId, state, rawRow ?? row);
					appendCost(pi, sessionFile, runId, rawRow ?? row, state);
				}
				// Reconciliation is verified like the streams: same pinned
				// route and thinking, or a gap that degrades the directive.
				const substituted = row && text ? detectDoubleSubstitutions(label, reconcileRun.route, reconcileRun.thinking, result, rawRow) : { kinds: [] as string[], gap: "" };
				progress("Reconciliation", row && text ? (substituted.kinds.length ? `completed · ${substituted.kinds.join("+")} substituted` : "completed") : "unavailable", now() - startedAt, text || undefined);
				return { text, gap: mergeDoubleGaps([reconcileSwapGap, substituted.gap]) };
			} catch (error) {
				if (ownsSession()) {
					const failed = { ...identity, exitCode: 1, error: error instanceof Error ? error.message : "Double reconciliation failed" };
					const state = signal.aborted || !ownsSession() ? "stopped" : "failed";
					appendLifecycle(pi, runId, state, failed);
					appendCost(pi, sessionFile, runId, failed, state);
					if (signal.aborted && work) settleLate(runId, identity, work);
				}
				if (!signal.aborted) progress("Reconciliation", "unavailable", now() - startedAt);
				return { text: "", gap: "" };
			}
		};

		try {
			setStatus(activePair ? `Double A ∥ B · ${specs.A.route} ∥ ${specs.B.route}` : `Double A ∥ B · ${route}`);
			progress("Independent A ∥ B", "started");
			// B starts when A first reports progress: that means A's request is accepted and the prefix
			// both streams share is cached. Two different routes share no cache, so a pair launches both at once. A failing or finishing A opens the gate too, and the wait is
			// bounded so a route that is silent until it finishes costs at most warmWaitMs.
			let openWarm!: () => void;
			const warm = new Promise<void>((resolve) => { openWarm = resolve; });
			const waitForWarm = (ms: number) => new Promise<void>((resolve) => {
				if (ms <= 0) { resolve(); return; }
				const timer = setTimeout(done, ms);
				timer.unref?.();
				function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
				signal.addEventListener("abort", done, { once: true });
				void warm.then(done);
			});
			const [outcomeA, outcomeB] = await Promise.all([
				runStream("A", streamTaskA, openWarm).finally(openWarm),
				waitForWarm(deps.warmWaitMs ?? (activePair && !doublePairSameRoute(activePair) ? 0 : DOUBLE_LIMITS.warmWaitMs)).then(() => runStream("B", streamTaskB)),
			]);
			let packaged: ReturnType<typeof packageDoubleStreams>;
			try {
				packaged = packageDoubleStreams(outcomeA, outcomeB);
			} catch {
				return undefined;
			}
			if (!ownsSession() || signal.aborted) return undefined;
			if (packaged.usable.length === 0) {
				progress("Unified action", "unavailable");
				try {
					(ctx as any)?.ui?.notify?.(
						`Double: both streams unavailable (${mergeDoubleGaps(packaged.gaps).slice(0, 220) || "no usable text"}). Continuing as a normal single turn.`,
						"warning",
					);
				} catch {}
				return undefined;
			}
			setStatus("Double · reconciling A ∥ B");
			const reconciled = signal.aborted || !ownsSession() ? { text: "", gap: "" } : await runReconcile(outcomeA, outcomeB);
			if (!ownsSession()) return undefined;
			let directive: string;
			let degraded: boolean;
			try {
				({ directive, degraded } = buildDoubleDirective({
					ref,
					...(activePair ? { pair: activePair } : {}),
					requirements,
					...(reconciled.text ? { reconcileText: reconciled.text } : {}),
					...(reconciled.gap ? { reconcileGap: reconciled.gap } : {}),
					outcomeA,
					outcomeB,
					maxDirectiveChars: DOUBLE_LIMITS.maxDirectiveChars,
				}));
			} catch {
				return undefined;
			}
			progress("Unified action", degraded ? "ready · partial" : "ready", undefined, directive.slice(0, 2500));
			// Say what the agent was told on the shared board, so the reviewers neither repeat nor contradict it.
			try { if (boardKey) publishReviewerNote(boardKey, "double", doubleDirectiveDigest(directive), [], now()); } catch { /* the board is best-effort */ }
			setStatus(undefined);
			statusOwner = undefined;
			return { message: { customType: DOUBLE_DIRECTIVE_TYPE, content: directive, display: true } };
		} finally {
			clearTimeout(deadlineTimer);
			if (statusOwner === statusToken) {
				statusOwner = undefined;
				if (ownsSession()) {
					try { (ctx as any)?.ui?.setStatus?.("double", idleStatus()); } catch {}
				}
			}
			controller.abort();
		}
	});

	const runner = {};
	(runner as any).limits = DOUBLE_LIMITS;
	(runner as any).snapshot = () => ({
		enabled: doubleEnabled(),
		kind: pair ? "custom" : "twin",
		...(pair ? { pair: serializePair(pair), key: pairKey(pair) } : {}),
	});
	(runner as any).dispose = () => {
		lifetime.abort();
		disposePlannerStatus();
	};
	(globalThis as any)[DOUBLE_RUNNER] = runner;
	pi.on?.("session_shutdown", () => {
		sessionEpoch++;
		(runner as any).dispose();
		if ((globalThis as any)[DOUBLE_RUNNER] === runner) delete (globalThis as any)[DOUBLE_RUNNER];
	});
}

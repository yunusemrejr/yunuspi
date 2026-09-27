import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@yunuspi/coding-agent";
import { Text } from "@yunuspi/tui";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { persistSubagentCost } from "./session-cost.ts";
import { stripAcceptanceReport } from "../runs/shared/acceptance.ts";
import {
	buildDoubleDirective,
	buildDoubleReconcileTask,
	buildDoubleStreamTask,
DOUBLE_RECOMMENDED_LIMITS,
	doubleRouteLabel,
	formatDoubleStatus,
	mergeDoubleGaps,
	packageDoubleStreams,
	parseDoubleCommandArgs,
	type DoubleModelRef,
	type DoubleSharedContext,
	type DoubleStreamId,
	type DoubleStreamOutcome,
	type DoubleStreamStatus,
} from "../../../lib/double.ts";

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
 * Flow per user turn while ON:
 *   1. Pin the current session route (provider/id + thinking); never substitute.
 *   2. Prepare one shared context packet; launch stream A and stream B
 *      concurrently with fork context and a read-only tool ceiling.
 *   3. Reconcile via one lightweight same-route pass (compare → challenge →
 *      reconcile → commit); degrade deterministically when it cannot run.
 *   4. Inject exactly one directive message; the normal turn commits to it.
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
	onUpdate: undefined,
	ctx: ExtensionContext,
) => Promise<any>;

export const DOUBLE_LIMITS = Object.freeze({
	deadlineMs: 240_000,
	/** Per-stream ceiling; the shared deadline still bounds the slowest peer. */
	streamMs: 150_000,
	/** Lightweight reconciliation ceiling, well under one stream budget. */
	synthesisMs: 60_000,
	tokensPerStream: 96_000,
	tokensReconcile: 32_000,
	toolsPerStream: 16,
	toolsReconcile: 2,
	maxTaskChars: DOUBLE_RECOMMENDED_LIMITS.maxTaskChars,
	maxStreamChars: DOUBLE_RECOMMENDED_LIMITS.maxStreamTextChars,
	maxReconcileChars: DOUBLE_RECOMMENDED_LIMITS.maxReconcileChars,
	maxDirectiveChars: DOUBLE_RECOMMENDED_LIMITS.maxDirectiveChars,
});

/** Deliberately narrow: streams investigate and propose, the parent executes. */
const DOUBLE_READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "git_info"];

export interface DoubleRunnerDeps {
	launch: Launch;
	now?: () => number;
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
	const excerpt = [result?.error, result?.message, result?.details?.error, contentText, typeof row?.error === "string" ? row.error : undefined]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.map((value) => value.replace(/\s+/g, " ").trim().slice(0, 180))[0];
	return excerpt ? ` Underlying failure: ${excerpt}` : "";
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
	let capabilityWarned = false;

	const doubleEnabled = () => enabled && (process.env.PI_DOUBLE ?? "on").toLowerCase() !== "off";

	for (const event of ["session_start", "session_switch", "session_tree", "session_fork"]) {
		pi.on?.(event, () => { sessionEpoch++; });
	}
	pi.registerMessageRenderer?.(DOUBLE_PROGRESS, renderDoubleProgress);

	pi.on?.("session_start", (_event: any, ctx: any) => {
		enabled = false;
		capabilityWarned = false;
		try {
			const entries = ctx?.sessionManager?.getEntries?.() ?? [];
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (entry?.type === "custom" && entry?.customType === DOUBLE_MODE_ENTRY) {
					enabled = (entry as any)?.data?.enabled === true;
					break;
				}
			}
		} catch { /* an unreadable ledger leaves Double off */ }
	});

	const setEnabled = (next: boolean, ctx: any): void => {
		enabled = next;
		try {
			pi.appendEntry(DOUBLE_MODE_ENTRY, { enabled: next, at: now() });
		} catch { /* in-memory state still governs this session */ }
		try {
			ctx?.ui?.notify?.(formatDoubleStatus(next, modelRefOf(ctx?.model)), "info");
		} catch { /* notification is optional */ }
	};

	pi.registerCommand("double", {
		description: "Toggle Double mode: two independent streams of the current model reconciled into one decision",
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
				ctx?.ui?.notify?.(formatDoubleStatus(doubleEnabled(), modelRefOf(ctx?.model)), "info");
				return;
			}
			setEnabled(intent === "on" ? true : intent === "off" ? false : !doubleEnabled(), ctx);
		},
	});

	pi.on?.("before_agent_start", async (event: any, ctx: ExtensionContext) => {
		if (!doubleEnabled()) return undefined;
		if ((globalThis as any)[DOUBLE_RUNNER] !== runner) return undefined;
		const prompt = typeof event?.prompt === "string" ? event.prompt : "";
		if (!prompt.trim()) return undefined;
		const ref = modelRefOf(ctx?.model);
		if (!ref) return undefined;
		let route: string;
		try {
			route = doubleRouteLabel(ref);
		} catch {
			return undefined;
		}
		if (ctx?.signal?.aborted || lifetime.signal.aborted) return undefined;
		try {
			const activeTools: unknown = pi.getActiveTools?.();
			if (!Array.isArray(activeTools) || !activeTools.includes("subagent")) {
				if (!capabilityWarned) {
					capabilityWarned = true;
					try { (ctx as any)?.ui?.notify?.("Double mode needs the subagent capability; this turn continues single.", "warning"); } catch {}
				}
				return undefined;
			}
		} catch {
			return undefined;
		}

		let sessionFile: string | null | undefined;
		let identity: string;
		try {
			sessionFile = ctx.sessionManager?.getSessionFile?.();
			identity = JSON.stringify([ctx.cwd, ctx.sessionManager?.getSessionId?.(), sessionFile]);
		} catch {
			return undefined;
		}
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

		// One shared packet for both streams: immutable context is prepared
		// once, so the two launches differ only in their stream identity.
		const shared: DoubleSharedContext = {
			...(typeof ctx.cwd === "string" && ctx.cwd ? { cwd: ctx.cwd } : {}),
			toolNames: toolNamesOf(pi),
			skillNames: skillNamesOf(event?.systemPromptOptions),
			extra: `Active model: ${route}${thinking ? ` (thinking: ${thinking})` : ""}. Double mode is ON for this session; both streams use this same route.`,
		};
		let streamTaskA: string;
		let streamTaskB: string;
		try {
			streamTaskA = buildDoubleStreamTask({ stream: "A", task: prompt, context: shared, maxTaskChars: DOUBLE_LIMITS.maxTaskChars }).task;
			streamTaskB = buildDoubleStreamTask({ stream: "B", task: prompt, context: shared, maxTaskChars: DOUBLE_LIMITS.maxTaskChars }).task;
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
			try { (ctx as any)?.ui?.setStatus?.("double", text); } catch { /* UI is optional */ }
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

		const launchParams = (task: string, timeoutMs: number, tokens: number, tools: number, label: string): SubagentParamsLike => ({
			agent: "automatic-free-assistant",
			model: route,
			...(thinking ? { thinking } : {}),
			modelOrigin: "explicit",
			context: "fork",
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

		const runStream = async (stream: DoubleStreamId, task: string): Promise<DoubleStreamOutcome> => {
			const startedAt = now();
			const scopeId = stream === "A" ? "double-A" : "double-B";
			const label = `Double stream ${stream}`;
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
				const identity = { index: 0, agent: "automatic-free-assistant", attempt, label, scopeId, model: route };
				if (current()) appendCost(pi, sessionFile, runId, { ...identity, status: "running" }, "running");
				let work: Promise<any> | undefined;
				try {
					const remaining = Math.max(1, Math.floor(deadlineAt - now()));
					const timeoutMs = Math.min(DOUBLE_LIMITS.streamMs, Math.max(1, remaining - 30_000));
					work = deps.launch(runId, launchParams(task, timeoutMs, DOUBLE_LIMITS.tokensPerStream, DOUBLE_LIMITS.toolsPerStream, label), signal, undefined, ctx);
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
					// Same-route pinning is verified, not assumed: a silently
					// substituted stream stays usable but visibly degraded.
					const ranRoute = typeof rawRow?.model === "string" && rawRow.model !== route ? rawRow.model : undefined;
					if (!row || !text) {
						const state = signal.aborted || !ownsSession() ? "stopped" : "failed";
						if (ownsSession()) {
							appendLifecycle(pi, runId, state, rawRow);
							appendCost(pi, sessionFile, runId, rawRow ?? row, state);
						}
						const reason = signal.aborted
							? `${label} was cancelled before returning usable text.`
							: `${label} failed or returned no usable advisory text.${failureSuffix(result, rawRow)}`;
						if (attempt === 1 && !signal.aborted && ownsSession() && now() + 15_000 < deadlineAt) {
							gaps.push(reason);
							continue;
						}
						if (!signal.aborted) progress(label, "unavailable", now() - startedAt);
						return { stream, status: signal.aborted || !ownsSession() ? "cancelled" : "failed", text: "", gap: mergeDoubleGaps([...gaps, reason]) || reason, elapsedMs: now() - startedAt, attempts };
					}
					if (ownsSession()) {
						appendLifecycle(pi, runId, "completed", row);
						appendCost(pi, sessionFile, runId, row, "completed");
					}
					progress(label, "completed", now() - startedAt, text);
					// Usable text on the wrong route is partial, not complete:
					// the gap must survive packaging into the directive.
					const status: DoubleStreamStatus = ranRoute ? "partial" : "complete";
					return {
						stream,
						status,
						text,
						...(ranRoute ? { gap: `${label} ran on ${ranRoute} instead of the pinned ${route}; its analysis is still independent.` } : {}),
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
					if (attempt === 1 && !signal.aborted && ownsSession() && now() + 15_000 < deadlineAt) {
						gaps.push(reason);
						continue;
					}
					if (!signal.aborted) progress(label, "unavailable", now() - startedAt);
					return { stream, status: signal.aborted || !ownsSession() ? "cancelled" : "failed", text: "", gap: mergeDoubleGaps([...gaps, reason]) || reason, elapsedMs: now() - startedAt, attempts };
				}
			}
			return { stream, status: "failed", text: "", gap: mergeDoubleGaps(gaps) || `${label} produced no usable text.`, elapsedMs: now() - startedAt, attempts };
		};

		const runReconcile = async (outcomeA: DoubleStreamOutcome, outcomeB: DoubleStreamOutcome): Promise<string> => {
			let reconcileTask: string;
			try {
				reconcileTask = buildDoubleReconcileTask({ task: prompt, outcomeA, outcomeB, maxTaskChars: DOUBLE_LIMITS.maxTaskChars, maxStreamTextChars: DOUBLE_LIMITS.maxStreamChars }).task;
			} catch {
				return "";
			}
			const startedAt = now();
			progress("Reconciliation", "started");
			setStatus("Double · reconciling A ∥ B");
			const runId = `double-reconcile-${randomUUID()}`;
			const identity = { index: 0, agent: "automatic-free-assistant", attempt: 1, label: "Double reconciliation", scopeId: "double-reconcile", model: route };
			if (current()) appendCost(pi, sessionFile, runId, { ...identity, status: "running" }, "running");
			let work: Promise<any> | undefined;
			try {
				const remaining = Math.max(1, Math.floor(deadlineAt - now()));
				const timeoutMs = Math.min(DOUBLE_LIMITS.synthesisMs, remaining);
				work = deps.launch(runId, launchParams(reconcileTask, timeoutMs, DOUBLE_LIMITS.tokensReconcile, DOUBLE_LIMITS.toolsReconcile, "Double reconciliation"), signal, undefined, ctx);
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
				progress("Reconciliation", row && text ? "completed" : "unavailable", now() - startedAt, text || undefined);
				return text;
			} catch (error) {
				if (ownsSession()) {
					const failed = { ...identity, exitCode: 1, error: error instanceof Error ? error.message : "Double reconciliation failed" };
					const state = signal.aborted || !ownsSession() ? "stopped" : "failed";
					appendLifecycle(pi, runId, state, failed);
					appendCost(pi, sessionFile, runId, failed, state);
					if (signal.aborted && work) settleLate(runId, identity, work);
				}
				if (!signal.aborted) progress("Reconciliation", "unavailable", now() - startedAt);
				return "";
			}
		};

		try {
			setStatus(`Double A ∥ B · ${route}`);
			progress("Independent A ∥ B", "started");
			const [outcomeA, outcomeB] = await Promise.all([runStream("A", streamTaskA), runStream("B", streamTaskB)]);
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
			const reconcileText = signal.aborted || !ownsSession() ? "" : await runReconcile(outcomeA, outcomeB);
			if (!ownsSession()) return undefined;
			let directive: string;
			let degraded: boolean;
			try {
				({ directive, degraded } = buildDoubleDirective({
					ref,
					...(reconcileText ? { reconcileText } : {}),
					outcomeA,
					outcomeB,
					maxDirectiveChars: DOUBLE_LIMITS.maxDirectiveChars,
				}));
			} catch {
				return undefined;
			}
			progress("Unified action", degraded ? "ready · partial" : "ready", undefined, directive.slice(0, 2500));
			setStatus(undefined);
			statusOwner = undefined;
			const systemNote = `\n\nDouble mode reconciled two independent ${route} analyses into this turn's directive message. Commit to its single path; challenge its open questions against live evidence instead of re-running both analyses.`;
			return {
				message: { customType: DOUBLE_DIRECTIVE_TYPE, content: directive, display: true },
				systemPrompt: typeof event?.systemPrompt === "string" ? `${event.systemPrompt}${systemNote}` : undefined,
			};
		} finally {
			clearTimeout(deadlineTimer);
			if (statusOwner === statusToken) {
				statusOwner = undefined;
				if (ownsSession()) {
					try { (ctx as any)?.ui?.setStatus?.("double", undefined); } catch {}
				}
			}
			controller.abort();
		}
	});

	const runner = {};
	(runner as any).limits = DOUBLE_LIMITS;
	(runner as any).dispose = () => {
		lifetime.abort();
	};
	(globalThis as any)[DOUBLE_RUNNER] = runner;
	pi.on?.("session_shutdown", () => {
		sessionEpoch++;
		(runner as any).dispose();
		if ((globalThis as any)[DOUBLE_RUNNER] === runner) delete (globalThis as any)[DOUBLE_RUNNER];
	});
}

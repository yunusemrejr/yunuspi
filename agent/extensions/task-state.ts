/**
 * Task State Graph — shared structured task state beneath the harness.
 *
 * Event-sourced: bounded harness happenings become append-only events, a
 * deterministic reducer materializes the current graph, and consumers read
 * small relevance-selected projections. The graph records and exposes; it
 * never decides, permits, or orchestrates.
 *
 * Reads are exposed through one compact `task_state` tool and the
 * `/task-state` command. Writes happen automatically from harness events.
 * Everything here is fail-open: any graph failure degrades to existing
 * behavior with visible health status.
 */
import type { ExtensionAPI, ExtensionContext } from "@yunuspi/coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@yunuspi/ai";
import {
	clearTaskStateServices,
	currentTaskStateService,
	getTaskStateService,
	type TaskStateService,
} from "./lib/task-state/service.ts";
import {
	bashResultEvents,
	completionClaimEvents,
	fileWriteEvents,
	findingEvents,
	isTestLikeCommand,
	subagentResultEvents,
	stableId,
	todoEvents,
	type LedgerRequirement,
} from "./lib/task-state/ingest.ts";
import { collectDiagnostics } from "./lib/task-state/projections.ts";
import type { TaskEvent, TaskRefs } from "./lib/task-state/types.ts";
import { readSessionLedger } from "./lib/requirement-ledger.ts";
import { taskFileHashes, taskFileObservation, MAX_EVIDENCE_FILES } from "./lib/task-state/file-evidence.ts";
import { classifyChildTerminal, type ChildTerminalFacts } from "./pi-subagents/src/runs/shared/group-reliability.ts";

const DISABLED = process.env.PI_TASK_STATE === "0";

function sidOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() || "";
	} catch {
		return "";
	}
}

function serviceFor(ctx: ExtensionContext): TaskStateService | undefined {
	const sid = sidOf(ctx);
	if (!sid) return currentTaskStateService();
	try {
		return getTaskStateService(sid);
	} catch {
		return undefined;
	}
}

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => !!part && (part as { type: string }).type === "text")
		.map((part) => part.text)
		.join("\n");
};

/** Latest prompt-analysis relation from the branch (reuses existing infrastructure). */
function latestAnalysisRelation(ctx: ExtensionContext, requestId?: string): string | undefined {
	if (!requestId) return undefined;
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as any;
			const message = entry.type === "custom_message" ? entry : entry.message;
			if (message?.customType === "prompt-analysis" && message.details?.requestId === requestId) {
				const relation = message.details?.relation;
				if (typeof relation === "string" && relation) return relation;
				return undefined;
			}
		}
	} catch {
		/* branch reads are best-effort */
	}
	return undefined;
}

/** Read the persisted owner, never a context-only rendering or a second split. */
function ledgerItemsFromBranch(ctx: ExtensionContext): LedgerRequirement[] {
	try {
		return readSessionLedger(ctx.sessionManager.getBranch())?.items ?? [];
	} catch {
		/* ignore */
	}
	return [];
}

function todoTasksFromResult(event: { details?: unknown; output?: unknown }): Array<{ id: number; title?: string; status?: string }> {
	const details = (event.details ?? event.output) as { tasks?: unknown } | undefined;
	if (!details || !Array.isArray(details.tasks)) return [];
	return details.tasks
		.filter((task): task is { id: number; subject?: string; title?: string; status?: string } =>
			!!task && typeof task === "object" && Number.isSafeInteger((task as { id: number }).id))
		.map((task) => ({
			id: task.id,
			title: typeof task.subject === "string" ? task.subject : typeof task.title === "string" ? task.title : undefined,
			status: typeof task.status === "string" ? task.status : undefined,
		}));
}

function excerptOf(event: { content?: unknown }, max = 600): string {
	return textOf(event.content).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Bounded source scope observed before a command starts. */
function checkSources(service: TaskStateService, cwd: string): TaskRefs {
	const graph = service.graph();
	const files = Object.keys(graph.files).sort((a, b) => graph.files[b].ts - graph.files[a].ts).slice(0, MAX_EVIDENCE_FILES);
	return { fileVersions: Object.fromEntries(files.map(file => [file, graph.files[file].version])), fileHashes: taskFileHashes(cwd, files) };
}

/** A result binds matching source observations before and after the command. */
function bindCheckSources(events: TaskEvent[], service: TaskStateService, cwd: string, start?: TaskRefs): void {
	if (!start?.fileVersions || !start.fileHashes) return;
	const hashes = taskFileHashes(cwd, Object.keys(start.fileVersions));
	const versions: Record<string, number> = {};
	const stableHashes: Record<string, string> = {};
	for (const [file, version] of Object.entries(start.fileVersions)) {
		if (service.graph().files[file]?.version === version && start.fileHashes[file] && hashes[file] === start.fileHashes[file]) {
			versions[file] = version;
			stableHashes[file] = hashes[file];
		}
	}
	for (const event of events) {
		if (event.kind === "entity-upsert" && event.entity.kind === "evidence") {
			event.entity.refs = { ...event.entity.refs, fileVersions: versions, fileHashes: stableHashes };
		}
	}
}

/** Use the runner's terminal contract, including partial failure and cancellation. */
function childStatus(details: Record<string, unknown>, failed = false): "active" | "implemented" | "failed" {
	const results = Array.isArray(details.results) ? details.results : [];
	const terminals = results.map(child => child && typeof child === "object" ? classifyChildTerminal(child as ChildTerminalFacts) : undefined);
	const terminal = classifyChildTerminal(details as ChildTerminalFacts);
	if (failed || (terminal && terminal !== "succeeded") || terminals.some(state => state && state !== "succeeded")) return "failed";
	if (terminals.length) return terminals.every(state => state === "succeeded") ? "implemented" : "active";
	return terminal === "succeeded" ? "implemented" : "active";
}

export default function taskStateExtension(pi: ExtensionAPI): void {
	if (DISABLED) return;
	let pendingInput: { sessionId: string; requestId: string; text: string; taskId: string; mode: string; hadTask: boolean } | undefined;

	pi.registerTool({
		name: "task_state",
		label: "Task State",
		description: "Inspect shared task state, retained implementation/evidence IDs, and requirement blockers. Use assess to bind one requirement to completed native implementation and current observed checks with a coverage reason. The main stream owns judgment; successful exits and child claims never automatically verify requirements.",
		parameters: Type.Object({
			action: Type.Optional(StringEnum([
				"status", "requirements", "unresolved", "evidence", "work", "entity", "blockers", "failures", "decisions", "diagnostics", "assess",
			])),
			entityId: Type.Optional(Type.String({ description: "Entity id for action=entity." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
			requirementId: Type.Optional(Type.String({ maxLength: 160, description: "Current R# or full requirement entity ID for assess." })),
			implementationIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 8, description: "Retained IDs from work; native edits, completed todo work or successful command attempts." })),
			evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 8, description: "Retained IDs from evidence; current native check observations." })),
			reason: Type.Optional(Type.String({ minLength: 20, maxLength: 1200, description: "Explain which behavior the checks observed and why that covers this requirement. Passing alone is insufficient." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const service = serviceFor(ctx);
			if (!service) throw new Error("Task state is unavailable in this session.");
			const action = params.action ?? "status";
			const limit = Math.max(1, Math.min(60, params.limit ?? 12));
			let text: string;
			if (action === "assess") {
				const implementations = params.implementationIds ?? [];
				const files = service.assessmentFiles(implementations);
				const assessment = service.assessRequirement({ requirementId: params.requirementId ?? "", implementationIds: implementations,
					evidenceIds: params.evidenceIds ?? [], reason: params.reason ?? "" }, taskFileHashes(ctx.cwd, files));
				return { content: [{ type: "text" as const, text: JSON.stringify(assessment) }], details: assessment, ...(assessment.ok ? {} : { isError: true }) };
			} else if (action === "work" || action === "evidence") {
				const entities = Object.values(service.graph().entities).filter(entity => action === "evidence" ? entity.kind === "evidence" : ["tool-exec", "work", "attempt"].includes(entity.kind))
					.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
				text = entities.map(entity => `${entity.id} [${entity.kind}/${entity.status}${entity.stale ? "/STALE" : ""}] ${entity.title.slice(0, 160)}`).join("\n") || "No retained records.";
			} else if (action === "entity") {
				const entity = params.entityId ? service.entity(params.entityId) : undefined;
				text = entity ? JSON.stringify(entity, null, 1).slice(0, 4000) : `No task-state entity ${(params.entityId ?? "").slice(0, 80)}.`;
			} else if (action === "diagnostics") {
				text = JSON.stringify(collectDiagnostics(service.graph()), null, 1).slice(0, 6000);
			} else {
				text = service.project(action === "status" ? "main" : "main", 4000);
				if (action !== "status") {
					// Focused slices stay bounded: filter the main projection to
					// the requested section instead of dumping the graph.
					const want = action === "requirements" ? "Requirements"
						: action === "blockers" ? "Completion blockers"
						: action === "failures" ? "Recent failures"
						: action === "evidence" ? "Recent evidence"
						: action === "decisions" ? "Decisions"
						: "Unresolved requirements";
					const lines = text.split("\n");
					const head = lines.slice(0, 2);
					const start = lines.findIndex((line) => line.startsWith(`${want}:`) || line.startsWith(want));
					text = start < 0 ? text : [...head, ...lines.slice(start, start + limit + 2)].join("\n");
				}
			}
			const details = { action, text: text.slice(0, 6000) };
			return { content: [{ type: "text" as const, text: details.text }], details };
		},
	});

	pi.registerCommand("task-state", {
		description: "Show the shared Task State Graph: requirements, work, evidence, failures, reviews and health.",
		handler: (args: string, ctx: ExtensionContext) => {
			try {
				const service = serviceFor(ctx);
				if (!service) {
					ctx.ui?.notify?.("Task state is unavailable in this session.", "warning");
					return;
				}
				const query = String(args ?? "").trim();
				if (query) {
					const entity = service.entity(query)
						?? service.query((entry) => entry.id.includes(query) || (entry.refs?.requirementId ?? "") === query.toUpperCase(), 1)[0];
					ctx.ui?.notify?.(
						entity ? `${entity.id} [${entity.kind}/${entity.status}] ${entity.title} — provenance ${entity.provenance}${entity.stale ? " STALE" : ""}` : `No task-state entity matching ${query.slice(0, 60)}.`,
						"info",
					);
					return;
				}
				ctx.ui?.notify?.(service.project("summary"), "info");
			} catch (error) {
				ctx.ui?.notify?.(`Task state unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		pendingInput = undefined;
		try {
			if (sidOf(ctx)) getTaskStateService(sidOf(ctx));
		} catch {
			/* degraded mode covers this */
		}
	});
	pi.on("session_switch", (_event, ctx) => {
		pendingInput = undefined;
		try {
			if (sidOf(ctx)) getTaskStateService(sidOf(ctx));
		} catch {
			/* ignore */
		}
	});
	const checkpoint = (_event: unknown, ctx: ExtensionContext): void => {
		try {
			serviceFor(ctx)?.checkpoint();
		} catch {
			/* snapshots must never break compaction or shutdown */
		}
	};
	pi.on("session_before_compact", checkpoint);
	// The ledger's input hook may run after ours; adopt its persisted receipt
	// after all input handlers, before the first model call of the request.
	pi.on("before_agent_start", (_event, ctx) => {
		try { serviceFor(ctx)?.syncRequirements(ledgerItemsFromBranch(ctx), pendingInput?.mode === "correction" ? "correction" : "followup"); }
		catch { /* ledger synchronization never blocks a turn */ }
	});
	pi.on("session_shutdown", () => {
		pendingInput = undefined;
		try {
			currentTaskStateService()?.checkpoint();
		} catch {
			/* ignore */
		} finally {
			clearTaskStateServices();
		}
	});

	pi.on("input", (event: { source?: string; text?: unknown; originalText?: unknown; requestId?: string }, ctx: ExtensionContext) => {
		try {
			// The user's own words, not text the harness wrapped around them (a goal kickoff adds criteria).
			const words = typeof event.originalText === "string" ? event.originalText : event.text;
			if (event.source === "extension" || typeof words !== "string" || !words.trim()) return;
			const service = serviceFor(ctx);
			if (!service) return;
			const hadTask = !!service.graph().label;
			const relation = latestAnalysisRelation(ctx, event.requestId);
			const { mode } = service.userInput(words, relation);
			pendingInput = event.requestId ? { sessionId: sidOf(ctx), requestId: event.requestId, text: words, taskId: service.taskId, mode, hadTask } : undefined;
			// The ledger folds on the same hook and persists its own R-ids.
			const items = ledgerItemsFromBranch(ctx);
			if (items.length) service.syncRequirements(items, mode);
		} catch {
			/* user input must never fail because of the graph */
		}
	});

	pi.on("tool_call", (event: { toolName?: string; input?: Record<string, unknown>; toolCallId?: string }, ctx: ExtensionContext) => {
		try {
			const service = serviceFor(ctx);
			if (!service) return;
			const input = event.input ?? {};
			if (["bash", "bg_run", "process"].includes(event.toolName ?? "") && typeof input.command === "string" && isTestLikeCommand(input.command)) {
				const graph = service.graph();
				const events = bashResultEvents({ sessionId: graph.sessionId, taskId: graph.taskId, ts: Date.now() },
					{ command: input.command, toolCallId: event.toolCallId, failed: false, pending: true });
				const sources = checkSources(service, ctx.cwd);
				for (const event of events) if (event.kind === "entity-upsert") event.entity.refs = { ...event.entity.refs, ...sources };
				service.apply(events);
				return;
			}
			if (event.toolName !== "subagent" || input.action) return;
			const label = typeof input.agent === "string" && input.agent ? input.agent
				: typeof input.action === "string" && input.action ? `action:${input.action}`
				: input.workflowScript || input.workflowScriptPath ? "workflow" : "dispatch";
			const brief = typeof input.task === "string" ? input.task
				: typeof input.commonTask === "string" ? input.commonTask : "";
			service.record({
				id: `child-${stableId([service.taskId, event.toolCallId ?? Date.now()])}`,
				kind: "child",
				status: "active",
				title: `dispatch ${String(label).slice(0, 80)}`,
				detail: brief.replace(/\s+/g, " ").trim().slice(0, 600) || undefined,
				provenance: "main-agent",
				refs: { toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined },
			}, `dispatch:${String(event.toolCallId ?? "")}`);
		} catch {
			/* dispatch recording is advisory */
		}
	});

	pi.on("tool_result", (event: {
		toolName?: string;
		toolCallId?: string;
		input?: Record<string, unknown>;
		content?: unknown;
		details?: unknown;
		output?: unknown;
		isError?: boolean;
	}, ctx: ExtensionContext) => {
		try {
			const service = serviceFor(ctx);
			if (!service) return;
			const graph = service.graph();
			const ingestCtx = { sessionId: graph.sessionId, taskId: graph.taskId, ts: Date.now() };
			const events: TaskEvent[] = [];
			const name = event.toolName ?? "";
			const start = service.entity(`att-${stableId([service.taskId, event.toolCallId])}`)?.refs;
			if ((name === "edit" || name === "write") && !event.isError && typeof event.input?.path === "string") {
				const observation = taskFileObservation(ctx.cwd, event.input.path);
				const file = observation.file.slice(0, 512);
				if (event.toolCallId && service.entity(`chg-${stableId([graph.taskId, file, event.toolCallId])}`)) return;
				const nextVersion = (graph.files[file]?.version ?? 0) + 1;
				events.push(...fileWriteEvents(ingestCtx, {
					path: file,
					toolCallId: event.toolCallId,
					contentHash: observation.hash,
				}, nextVersion));
			} else if (name === "bash" || name === "bg_run" || name === "process") {
				const command = typeof event.input?.command === "string" ? event.input.command : "";
				// Completion-relevant outcomes and failures only; routine reads
				// and passing non-check commands are telemetry noise.
				if (event.isError === true || isTestLikeCommand(command)) {
					events.push(...bashResultEvents(ingestCtx, {
						command,
						toolCallId: event.toolCallId,
						failed: event.isError === true,
						excerpt: excerptOf(event),
						// bg_run hands back a task id before the command has produced any
						// result, so a suite it launches is not yet a passing check.
						pending: name === "bg_run" && event.isError !== true,
					}));
				}
			} else if (name === "todo") {
				const tasks = todoTasksFromResult(event);
				if (tasks.length) events.push(...todoEvents(ingestCtx, tasks));
			} else if (name === "subagent") {
				const details = (event.details ?? {}) as Record<string, unknown>;
				if (details.mode === "management") return;
				const runId = String(event.toolCallId ?? `sub-${Date.now()}`);
				const agent = typeof event.input?.agent === "string" ? event.input.agent : undefined;
				events.push(...subagentResultEvents(ingestCtx, {
					runId,
					agent,
					ok: event.isError !== true,
					status: childStatus(details, event.isError === true),
					nativeRunId: typeof details.asyncId === "string" ? details.asyncId : typeof details.runId === "string" ? details.runId : runId,
					toolCallId: event.toolCallId,
					summary: excerptOf(event, 1000),
				}));
			} else if (name === "bg_wait") {
				const details = event.details as { completions?: unknown } | undefined;
				if (!Array.isArray(details?.completions)) return;
				for (const completion of details.completions.slice(0, 32)) {
					if (!completion || typeof completion !== "object" || typeof completion.runId !== "string") continue;
					const prior = Object.values(graph.entities).find(entity => entity.kind === "child" && entity.refs?.childRunId === completion.runId);
					// Only results for this task's retained dispatch can update it.
					if (!prior) continue;
					events.push(...subagentResultEvents(ingestCtx, { runId: completion.runId, entityId: prior.id, nativeRunId: completion.runId,
						toolCallId: prior.refs?.toolCallId, ok: true, status: childStatus(completion),
						summary: JSON.stringify({ state: completion.state, groupCounters: completion.groupCounters, results: completion.results }).slice(0, 1000) }));
				}
			} else if (name === "quality_review") {
				const text = excerptOf(event, 800);
				const blocker = /block(?:ed|er)|missing evidence|not accepted/i.test(text);
				events.push(...findingEvents(ingestCtx, {
					reviewId: String(event.toolCallId ?? `qr-${Date.now()}`),
					kind: "review-council",
					blocker,
					note: `quality_review: ${text.slice(0, 220)}`,
				}));
			} else if (name === "project_tests") {
				if (event.isError !== true && typeof event.input?.action === "string") {
					events.push(...completionClaimEvents(ingestCtx, {
						claimId: `pt-${String(event.toolCallId ?? Date.now())}`,
						blocked: false,
						reason: `project_tests ${String(event.input.action)}: ${excerptOf(event, 400)}`,
					}));
				}
			}
			if (events.length) {
				if (name === "bg_run" && start && event.isError !== true) {
					const details = event.details as { id?: unknown; taskId?: unknown; task?: { id?: unknown } } | undefined;
					const id = details?.task?.id ?? details?.taskId ?? details?.id;
					if (typeof id === "string") {
						const pending = bashResultEvents(ingestCtx, { command: event.input?.command, toolCallId: `bg-${id}`, failed: false, pending: true });
						for (const event of pending) if (event.kind === "entity-upsert") event.entity.refs = { ...event.entity.refs, ...start, toolCallId: `bg-${id}` };
						events.push(...pending);
					}
				}
				if (events.some(event => event.kind === "entity-upsert" && event.entity.kind === "evidence")) bindCheckSources(events, service, ctx.cwd, start);
				service.apply(events);
			}
		} catch {
			/* tool results must never fail because of the graph */
		}
	});

	// A background suite is an attempt until it reports. bg_run returns a task id
	// immediately, so the launch cannot say whether it passed — the terminal
	// receipt can, and that is where the evidence belongs.
	pi.on("message_end", (event: { message?: Record<string, unknown> }, ctx: ExtensionContext) => {
		try {
			const message = event.message;
			if (message?.customType === "prompt-analysis") {
				const details = message.details as Record<string, unknown> | undefined;
				const pending = pendingInput;
				if (!pending || pending.sessionId !== sidOf(ctx) || details?.requestId !== pending.requestId) return;
				pendingInput = undefined;
				const service = serviceFor(ctx);
				if (!service || service.taskId !== pending.taskId || !pending.hadTask || pending.mode === "new-task") return;
				const relation = typeof details.relation === "string" ? details.relation : undefined;
				if (!relation) return;
				// Analysis arrives at the native context boundary, after input.
				// Only the latest matching request may revise its classification.
				const { mode } = service.userInput(pending.text, relation);
				service.syncRequirements(ledgerItemsFromBranch(ctx), mode);
				return;
			}
			if ((message?.customType as string | undefined) !== "background-task-notification") return;
			const details = message?.details as Record<string, unknown> | undefined;
			const command = typeof details?.command === "string" ? details.command : "";
			if (!details || !isTestLikeCommand(command)) return;
			const service = serviceFor(ctx);
			if (!service) return;
			const graph = service.graph();
			const exit = details.exitCode;
			const failed = details.status === "failed" || details.status === "killed"
				|| !!details.signal || (typeof exit === "number" && exit !== 0);
			const events = bashResultEvents(
				{ sessionId: graph.sessionId, taskId: graph.taskId, ts: Date.now() },
				{ command, toolCallId: `bg-${String(details.id ?? Date.now())}`, failed, pending: !failed && (details.status !== "completed" || exit !== 0),
					excerpt: typeof details.error === "string" ? details.error : undefined },
			);
			const start = service.entity(`att-${stableId([service.taskId, `bg-${String(details.id)}`])}`)?.refs;
			bindCheckSources(events, service, ctx.cwd, start);
			service.apply(events);
		} catch {
			/* a background receipt must never fail because of the graph */
		}
	});
}

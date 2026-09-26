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
	todoEvents,
	type LedgerRequirement,
} from "./lib/task-state/ingest.ts";
import { collectDiagnostics } from "./lib/task-state/projections.ts";
import type { TaskEvent } from "./lib/task-state/types.ts";

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
function latestAnalysisRelation(ctx: ExtensionContext): string | undefined {
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const message = (branch[i] as { type?: string; message?: { role?: string; customType?: string; details?: { relation?: unknown } } }).message;
			if (message?.role === "custom" && message.customType === "prompt-analysis") {
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

/** Current requirement-ledger items parsed from the ledger's own context line (ledger stays authoritative). */
function ledgerItemsFromBranch(ctx: ExtensionContext): LedgerRequirement[] {
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const message = (branch[i] as { type?: string; message?: { role?: string; customType?: string; content?: unknown } }).message;
			if (message?.role !== "custom" || message.customType !== "requirement-ledger") continue;
			const text = textOf(message.content);
			const items: LedgerRequirement[] = [];
			for (const line of text.split("\n")) {
				const match = /^\s*(R\d{1,3}):\s+(.+)$/.exec(line);
				if (match) items.push({ id: match[1], text: match[2].slice(0, 300) });
				if (items.length >= 20) break;
			}
			if (items.length) return items;
		}
	} catch {
		/* ignore */
	}
	return [];
}

function todoTasksFromResult(event: { details?: unknown; output?: unknown }): Array<{ id: number; title?: string; status?: string }> {
	const details = (event.details ?? event.output) as { tasks?: unknown } | undefined;
	if (!details || !Array.isArray(details.tasks)) return [];
	return details.tasks
		.filter((task): task is { id: number; title?: string; status?: string } =>
			!!task && typeof task === "object" && Number.isSafeInteger((task as { id: number }).id))
		.map((task) => ({ id: task.id, title: typeof task.title === "string" ? task.title : undefined, status: typeof task.status === "string" ? task.status : undefined }));
}

function excerptOf(event: { content?: unknown }, max = 600): string {
	return textOf(event.content).replace(/\s+/g, " ").trim().slice(0, max);
}

export default function taskStateExtension(pi: ExtensionAPI): void {
	if (DISABLED) return;

	pi.registerTool({
		name: "task_state",
		label: "Task State",
		description: "Read the shared Task State Graph: current objective, requirements with implementation/verification state, unresolved work, evidence, failures, decisions, and completion blockers. Read-only; the graph updates automatically from harness events. Prefer this over re-deriving task reality from the transcript.",
		parameters: Type.Object({
			action: Type.Optional(StringEnum([
				"status", "requirements", "unresolved", "evidence", "entity", "blockers", "failures", "decisions", "diagnostics",
			])),
			entityId: Type.Optional(Type.String({ description: "Entity id for action=entity." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const service = serviceFor(ctx);
			if (!service) throw new Error("Task state is unavailable in this session.");
			const action = params.action ?? "status";
			const limit = Math.max(1, Math.min(60, params.limit ?? 12));
			let text: string;
			if (action === "entity") {
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
		try {
			if (sidOf(ctx)) getTaskStateService(sidOf(ctx));
		} catch {
			/* degraded mode covers this */
		}
	});
	pi.on("session_switch", (_event, ctx) => {
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
	pi.on("session_shutdown", () => {
		try {
			currentTaskStateService()?.checkpoint();
		} catch {
			/* ignore */
		} finally {
			clearTaskStateServices();
		}
	});

	pi.on("input", (event: { source?: string; text?: unknown }, ctx: ExtensionContext) => {
		try {
			if (event.source === "extension" || typeof event.text !== "string" || !event.text.trim()) return;
			const service = serviceFor(ctx);
			if (!service) return;
			const relation = latestAnalysisRelation(ctx);
			const { mode } = service.userInput(event.text, relation);
			// The ledger folds on the same hook; read its rendered line so the
			// graph adopts ledger R-ids instead of inventing parallel ones.
			const items = ledgerItemsFromBranch(ctx);
			if (items.length) service.syncRequirements(items, mode);
		} catch {
			/* user input must never fail because of the graph */
		}
	});

	pi.on("tool_call", (event: { toolName?: string; input?: Record<string, unknown>; toolCallId?: string }, ctx: ExtensionContext) => {
		try {
			if (event.toolName !== "subagent") return;
			const service = serviceFor(ctx);
			if (!service) return;
			const input = event.input ?? {};
			const label = typeof input.agent === "string" && input.agent ? input.agent
				: typeof input.action === "string" && input.action ? `action:${input.action}`
				: input.workflowScript || input.workflowScriptPath ? "workflow" : "dispatch";
			const brief = typeof input.task === "string" ? input.task
				: typeof input.commonTask === "string" ? input.commonTask : "";
			service.record({
				id: `child-${String(event.toolCallId ?? `${Date.now()}`).slice(0, 48)}-dispatch`,
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
			if ((name === "edit" || name === "write") && !event.isError && typeof event.input?.path === "string") {
				const file = String(event.input.path).slice(0, 512);
				const nextVersion = (graph.files[file]?.version ?? 0) + 1;
				events.push(...fileWriteEvents(ingestCtx, {
					path: file,
					toolCallId: event.toolCallId,
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
					}));
				}
			} else if (name === "todo") {
				const tasks = todoTasksFromResult(event);
				if (tasks.length) events.push(...todoEvents(ingestCtx, tasks));
			} else if (name === "subagent") {
				const runId = String(event.toolCallId ?? `sub-${Date.now()}`);
				const agent = typeof event.input?.agent === "string" ? event.input.agent : undefined;
				events.push(...subagentResultEvents(ingestCtx, {
					runId,
					agent,
					ok: event.isError !== true,
					summary: excerptOf(event, 1000),
				}));
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
			if (events.length) service.apply(events);
		} catch {
			/* tool results must never fail because of the graph */
		}
	});
}

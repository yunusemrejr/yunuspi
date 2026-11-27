/**
 * Check gate: code that changed after its last check is not done.
 *
 * At the end of a turn, one continuation names what changed without a passing
 * check (or the check that failed), what was changed but never looked at, and a
 * final report that puts part of the request off. Before a push or deploy, one
 * hold with the same facts. Each fires once per user prompt, never loops.
 * A user who says not to run tests or builds (or not to open a browser) silences
 * that part for the prompt.
 * PI_CHECK_GATE=0 turns it all off; PI_LOOK_GATE=0 only the look part.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@yunuspi/coding-agent";
import { armCheckGate, checkGateOn, clearHeld, finalTurn, isImageFile, isPublishCommand, lookGateOn, noteHeld, sharedCheckLedger, shellWrittenFiles, wasHeld } from "./lib/check-evidence.ts";
import { collectVerificationReceipts, resumesElsewhere } from "./lib/continuation-notice.ts";
import { isSessionStopped } from "./lib/session-stop.ts";
import { isDeployCommand } from "./lib/session-hooks.ts";

const WRITE_TOOLS = new Set(["edit", "write"]);
/** Tools whose successful result shows pixels of the real output. */
const LOOK_TOOLS = new Set(["render_see", "ui_explore", "visual_review", "image_understand", "video_qa"]);
/** Tools whose result can show a background task as finished; the registry also announces every end on this channel. */
const BACKGROUND_TOOLS = new Set(["bg_wait", "bg_status", "bg_logs", "bg_kill"]);
const BG_TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";
const TASK_ENDED = new Set(["completed", "failed", "killed"]);
/** File times are coarse: an image written this close before the change still counts as made after it. */
const MTIME_SLACK_MS = 2000;

const textOf = (content: unknown): string => Array.isArray(content) ? content.map((part: any) => (part?.type === "text" ? part.text : "")).join("\n") : typeof content === "string" ? content : "";

/** True when the image file was written no earlier than `since` (epoch ms, less the slack). The path is read as the read tool reads it: `@` prefix, `~`, then cwd. An unreadable file is not a look. */
function writtenSince(path: string, cwd: string | undefined, since: number): boolean {
	try {
		const bare = path.replace(/^@/, "");
		const file = bare === "~" || bare.startsWith("~/") ? join(homedir(), bare.slice(1)) : resolve(cwd ?? process.cwd(), bare);
		return statSync(file).mtimeMs >= since - MTIME_SLACK_MS;
	} catch { return false; }
}

/** A finished background task: failed unless it completed with exit 0. Undefined while it runs. */
/** The last 16 KB of a finished task's output file: a piped check (`npm test | tail`) is judged by what it printed. */
const OUTPUT_TAIL_BYTES = 16_384;
function outputTail(file: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const size = statSync(file).size, length = Math.min(size, OUTPUT_TAIL_BYTES), buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} catch { return ""; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

function taskEnd(task: any): { id: string; failed: boolean } | undefined {
	if (typeof task?.id !== "string" || !TASK_ENDED.has(task.status)) return undefined;
	return { id: task.id, failed: task.status !== "completed" || typeof task.exitCode === "number" && task.exitCode !== 0 };
}

function isLook(name: string, input: Record<string, unknown> | undefined, content: unknown, cwd: string | undefined, changedAt: number): boolean {
	if (LOOK_TOOLS.has(name)) return !["plan", "status", "list"].includes(String(input?.action ?? ""));
	if (name === "browser_session") return input?.action === "screenshot";
	if (name === "office_doc") return ["render", "inspect"].includes(String(input?.action ?? ""));
	if (name === "read") {
		// An image file already in the project shows nothing of this change: only one written since it counts.
		if (typeof input?.path === "string" && isImageFile(input.path)) return writtenSince(input.path, cwd, changedAt);
		return Array.isArray(content) && content.some((part: any) => part?.type === "image");
	}
	return false;
}

export default function checkGate(pi: ExtensionAPI): void {
	// A child's caller checks its work.
	if (process.env.PI_SUBAGENT_CHILD === "1" || !checkGateOn()) return;
	const ledger = sharedCheckLedger();
	armCheckGate();
	const switches = () => ({ check: checkGateOn(), look: lookGateOn() });

	for (const name of ["session_start", "session_switch", "session_tree"] as const) pi.on(name as any, () => { ledger.reset(); finalTurn.report = ""; finalTurn.stop = undefined; });
	pi.on("input", (event: any) => { if (event?.source !== "extension") { ledger.newPrompt(typeof event.text === "string" ? event.text : ""); clearHeld(); finalTurn.report = ""; } });
	pi.on("message_end", (event: any) => {
		if (event?.message?.role !== "assistant") return;
		ledger.turnEnded();
		finalTurn.stop = event.message.stopReason;
		finalTurn.report = textOf(event.message.content);
	});
	// The registry announces each background task's end, also when the agent never asks.
	// Where each background check's output lives: its snapshot path is relative to the session folder it started in.
	const taskOutput = new Map<string, string>();
	const outputOf = (id: string) => { const file = taskOutput.get(id); taskOutput.delete(id); return file ? outputTail(file) : ""; };
	pi.events?.on?.(BG_TERMINAL_CHANNEL, (data: any) => {
		try {
			const end = taskEnd(data?.task);
			if (end) ledger.backgroundEnded(end.id, { failed: end.failed, output: outputOf(end.id) });
		} catch { /* a gate never breaks the task registry */ }
	});

	pi.on("tool_result", (event: any, ctx: any) => {
		const name = String(event.toolName ?? "");
		const input = event.input as Record<string, unknown> | undefined;
		try {
			if (WRITE_TOOLS.has(name)) {
				const file = event.details?.fileMutation?.resolved ?? input?.path;
				if (!event.isError && typeof file === "string") ledger.change(file, ctx?.cwd);
				return;
			}
			if (!event.isError && isLook(name, input, event.content, ctx?.cwd, ledger.visibleChangedAt())) ledger.look();
			if (BACKGROUND_TOOLS.has(name) && !event.isError) {
				const carried = [event.details?.providerOutcome, event.details?.task, ...(Array.isArray(event.details?.tasks) ? event.details.tasks : [])].filter(Boolean);
				// The output text belongs to the task only when the result is about that one task.
				const output = carried.length === 1 ? textOf(event.content) : "";
				for (const task of carried) {
					const end = taskEnd(task);
					if (end) ledger.backgroundEnded(end.id, { failed: end.failed, output: [output, outputOf(end.id)].filter(Boolean).join("\n") });
				}
			}
			const command = typeof input?.command === "string" ? input.command : "";
			if (name !== "bash" && name !== "bg_run" || !command) return;
			if (!event.isError) for (const file of shellWrittenFiles(command)) ledger.change(file, ctx?.cwd);
			const exit = event.details?.exitCode;
			const output = textOf(event.content);
			const task = name === "bg_run" ? event.details?.task : undefined;
			if (typeof task?.id === "string" && typeof task.outputPath === "string" && ctx?.cwd) {
				if (taskOutput.size >= 32) taskOutput.delete(taskOutput.keys().next().value!);
				taskOutput.set(task.id, resolve(ctx.cwd, task.outputPath));
			}
			// A command managed bash moved to the background has no result yet: it proves nothing until it ends.
			if (name === "bash" && output.includes("[managed bash] Still running — detached")) return;
			ledger.check(command, { failed: event.isError === true || typeof exit === "number" && exit !== 0, output, background: name === "bg_run", taskId: name === "bg_run" ? event.details?.task?.id : undefined });
		} catch { /* a gate never breaks a tool result */ }
	});

	pi.on("tool_call", (event: any) => {
		// A push started with bg_run is still a push.
		if (event.toolName !== "bash" && event.toolName !== "bg_run") return;
		const command = typeof event.input?.command === "string" ? event.input.command : "";
		if (!command || wasHeld(command) || !isPublishCommand(command) && !isDeployCommand("bash", { command })) return;
		try {
			const hold = ledger.beforePublish(switches());
			if (hold) { noteHeld(command); return { block: true, reason: hold }; }
		} catch { /* never wedge a publish on a gate failure */ }
	});

	pi.on("agent_settled", async (_event: any, ctx: any) => {
		try {
			// A stopped, interrupted or still-running session is not a finish.
			if (finalTurn.stop !== "stop" || isSessionStopped(ctx) || ctx?.signal?.aborted || ctx?.hasPendingMessages?.() || resumesElsewhere(ctx?.sessionManager)) return;
			// The UI/SVG verification owner asks for the look itself, with its own bounded rounds.
			const lookOwned = collectVerificationReceipts(8, ctx.sessionManager).some(receipt => receipt.source === "creative");
			const text = ledger.finish(switches(), lookOwned, finalTurn.report);
			if (!text) return;
			await pi.sendMessage({ customType: "check-gate", content: text, display: false }, { deliverAs: "followUp", triggerTurn: true });
		} catch { /* a gate failure must never wedge the session */ }
	});
}

/**
 * Check gate: code that changed after its last check is not done.
 *
 * At the end of a turn, one continuation names what changed without a passing
 * check (or the check that failed), what was changed but never looked at, and a
 * final report that puts part of the request off. Before a push or deploy, one
 * hold with the same facts. Each fires once per user prompt, never loops.
 * PI_CHECK_GATE=0 turns it all off; PI_LOOK_GATE=0 only the look part.
 */
import type { ExtensionAPI } from "@yunuspi/coding-agent";
import { armCheckGate, checkGateOn, clearHeld, finalTurn, isImageFile, isPublishCommand, lookGateOn, noteHeld, sharedCheckLedger, shellWrittenFiles, wasHeld } from "./lib/check-evidence.ts";
import { collectVerificationReceipts, resumesElsewhere } from "./lib/continuation-notice.ts";
import { isSessionStopped } from "./lib/session-stop.ts";
import { isDeployCommand } from "./lib/session-hooks.ts";

const WRITE_TOOLS = new Set(["edit", "write"]);
/** Tools whose successful result shows pixels of the real output. */
const LOOK_TOOLS = new Set(["render_see", "ui_explore", "visual_review", "image_understand", "video_qa"]);

const textOf = (content: unknown): string => Array.isArray(content) ? content.map((part: any) => (part?.type === "text" ? part.text : "")).join("\n") : typeof content === "string" ? content : "";

function isLook(name: string, input: Record<string, unknown> | undefined, content: unknown): boolean {
	if (LOOK_TOOLS.has(name)) return !["plan", "status", "list"].includes(String(input?.action ?? ""));
	if (name === "browser_session") return input?.action === "screenshot";
	if (name === "office_doc") return ["render", "inspect"].includes(String(input?.action ?? ""));
	if (name === "read") return typeof input?.path === "string" && isImageFile(input.path) || Array.isArray(content) && content.some((part: any) => part?.type === "image");
	return false;
}

export default function checkGate(pi: ExtensionAPI): void {
	// A child's caller checks its work.
	if (process.env.PI_SUBAGENT_CHILD === "1" || !checkGateOn()) return;
	const ledger = sharedCheckLedger();
	armCheckGate();
	const switches = () => ({ check: checkGateOn(), look: lookGateOn() });

	for (const name of ["session_start", "session_switch", "session_tree"] as const) pi.on(name as any, () => { ledger.reset(); finalTurn.report = ""; finalTurn.stop = undefined; });
	pi.on("input", (event: any) => { if (event?.source !== "extension") { ledger.newPrompt(); clearHeld(); finalTurn.report = ""; } });
	pi.on("message_end", (event: any) => {
		if (event?.message?.role !== "assistant") return;
		finalTurn.stop = event.message.stopReason;
		finalTurn.report = textOf(event.message.content);
	});
	// Shell and extension-owned writers are named by their paths too.
	pi.events?.on?.("harness:mutation-committed", (event: any) => {
		for (const file of Array.isArray(event?.paths) ? event.paths : []) if (typeof file === "string") ledger.change(file, event?.ctx?.cwd);
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
			if (!event.isError && isLook(name, input, event.content)) ledger.look();
			const command = typeof input?.command === "string" ? input.command : "";
			if (name !== "bash" && name !== "bg_run" || !command) return;
			if (!event.isError) for (const file of shellWrittenFiles(command)) ledger.change(file, ctx?.cwd);
			const exit = event.details?.exitCode;
			ledger.check(command, { failed: event.isError === true || typeof exit === "number" && exit !== 0, output: textOf(event.content), background: name === "bg_run" });
		} catch { /* a gate never breaks a tool result */ }
	});

	pi.on("tool_call", (event: any) => {
		if (event.toolName !== "bash") return;
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

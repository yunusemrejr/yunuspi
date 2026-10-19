import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@yunuspi/coding-agent";
import { Text } from "@yunuspi/tui";
import { SLASH_TEXT_RESULT_TYPE } from "../shared/types.ts";
import { renderWatchdogWarning } from "./render.ts";
import { createCoordinatedWatchdogReview } from "./coordinated-review.ts";
import { MainWatchdogRuntime, type WatchdogReviewFunction } from "./runtime.ts";
import { getWatchdogUserSettingsPath, writeUserWatchdogEnabled } from "./settings.ts";
import {
	SUBAGENT_WATCHDOG_WARNING_TYPE,
	type WatchdogRuntimeStatus,
	type WatchdogWarning,
	type WatchdogWarningDetails,
} from "./types.ts";
import { createWatchdogWarningMessage } from "./warning-format.ts";

interface RegisterMainWatchdogOptions {
	runtime?: MainWatchdogRuntime;
	review?: WatchdogReviewFunction;
}

function sendSlashText(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({ customType: SLASH_TEXT_RESULT_TYPE, content: text, display: true });
}

function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function boolLabel(value: boolean): string {
	return value ? "on" : "off";
}

function statusLabel(status: WatchdogRuntimeStatus): string {
	return status.replaceAll("-", " ");
}

function sourceLine(source: { scope: string; path?: string; exists: boolean }): string {
	const location = source.path ? ` ${source.path}` : "";
	return `- ${source.scope}${location}: ${source.exists ? "found" : "not found"}`;
}

function currentSessionModelLine(ctx: ExtensionContext): string {
	const model = ctx.model as { provider?: unknown; id?: unknown } | undefined;
	if (model && typeof model.provider === "string" && typeof model.id === "string") return `current session (${model.provider}/${model.id})`;
	return "current session (not configured)";
}

function reviewLine(ctx: ExtensionContext): string {
	const thinking = typeof ctx.thinkingLevel === "string" ? ctx.thinkingLevel : "off";
	return `Review model: ${currentSessionModelLine(ctx)} · thinking ${thinking}`;
}

function childrenLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>): string {
	const children = snapshot.config.children;
	const overrides = Object.entries(children.overrides);
	const overrideText = overrides.length
		? ` · overrides ${overrides.map(([agent, override]) => override.enabled === undefined ? agent : `${agent} ${boolLabel(override.enabled)}`).join("; ")}`
		: "";
	return `Children: ${boolLabel(snapshot.config.enabled && children.enabled)}${overrideText}`;
}

function lspLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>): string {
	const lsp = snapshot.lsp;
	const provider = lsp.provider ? ` · ${lsp.provider}` : "";
	const counts = lsp.diagnosticCount > 0 || lsp.freshDiagnosticCount > 0
		? ` · ${lsp.freshDiagnosticCount} new/${lsp.diagnosticCount} total`
		: "";
	const message = lsp.message ? ` · ${lsp.message}` : "";
	return `LSP diagnostics: ${lsp.enabled ? "on" : "off"} · ${lsp.status}${provider}${counts}${message}`;
}

export function buildWatchdogStatus(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>, ctx: ExtensionContext): string {
	const lines = [
		"Subagent watchdog",
		`Main: ${boolLabel(snapshot.enabled)}`,
		`Runtime: ${statusLabel(snapshot.status)}${snapshot.bufferedDeltas > 0 ? ` · buffered deltas ${snapshot.bufferedDeltas}` : ""}`,
		`Review trigger: ${snapshot.reviewTrigger === "repo-edits" ? "repo edits only" : "every non-empty turn delta"}`,
		`Scope context: ${snapshot.config.scope.enabled ? "on" : "off"}`,
		`Cadence: ${snapshot.config.cadence.everyNTools === null ? "boundary only" : `every ${snapshot.config.cadence.everyNTools} tools + boundary`}`,
		lspLine(snapshot),
		`Session override: ${snapshot.sessionOverride === undefined ? "none" : boolLabel(snapshot.sessionOverride)}`,
		reviewLine(ctx),
		childrenLine(snapshot),
		`Agent-end timeout: ${snapshot.config.agentEndTimeoutMs}ms`,
		`Auto-follow: ${snapshot.autoFollowActive ? "on for blockers" : "shared quality/completion owner"} · attempts ${snapshot.autoFollowAttempts}${snapshot.config.autoFollow.maxAttempts === null ? "" : `/${snapshot.config.autoFollow.maxAttempts}`}${snapshot.autoFollowQueued ? " · queued" : ""}${snapshot.autoFollowStalemate ? " · stalemate" : ""}`,
		`Review model call: ${snapshot.reviewDescription}`,
	];
	if (snapshot.failedReviews > 0) lines.push(`Failed reviews: ${snapshot.failedReviews}`);
	if (snapshot.staleReviews > 0) lines.push(`Stale reviews: ${snapshot.staleReviews}`);
	if (snapshot.changedPaths?.length) {
		lines.push(`Changed paths: ${snapshot.changedPaths.slice(0, 8).join(", ")}${snapshot.changedPaths.length > 8 ? `, +${snapshot.changedPaths.length - 8} more` : ""}`);
	}
	if (snapshot.lastWarning) {
		lines.push(`Last warning: ${snapshot.lastWarning.severity} · ${snapshot.lastWarning.state ?? "candidate"} · ${snapshot.lastWarning.summary}`);
	}
	if (snapshot.lastError) lines.push(`Last error: ${snapshot.lastError}`);
	if (!snapshot.configOk) {
		lines.push("", "Config errors:", ...snapshot.errors.map((error) => `- ${error.message}`), "Watchdog is disabled until the config is fixed.");
	} else {
		lines.push("", "Config: ok");
	}
	lines.push("Sources:", ...snapshot.sources.map(sourceLine));
	return lines.join("\n");
}

function parseTestCommand(input: string): { severity: "concern" | "blocker"; text: string } | undefined {
	const match = input.match(/^test\s+(concern|blocker)\s+([\s\S]+)$/);
	if (!match) return undefined;
	return { severity: match[1] as "concern" | "blocker", text: match[2]!.trim() };
}

function buildCheckText(runtime: MainWatchdogRuntime, ctx: ExtensionCommandContext): string {
	const snapshot = runtime.getSnapshot(ctx.cwd);
	if (!snapshot.configOk) {
		return ["Subagent watchdog config check", "", "Config errors:", ...snapshot.errors.map((error) => `- ${error.message}`)].join("\n");
	}
	return ["Subagent watchdog config check", "", "Config: ok", reviewLine(ctx), lspLine(snapshot)].join("\n");
}

function createTestWarning(severity: "concern" | "blocker", text: string): WatchdogWarning {
	return {
		severity,
		category: "other",
		confidence: "high",
		source: "main",
		state: "displayed",
		summary: text,
		evidence: `Manual /subagents-watchdog test ${severity} message from the main session.`,
		recommendedAction: severity === "blocker"
			? "Verify the renderer, transcript delivery, and auto-follow policy."
			: "Verify the renderer and transcript delivery; decide manually whether any action is needed.",
	};
}

async function handleWatchdogCommand(
	pi: ExtensionAPI,
	runtime: MainWatchdogRuntime,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const input = args.trim();
	if (!input || input === "status") {
		sendSlashText(pi, buildWatchdogStatus(runtime.getSnapshot(ctx.cwd), ctx));
		return;
	}
	if (input === "check") {
		try {
			sendSlashText(pi, buildCheckText(runtime, ctx));
		} catch (error) {
			sendSlashText(pi, `Subagent watchdog config check\n\n${messageFromError(error)}`);
		}
		return;
	}
	if (input === "on" || input === "off") {
		const enabled = input === "on";
		try {
			const settingsPath = writeUserWatchdogEnabled(enabled);
			const snapshot = runtime.getSnapshot(ctx.cwd);
			sendSlashText(pi, [
				`Subagent watchdog ${boolLabel(enabled)} saved to user settings.`,
				`Updated: ${settingsPath}`,
				`Main now: ${boolLabel(snapshot.enabled)}${snapshot.sessionOverride !== undefined ? ` (session override ${boolLabel(snapshot.sessionOverride)})` : ""}`,
			].join("\n"));
		} catch (error) {
			sendSlashText(pi, `Subagent watchdog\n\nCould not update ${getWatchdogUserSettingsPath()}: ${messageFromError(error)}`);
		}
		return;
	}
	if (input === "session on" || input === "session off") {
		const enabled = input.endsWith("on");
		const snapshot = runtime.setSessionEnabled(enabled, ctx.cwd);
		sendSlashText(pi, [
			`Subagent watchdog session override: ${boolLabel(enabled)}.`,
			"No settings files were changed.",
			"",
			buildWatchdogStatus(snapshot, ctx),
		].join("\n"));
		return;
	}
	const test = parseTestCommand(input);
	if (test) {
		if (!test.text) {
			ctx.ui.notify("Usage: /subagents-watchdog test concern|blocker <text>", "error");
			return;
		}
		const warning = createTestWarning(test.severity, test.text);
		const details = runtime.recordDisplayedWarning(warning);
		pi.sendMessage(createWatchdogWarningMessage(details, { display: true, details }));
		return;
	}
	ctx.ui.notify("Usage: /subagents-watchdog [status|on|off|session on|session off|check|test concern <text>|test blocker <text>]", "error");
}

export function registerMainWatchdog(pi: ExtensionAPI, options: RegisterMainWatchdogOptions = {}): MainWatchdogRuntime {
	let currentContext: ExtensionContext | undefined;
	const rememberContext = (ctx: ExtensionContext) => {
		currentContext = ctx;
	};
	const runtime = options.runtime ?? new MainWatchdogRuntime({
		review: options.review ?? createCoordinatedWatchdogReview(() => currentContext),
		reviewDescription: options.review ? "injected seam" : "local diagnostics + shared quality review",
		ownsAutoFollow: () => Boolean(options.review),
		reviewChangesOnly: true,
		displayWarning: (details, delivery) => {
			pi.sendMessage(createWatchdogWarningMessage(details, { display: true, details }), delivery?.deliverAs === "steer" ? { deliverAs: "steer" } : undefined);
		},
		sendUserMessage: (message) => pi.sendUserMessage(message, { deliverAs: "steer" }),
	});

	pi.registerMessageRenderer<WatchdogWarningDetails>(SUBAGENT_WATCHDOG_WARNING_TYPE, (message, renderOptions, theme) => {
		const details = message.details as WatchdogWarningDetails | undefined;
		if (!details?.summary || !details.evidence || !details.recommendedAction) {
			const content = typeof message.content === "string"
				? message.content
				: message.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
			return new Text(content, 0, 0);
		}
		return renderWatchdogWarning(details, renderOptions, theme);
	});

	pi.registerCommand("subagents-watchdog", {
		description: "Inspect automatic diagnostics and shared quality review",
		handler: (args, ctx) => {
			rememberContext(ctx);
			return handleWatchdogCommand(pi, runtime, args, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		rememberContext(ctx);
		runtime.bindSession(ctx);
	});
	pi.on("before_agent_start", (event, ctx) => {
		rememberContext(ctx);
		runtime.handleBeforeAgentStart(event, ctx);
	});
	pi.on("turn_end", (event, ctx) => {
		rememberContext(ctx);
		runtime.handleTurnEnd(event, ctx);
	});
	pi.on("tool_result", (_event, ctx) => {
		rememberContext(ctx);
		runtime.handleToolResult(ctx);
	});
	pi.on("agent_end", (event, ctx) => {
		rememberContext(ctx);
		return runtime.handleAgentEnd(event, ctx);
	});
	pi.on("session_before_switch", () => runtime.reset("session switch", { clearReviewInputSignature: true, clearLspLedger: true, clearScope: true, resetAutoFollow: true }));
	pi.on("session_before_fork", () => runtime.reset("session fork", { clearReviewInputSignature: true, clearLspLedger: true, clearScope: true, resetAutoFollow: true }));
	pi.on("session_compact", () => runtime.reset("session compact", { clearScope: true }));
	pi.on("session_shutdown", () => {
		currentContext = undefined;
		runtime.dispose();
	});

	return runtime;
}

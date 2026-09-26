import { sessionObservability } from './lib/session-observability.ts';
/**
 * session-hooks — deterministic first-use guidance for recurring workflows.
 *
 * The rule catalogue lives in `lib/session-hooks.ts` (pure, unit-tested).
 * This extension owns only the pi wiring:
 *
 *   - rules are matched at `tool_call` time (tool args are available there)
 *     and consumed at `tool_result`, exactly once per key per session;
 *   - the hint is appended as one extra text item to the tool result, the
 *     same non-blocking contract bash-router uses;
 *   - nothing is ever blocked; errors only receive a matching recovery hint;
 *   - `PI_SESSION_HOOKS=off` disables the whole surface.
 *
 * Telemetry (health sink, allowlisted fields only):
 *   session_hook.decision { hook: <rule key>, decision: "annotate", tool, count: 1 }
 */
import {
	isDeployCommand,
	isEmptySearchResult,
	isLiveByteVerification,
	matchHook,
} from "./lib/session-hooks.ts";
import { registerContinuationSource } from "./lib/continuation-notice.ts";

const HEALTH_SINK = Symbol.for("yunus-pi.health.v1");

export default function (pi: any) {
	/** toolCallId -> rule key queued at tool_call time. */
	const pending = new Map<string, { success: ReturnType<typeof matchHook>; failure: ReturnType<typeof matchHook>; input: Record<string, unknown> }>();
	/** Rule keys already shown this session. */
	const shown = new Set<string>();
	/** A successful deploy stays unverified until live bytes are compared. */
	let unverifiedDeployAt: number | undefined;
	/** One unverified-deploy text shared by the warning line and the gate receipt. */
	const deployVerificationText = (at: number): string =>
		`deploy at ${new Date(at).toISOString().slice(11, 16)} UTC is not verified live: compare changed assets' sha256 on the production URL with the local files and check Cache-Control on replaced assets.`;
	let disposeDeployNotice: (() => void) | undefined;
	const deployCalls = new Map<string, { deploy: boolean; verify: boolean }>();

	const enabled = (): boolean =>
		(process.env.PI_SESSION_HOOKS ?? "on").toLowerCase() !== "off";

	const reset = () => {
		pending.clear();
		shown.clear();
		deployCalls.clear();
		unverifiedDeployAt = undefined;
		disposeDeployNotice?.();
		disposeDeployNotice = undefined;
	};

	pi.on("session_start", reset);
	pi.on("session_switch", reset);
	pi.on("session_shutdown", reset);
	pi.on("agent_end", () => { pending.clear(); deployCalls.clear(); });

	pi.on("tool_call", (event: any) => {
		if (!enabled()) return;
		if (typeof event.toolCallId !== "string") return;
		const input = event.input ?? {};
		const deploy = isDeployCommand(event.toolName, input);
		// "git push prod && curl -s URL | sha256sum" deploys and verifies in one call.
		const verify = (deploy || unverifiedDeployAt !== undefined) && isLiveByteVerification(event.toolName, input);
		if (deploy || verify) deployCalls.set(event.toolCallId, { deploy, verify });
		const success = matchHook(event.toolName, event.input ?? {});
		const failure = matchHook(event.toolName, event.input ?? {}, true);
		// Browser recovery is selected from the actual outcome at result time.
		// Its earlier generic hint cannot consume a later uncertain-action hint.
		const mayMatchResult = event.toolName === 'browser_session' && !shown.has('browser-session-recovery');
		if (!mayMatchResult && (!success || shown.has(success.key)) && (!failure || shown.has(failure.key))) return;
		// Aborted/unpaired calls cannot retain an unbounded per-session map.
		if (pending.size >= 256) pending.delete(pending.keys().next().value!);
		pending.set(event.toolCallId, { success, failure, input: event.input ?? {} });
	});

	pi.on("tool_result", (event: any, ctx: any) => {
		const deployRole = deployCalls.get(event.toolCallId);
		deployCalls.delete(event.toolCallId);
		if (deployRole && !event.isError) {
			if (deployRole.deploy) {
				unverifiedDeployAt = Date.now();
				// Final answers carry this receipt until a live byte comparison runs:
				// a successful push is not the state visitors receive.
				if (ctx?.sessionManager) {
					disposeDeployNotice?.();
					disposeDeployNotice = registerContinuationSource({
						name: "deploy",
						session: ctx.sessionManager,
						pending: () => [],
						verification: () => unverifiedDeployAt === undefined ? [] : [deployVerificationText(unverifiedDeployAt)],
						verificationReceipts: () => unverifiedDeployAt === undefined ? [] : [{
							source: "deploy", id: `deploy:${unverifiedDeployAt}`, revision: String(unverifiedDeployAt),
							state: "unverified", line: `deploy: ${deployVerificationText(unverifiedDeployAt)}`,
						}],
					});
				}
			}
			if (deployRole.verify) unverifiedDeployAt = undefined;
		}
		const queued = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (!enabled() || !queued) return;
		// Structured browser failures already carry the precise recovery step.
		if (event.isError && ['browser_session', 'render_see'].includes(event.toolName) && typeof event.details?.failure?.nextStep === 'string') return;
		const rule = event.isError ? matchHook(event.toolName, queued.input, true, event) : queued.success;
		if (!rule || shown.has(rule.key)) return;
		if (rule.needsEmptyResult && !isEmptySearchResult(event.content)) return;
		shown.add(rule.key);

		const sink = sessionObservability()[HEALTH_SINK];
		if (typeof sink === "function") {
			try { sink("session_hook.decision", {
				hook: rule.key,
				decision: "annotate",
				tool: event.toolName,
				count: 1,
			}); } catch { /* Telemetry must never turn a successful tool into an error. */ }
			// Visible receipt: the user sees which workflow hook fired and where.
			try { sink("hook.fired", { hook: rule.key, tool: event.toolName, decision: event.isError ? "recovery" : "guidance" }); } catch { /* display only */ }
		}
		// The observer sees the same guidance the agent was given.
		try { pi.events?.emit?.("harness-hook-fired", { hook: rule.key, tool: event.toolName, line: rule.line }); } catch { /* optional bridge */ }

		const content = Array.isArray(event.content) ? event.content : [];
		return {
			content: [
				...content,
				{ type: "text", text: `[session-hooks] ${rule.line}` },
			],
		};
	});
}

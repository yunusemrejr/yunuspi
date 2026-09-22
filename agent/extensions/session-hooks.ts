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
	isEmptySearchResult,
	matchHook,
} from "./lib/session-hooks.ts";

const HEALTH_SINK = Symbol.for("yunus-pi.health.v1");

export default function (pi: any) {
	/** toolCallId -> rule key queued at tool_call time. */
	const pending = new Map<string, { success: ReturnType<typeof matchHook>; failure: ReturnType<typeof matchHook>; input: Record<string, unknown> }>();
	/** Rule keys already shown this session. */
	const shown = new Set<string>();

	const enabled = (): boolean =>
		(process.env.PI_SESSION_HOOKS ?? "on").toLowerCase() !== "off";

	const reset = () => {
		pending.clear();
		shown.clear();
	};

	pi.on("session_start", reset);
	pi.on("session_switch", reset);
	pi.on("session_shutdown", reset);
	pi.on("agent_end", () => pending.clear());

	pi.on("tool_call", (event: any) => {
		if (!enabled()) return;
		if (typeof event.toolCallId !== "string") return;
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

	pi.on("tool_result", (event: any) => {
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
		}

		const content = Array.isArray(event.content) ? event.content : [];
		return {
			content: [
				...content,
				{ type: "text", text: `[session-hooks] ${rule.line}` },
			],
		};
	});
}

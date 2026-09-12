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
 *   - nothing is ever blocked, and a result that is already an error is
 *     left untouched;
 *   - `PI_SESSION_HOOKS=off` disables the whole surface.
 *
 * Telemetry (health sink, allowlisted fields only):
 *   session_hook.decision { hook: <rule key>, decision: "annotate", tool, count: 1 }
 */
import {
	HOOK_RULES,
	isEmptySearchResult,
	matchHook,
} from "./lib/session-hooks.ts";

const HEALTH_SINK = Symbol.for("yunus-pi.health.v1");

export default function (pi: any) {
	/** toolCallId -> rule key queued at tool_call time. */
	const pending = new Map<string, (typeof HOOK_RULES)[number]>();
	/** Rule keys already shown this session. */
	const shown = new Set<string>();

	const enabled = (): boolean =>
		(process.env.PI_SESSION_HOOKS ?? "on").toLowerCase() !== "off";

	const reset = () => {
		pending.clear();
		shown.clear();
	};

	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);

	pi.on("tool_call", (event: any) => {
		if (!enabled()) return;
		const rule = matchHook(event.toolName, event.input ?? {});
		if (!rule) return;
		if (shown.has(rule.key)) return;
		pending.set(event.toolCallId, rule);
	});

	pi.on("tool_result", (event: any) => {
		const rule = pending.get(event.toolCallId);
		if (!rule) return;
		pending.delete(event.toolCallId);
		if (event.isError) return;
		if (rule.needsEmptyResult && !isEmptySearchResult(event.content)) return;
		shown.add(rule.key);

		const sink = (globalThis as any)[HEALTH_SINK];
		if (typeof sink === "function") {
			sink("session_hook.decision", {
				hook: rule.key,
				decision: "annotate",
				tool: event.toolName,
				count: 1,
			});
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

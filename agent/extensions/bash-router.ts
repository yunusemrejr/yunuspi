/**
 * Bash Router — routes common simple bash commands to structured tools.
 *
 * Why: shell-heavy sessions (observed ~50k bash calls across the live session
 * corpus) spend most time on file views, searches, JSON queries, git reads and
 * HTTP calls that already have bounded, structured tools. Small models
 * especially lose time on quoting/escaping/flag recall.
 *
 * Behavior:
 *   - The classifier (lib/bash-routing.ts) matches only simple, single
 *     commands; compound/piped/redirected commands run untouched.
 *   - First occurrence: one short hint is appended to the bash result.
 *   - Escalating rules repeat: the command is blocked with a copyable
 *     replacement tool call only when PI_BASH_ROUTER=soft|hard is opted in.
 *   - Annotations are used instead of blocks when the suggested tool differs
 *     in semantics (grep flags, head/tail, sleep, heredocs).
 *
 * Controls:
 *   PI_BASH_ROUTER=off      disable entirely
 *   PI_BASH_ROUTER=annotate hints only, never block
 *   PI_BASH_ROUTER=soft     hints first, block escalating rules on repeat (opt-in)
 *   PI_BASH_ROUTER=hard     block escalating rules from the first occurrence
 *
 * Only tracks bounded per-session counters and never logs command text.
 */

import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { classifyBashCommand } from "./lib/bash-routing.ts";

const HEALTH_SINK = Symbol.for("yunus-pi.health.v1");
const MAX_PENDING = 256;

function routerMode(): string {
     const mode = (process.env.PI_BASH_ROUTER ?? "annotate").toLowerCase();
     return ["off", "annotate", "soft", "hard"].includes(mode) ? mode : "annotate";
}

export default function bashRouter(pi: any) {
	let counts = new Map<string, number>();
	let hintCounts = new Map<string, number>();
	let pending = new Map<string, { tool: string; hint: string; ruleId: string; seen: number }>();
     let nativePending = new Map<string, string>();
     let nativeUsed = new Set<string>();
	const nativeRouteTargets = new Map([
		["read", "read"],
		["grep", "grep"],
		["find", "find"],
		["data_query", "data_query"],
		["http_request", "http_request"],
		["git_info", "git_info"],
		["wait_for", "wait_for"],
		["ls", "ls"],
		["write", "write"],
		["edit", "write"],
		["sys_probe", "sys_probe"],
	]);
     const maxHintsPerRule = 3;

     const emit = (
          decision: string,
          tool: string,
          ruleId: string,
          count: number,
     ) => {
          const sink = (globalThis as any)[HEALTH_SINK];
          if (typeof sink !== "function") return;
          try {
               sink("router.decision", { decision, tool, hook: ruleId, count });
          } catch {
               /* telemetry must never break a tool call */
          }
     };

     const reset = () => {
          counts = new Map();
          hintCounts = new Map();
          pending = new Map();
          nativePending = new Map();
          nativeUsed = new Set();
     };

	pi.on("session_start", reset);
	pi.on("session_switch", reset);
	pi.on("session_shutdown", reset);
	pi.on("agent_end", () => {
		// Tool results cannot legitimately arrive after an agent turn ends. Keep
		// the session counters, but drop reservations tied to that turn.
		pending.clear();
		nativePending.clear();
	});

     pi.on("tool_call", (event: any) => {
          const mode = routerMode();
          if (mode === "off") return;
          const calledTool = typeof event.toolName === "string" ? event.toolName : typeof event.name === "string" ? event.name : "";
		const nativeRouteTarget = nativeRouteTargets.get(calledTool);
		if (nativeRouteTarget && typeof event.toolCallId === "string" && event.toolCallId.length > 0) {
			nativePending.set(event.toolCallId, nativeRouteTarget);
               if (nativePending.size > MAX_PENDING) {
                    const oldest = nativePending.keys().next().value;
                    if (oldest !== undefined) nativePending.delete(oldest);
               }
               return;
          }
          if (!isToolCallEventType("bash", event)) return;
          const command = event.input?.command;
          if (typeof command !== "string") return;
          const route = classifyBashCommand(command);
          if (!route) return;

          // Tool catalogs can become available after session start. Do not
          // spend an escalation count while the suggested tool is absent, or
          // a later registration would unexpectedly block on its first use.
			let active: unknown;
			try {
				active = typeof pi.getActiveTools === "function"
					? pi.getActiveTools()
					: undefined;
			} catch {
				// A transient catalog failure must not prescribe or block a tool whose
				// availability cannot be established.
				return;
			}
          const targetAvailable = active === undefined
               || (Array.isArray(active) && active.includes(route.tool))
               || (active instanceof Set && active.has(route.tool));
          if (!targetAvailable) return;
          if (nativeUsed.has(route.tool)) return;

          const seen = (counts.get(route.ruleId) ?? 0) + 1;
          counts.set(route.ruleId, seen);

          const threshold = mode === "hard" ? 1 : 2;
          if (
               mode !== "annotate" &&
               route.severity === "escalate" &&
               seen >= threshold
          ) {
               emit("block", route.tool, route.ruleId, seen);
               const replacement = route.replacement
                    ? `: ${route.replacement}`
                    : ".";
               return {
                    block: true,
                    reason: `bash-router: repeated \`${route.ruleId}\` — use the ${route.tool} tool instead${replacement}`,
               };
          }

			const delivered = hintCounts.get(route.ruleId) ?? 0;
			const hintAlreadyPending = [...pending.values()].some((item) => item.ruleId === route.ruleId);
			const nextHintAt = delivered === 0 ? 1 : delivered === 1 ? 4 : delivered === 2 ? 8 : Number.POSITIVE_INFINITY;
			// Reserve one hint until the result succeeds. Failed calls, missing
			// result IDs, and an off-mode switch must not consume the delivery cap.
			if (seen < nextHintAt || delivered >= maxHintsPerRule || hintAlreadyPending) return;
			if (typeof event.toolCallId !== "string" || event.toolCallId.length === 0) return;
			pending.set(event.toolCallId, { tool: route.tool, hint: route.hint, ruleId: route.ruleId, seen });
			if (pending.size > MAX_PENDING) {
				const oldest = pending.keys().next().value;
				if (oldest !== undefined) pending.delete(oldest);
			}
     });

     pi.on("tool_result", (event: any) => {
          if (typeof event.toolCallId !== "string" || event.toolCallId.length === 0) return;
          const nativeTool = nativePending.get(event.toolCallId);
			if (nativeTool) {
				nativePending.delete(event.toolCallId);
				if (!event.isError) nativeUsed.add(nativeTool);
				return;
			}
			const pendingRoute = pending.get(event.toolCallId);
			if (!pendingRoute) return;
			pending.delete(event.toolCallId);
			if (routerMode() === "off") return;
			if (event.isError || nativeUsed.has(pendingRoute.tool)) return;
			const delivered = hintCounts.get(pendingRoute.ruleId) ?? 0;
			if (delivered >= maxHintsPerRule) return;
			hintCounts.set(pendingRoute.ruleId, delivered + 1);
			emit("annotate", pendingRoute.tool, pendingRoute.ruleId, pendingRoute.seen);
			const content = Array.isArray(event.content) ? event.content : [];
          return {
               content: [
                    ...content,
                    { type: "text", text: `[bash-router] ${pendingRoute.hint}` },
               ],
          };
     });
}

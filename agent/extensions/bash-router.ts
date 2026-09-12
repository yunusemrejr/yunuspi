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
 *     replacement tool call (default threshold: second occurrence).
 *   - Annotations are used instead of blocks when the suggested tool differs
 *     in semantics (grep flags, head/tail, sleep, heredocs).
 *
 * Controls:
 *   PI_BASH_ROUTER=off      disable entirely
 *   PI_BASH_ROUTER=annotate hints only, never block
 *   PI_BASH_ROUTER=soft     hints first, block escalating rules on repeat (default)
 *   PI_BASH_ROUTER=hard     block escalating rules from the first occurrence
 *
 * Only tracks bounded per-session counters and never logs command text.
 */

import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { classifyBashCommand } from "./lib/bash-routing.ts";

const HEALTH_SINK = Symbol.for("yunus-pi.health.v1");
const MAX_PENDING = 256;

function routerMode(): string {
     return (process.env.PI_BASH_ROUTER ?? "soft").toLowerCase();
}

export default function bashRouter(pi: any) {
     let counts = new Map<string, number>();
     let pending = new Map<string, string>();

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
          pending = new Map();
     };

     pi.on("session_start", reset);
     pi.on("session_shutdown", reset);

     pi.on("tool_call", (event: any) => {
          const mode = routerMode();
          if (mode === "off") return;
          if (!isToolCallEventType("bash", event)) return;
          const command = event.input?.command;
          if (typeof command !== "string") return;
          const route = classifyBashCommand(command);
          if (!route) return;

          const seen = (counts.get(route.ruleId) ?? 0) + 1;
          counts.set(route.ruleId, seen);

          // Never route to a tool this session cannot call.
          const active =
               typeof pi.getActiveTools === "function"
                    ? pi.getActiveTools()
                    : undefined;
          if (Array.isArray(active) && !active.includes(route.tool)) return;

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

          pending.set(event.toolCallId, route.hint);
          if (pending.size > MAX_PENDING) {
               const oldest = pending.keys().next().value;
               if (oldest !== undefined) pending.delete(oldest);
          }
          emit("annotate", route.tool, route.ruleId, seen);
     });

     pi.on("tool_result", (event: any) => {
          const hint = pending.get(event.toolCallId);
          if (!hint) return;
          pending.delete(event.toolCallId);
          if (event.isError) return;
          const content = Array.isArray(event.content) ? event.content : [];
          return {
               content: [
                    ...content,
                    { type: "text", text: `[bash-router] ${hint}` },
               ],
          };
     });
}

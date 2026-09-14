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
import { classifyBashCommand, selfMatchingSignal } from "./lib/bash-routing.ts";

const HEALTH_SINK = Symbol.for("yunus-pi.health.v1");
const MAX_PENDING = 256;

function routerMode(): string {
     const mode = (process.env.PI_BASH_ROUTER ?? "annotate").toLowerCase();
     return ["off", "annotate", "soft", "hard"].includes(mode)
          ? mode
          : "annotate";
}

export default function bashRouter(pi: any) {
     let counts = new Map<string, number>();
     let hintCounts = new Map<string, number>();
     let pending = new Map<
          string,
          { tool: string; hint: string; ruleId: string; seen: number }
     >();
     let activity = new Map<
          string,
          { decision: string; tool: string; rule: string; count: number }
     >();
     let observed = new Set<string>();
     let candidateResults = new Map<string, { tool: string; ruleId: string }>();
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
          ...[
               "sqlite_probe",
               "package_probe",
               "openapi_probe",
               "coverage_probe",
               "contract_diff",
               "env_audit",
               "net_probe",
               "archive_probe",
          ].map((name) => [name, name] as [string, string]),
     ]);
     const maxHintsPerRule = 3;

     const recordActivity = (decision: string, tool: string, rule: string) => {
          const key = `${decision}:${rule}`;
          const row = activity.get(key) ?? { decision, tool, rule, count: 0 };
          row.count++;
          activity.set(key, row);
          try {
               (globalThis as any)[HEALTH_SINK]?.("router.activity", {
                    decision,
                    tool,
                    hook: rule,
                    count: 1,
               });
          } catch {
               /* Observations never affect routing. */
          }
     };
     pi.registerCommand?.("bash-routes", {
          description:
               "Measured Bash routing opportunities and native-tool use since session load",
          handler: async (_args: string, ctx: any) => {
               const lines = [...activity.values()].map(
                    (r) => `${r.decision} · ${r.tool} · ${r.rule}: ${r.count}`,
               );
               ctx.ui.notify(
                    [
                         "Bash routing observations since this session loaded",
                         ...(lines.length
                              ? lines
                              : [
                                     "No observations recorded (routing may be disabled).",
                                ]),
                         "Available candidates are simple classified commands with an active specialized tool; they are opportunities, not proof of misuse or exact semantic equivalence. Complex commands are outside classifier coverage. Successful bypasses require a successful Bash result. Native successes are separate, not matched workload savings. Numeric events also persist in the health log when enabled.",
                    ].join("\n"),
                    "info",
               );
          },
     });

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
          activity = new Map();
          observed = new Set();
          candidateResults = new Map();
     };

     pi.on("session_start", reset);
     pi.on("session_switch", reset);
     pi.on("session_shutdown", reset);
     pi.on("agent_end", () => {
          // Tool results cannot legitimately arrive after an agent turn ends. Keep
          // the session counters, but drop reservations tied to that turn.
          pending.clear();
          nativePending.clear();
          candidateResults.clear();
     });

     pi.on("tool_call", (event: any) => {
          const mode = routerMode();
          if (mode === "off") return;
          const calledTool =
               typeof event.toolName === "string"
                    ? event.toolName
                    : typeof event.name === "string"
                      ? event.name
                      : "";
          const id = event.toolCallId;
          if (typeof id === "string" && id) {
               if (observed.has(id)) return;
               observed.add(id);
               if (observed.size > 2048)
                    observed.delete(observed.values().next().value!);
          }
          const nativeRouteTarget = nativeRouteTargets.get(calledTool);
          if (
               nativeRouteTarget &&
               typeof event.toolCallId === "string" &&
               event.toolCallId.length > 0
          ) {
               nativePending.set(event.toolCallId, nativeRouteTarget);
               if (nativePending.size > MAX_PENDING) {
                    const oldest = nativePending.keys().next().value;
                    if (oldest !== undefined) nativePending.delete(oldest);
               }
               return;
          }
          if (!isToolCallEventType("bash", event)) return;
          recordActivity("observed", "bash", "bash");
          const command = event.input?.command;
          if (typeof command !== "string") return;
          // A `pkill -f <text>` whose pattern is literal in this command also
          // matches the shell running it; kill it before that becomes exit 137.
          const selfMatch = selfMatchingSignal(command);
          if (selfMatch) {
               emit("block", "bash", "self-match-signal", 1);
               recordActivity("blocked", "bash", "self-match-signal");
               return {
                    block: true,
                    reason: `bash-router: ${selfMatch.reason} Safer form: ${selfMatch.replacement}`,
               };
          }
          const route = classifyBashCommand(command);
          if (!route) return;

          // Tool catalogs can become available after session start. Do not
          // spend an escalation count while the suggested tool is absent, or
          // a later registration would unexpectedly block on its first use.
          let active: unknown;
          try {
               active =
                    typeof pi.getActiveTools === "function"
                         ? pi.getActiveTools()
                         : undefined;
          } catch {
               // A transient catalog failure must not prescribe or block a tool whose
               // availability cannot be established.
               recordActivity("availability-unknown", route.tool, route.ruleId);
               return;
          }
          const targetAvailable =
               active === undefined ||
               (Array.isArray(active) && active.includes(route.tool)) ||
               (active instanceof Set && active.has(route.tool));
          const availability =
               active === undefined
                    ? "availability-unknown"
                    : targetAvailable
                      ? "available-candidate"
                      : "unavailable-candidate";
          recordActivity(availability, route.tool, route.ruleId);
          if (!targetAvailable) return;
          if (active !== undefined && typeof id === "string" && id) {
               candidateResults.set(id, {
                    tool: route.tool,
                    ruleId: route.ruleId,
               });
               if (candidateResults.size > MAX_PENDING)
                    candidateResults.delete(
                         candidateResults.keys().next().value!,
                    );
          }
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
               candidateResults.delete(id);
               recordActivity("blocked", route.tool, route.ruleId);
               const replacement = route.replacement
                    ? `: ${route.replacement}`
                    : ".";
               return {
                    block: true,
                    reason: `bash-router: repeated \`${route.ruleId}\` — use the ${route.tool} tool instead${replacement}`,
               };
          }

          const delivered = hintCounts.get(route.ruleId) ?? 0;
          const hintAlreadyPending = [...pending.values()].some(
               (item) => item.ruleId === route.ruleId,
          );
          const nextHintAt =
               delivered === 0
                    ? 1
                    : delivered === 1
                      ? 4
                      : delivered === 2
                        ? 8
                        : Number.POSITIVE_INFINITY;
          // Reserve one hint until the result succeeds. Failed calls, missing
          // result IDs, and an off-mode switch must not consume the delivery cap.
          if (
               seen < nextHintAt ||
               delivered >= maxHintsPerRule ||
               hintAlreadyPending
          )
               return;
          if (
               typeof event.toolCallId !== "string" ||
               event.toolCallId.length === 0
          )
               return;
          pending.set(event.toolCallId, {
               tool: route.tool,
               hint: route.hint,
               ruleId: route.ruleId,
               seen,
          });
          if (pending.size > MAX_PENDING) {
               const oldest = pending.keys().next().value;
               if (oldest !== undefined) pending.delete(oldest);
          }
     });

     pi.on("tool_result", (event: any) => {
          if (
               typeof event.toolCallId !== "string" ||
               event.toolCallId.length === 0
          )
               return;
          const candidate = candidateResults.get(event.toolCallId);
          candidateResults.delete(event.toolCallId);
          if (candidate && routerMode() !== "off")
               recordActivity(
                    event.isError ? "failed-bypass" : "successful-bypass",
                    candidate.tool,
                    candidate.ruleId,
               );
          const nativeTool = nativePending.get(event.toolCallId);
          if (nativeTool) {
               nativePending.delete(event.toolCallId);
               if (!event.isError && routerMode() !== "off") {
                    nativeUsed.add(nativeTool);
                    recordActivity("native-success", nativeTool, nativeTool);
               }
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
          emit(
               "annotate",
               pendingRoute.tool,
               pendingRoute.ruleId,
               pendingRoute.seen,
          );
          const content = Array.isArray(event.content) ? event.content : [];
          return {
               content: [
                    ...content,
                    {
                         type: "text",
                         text: `[bash-router] ${pendingRoute.hint}`,
                    },
               ],
          };
     });
}

import { collectSessionDiagnostics } from "./lib/session-diagnostics.ts";
import { collectContextTraffic } from "./lib/session-report.ts";
import { collectSessionCost } from "./lib/session-cost.ts";
import { scanSessionAudit } from "./lib/session-audit.ts";
import { stableToolOrder } from "./lib/stable-tool-order.ts";
import { createToolJsonCompactor } from "./lib/compact-tool-json.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import path from "node:path";
import { Type } from "typebox";
import {
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  PressureThresholds,
  pressureFacts,
  payloadPressureWarning,
  truncationDiagnostic,
  type OutputRequest,
  dateAnchor,
  sessionFacts,
} from "./lib/session-signals.ts";
function runtimeFacts(pi: ExtensionAPI, ctx: ExtensionContext) {
  const activeTools = pi.getActiveTools().slice().sort();
  const backgroundHandles: Record<string, string> = {};
  if (activeTools.includes("process"))
    backgroundHandles.process =
      "Supervised internal helper/wait_for handles only; ephemeral to this Pi process. Ordinary bash waits; bg_run and subagent IDs have their own owners.";
  if (activeTools.includes("bg_status"))
    backgroundHandles.bg_status =
      "bg_run task IDs; completion normally notifies. Inspect existing work before relaunching.";
  if (activeTools.includes("subagent"))
    backgroundHandles.subagent =
      "Native subagent run IDs; status/steer/stop belong here. Async runs normally notify; do not launch a duplicate to wait.";
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    mode: ctx.mode ?? null,
    agentDir: getAgentDir(),
    parentSession: ctx.sessionManager.getHeader()?.parentSession ?? null,
    model: ctx.model
      ? {
          provider: ctx.model.provider,
          id: ctx.model.id,
          input: ctx.model.input,
        }
      : null,
    thinkingLevel: ctx.thinkingLevel ?? null,
    activeTools,
    backgroundHandles,
    scope:
      "cwd is the tool default, not proof of repository ownership or write/deploy permission. parentSession records lineage, not a delegated task. Live schemas govern availability; historical summaries do not grant tools or authority.",
  };
}

export default function (pi: any) {
  pi.registerCommand("cost", {
    description: "Session cost by model, child runs and auxiliary usage, with pricing coverage",
    handler: async (_args: string, ctx: any) => {
      const cost = collectSessionCost(ctx.sessionManager.getEntries());
      const money = (n: number) => n > 0 && n < 0.000001 ? `$${n.toExponential(3)}` : `$${n.toFixed(6)}`;
      const lines = [
        `${cost.formatted} total (USD)`,
        `Provider-reported: ${money(cost.reported)}; estimated: ${money(cost.estimated)}.`,
        ...cost.rows.map((r: any) => `${r.scope} · ${r.route}: ${money(r.reported + r.estimated)}${r.estimatedUsage ? ' estimated' : ''}${r.unknown ? ' + unpriced usage' : ''}${r.subscription ? ' · subscription' : ''}`),
        ...(cost.pending ? [`${cost.pending} child operation(s) awaiting final cost evidence.`] : []),
        ...(cost.unknown ? ['Partial total: some recorded activity has missing prices or usage.'] : []),
        'Main responses, child runs, retries, compactions and usage-bearing tools are included when recorded. Repeated child snapshots count once.',
        'Estimates use the rates attached to each response. Provider-reported amounts take precedence. Unreported external tools, storage, taxes, credit purchases and subscription fees are outside this total.',
      ];
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
  const toolJson = createToolJsonCompactor();
  let riskAnnounced = false;
  // Pressure notices are derived from the current model/session state. Keep
  // an internal tag so a notice from before resume, model selection or
  // compaction cannot be projected as if it described the current window.
  const pressureInstance = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const pressureSignalKind = "context-pressure-v1";
  let pressureGeneration = 0;
  const resetPressureSignals = () => pressureGeneration++;
  const pressureSignal = (content: string) => ({
    customType: "runtime-signals",
    content,
    display: false,
    details: {
      kind: pressureSignalKind,
      tag: `${pressureInstance}:${pressureGeneration}`,
    },
  });
  let requested: number | undefined;
  let outputRequest: OutputRequest | undefined;
  const terminatingTools = new Set<string>();
  const thresholds = new PressureThresholds(
    (process.env.PI_CONTEXT_THRESHOLDS ?? "70,85").split(",").map(Number),
  );
  const facts = (ctx: any) =>
    pressureFacts(
      ctx,
      ctx.getContextUsage()?.compactionSettings ??
        SettingsManager.create(ctx.cwd, getAgentDir(), {
          projectTrusted: ctx.isProjectTrusted?.() ?? false,
        }).getCompactionSettings(),
      requested,
  );
  const notice = (ctx: any) => {
    const f = facts(ctx);
    const contextPercent = f.contextWindowPercent;
    const risk = !riskAnnounced
      ? payloadPressureWarning(contextPercent)
      : undefined;
    if (risk) riskAnnounced = true;
    const lines = [];
    if (thresholds.observe(contextPercent ?? null) !== null)
      lines.push(
        `[context pressure] ${Math.round(contextPercent!)}% of the selected model context window (${f.tokens}/${f.contextWindow}; automatic compaction starts at ${f.compactionTrigger ?? "disabled"} tokens). Output/safety-adjusted usable budget is ${f.usableBudget} tokens (~${f.remaining ?? "unknown"} remaining; estimated). Preserve the goal, decisions, evidence locations and next step, then continue required work. This notice saves nothing and does not interrupt execution.`,
      );
    if (risk) lines.push(risk);
    return lines.join("\n") || undefined;
  };
  pi.on("turn_start", () => {
    outputRequest = undefined;
    terminatingTools.clear();
  });
  pi.on("tool_execution_end", (event: any) => {
    if (event.result.terminate === true) terminatingTools.add(event.toolCallId);
  });
  pi.on("session_start", () => {
    resetPressureSignals();
    toolJson.reset();
    outputRequest = undefined;
    requested = undefined;
    terminatingTools.clear();
    thresholds.reset();
    riskAnnounced = false;
  });
  pi.on("session_compact", () => {
    resetPressureSignals();
    toolJson.reset();
    outputRequest = undefined;
    thresholds.reset();
    riskAnnounced = false;
  });
  pi.on("session_switch", () => resetPressureSignals());
  // Runtime identity is available on demand via session_self. Remove legacy
  // conversation signals rather than moving them to the most recent position.
  pi.on("context", (event: any, ctx: any) => {
    const currentPressureTag = `${pressureInstance}:${pressureGeneration}`;
    const isPressureLine = (line: string) =>
      line.startsWith("[context pressure]") ||
      line.startsWith("[tool payload risk]");
    const messages = toolJson
      .transform(event.messages)
      .flatMap(
        (m: {
          role: string;
          customType?: string;
          content?: unknown;
          details?: { kind?: string; tag?: string };
        }) => {
          if (m.role !== "custom") return [m];
          if (
            ["tool-payload-risk", "runtime-awareness"].includes(
              m.customType ?? "",
            )
          )
            return [];
          if (
            m.customType !== "runtime-signals" ||
            typeof m.content !== "string"
          )
            return [m];
          const lines = m.content.split("\n");
          const taggedPressure = m.details?.kind === pressureSignalKind;
          // Tagged pressure messages from a previous generation are owned by
          // this extension and safe to omit from projected context. Legacy
          // untagged pressure lines are also removed on every projection,
          // because context transforms do not rewrite the durable entry.
          const staleTaggedPressure =
            taggedPressure && m.details?.tag !== currentPressureTag;
          const content = lines
            .filter(
              (line) =>
                !line.startsWith("[runtime date]") &&
                !(isPressureLine(line) && (!taggedPressure || staleTaggedPressure)),
            )
            .join("\n");
          return content ? [content === m.content ? m : { ...m, content }] : [];
        },
      );

    if (
      messages.length === event.messages.length &&
      messages.every((m: any, i: number) => m === event.messages[i])
    )
      return;
    return { messages };
  });
  pi.on("model_select", () => {
    resetPressureSignals();
    outputRequest = undefined;
    requested = undefined;
    thresholds.reset();
    riskAnnounced = false;
  });
  pi.on("before_provider_request", (e: any, ctx: any) => {
    const p = stableToolOrder(e.payload);
    const changed = p !== e.payload ? p : undefined;
    // Auxiliary requests use the same runner while ctx still identifies the
    // primary model. A distinct wire model must not replace its cap evidence.
    if (typeof p?.model === "string" && p.model !== ctx.model?.id)
      return changed;
    const n =
      p?.max_tokens ??
      p?.max_completion_tokens ??
      p?.max_output_tokens ??
      p?.generationConfig?.maxOutputTokens;
    requested = Number.isSafeInteger(n) && n > 0 ? n : undefined;
    outputRequest = {
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      cap: requested,
      configuredCap: ctx.model?.maxTokens,
    };
    return changed;
  });
  pi.on("message_end", (e: any) => {
    if (e.message.role !== "assistant") return;
    const request = outputRequest;
    outputRequest = undefined;
    if (e.message.stopReason !== "length") return;
    const diagnostic = truncationDiagnostic(e.message, request);
    return {
      message: {
        ...e.message,
        errorMessage: e.message.errorMessage
          ? `${e.message.errorMessage}\n${diagnostic}`
          : diagnostic,
      },
    };
  });
  pi.on("before_agent_start", (_e: any, ctx: any) => {
    const n = notice(ctx);
    return {
      // Stable for the whole run, including tool continuations and compaction.
      // Unlike custom messages this is metadata, not a fresh conversational turn.
      systemPrompt: `${_e.systemPrompt}\n\n${dateAnchor().text}`,
      ...(n
        ? {
            message: pressureSignal(n),
          }
        : {}),
    };
  });
  pi.on("turn_end", (e: any, ctx: any) => {
    // A pressure notice is useful only while normal tool execution continues.
    // Queuing a steer into a stopped/failed run can revive work the user ended.
    if (
      e.message?.role !== "assistant" ||
      !e.toolResults?.length ||
      ctx.signal?.aborted ||
      e.toolResults.every((r: any) => terminatingTools.has(r.toolCallId)) ||
      (e.message.stopReason && e.message.stopReason !== "toolUse")
    )
      return;
    const lines = [];
    const n = notice(ctx);
    if (n) lines.push(n);
    if (lines.length)
      pi.sendMessage(pressureSignal(lines.join("\n")), { deliverAs: "steer" });
  });
  const self = (ctx: any) => sessionFacts(ctx.sessionManager.getEntries());
  // Bounded, newest-first failure read: diagnose without re-running any work.
  const recentFailures = (ctx: any) => collectSessionDiagnostics(
    ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [],
  );
  pi.registerCommand("self", {
    description: "Current-session token and failure diagnostics",
    handler: async (_a: any, ctx: any) =>
      ctx.ui.notify(JSON.stringify(self(ctx)), "info"),
  });
  pi.registerTool({
    name: "session_self",
    promptGuidelines: [
      "When useful, explore tool_search or find a task-specific skill with skill_review. Read a SKILL.md on demand when it helps the next decision. Discovery is optional; tool access and suggestions do not grant authorization or prove success.",
    ],
    label: "Session self",
    description:
      "Current session diagnostics: view:context for full-window occupancy, the automatic compaction threshold and separate output/safety headroom; view:failures for grouped tool/model/child/workflow evidence and recovery clues; view:efficiency for the largest returned text and exact repeated request/result pairs; view:runtime for live cwd, model, active tools and background-handle owners. Use efficiency after repeated inspection or large output to choose focused native tools and evidence reuse. Runtime facts do not authorize new work. session_audit provides aggregate counts from past sessions.",
    parameters: Type.Object({
      view: Type.Optional(
        StringEnum(["session", "context", "runtime", "failures", "efficiency"]),
      ),
    }),
    async execute(_id: any, p: any, _s: any, _u: any, ctx: any) {
      const details =
        p.view === "efficiency"
          ? (() => {
            const traffic = collectContextTraffic(ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries());
            return { ...traffic, tools: traffic.tools.slice(0, 8), omittedTools: Math.max(0, traffic.tools.length - 8),
              interpretation: "Last 2000 branch entries; raw returned characters before projection, not current occupancy or billed tokens. Exact repeated observations can be legitimate polling. Prefer focused source queries, retained evidence, and completion notifications when appropriate; do not skip necessary verification." };
          })()
          : p.view === "failures"
          ? recentFailures(ctx)
          : p.view === "runtime"
            ? runtimeFacts(pi, ctx)
            : p.view === "context"
              ? facts(ctx)
              : self(ctx);
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  });
  pi.registerTool({
    name: "session_audit",
    label: "Session audit",
    description:
      "Bounded offline aggregate of persisted past-session activity. The default workspace scope includes only session headers whose cwd canonicalizes exactly to the active workspace; choose scope all explicitly for a harness-wide audit. Returns tool, skill, child, workflow and failure counts only, with no prompts, paths or raw errors; no model or network calls.",
    parameters: Type.Object({
      scope: Type.Optional(StringEnum(["workspace", "all"])),
    }),
    async execute(_id: any, p: any, signal: any, _u: any, ctx: any) {
      const details = await scanSessionAudit({
        sessionsDir: path.join(getAgentDir(), "sessions"),
        workspace: ctx.cwd,
        scope: p?.scope === "all" ? "all" : "workspace",
        maxFiles: 100,
        signal,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  });
}

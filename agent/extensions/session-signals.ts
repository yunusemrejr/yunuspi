import { stableToolOrder } from "./lib/stable-tool-order.ts";
import { createToolJsonCompactor } from "./lib/compact-tool-json.ts";
import { StringEnum } from "@earendil-works/pi-ai";
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
      "Own detached bash/wait_for handles; ephemeral to this Pi process, not bg_run or subagent IDs.";
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
  const toolJson = createToolJsonCompactor();
  let riskAnnounced = false;
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
    const risk = !riskAnnounced ? payloadPressureWarning(f.percent) : undefined;
    if (risk) riskAnnounced = true;
    const lines = [];
    if (thresholds.observe(f.percent ?? null) !== null)
      lines.push(`[context pressure] ${Math.round(f.percent!)}% of effective usable budget (${f.tokens}/${f.usableBudget}, ~${f.remaining} remaining; estimated). Compaction is routine: preserve the goal, decisions, evidence locations and next step, then continue required work. Do not rush or omit verification to avoid compaction. This notice saves nothing and does not interrupt execution.`);
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
    toolJson.reset();
    outputRequest = undefined;
    requested = undefined;
    terminatingTools.clear();
    thresholds.reset();
    riskAnnounced = false;
  });
  pi.on("session_compact", () => {
    toolJson.reset();
    outputRequest = undefined;
    thresholds.reset();
    riskAnnounced = false;
  });
  // Runtime identity is available on demand via session_self. Remove legacy
  // conversation signals rather than moving them to the most recent position.
  pi.on("context", (event: any, ctx: any) => {
    const messages = toolJson.transform(event.messages).flatMap(
      (m: { role: string; customType?: string; content?: unknown }) => {
        if (m.role !== "custom") return [m];
        if (
          ["tool-payload-risk", "runtime-awareness"].includes(
            m.customType ?? "",
          )
        )
          return [];
        if (m.customType !== "runtime-signals" || typeof m.content !== "string")
          return [m];
        // Preserve pressure notices, but never replay a runtime date as a user turn.
        const content = m.content
          .split("\n")
          .filter((line) => !line.startsWith("[runtime date]"))
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
    if (typeof p?.model === "string" && p.model !== ctx.model?.id) return changed;
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
            message: {
              customType: "runtime-signals",
              content: n,
              display: false,
            },
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
    ) return;
    const lines = [];
    const n = notice(ctx);
    if (n) lines.push(n);
    if (lines.length)
      pi.sendMessage(
        {
          customType: "runtime-signals",
          content: lines.join("\n"),
          display: false,
        },
        { deliverAs: "steer" },
      );
  });
  const self = (ctx: any) => sessionFacts(ctx.sessionManager.getEntries());
  pi.registerCommand("self", {
    description: "Current-session token and failure diagnostics",
    handler: async (_a: any, ctx: any) =>
      ctx.ui.notify(JSON.stringify(self(ctx)), "info"),
  });
  pi.registerTool({
    name: "session_self",
    promptGuidelines: ["For substantial changes, establish relevant project conventions and environment; read matching skills and use the available inspection tools when useful. Keep simple tasks simple. Capability hints are advisory, never new scope or authorization."],
    label: "Session self",
    description:
      "Current session diagnostics, effective context pressure, or view:runtime for live cwd, harness directory, session/model, active tools and background-handle owners. Runtime facts do not authorize new work; unavailable fields are explicit.",
    parameters: Type.Object({
      view: Type.Optional(StringEnum(["session", "context", "runtime"])),
    }),
    async execute(_id: any, p: any, _s: any, _u: any, ctx: any) {
      const details =
        p.view === "runtime"
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
}

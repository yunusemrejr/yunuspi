import { collectSessionMetrics } from "./session-metrics.ts";
import { CHILD_REASON_TEXT, childFailureExcerpt, errorSignature, failureCategory, incidentId } from "./session-diagnostics.ts";
import type { LogicalChildTask } from "../pi-subagents/src/runs/shared/child-ledger.ts";

export type SessionErrorKind = "tool" | "model" | "child" | "workflow" | "hook";

export type SessionErrorDetail = {
  /** 1-based position, newest error first. */
  seq: number;
  /** Stable incident id shared with /metrics diagnostics. */
  incident: string;
  /** Recurring-failure signature shared with the report's signatures table. */
  signature: string;
  kind: SessionErrorKind;
  tool: string;
  /** Owning harness module: extension path, provider route, or hook owner. Never guessed beyond the recorded evidence. */
  module: string;
  category: string;
  recovery: string;
  /** One-line cause: what failed, at which stage, and the next step. */
  why: string;
  timestamp?: string;
  entryId?: string;
  callId?: string;
  runId?: string;
  agent?: string;
  provider?: string;
  model?: string;
  backend?: string;
  route?: string;
  stopReason?: string;
  statusCode?: string;
  exitCode?: number;
  attempts?: number;
  outputPresence?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; turns?: number };
  /** Bounded redacted error text with newlines preserved for stacks. */
  error: string;
  errorChars: number;
  truncated: boolean;
  /** Redacted bounded call arguments that produced the failure. */
  payload?: unknown;
  payloadTruncated?: boolean;
  /** Redacted bounded result/ledger details. */
  details?: unknown;
  detailsTruncated?: boolean;
  /** Canonical ledger execution/acceptance for a matched child attempt. */
  execution?: string;
  acceptance?: string;
};

export type SessionErrorsReport = {
  inspected: number;
  truncated: boolean;
  total: number;
  omitted: number;
  limit: number;
  /** Newest first. */
  errors: SessionErrorDetail[];
  groups: { kind: string; tool: string; category: string; count: number }[];
  omittedGroups: number;
  /** Recurring signatures across the full inspected window (not the shown limit): same normalized cause counted once with preceding-tool context. */
  signatures: {
    signature: string; count: number; kind: string; tool: string; category: string;
    module: string; recovery: string; firstEntry: number; lastEntry: number;
    exampleIncident: string; precedingTools: { tool: string; count: number }[];
  }[];
  omittedSignatures: number;
  byKind: Record<string, number>;
  hookErrors: { hook: string; owner: string; calls: number; errors: number; ms: number }[];
  scope: string;
};

// Secret patterns mirror the pi-subagents permissions owner; copied here so
// this leaf collector gains no new cross-tree edge for two regexes.
const SECRET_KEY = /(?:authorization|cookie|credential|password|secret|token|api[-_]?key)/i;
const SECRET_VALUE = /\b(?:Bearer\s+\S+|(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,})\b/gi;
const redactSecrets = (value: string): string => value.replace(SECRET_VALUE, "[redacted]");

const LIMIT = 2000;
const DEFAULT_ERROR_LIMIT = 50;
const ERROR_CHARS = 2000;
const STRING_CHARS = 500;

/** Provider status codes only in failure phrasing — bare counts such as "500 items" must not become a statusCode. */
const STATUS_CODE = /(?:status|HTTP|code|error|failed)[^\d]{0,20}([45]\d\d)\b|([45]\d\d)[^\n]{0,20}(?:error|exceeded|failed|exhausted)/i;
const statusCodeOf = (raw: string): string | undefined => {
  const match = STATUS_CODE.exec(raw);
  return match?.[1] ?? match?.[2] ?? undefined;
};
const FINITE = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function boundText(value: unknown, max: number): { text: string; chars: number; truncated: boolean } {
  const raw = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const clean = redactSecrets(raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " "));
  return { text: clean.slice(0, max), chars: clean.length, truncated: clean.length > max };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Redacted bounded clone for JSON payloads. Strings cap at 500 chars, objects at 20 keys, arrays at 10 items, depth at 4. */
function boundValue(value: unknown, key = "", depth = 0, flag = { truncated: false }): unknown {
  if (SECRET_KEY.test(key)) {
    flag.truncated = true;
    return "[redacted]";
  }
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    const clean = redactSecrets(value);
    if (clean.length > STRING_CHARS) flag.truncated = true;
    return clean.slice(0, STRING_CHARS);
  }
  if (depth >= 4) {
    flag.truncated = true;
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    if (value.length > 10) flag.truncated = true;
    return value.slice(0, 10).map((item) => boundValue(item, "", depth + 1, flag));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 20) flag.truncated = true;
    return Object.fromEntries(
      entries.slice(0, 20).map(([entryKey, entryValue]) => [entryKey.slice(0, 120), boundValue(entryValue, entryKey, depth + 1, flag)]),
    );
  }
  return String(value).slice(0, STRING_CHARS);
}

const TOOL_MODULES: [string, string][] = [
  ["subagent", "agent/extensions/pi-subagents"],
  ["browser_", "agent/extensions/pi-web-access"],
  ["web_search", "agent/extensions/pi-web-access"],
  ["web_research", "agent/extensions/pi-web-access"],
  ["web_probe", "agent/extensions/pi-web-access"],
  ["fetch_content", "agent/extensions/pi-web-access"],
  ["source_check", "agent/extensions/pi-web-access"],
  ["get_search_content", "agent/extensions/pi-web-access"],
  ["agentmail_", "agent/extensions/agentmail.ts"],
  ["bg_", "agent/extensions/pi-background-tasks"],
  ["project_", "agent/extensions/project-intelligence.ts"],
  ["module_report", "agent/extensions/project-intelligence.ts"],
  ["symbol_", "agent/extensions/pi-lens + agent-context-tools"],
  ["context_slice", "agent/extensions/agent-context-tools.ts"],
  ["context_score", "agent/extensions/agent-context-tools.ts"],
  ["handoff_capsule", "agent/extensions/agent-context-tools.ts"],
  ["evidence_cache", "agent/extensions/agent-context-tools.ts"],
  ["quality_", "agent/extensions/lib/quality-review.ts"],
  ["test_run", "agent/extensions/lib/project-tests.ts"],
  ["media_", "agent/extensions/media-tools.ts"],
  ["video_frames", "agent/extensions/media-tools.ts"],
  ["audio_analyze", "agent/extensions/media-tools.ts"],
  ["music_compose", "agent/extensions/media-tools.ts"],
  ["image_ocr", "agent/extensions/media-tools.ts"],
  ["sandbox_run", "agent/extensions/sandbox.ts"],
  ["http_request", "agent/extensions/http-tools.ts"],
  ["git_info", "agent/extensions/git-tools.ts"],
  ["todo", "agent/extensions/rpiv-todo"],
  ["obs_read", "agent/extensions/pi-observations.ts"],
  ["render_see", "agent/extensions/render-and-wait.ts"],
  ["wait_for", "agent/extensions/render-and-wait.ts"],
  ["process", "agent/extensions/managed-bash.ts"],
  ["checkpoint_", "agent/extensions/checkpoints.ts"],
  ["context_profile", "agent/extensions/context-profile.ts"],
  ["sys_probe", "agent/extensions/sys-probe.ts"],
  ["session_self", "agent/extensions/session-signals.ts"],
  ["session_audit", "agent/extensions/session-signals.ts"],
  ["session_stop", "agent/extensions/lib/session-stop.ts"],
  ["session_coordinate", "agent/extensions/siblings.ts"],
  ["skill_review", "agent/extensions/lib/harness-capabilities.ts"],
  ["tool_search", "agent/extensions/lib/harness-capabilities.ts"],
  ["bulk_edit", "agent/extensions/bulk-edit.ts"],
  ["workdir_snapshot", "agent/extensions/scoped-snapshots.ts"],
  ["research_toolkit", "agent/extensions/research-toolkit.ts"],
  ["micro_status", "agent/extensions/micro-intelligence.ts"],
  ["math_check", "agent/extensions/lib/small-tools.ts"],
  ["artifact_check", "agent/extensions/lib/small-tools.ts"],
  ["value_convert", "agent/extensions/lib/small-tools.ts"],
  ["decision_frontier", "agent/extensions/lib/small-tools.ts"],
  ["lsp_", "agent/extensions/pi-lens"],
  ["read", "core (native)"],
  ["write", "core (native)"],
  ["edit", "core (native)"],
  ["bash", "core (native)"],
  ["grep", "core (native)"],
  ["glob", "core (native)"],
  ["apply_patch", "core (native)"],
  ["structured_output", "core (native)"],
];

/** Owning module for a tool name. Prefix match; unknown tools stay explicitly unknown. */
export function moduleForTool(tool: string): string {
  const name = String(tool ?? "");
  for (const [prefix, module] of TOOL_MODULES) {
    if (name === prefix || name.startsWith(prefix)) return module;
  }
  return "unknown (unmapped tool owner)";
}

export function collectSessionErrors(
  allEntries: unknown,
  options: { limit?: number; errorChars?: number; ledgerTasks?: LogicalChildTask[] } = {},
): SessionErrorsReport {
  const limit = Number.isSafeInteger(options.limit) && (options.limit as number) > 0 ? Math.min(options.limit as number, 200) : DEFAULT_ERROR_LIMIT;
  const errorChars = Number.isSafeInteger(options.errorChars) && (options.errorChars as number) > 0 ? Math.min(options.errorChars as number, 8000) : ERROR_CHARS;
  const entries = Array.isArray(allEntries) ? allEntries.slice(-LIMIT) : [];
  const ledgerByRun = new Map<string, { agent?: string; route?: string; backend?: string; execution: string; acceptance: string }>();
  for (const task of options.ledgerTasks ?? []) {
    for (const attempt of task?.attempts ?? []) {
      if (!attempt?.runId || ledgerByRun.has(attempt.runId)) continue;
      const cause = attempt.execution?.cause;
      ledgerByRun.set(attempt.runId, {
        agent: attempt.agent ?? task.agent,
        route: attempt.route,
        backend: attempt.backend,
        execution: cause ? `${attempt.execution.status} (${cause.stage}/${cause.category})` : attempt.execution.status,
        acceptance: `${attempt.acceptance.status}${attempt.acceptance.reason ? ` · ${attempt.acceptance.reason}` : ""}`,
      });
    }
  }

  const calls = new Map<string, { name?: string; args?: unknown }>();
  for (const entry of entries) {
    const message = (entry as Record<string, unknown>)?.type === "message" ? (entry as { message: { role?: string; content?: unknown } }).message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content.slice(0, 256)) {
      if (part?.type === "toolCall" && typeof part.id === "string" && !calls.has(part.id))
        calls.set(part.id, { name: part.name, args: part.arguments });
    }
  }
  // Launch-level spawn args keyed by every id a cost row may carry.
  const spawnArgs = new Map<string, unknown>();
  const childEvidence = new Map<string, { outcomeReason?: unknown; attemptCount?: unknown; output?: unknown; cause?: unknown }>();
  for (const entry of entries) {
    const message = (entry as Record<string, unknown>)?.type === "message" ? (entry as { message: Record<string, unknown> }).message : undefined;
    if (message?.role === "toolResult" && message.toolName === "subagent" && typeof message.toolCallId === "string") {
      const call = calls.get(message.toolCallId as string);
      if (call && !(call.args as Record<string, unknown>)?.action) {
        const details = (message.details ?? {}) as Record<string, unknown>;
        for (const key of [details.asyncId, details.runId, message.toolCallId]) {
          if (typeof key === "string" && key && !spawnArgs.has(key)) spawnArgs.set(key, call.args);
        }
      }
    }
    if ((entry as Record<string, unknown>)?.type === "custom" && (entry as { customType?: string }).customType === "subagent-cost-v1") {
      const data = (entry as { data?: { runId?: string; results?: unknown[] } }).data;
      if (!Array.isArray(data?.results)) continue;
      for (const [index, row] of data.results.slice(0, 64).entries()) {
        const typed = row as Record<string, unknown>;
        const evidence = typed?.evidence as Record<string, unknown> | undefined;
        if (evidence?.version !== 1) continue;
        childEvidence.set(`${(typed.runId ?? data?.runId) as string}:${typed.runId ? 0 : ((typed.workflowKey ?? typed.childId ?? typed.index ?? index) as string | number)}`, evidence);
      }
    }
  }

  const reasonText = CHILD_REASON_TEXT;
  // Preceding-tool context per entry position: the tool-result names seen
  // before this entry (the failing call itself excluded).
  const precedingByOrder = new Map<number, string[]>();
  {
    const recent: string[] = [];
    entries.forEach((entry, order) => {
      precedingByOrder.set(order, recent.slice(-5));
      const message = (entry as Record<string, unknown>)?.type === "message"
        ? ((entry as { message: Record<string, unknown> }).message)
        : undefined;
      if (message?.role === "toolResult" && typeof message.toolName === "string") {
        recent.push(String(message.toolName).slice(0, 120));
        if (recent.length > 8) recent.shift();
      }
    });
  }
  type Found = { order: number; key: string; error: Omit<SessionErrorDetail, "seq">; preceding: string[] };
  const found = new Map<string, Found>();
  const push = (order: number, key: string, error: Omit<SessionErrorDetail, "seq">): void => {
    // Same failure described by several records (launch receipt + cost ledger):
    // the newest description wins, counted once.
    found.set(key, { order, key, error, preceding: precedingByOrder.get(order) ?? [] });
  };

  const usageOf = (value: unknown): SessionErrorDetail["usage"] | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const usage = {
      ...(FINITE(record.input) !== undefined ? { input: FINITE(record.input) } : {}),
      ...(FINITE(record.output) !== undefined ? { output: FINITE(record.output) } : {}),
      ...(FINITE(record.cacheRead) !== undefined ? { cacheRead: FINITE(record.cacheRead) } : {}),
      ...(FINITE(record.cacheWrite) !== undefined ? { cacheWrite: FINITE(record.cacheWrite) } : {}),
      ...(FINITE(record.turns) !== undefined ? { turns: FINITE(record.turns) } : {}),
    };
    return Object.keys(usage).length ? usage : undefined;
  };

  entries.forEach((entry, order) => {
    const record = entry as Record<string, unknown>;
    const message = record?.type === "message" ? (record.message as Record<string, unknown>) : undefined;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp.slice(0, 32) : undefined;
    const entryId = typeof record.id === "string" ? record.id.slice(0, 80) : undefined;

    if (message?.role === "assistant" && message.stopReason === "error") {
      const raw = String((message.errorMessage as string) ?? contentText(message.content)).slice(0, 16000);
      const classification = failureCategory(raw);
      const provider = typeof message.provider === "string" ? (message.provider as string).slice(0, 80) : undefined;
      const model = typeof message.model === "string" ? (message.model as string).slice(0, 160) : undefined;
      const stopReason = typeof message.stopReason === "string" ? (message.stopReason as string).slice(0, 32) : undefined;
      const link = `${entryId ?? order}`;
      const bounded = boundText(raw, errorChars);
      const statusCode = statusCodeOf(raw);
      push(order, `model:${entryId ?? order}`, {
        incident: incidentId(classification.category, raw, link),
        signature: errorSignature("model", "provider", classification.category, raw),
        kind: "model",
        tool: "provider",
        module: provider ? `provider:${provider} via agent/extensions/provider-gate.ts` : "agent/extensions/provider-gate.ts",
        category: classification.category,
        recovery: classification.recovery,
        why: raw.trim()
          ? `provider ${provider ?? "unknown"}/${model ?? "unknown"} request failed (${classification.category}); ${classification.recovery}`
          : `provider ${provider ?? "unknown"}/${model ?? "unknown"} request failed with no message text (${classification.category}); ${classification.recovery}`,
        ...(timestamp ? { timestamp } : {}),
        ...(entryId ? { entryId } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(stopReason ? { stopReason } : {}),
        ...(statusCode ? { statusCode } : {}),
        ...(usageOf(message.usage) ? { usage: usageOf(message.usage) } : {}),
        error: bounded.text,
        errorChars: bounded.chars,
        truncated: bounded.truncated,
      });
    }

    const toolFailed =
      message?.role === "toolResult" &&
      (message.isError === true ||
        (message.toolName === "web_search" &&
          ((message.details as Record<string, unknown>)?.queryCount as number) > 0 &&
          ((message.details as Record<string, unknown>)?.successfulQueries as number) === 0));
    if (toolFailed && message) {
      const tool = String(message.toolName ?? "unknown").slice(0, 120);
      const callId = typeof message.toolCallId === "string" ? (message.toolCallId as string) : undefined;
      const raw = contentText(message.content).slice(0, 16000);
      // Failures with no message text: mine the structured details for a
      // cause (exit codes, states) instead of reporting an empty error.
      const detailsRecord = message.details && typeof message.details === "object" && !Array.isArray(message.details)
        ? (message.details as Record<string, unknown>) : undefined;
      const clueParts: string[] = [];
      if (detailsRecord) {
        for (const field of ["status", "state", "code", "error", "message"] as const) {
          const value = detailsRecord[field];
          if (typeof value === "string" && value.trim()) clueParts.push(`${field}: ${value.trim().slice(0, 200)}`);
        }
        if (Number.isInteger(detailsRecord.exitCode)) clueParts.push(`exitCode: ${detailsRecord.exitCode}`);
      }
      const causeText = raw.trim() ? raw : clueParts.join(" · ");
      const classification = failureCategory(causeText || raw);
      const bounded = boundText(causeText, errorChars);
      const statusCode = statusCodeOf(causeText || raw);
      const call = callId ? calls.get(callId) : undefined;
      const payloadFlag = { truncated: false };
      const payload = call?.args !== undefined ? boundValue(call.args, "", 0, payloadFlag) : undefined;
      const detailsFlag = { truncated: false };
      const details = message.details !== undefined ? boundValue(message.details, "", 0, detailsFlag) : undefined;
      push(order, `tool:${callId ?? entryId ?? order}`, {
        incident: incidentId(classification.category, causeText || raw, callId ?? `${entryId ?? order}`),
        signature: errorSignature("tool", tool, classification.category, causeText || raw),
        kind: "tool",
        tool,
        module: moduleForTool(tool),
        category: classification.category,
        recovery: classification.recovery,
        why: raw.trim()
          ? `tool ${tool} returned an error (${classification.category}); ${classification.recovery}`
          : `tool ${tool} failed with no message text (${classification.category}); inspect the failed payload and details; ${classification.recovery}`,
        ...(timestamp ? { timestamp } : {}),
        ...(entryId ? { entryId } : {}),
        ...(callId ? { callId } : {}),
        ...(statusCode ? { statusCode } : {}),
        ...(Number.isInteger(detailsRecord?.exitCode) ? { exitCode: detailsRecord?.exitCode as number } : {}),
        error: bounded.text,
        errorChars: bounded.chars,
        truncated: bounded.truncated,
        ...(payload !== undefined ? { payload, ...(payloadFlag.truncated ? { payloadTruncated: true as const } : {}) } : {}),
        ...(details !== undefined ? { details, ...(detailsFlag.truncated ? { detailsTruncated: true as const } : {}) } : {}),
      });
    }

    const owned = record?.type === "custom" && ["subagent-cost-v1", "subagent-lifecycle-v1"].includes(record.customType as string);
    const launch =
      message?.role === "toolResult" && message.toolName === "subagent" && typeof message.toolCallId === "string" &&
      calls.has(message.toolCallId as string) && !(calls.get(message.toolCallId as string)?.args as Record<string, unknown>)?.action;
    const data = (owned ? (record.data as Record<string, unknown>) : launch ? (message?.details as Record<string, unknown>) : undefined) as
      | Record<string, unknown>
      | undefined;
    if (!data || typeof data !== "object") return;
    const root = String((data.runId ?? data.asyncId ?? record.id ?? message?.toolCallId ?? order) as string).slice(0, 80);
    const callId = typeof message?.toolCallId === "string" ? (message.toolCallId as string) : undefined;
    if (data.mode === "workflow") {
      const state = String(data.state ?? (data.workflowChildren as Record<string, unknown>)?.workflowState ?? "");
      if (["failed", "rejected"].includes(state) || data.success === false) {
        const raw = String(data.error ?? data.errorMessage ?? "Workflow controller failed").slice(0, 16000);
        const classification = failureCategory(raw);
        const bounded = boundText(raw, errorChars);
        push(order, `workflow:${root}`, {
          incident: incidentId(classification.category, raw, root),
          signature: errorSignature("workflow", "subagent", classification.category, raw),
          kind: "workflow",
          tool: "subagent",
          module: "agent/extensions/pi-subagents/workflows",
          category: classification.category,
          recovery: classification.recovery,
          why: `workflow controller ${root} failed (${classification.category}); ${classification.recovery}`,
          ...(timestamp ? { timestamp } : {}),
          ...(entryId ? { entryId } : {}),
          ...(callId ? { callId } : {}),
          runId: root,
          error: bounded.text,
          errorChars: bounded.chars,
          truncated: bounded.truncated,
        });
      }
    }
    const rows = ((data.workflowChildren as Record<string, unknown>)?.children ?? data.results) as unknown;
    if (!Array.isArray(rows)) return;
    for (const [index, row] of rows.slice(0, 64).entries()) {
      if (!row || typeof row !== "object") continue;
      const typed = row as Record<string, unknown>;
      const status = String(typed.state ?? typed.status ?? "");
      const failed = Boolean(typed.error) || typed.timedOut === true || (Number.isInteger(typed.exitCode) && typed.exitCode !== 0) || ["failed", "rejected"].includes(status);
      if (!failed) continue;
      const childKey = `${(typed.runId ?? root) as string}:${typed.runId ? 0 : ((typed.workflowKey ?? typed.childId ?? typed.index ?? index) as string | number)}`;
      const evidence = childEvidence.get(childKey);
      const reason = evidence?.outcomeReason;
      const raw = childFailureExcerpt(
        String(typed.error ?? typed.errorMessage ?? (typed.timedOut ? "Child timed out" : "Child failed")),
        { reason, cause: (evidence as { cause?: unknown } | undefined)?.cause, timedOut: typed.timedOut, exitCode: typed.exitCode },
      ).slice(0, 16000);
      const classification = failureCategory(typeof reason === "string" && Object.hasOwn(reasonText, reason) ? reasonText[reason] : raw);
      const bounded = boundText(raw, errorChars);
      const statusCode = statusCodeOf(raw);
      const modelText = typeof typed.model === "string" ? (typed.model as string).slice(0, 240) : undefined;
      const slash = modelText?.indexOf("/") ?? -1;
      const backend = typeof typed.backend === "string" ? (typed.backend as string).slice(0, 80) : undefined;
      const ledger = typeof typed.runId === "string" ? ledgerByRun.get(typed.runId) : undefined;
      const launchArgs = (spawnArgs.get(root) ?? (typeof typed.runId === "string" ? spawnArgs.get(typed.runId) : undefined)) as Record<string, unknown> | undefined;
      // Agent name: canonical ledger first, then launch args (tasks[i]
      // positionally for parallel launches, else the single-launch agent).
      const childPos = Number(childKey.slice(childKey.lastIndexOf(":") + 1));
      const positionalAgent = Array.isArray(launchArgs?.tasks) && Number.isInteger(childPos) && childPos >= 0
        ? ((launchArgs?.tasks as unknown[])[childPos] as Record<string, unknown> | undefined)?.agent
        : undefined;
      const agent = ledger?.agent
        ?? (typeof positionalAgent === "string" && positionalAgent ? positionalAgent.slice(0, 80) : undefined)
        ?? (!launchArgs?.tasks && typeof launchArgs?.agent === "string" && launchArgs.agent ? (launchArgs.agent as string).slice(0, 80) : undefined);
      const payloadFlag = { truncated: false };
      const payload =
        launchArgs && typeof launchArgs === "object"
          ? boundValue(
              Object.fromEntries(["agent", "model", "thinking", "backend", "task"].filter((field) => launchArgs[field] !== undefined).map((field) => [field, launchArgs[field]])),
              "",
              0,
              payloadFlag,
            )
          : undefined;
      const attempts = Number.isSafeInteger(evidence?.attemptCount) && (evidence?.attemptCount as number) >= 0 ? (evidence?.attemptCount as number) : undefined;
      const outputPresence = ["present", "absent", "unknown"].includes(evidence?.output as string) ? (evidence?.output as string) : undefined;
      const noCause = !typed.error && !typed.errorMessage && !typed.timedOut && typed.exitCode === undefined && !ledger && !status;
      push(order, `child:${childKey}:${raw.toLowerCase().slice(0, 120)}`, {
        incident: incidentId(classification.category, raw, childKey),
        signature: errorSignature("child", "subagent", classification.category, raw),
        kind: "child",
        tool: "subagent",
        module: `agent/extensions/pi-subagents (${backend ?? ledger?.backend ?? "native"}${modelText ?? ledger?.route ? ` · ${modelText ?? ledger?.route}` : ""})`,
        category: classification.category,
        recovery: classification.recovery,
        why: noCause
          ? `child ${childKey}${agent ? ` (${agent})` : ""} failed with no recorded cause (${classification.category}); inspect the run ledger; ${classification.recovery}`
          : `child ${childKey}${agent ? ` (${agent})` : ""} failed${ledger ? ` [${ledger.execution} / acceptance ${ledger.acceptance}]` : status ? ` (${status})` : ""} (${classification.category}); ${classification.recovery}`,
        ...(timestamp ? { timestamp } : {}),
        ...(entryId ? { entryId } : {}),
        ...(callId ? { callId } : {}),
        runId: String(typed.runId ?? root).slice(0, 80),
        ...(agent ? { agent } : {}),
        ...(slash > 0 && modelText ? { provider: modelText.slice(0, slash).slice(0, 80), model: modelText.slice(slash + 1).slice(0, 160) } : modelText ? { model: modelText.slice(0, 160) } : {}),
        ...(backend ?? ledger?.backend ? { backend: (backend ?? ledger?.backend as string).slice(0, 80) } : {}),
        ...(modelText ?? ledger?.route ? { route: (modelText ?? ledger?.route as string).slice(0, 240) } : {}),
        ...(statusCode ? { statusCode } : {}),
        ...(Number.isInteger(typed.exitCode) ? { exitCode: typed.exitCode as number } : {}),
        ...(attempts !== undefined ? { attempts } : {}),
        ...(outputPresence ? { outputPresence } : {}),
        ...(usageOf(typed.usage) ? { usage: usageOf(typed.usage) } : {}),
        error: bounded.text,
        errorChars: bounded.chars,
        truncated: bounded.truncated,
        ...(payload !== undefined ? { payload, ...(payloadFlag.truncated ? { payloadTruncated: true as const } : {}) } : {}),
        ...(evidence ? { details: boundValue(evidence) } : {}),
        ...(ledger ? { execution: ledger.execution.slice(0, 200), acceptance: ledger.acceptance.slice(0, 200) } : {}),
      });
    }
  });

  const all = [...found.values()].sort((a, b) => b.order - a.order);
  const groups = new Map<string, { kind: string; tool: string; category: string; count: number }>();
  const byKind: Record<string, number> = {};
  const signatures = new Map<string, {
    signature: string; count: number; kind: string; tool: string; category: string;
    module: string; recovery: string; firstEntry: number; lastEntry: number;
    exampleIncident: string; preceding: Map<string, number>;
  }>();
  for (const item of all) {
    byKind[item.error.kind] = (byKind[item.error.kind] ?? 0) + 1;
    const key = JSON.stringify([item.error.kind, item.error.tool, item.error.category]);
    const group = groups.get(key) ?? { kind: item.error.kind, tool: item.error.tool, category: item.error.category, count: 0 };
    group.count++;
    groups.set(key, group);
    // Same normalized cause across linkages counts once here, over the full
    // window (not the shown limit), with preceding-tool co-occurrence.
    const sig = signatures.get(item.error.signature) ?? {
      signature: item.error.signature, count: 0, kind: item.error.kind, tool: item.error.tool,
      category: item.error.category, module: item.error.module, recovery: item.error.recovery,
      firstEntry: item.order + 1, lastEntry: item.order + 1,
      exampleIncident: item.error.incident, preceding: new Map<string, number>(),
    };
    sig.count++;
    sig.firstEntry = Math.min(sig.firstEntry, item.order + 1);
    sig.lastEntry = Math.max(sig.lastEntry, item.order + 1);
    for (const tool of item.preceding.slice(0, 5)) sig.preceding.set(tool, (sig.preceding.get(tool) ?? 0) + 1);
    signatures.set(item.error.signature, sig);
  }
  const signatureRows = [...signatures.values()]
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))
    .slice(0, 16)
    .map((sig) => ({
      signature: sig.signature, count: sig.count, kind: sig.kind, tool: sig.tool,
      category: sig.category, module: sig.module, recovery: sig.recovery,
      firstEntry: sig.firstEntry, lastEntry: sig.lastEntry, exampleIncident: sig.exampleIncident,
      precedingTools: [...sig.preceding.entries()]
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
        .slice(0, 6),
    }));
  const errors = all.slice(0, limit).map((item, index) => ({ ...item.error, seq: index + 1 }));

  let hookErrors: SessionErrorsReport["hookErrors"] = [];
  try {
    const metrics = collectSessionMetrics(entries);
    hookErrors = Object.entries(metrics.hooks ?? {})
      .filter(([, value]) => ((value as { errors?: number }).errors ?? 0) > 0)
      .map(([key, value]) => {
        const typed = value as { calls?: number; errors?: number; ms?: number };
        const cut = key.lastIndexOf(":");
        return {
          hook: key.slice(cut + 1).slice(0, 120),
          owner: key.slice(0, Math.max(0, cut)).slice(0, 200),
          calls: FINITE(typed.calls) ?? 0,
          errors: FINITE(typed.errors) ?? 0,
          ms: Math.round(FINITE(typed.ms) ?? 0),
        };
      })
      .sort((a, b) => b.errors - a.errors || b.ms - a.ms)
      .slice(0, 24);
  } catch {
    hookErrors = [];
  }

  return {
    inspected: entries.length,
    truncated: Array.isArray(allEntries) && allEntries.length > entries.length,
    total: all.length,
    omitted: Math.max(0, all.length - errors.length),
    limit,
    errors,
    groups: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 16),
    omittedGroups: Math.max(0, groups.size - 16),
    signatures: signatureRows,
    omittedSignatures: Math.max(0, signatures.size - 16),
    byKind,
    hookErrors,
    scope: "Newest failures within the last 2000 branch entries; hook rows are telemetry summaries without excerpts. Records sharing one incident id are one incident — the same stable id /metrics shows. Signatures dedup one recurring cause across linkages over the full window with preceding-tool co-occurrence. Missing payload or usage stays absent, never guessed.",
  };
}

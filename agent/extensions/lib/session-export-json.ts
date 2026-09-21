// Pure builder for the local /export-json diagnostics archive.
//
// The stock /export path is redacted for sharing (scripts/compatibility/legacy-transforms/
// export-redaction.mjs): reasoning, tool I/O, images and harness metadata
// never leave the machine there. This builder is the opposite contract: a
// LOCAL-ONLY, unredacted, machine-sortable JSON archive of one session for
// debugging the harness itself — thinking, tool calls/results with errors,
// per-response provider/API records, user prompts, intercession signals
// (reminders, follow-ups, background notifications), model/thinking changes,
// compactions and harness ledger entries.
//
// No pi imports, no I/O. The extension owns arg parsing and file writing;
// scripts/bench/session-export-json-test.mjs owns the contract tests.
import { createHash } from "node:crypto";
import { collectSessionMetrics } from "./session-metrics.ts";
import { collectSessionDiagnostics, failureCategory } from "./session-diagnostics.ts";
import { collectSessionErrors } from "./session-errors.ts";
import { collectSessionCost } from "./session-cost.ts";
import type { ActivityCounters } from "./activity-indicators.ts";
import { reduceChildEvents, projectTranscriptChildren, summarizeLedger, childTaskToEvidence } from "../pi-subagents/src/runs/shared/child-ledger.ts";

/** Latest context-injection envelopes from the live bridge (best-effort, no I/O). */
function readInjectionBridge(): unknown[] {
  try {
    const bridge = (globalThis as Record<symbol, { last?: unknown[] }>)[Symbol.for("yunus-pi.context-injection.v1")];
    const last = Array.isArray(bridge?.last) ? bridge.last : [];
    return last.filter((entry) => entry && typeof entry === "object").slice(-8).map((entry) => {
      const record = entry as Record<string, unknown>;
      return {
        owner: typeof record.owner === "string" ? record.owner.slice(0, 80) : "unknown",
        hash: typeof record.hash === "string" ? record.hash.slice(0, 32) : "unknown",
        sourceRevision: typeof record.sourceRevision === "string" ? record.sourceRevision.slice(0, 128) : "unknown",
        estimatedTokens: typeof record.estimatedTokens === "number" ? record.estimatedTokens : 0,
        materiallyNew: record.materiallyNew === true,
        placement: record.placement === "late-bound" ? "late-bound" : "stable-prefix",
      };
    });
  } catch {
    return [];
  }
}
import { classifyCostState } from "./cost-states.ts";
import type { RuntimeProvenance } from "./diagnostic-provenance.ts";

export const SESSION_EXPORT_JSON_VERSION = 1;
export const SESSION_EXPORT_JSON_FORMAT = "yunuspi-session-export-json";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
};

const thinkingOf = (content: unknown): string[] => {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === "thinking" && typeof part.thinking === "string")
    .map((part) => part.thinking);
};

const toolCallsOf = (content: unknown): any[] => {
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part?.type === "toolCall");
};

const capped = (value: string, limit: number): { text: string; truncated: boolean } =>
  value.length > limit
    ? { text: value.slice(0, limit), truncated: true }
    : { text: value, truncated: false };

// Normalized rows carry bounded scan-friendly fields; full bytes stay on `raw`.
const PREVIEW_LIMIT = 4000;
const THINKING_LIMIT = 8000;

const timestampMsOf = (entry: any): number | null => {
  const parsed = Date.parse(entry?.timestamp);
  if (Number.isFinite(parsed)) return parsed;
  const fallback = entry?.message?.timestamp;
  return isFiniteNumber(fallback) ? fallback : null;
};

const routeOf = (provider: unknown, model: unknown): string =>
  `${provider ?? "unknown"}/${model ?? "unknown"}`.slice(0, 160);

// Area root of a touched path for the workdirs rollup: first two segments
// for relative paths, last two directory segments for absolute ones
// (top-level system prefixes carry no project signal).
const fileRoot = (file: string): string | null => {
  const clean = file.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const segments = clean.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const root = clean.startsWith("/") ? segments.slice(-3, -1).join("/") : segments.slice(0, 2).join("/");
  return root && root.length <= 120 ? root : null;
};

const stableArgsKey = (name: unknown, args: unknown): string | null => {
  if (typeof name !== "string" || !args || typeof args !== "object") return null;
  try {
    const json = JSON.stringify([name, args]);
    if (json.length > 16384) return null;
    return createHash("sha256").update(json).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
};

export interface SessionJsonExportInput {
  header: any;
  sessionFile?: string | null;
  leafId?: string | null;
  cwd?: string | null;
  scope: "branch" | "all";
  /** Current-branch entries in tree order (the default export window). */
  branch: any[];
  /** All retained entries (metrics/diagnostics denominator + `--all` window). */
  retained: any[];
  model?: { provider?: string; id?: string; routing?: unknown; endpoint?: string } | null;
  thinkingLevel?: string | null;
  exportedAt?: string;
  includeRaw?: boolean;
  /** Live control-plane shadow rollup at export time (null when unavailable). */
  controlPlaneShadow?: { at: number; sources: Record<string, unknown> } | null;
  /** Live harness-activity counters at export time (null when unavailable). */
  activity?: ActivityCounters | null;
  /** Stable harness/runtime provenance, collected by the extension (no I/O here). */
  provenance?: RuntimeProvenance | null;
}

function normalizeEvent(entry: any, seq: number, includeRaw: boolean): any {
  const base: any = {
    seq,
    id: entry?.id ?? null,
    parentId: entry?.parentId ?? null,
    timestamp: entry?.timestamp ?? null,
    timestampMs: timestampMsOf(entry),
  };
  const message = entry?.type === "message" ? entry.message : undefined;
  if (message && typeof message === "object") {
    if (message.role === "user") {
      const text = textOf(message.content);
      const preview = capped(text, PREVIEW_LIMIT);
      return {
        ...base, kind: "user", chars: text.length,
        text: preview.text, textTruncated: preview.truncated,
        ...(includeRaw ? { raw: entry } : {}),
      };
    }
    if (message.role === "assistant") {
      const thinking = thinkingOf(message.content);
      const text = textOf(message.content);
      const calls = toolCallsOf(message.content).map((call) => ({
        id: call?.id ?? null,
        name: call?.name ?? null,
        arguments: call?.arguments ?? null,
      }));
      const thinkingChars = thinking.reduce((sum, block) => sum + block.length, 0);
      const preview = capped(text, PREVIEW_LIMIT);
      return {
        ...base,
        kind: "assistant",
        provider: message.provider ?? null,
        model: message.model ?? null,
        route: routeOf(message.provider, message.model),
        api: message.api ?? null,
        stopReason: message.stopReason ?? null,
        rawStopReason: (message as any).rawStopReason ?? null,
        responseId: (message as any).responseId ?? null,
        errorMessage: typeof (message as any).errorMessage === "string"
          ? (message as any).errorMessage.slice(0, PREVIEW_LIMIT)
          : null,
        usage: message.usage ?? null,
        thinkingBlocks: thinking.length,
        thinkingChars,
        thinking: thinking.map((block) => capped(block, THINKING_LIMIT)),
        textChars: text.length,
        text: preview.text,
        textTruncated: preview.truncated,
        toolCalls: calls,
        ...(includeRaw ? { raw: entry } : {}),
      };
    }
    if (message.role === "toolResult") {
      const text = textOf(message.content);
      const preview = capped(text, PREVIEW_LIMIT);
      const failed = message.isError === true;
      const classification = failed
        ? failureCategory(text.slice(0, 16000))
        : { category: "ok", recovery: "" };
      return {
        ...base,
        kind: "tool_result",
        toolName: message.toolName ?? "unknown",
        toolCallId: message.toolCallId ?? null,
        isError: failed,
        category: classification.category,
        ...(failed ? { recovery: classification.recovery } : {}),
        chars: text.length,
        text: preview.text,
        textTruncated: preview.truncated,
        details: message.details ?? null,
        ...(includeRaw ? { raw: entry } : {}),
      };
    }
    return { ...base, kind: "message", role: message.role ?? null, ...(includeRaw ? { raw: entry } : {}) };
  }
  if (entry?.type === "custom_message") {
    const text = textOf(entry.content);
    const preview = capped(text, PREVIEW_LIMIT);
    return {
      ...base, kind: "signal", customType: entry.customType ?? null,
      display: entry.display ?? null, chars: text.length,
      text: preview.text, textTruncated: preview.truncated,
      details: entry.details ?? null,
      ...(includeRaw ? { raw: entry } : {}),
    };
  }
  if (entry?.type === "custom") {
    const data = entry.data;
    const event: any = {
      ...base, kind: "harness", customType: entry.customType ?? null,
      dataKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 64) : [],
      ...(includeRaw ? { raw: entry } : {}),
    };
    // Selection-boundary records pair each used route with its thinking
    // level and OpenRouter backend routing. Parsed here so route analytics
    // below can attribute configuration without re-reading raw entries.
    if (entry.customType === "model-config-v1" && data && typeof data === "object") {
      if (typeof data.route === "string" && data.route.trim()) event.route = data.route.trim().slice(0, 160);
      if (typeof data.thinking === "string" && data.thinking.trim()) event.thinking = data.thinking.trim().slice(0, 16);
      if (data.openRouterRouting && typeof data.openRouterRouting === "object" && !Array.isArray(data.openRouterRouting)) {
        try {
          const text = JSON.stringify(data.openRouterRouting);
          if (text.length <= 1024) event.routing = JSON.parse(text);
        } catch { /* unserializable routing stays on raw */ }
      }
      if (typeof data.recoveryEndpointName === "string" && data.recoveryEndpointName.trim()) {
        event.endpoint = data.recoveryEndpointName.trim().slice(0, 160);
      }
    }
    return event;
  }
  if (entry?.type === "model_change") {
    return {
      ...base, kind: "model_change",
      provider: entry.provider ?? null, modelId: entry.modelId ?? null,
      ...(includeRaw ? { raw: entry } : {}),
    };
  }
  if (entry?.type === "thinking_level_change") {
    return {
      ...base, kind: "thinking_level_change",
      thinkingLevel: entry.thinkingLevel ?? null,
      ...(includeRaw ? { raw: entry } : {}),
    };
  }
  if (entry?.type === "compaction" || entry?.type === "branch_summary") {
    return {
      ...base, kind: entry.type,
      summaryChars: typeof entry.summary === "string" ? entry.summary.length : 0,
      usage: entry.usage ?? null,
      ...(includeRaw ? { raw: entry } : {}),
    };
  }
  if (entry?.type === "session_info" || entry?.type === "label") {
    const labelText = entry?.type === "label" && typeof (entry.label ?? entry.text) === "string"
      ? String(entry.label ?? entry.text).slice(0, 300)
      : null;
    return { ...base, kind: entry.type, ...(labelText ? { label: labelText } : {}), ...(includeRaw ? { raw: entry } : {}) };
  }
  return { ...base, kind: entry?.type ?? "unknown", ...(includeRaw ? { raw: entry } : {}) };
}

export function buildSessionJsonExport(input: SessionJsonExportInput): any {
  const includeRaw = input.includeRaw !== false;
  const branch = Array.isArray(input.branch) ? input.branch : [];
  const retained = Array.isArray(input.retained) ? input.retained : branch;
  const entries = input.scope === "all" ? retained : branch;
  const events = entries.map((entry, seq) => normalizeEvent(entry, seq, includeRaw));

  const tools = new Map<string, any>();
  const ensureTool = (name: string) => {
    const row = tools.get(name) ?? {
      tool: name, calls: 0, results: 0, errors: 0,
      chars: 0, largest: 0, largestSeq: null as number | null,
    };
    tools.set(name, row);
    return row;
  };
  const repeats = new Map<string, { tool: string; count: number; callIds: string[] }>();
  const routes = new Map<string, any>();
  const ensureRoute = (route: string) => {
    const row = routes.get(route) ?? {
      route, turns: 0, input: 0, output: 0, cacheRead: 0,
      cacheWrite: 0, reasoning: 0, errors: 0,
      thinkingLevels: [] as string[], routingPins: [] as unknown[], endpoints: [] as string[],
      firstSeq: null as number | null, lastSeq: null as number | null,
    };
    routes.set(route, row);
    return row;
  };
  const thinkingByModel = new Map<string, { route: string; blocks: number; chars: number }>();
  const stopReasons: Record<string, number> = {};
  const signals: Record<string, number> = {};
  const harnessRecords: Record<string, number> = {};
  const modelTrail: any[] = [];
  const userTurns: any[] = [];

  let userTurnCount = 0, assistantTurns = 0, toolCalls = 0, toolResults = 0;
  let toolErrors = 0, modelErrors = 0, thinkingBlocks = 0, thinkingChars = 0;
  let compactions = 0, modelChanges = 0, thinkingChanges = 0;
  let turnsWithToolUse = 0, maxCallsInTurn = 0, burstTurns = 0;
  let assistantTextChars = 0, resultChars = 0, userChars = 0;
  let lastLabel: string | null = null;
  const bashCwds = new Set<string>();
  const fileRoots = new Map<string, number>();
  let largestThinking: { seq: number; id: string | null; chars: number; excerpt: string } | null = null;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

  for (const event of events) {
    if (event.kind === "user") {
      userTurnCount++;
      userChars += event.chars ?? 0;
      userTurns.push({
        seq: event.seq, id: event.id, timestamp: event.timestamp,
        chars: event.chars, preview: String(event.text ?? "").slice(0, 300),
      });
    } else if (event.kind === "assistant") {
      assistantTurns++;
      assistantTextChars += event.textChars ?? 0;
      const callCount = (event.toolCalls ?? []).length;
      if (callCount > 0) {
        turnsWithToolUse++;
        maxCallsInTurn = Math.max(maxCallsInTurn, callCount);
        if (callCount >= 5) burstTurns++;
      }
      const stop = event.stopReason ?? "unknown";
      stopReasons[stop] = (stopReasons[stop] ?? 0) + 1;
      if (stop === "error") modelErrors++;
      const usage = event.usage;
      if (usage && typeof usage === "object") {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
          if (isFiniteNumber(usage[key]) && usage[key] >= 0) tokens[key] += usage[key];
        }
        const row = ensureRoute(event.route);
        row.turns++;
        if (row.firstSeq === null) row.firstSeq = event.seq;
        row.lastSeq = event.seq;
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
          if (isFiniteNumber(usage[key]) && usage[key] >= 0) row[key] += usage[key];
        }
        if (stop === "error") row.errors++;
      }
      thinkingBlocks += event.thinkingBlocks;
      thinkingChars += event.thinkingChars;
      if (event.thinkingBlocks > 0) {
        const row = thinkingByModel.get(event.route) ?? { route: event.route, blocks: 0, chars: 0 };
        row.blocks += event.thinkingBlocks;
        row.chars += event.thinkingChars;
        thinkingByModel.set(event.route, row);
      }
      if (event.thinkingChars > (largestThinking?.chars ?? -1) && event.thinkingChars > 0) {
        const first = event.thinking?.[0]?.text ?? "";
        largestThinking = {
          seq: event.seq, id: event.id, chars: event.thinkingChars,
          excerpt: String(first).slice(0, 300),
        };
      }
      for (const call of event.toolCalls ?? []) {
        toolCalls++;
        ensureTool(call?.name ?? "unknown").calls++;
        const key = stableArgsKey(call?.name, call?.arguments);
        if (key && typeof call?.id === "string") {
          const group = repeats.get(key) ?? { tool: call.name, count: 0, callIds: [] };
          group.count++;
          if (group.callIds.length < 10) group.callIds.push(call.id);
          repeats.set(key, group);
        }
        const callArgs = call?.arguments;
        if (callArgs && typeof callArgs === "object") {
          const record = callArgs as Record<string, unknown>;
          if ((call?.name === "bash" || call?.name === "process") && typeof record.cwd === "string" && record.cwd && bashCwds.size < 16) {
            bashCwds.add(record.cwd.slice(0, 256));
          }
          const file = record.path ?? record.file_path ?? record.file;
          if (typeof file === "string" && file) {
            const root = fileRoot(file);
            if (root && (fileRoots.has(root) || fileRoots.size < 32)) fileRoots.set(root, (fileRoots.get(root) ?? 0) + 1);
          }
        }
      }
    } else if (event.kind === "tool_result") {
      toolResults++;
      resultChars += event.chars ?? 0;
      const row = ensureTool(event.toolName);
      row.results++;
      row.chars += event.chars;
      if (event.chars > row.largest) {
        row.largest = event.chars;
        row.largestSeq = event.seq;
      }
      if (event.isError) {
        toolErrors++;
        row.errors++;
      }
    } else if (event.kind === "label") {
      if (typeof event.label === "string" && event.label) lastLabel = event.label;
    } else if (event.kind === "signal") {
      const key = event.customType ?? "unknown";
      signals[key] = (signals[key] ?? 0) + 1;
    } else if (event.kind === "harness") {
      const key = event.customType ?? "unknown";
      harnessRecords[key] = (harnessRecords[key] ?? 0) + 1;
      if (key === "model-config-v1" && typeof event.route === "string" && event.route) {
        const row = ensureRoute(event.route);
        if (typeof event.thinking === "string" && event.thinking && !row.thinkingLevels.includes(event.thinking)) {
          row.thinkingLevels.push(event.thinking);
        }
        if (event.routing && typeof event.routing === "object") {
          const text = JSON.stringify(event.routing);
          if (!row.routingPins.some((pin: unknown) => JSON.stringify(pin) === text)) row.routingPins.push(event.routing);
        }
        if (typeof event.endpoint === "string" && event.endpoint && !row.endpoints.includes(event.endpoint)) {
          row.endpoints.push(event.endpoint);
        }
      }
    } else if (event.kind === "model_change") {
      modelChanges++;
      modelTrail.push({
        seq: event.seq, timestamp: event.timestamp, kind: "model_change",
        provider: event.provider, modelId: event.modelId,
      });
    } else if (event.kind === "thinking_level_change") {
      thinkingChanges++;
      modelTrail.push({
        seq: event.seq, timestamp: event.timestamp, kind: "thinking_level_change",
        thinkingLevel: event.thinkingLevel,
      });
    } else if (event.kind === "compaction") {
      compactions++;
    }
  }

  const toolRows = [...tools.values()]
    .map((row) => ({
      ...row,
      avgChars: row.results ? Math.round(row.chars / row.results) : 0,
      errorRate: row.results ? row.errors / row.results : 0,
    }))
    .sort((a, b) => b.calls - a.calls || b.results - a.results || a.tool.localeCompare(b.tool));
  const repeatRows = [...repeats.values()]
    .filter((group) => group.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
  const routeRows = [...routes.values()].sort((a, b) => b.turns - a.turns);
  const thinkingRows = [...thinkingByModel.values()].sort((a, b) => b.chars - a.chars);

  // Accounting collectors assume well-formed rows (true for real session
  // files); malformed rows still appear as events, never in aggregates.
  const accounted = entries.filter((entry) => entry && typeof entry === "object");
  const diagnostics = collectSessionDiagnostics(accounted);
  const metrics = collectSessionMetrics(accounted);
  const cost = collectSessionCost(accounted);
  // Normalized sections: the same canonical reducers every surface reads.
  // Raw events stay below for forensics; debugging operates on these.
  const childLedger = reduceChildEvents(projectTranscriptChildren(accounted));
  const childSummary = summarizeLedger(childLedger);
  // Error rollup for the normal export: counts plus top recurring
  // signatures — the same dedup /errors shows, not per-error depth.
  const errorReport = collectSessionErrors(accounted, { limit: 5, ledgerTasks: childLedger.tasks });
  const costState = classifyCostState({
    reported: cost?.reported ?? 0,
    estimated: cost?.estimated ?? 0,
    unknown: cost?.unknown === true,
    subscription: (cost as any)?.subscription === true,
    seen: (cost as any)?.seen === true,
    estimatedUsage: (cost as any)?.estimatedUsage === true,
    pending: cost?.pending ?? 0,
  });
  const todoSnapshots: any[] = [];
  const reviewRounds: any[] = [];
  const skillLedger: { read: string[]; partial: string[]; suggested: string[] } = {
    read: Array.isArray((metrics as any)?.skillsRead) ? [...(metrics as any).skillsRead] : [],
    partial: Array.isArray((metrics as any)?.skillsPartial) ? [...(metrics as any).skillsPartial] : [],
    suggested: Array.isArray((metrics as any)?.skillsRouted) ? [...(metrics as any).skillsRouted] : [],
  };
  for (const entry of accounted) {
    const message = (entry as any)?.type === "message" ? (entry as any).message : undefined;
    if (message?.role === "toolResult" && message.toolName === "todo" && message.details?.tasks && todoSnapshots.length < 4) {
      todoSnapshots.push({
        action: message.details.action ?? null,
        tasks: (message.details.tasks ?? []).slice(0, 64).map((task: any) => ({
          id: task?.id ?? null,
          status: task?.status ?? null,
          owner: task?.owner ?? null,
          execution: task?.execution ?? null,
          refs: Array.isArray(task?.refs) ? task.refs.slice(0, 32) : [],
          runId: task?.runId ?? null,
        })),
        nextId: message.details.nextId ?? null,
      });
    }
    if ((entry as any)?.type === "custom" && (entry as any)?.customType === "quality-review-v1" && reviewRounds.length < 16) {
      const data = (entry as any)?.data ?? {};
      reviewRounds.push({
        rounds: data.rounds ?? null,
        disposition: data.disposition ?? null,
        evidenceIds: Array.isArray(data.evidenceIds) ? data.evidenceIds.slice(0, 128) : [],
        coverage: data.coverage ?? "unknown",
      });
    }
  }
  const buildNormalized = (costSummary: any) => ({
    children: {
      summary: childSummary,
      tasks: childLedger.tasks.map((task) => ({
        taskId: task.taskId,
        label: task.label,
        agent: task.agent ?? null,
        todoId: task.todoId ?? null,
        scopeId: task.scopeId ?? null,
        state: task.state,
        execution: task.execution.status,
        executionCause: task.execution.cause?.category ?? null,
        acceptance: task.acceptance.status,
        attempts: task.attempts.length,
        evidence: childTaskToEvidence(task),
      })),
      unresolved: childLedger.unresolved,
    },
    attempts: childLedger.tasks.flatMap((task) => task.attempts.map((attempt) => ({
      taskId: task.taskId,
      attempt: attempt.attempt,
      runId: attempt.runId ?? null,
      agent: attempt.agent ?? null,
      route: attempt.route ?? null,
      backend: attempt.backend ?? null,
      state: attempt.state,
      execution: attempt.execution.status,
      cause: attempt.execution.cause?.category ?? null,
      truncation: attempt.execution.cause?.truncation ?? "none",
      acceptance: attempt.acceptance.status,
    }))).slice(0, 512),
    routes: routeRows,
    failures: {
      groups: diagnostics?.groups ?? [],
      causes: childLedger.tasks.flatMap((task) => task.attempts
        .filter((attempt) => attempt.execution.cause && attempt.execution.cause.category !== "none")
        .map((attempt) => ({
          taskId: task.taskId,
          attempt: attempt.attempt,
          stage: attempt.execution.cause!.stage,
          category: attempt.execution.cause!.category,
          retryable: attempt.execution.cause!.retryable,
          deterministicShape: attempt.execution.cause!.deterministicShape,
        }))).slice(0, 256),
    },
    todos: todoSnapshots,
    skills: skillLedger,
    microIntel: {
      jev: (metrics as any)?.jev ?? null,
      note: "per-helper usefulness lives in the micro-intelligence ledger when present",
    },
    hooks: (metrics as any)?.hooks ?? {},
    cost: { ...costSummary, state: costState },
    context: {
      tokens,
      cacheRate: (metrics as any)?.cacheRate ?? null,
      compactions,
      invalidationTurns: (metrics as any)?.invalidationTurns ?? 0,
      invalidationExcessTokens: (metrics as any)?.invalidationExcessTokens ?? 0,
      injections: readInjectionBridge(),
    },
    reviews: reviewRounds,
  });
  const costSummary = {
    total: cost?.formatted ?? null,
    reported: cost?.reported ?? null,
    estimated: cost?.estimated ?? null,
    unknown: cost?.unknown ?? true,
    pending: cost?.pending ?? 0,
    rows: Array.isArray(cost?.rows)
      ? cost.rows.map((row: any) => ({
        scope: row?.scope ?? null,
        route: row?.route ?? null,
        usd: (row?.reported ?? 0) + (row?.estimated ?? 0),
        estimatedUsage: row?.estimatedUsage ?? false,
        unknown: row?.unknown ?? false,
        subscription: row?.subscription ?? false,
      }))
      : [],
  };

  const normalized = buildNormalized(costSummary);

  return {
    format: SESSION_EXPORT_JSON_FORMAT,
    version: SESSION_EXPORT_JSON_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    provenance: input.provenance ?? null,
    normalized,
    notice:
      "Local diagnostics archive: unredacted prompts, reasoning, tool I/O and harness metadata. " +
      "Never share or publish; it may contain secrets. Request payloads are not persisted by pi — " +
      "API traffic here is response-side records (provider/model/api/usage/stopReason per assistant turn).",
    session: {
      id: input.header?.id ?? null,
      file: input.sessionFile ?? null,
      leafId: input.leafId ?? null,
      label: lastLabel,
      cwd: input.cwd ?? input.header?.cwd ?? null,
      startedAt: input.header?.timestamp ?? null,
      parentSession: input.header?.parentSession ?? null,
      scope: input.scope,
      branchEntries: branch.length,
      retainedEntries: retained.length,
      exportedEntries: entries.length,
      currentModel: input.model ? {
        provider: input.model.provider ?? null, id: input.model.id ?? null,
        ...(input.model.routing && typeof input.model.routing === "object" ? { routing: input.model.routing } : {}),
        ...(typeof input.model.endpoint === "string" && input.model.endpoint ? { endpoint: input.model.endpoint.slice(0, 160) } : {}),
      } : null,
      currentThinkingLevel: input.thinkingLevel ?? null,
    },
    summary: {
      userTurns: userTurnCount,
      assistantTurns,
      toolCalls,
      toolResults,
      toolErrors,
      modelErrors,
      thinkingBlocks,
      thinkingChars,
      modelChanges,
      thinkingChanges,
      compactions,
      modelsUsed: routeRows.length,
      tokens,
      cost: costSummary,
      stopReasons,
      signals,
      harnessRecords,
      childFailures: diagnostics?.activity?.childFailures ?? 0,
      uniqueIncidents: diagnostics?.uniqueIncidents ?? 0,
    },
    analytics: {
      tools: toolRows,
      thinking: {
        blocks: thinkingBlocks,
        chars: thinkingChars,
        avgChars: thinkingBlocks ? Math.round(thinkingChars / thinkingBlocks) : 0,
        largest: largestThinking,
        byModel: thinkingRows,
      },
      routes: routeRows,
      repeats: repeatRows,
      failureGroups: diagnostics?.groups ?? [],
      communication: {
        userTurns: userTurnCount,
        assistantTurns,
        turnsWithToolUse,
        avgCallsPerToolTurn: turnsWithToolUse ? Math.round((toolCalls / turnsWithToolUse) * 100) / 100 : 0,
        maxCallsInTurn,
        burstTurns,
        userChars,
        assistantTextChars,
        resultChars,
      },
      topic: {
        label: lastLabel,
        firstPrompt: userTurns[0]?.preview ?? null,
        promptChars: userChars,
      },
      workdirs: {
        sessionCwd: input.cwd ?? input.header?.cwd ?? null,
        bashCwds: [...bashCwds].sort(),
        fileRoots: [...fileRoots.entries()]
          .map(([root, count]) => ({ root, count }))
          .sort((a, b) => b.count - a.count || a.root.localeCompare(b.root))
          .slice(0, 16),
      },
      errorSummary: {
        toolErrors,
        modelErrors,
        childFailures: diagnostics?.activity?.childFailures ?? 0,
        uniqueIncidents: diagnostics?.uniqueIncidents ?? 0,
        byKind: errorReport.byKind,
        topSignatures: errorReport.signatures.slice(0, 8).map((sig) => ({
          ...sig,
          precedingTools: sig.precedingTools.slice(0, 5),
        })),
        omittedSignatures: errorReport.omittedSignatures + Math.max(0, errorReport.signatures.length - 8),
      },
    },
    modelTrail,
    userTurns,
    diagnostics,
    metrics,
    controlPlaneShadow: input.controlPlaneShadow ?? null,
    activity: input.activity ?? null,
    events,
  };
}

// Pure builder for the local /export-json diagnostics archive.
//
// The stock /export path is redacted for sharing (scripts/patches/
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
import { collectSessionCost } from "./session-cost.ts";

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
  model?: { provider?: string; id?: string } | null;
  thinkingLevel?: string | null;
  exportedAt?: string;
  includeRaw?: boolean;
  /** Live control-plane shadow rollup at export time (null when unavailable). */
  controlPlaneShadow?: { at: number; sources: Record<string, unknown> } | null;
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
    return {
      ...base, kind: "harness", customType: entry.customType ?? null,
      dataKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 64) : [],
      ...(includeRaw ? { raw: entry } : {}),
    };
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
    return { ...base, kind: entry.type, ...(includeRaw ? { raw: entry } : {}) };
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
  let largestThinking: { seq: number; id: string | null; chars: number; excerpt: string } | null = null;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

  for (const event of events) {
    if (event.kind === "user") {
      userTurnCount++;
      userTurns.push({
        seq: event.seq, id: event.id, timestamp: event.timestamp,
        chars: event.chars, preview: String(event.text ?? "").slice(0, 300),
      });
    } else if (event.kind === "assistant") {
      assistantTurns++;
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
      }
    } else if (event.kind === "tool_result") {
      toolResults++;
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
    } else if (event.kind === "signal") {
      const key = event.customType ?? "unknown";
      signals[key] = (signals[key] ?? 0) + 1;
    } else if (event.kind === "harness") {
      const key = event.customType ?? "unknown";
      harnessRecords[key] = (harnessRecords[key] ?? 0) + 1;
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

  return {
    format: SESSION_EXPORT_JSON_FORMAT,
    version: SESSION_EXPORT_JSON_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    notice:
      "Local diagnostics archive: unredacted prompts, reasoning, tool I/O and harness metadata. " +
      "Never share or publish; it may contain secrets. Request payloads are not persisted by pi — " +
      "API traffic here is response-side records (provider/model/api/usage/stopReason per assistant turn).",
    session: {
      id: input.header?.id ?? null,
      file: input.sessionFile ?? null,
      leafId: input.leafId ?? null,
      cwd: input.cwd ?? input.header?.cwd ?? null,
      startedAt: input.header?.timestamp ?? null,
      parentSession: input.header?.parentSession ?? null,
      scope: input.scope,
      branchEntries: branch.length,
      retainedEntries: retained.length,
      exportedEntries: entries.length,
      currentModel: input.model ? { provider: input.model.provider ?? null, id: input.model.id ?? null } : null,
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
    },
    modelTrail,
    userTurns,
    diagnostics,
    metrics,
    controlPlaneShadow: input.controlPlaneShadow ?? null,
    events,
  };
}

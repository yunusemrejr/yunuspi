/* PI_EXPORT_REDACTION_V2 */
function piRedactExportEntry(entry) {
  const pick = (value, keys) =>
    Object.fromEntries(
      keys.filter((k) => value?.[k] !== undefined).map((k) => [k, value[k]]),
    );
  const base = pick(entry, ["id", "parentId", "timestamp"]);
  if (entry?.type === "session")
    return {
      ...base,
      type: "session",
      version: entry.version,
      cwd: "[omitted]",
    };
  if (entry?.type === "model_change")
    return {
      ...base,
      type: entry.type,
      ...pick(entry, ["provider", "modelId"]),
    };
  if (entry?.type === "thinking_level_change")
    return { ...base, type: entry.type, thinkingLevel: entry.thinkingLevel };
  if (
    entry?.type !== "message" ||
    !["user", "assistant", "toolResult"].includes(entry.message?.role)
  ) {
    const safe = piRedactDiagnosticEntry(entry);
    if (safe) return { ...base, ...safe };
    // Includes extension data, bashExecution, summaries, retained tails and unknown future entries.
    return { ...base, type: "custom", customType: "export-redacted", data: {} };
  }
  const source = entry.message;
  const message = pick(source, [
    "role",
    "timestamp",
    "provider",
    "model",
    "api",
    "stopReason",
  ]);
  const blocks =
    typeof source.content === "string"
      ? [{ type: "text", text: source.content }]
      : (source.content ?? []);
  if (source.role === "toolResult") {
    Object.assign(message, pick(source, ["toolCallId", "toolName", "isError"]));
    message.content = [
      { type: "text", text: "[Tool output omitted from export]" },
    ];
  } else {
    message.content = blocks.flatMap((block) => {
      if (block.type === "text") return [{ type: "text", text: block.text }];
      if (block.type === "toolCall")
        return [
          { type: "toolCall", id: block.id, name: block.name, arguments: {} },
        ];
      return []; // Thinking, signatures, images and unknown content are never embedded.
    });
  }
  if (source.usage) {
    const numbers = (value, keys) =>
      Object.fromEntries(
        keys
          .filter(
            (k) =>
              typeof value?.[k] === "number" &&
              Number.isFinite(value[k]) &&
              value[k] >= 0,
          )
          .map((k) => [k, value[k]]),
      );
    message.usage = numbers(source.usage, [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "totalTokens",
      "reasoning",
    ]);
    message.usage.cost = numbers(source.usage.cost, [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
    ]);
    // Legacy zero plus a thinking block does not establish a measured zero.
    if (
      source.usage.reasoning === null ||
      (blocks.some((b) => b.type === "thinking") && !source.usage.reasoning)
    )
      message.usage.reasoning = null;
  }
  return { ...base, type: "message", message };
}
function piRedactDiagnosticEntry(entry) {
  if (entry?.type !== "custom" || typeof entry?.customType !== "string") return undefined;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const hex8 = (v) => (typeof v === "string" && /^[0-9a-f]{8}$/.test(v) ? v : undefined);
  const words = (v) => (typeof v === "string" && /^[a-z0-9_.:/-]{1,160}$/i.test(v) ? v : undefined);
  if (entry.customType === "session-metrics-v1") {
    const data = entry.data ?? {};
    const hooks = {};
    for (const [key, value] of Object.entries(data.hooks ?? {}).slice(0, 256)) {
      const name = words(key);
      if (!name || !value || typeof value !== "object") continue;
      const row = {};
      for (const field of ["calls", "errors", "ms", "changed", "removedChars", "addedChars", "charsChanged", "tokensChanged", "changedAt", "revision", "cacheAgeMs"]) {
        const n = num(value[field]);
        if (n !== undefined) row[field] = n;
      }
      for (const field of ["beforeHash", "afterHash", "semanticHash"]) {
        const h = hex8(value[field]);
        if (h !== undefined) row[field] = h;
      }
      hooks[name] = row;
    }
    const events = {};
    for (const field of ["swarms", "fusions", "recoveries", "aborted"]) {
      const n = num(data.events?.[field]);
      if (n !== undefined) events[field] = n;
    }
    return {
      type: "custom",
      customType: "session-metrics-v1",
      data: {
        ...(num(data.version) !== undefined ? { version: data.version } : {}),
        ...(typeof data.segment === "string" ? { segment: "[redacted]" } : {}),
        ...(num(data.startedAt) !== undefined ? { cacheAgeBasis: 0 } : {}),
        hooks,
        events,
      },
    };
  }
  if (entry.customType === "subagent-cost-v1" || entry.customType === "subagent-lifecycle-v1") {
    const data = entry.data ?? {};
    const rows = Array.isArray(data.results) ? data.results.slice(0, 64).map((row) => {
      if (!row || typeof row !== "object") return {};
      const out = {};
      for (const field of ["index", "status", "state", "exitCode", "attemptCount", "turns"]) {
        if (typeof row[field] === "string" && /^[a-z0-9_\-]{1,32}$/i.test(row[field])) out[field] = row[field];
        else if (num(row[field]) !== undefined) out[field] = num(row[field]);
      }
      if (row.usage && typeof row.usage === "object") {
        const usage = {};
        for (const field of ["input", "output", "cacheRead", "cacheWrite", "turns"]) {
          const n = num(row.usage[field]);
          if (n !== undefined) usage[field] = n;
        }
        if (Object.keys(usage).length) out.usage = usage;
      }
      const evidence = row.evidence;
      if (evidence && typeof evidence === "object" && num(evidence.version) !== undefined) {
        const kept = { version: evidence.version };
        if (typeof evidence.outcomeReason === "string" && /^[a-z0-9\-]{1,32}$/i.test(evidence.outcomeReason)) kept.outcomeReason = evidence.outcomeReason;
        if (num(evidence.attemptCount) !== undefined) kept.attemptCount = evidence.attemptCount;
        if (["present", "absent", "unknown"].includes(evidence.output)) kept.output = evidence.output;
        out.evidence = kept;
      }
      return out;
    }) : [];
    return {
      type: "custom",
      customType: entry.customType,
      data: {
        ...(words(data.runId) ? { runId: data.runId } : {}),
        ...(words(data.mode) ? { mode: data.mode } : {}),
        ...(words(data.state) ? { state: data.state } : {}),
        results: rows,
      },
    };
  }
  if (entry.customType === "quality-review-v1") {
    const data = entry.data ?? {};
    return {
      type: "custom",
      customType: "quality-review-v1",
      data: {
        ...(num(data.revision) !== undefined ? { revision: data.revision } : {}),
        ...(num(data.reviewed) !== undefined ? { reviewed: data.reviewed } : {}),
        ...(typeof data.disposition === "string" && /^[a-z_]{1,32}$/i.test(data.disposition) ? { disposition: data.disposition } : {}),
      },
    };
  }
  return undefined;
}
function piRedactExportData(data) {
  return {
    header: piRedactExportEntry({ ...data.header, type: "session" }),
    entries: (data.entries ?? []).map(piRedactExportEntry),
    leafId: data.leafId,
    exportNotice:
      "Conversation export: reasoning, harness instructions, tool data, images and internal metadata omitted. User/assistant text is retained and may contain sensitive information; review before sharing. This is not a resumable archive.",
  };
}
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePath } from "../utils/paths.js";
import { CURRENT_SESSION_VERSION } from "./session-manager.js";
/** Write the current session branch and optional trailing export-only entries as JSONL. */
export function exportSessionToJsonl(sessionManager, outputPath, createTrailingEntries) {
    const filePath = resolvePath(outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`, process.cwd());
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: sessionManager.getSessionId(),
        timestamp,
        cwd: sessionManager.getCwd(),
    };
    const lines = [JSON.stringify(piRedactExportEntry(header))];
    let parentId = null;
    for (const entry of sessionManager.getBranch()) {
        lines.push(JSON.stringify(piRedactExportEntry({ ...entry, parentId })));
        parentId = entry.id;
    }
    for (const entry of createTrailingEntries?.(parentId, timestamp) ?? []) {
        lines.push(JSON.stringify(piRedactExportEntry(entry)));
    }
    writeFileSync(filePath, `${lines.join("\n")}\n`);
    return filePath;
}

// Export-only redaction. Originals remain private session archives; never mutate them.
// HTML, its embedded JSONL download, /share and /export .jsonl use the same allowlist.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function piRedactExportEntry(entry) {
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

/**
 * Safe diagnostic metadata preserved in exports. Only fixed-shape numeric,
 * boolean, enum and 8-hex hash fields cross the boundary: hook owner, event
 * type/ID, before/after prefix hashes, changed position, chars/tokens changed,
 * semantic hash, revision and cache age. Payloads, paths, prompts, outputs,
 * errors and timestamps beyond the entry envelope never do.
 */
export function piRedactDiagnosticEntry(entry) {
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

export function piRedactExportData(data) {
  return {
    header: piRedactExportEntry({ ...data.header, type: "session" }),
    entries: (data.entries ?? []).map(piRedactExportEntry),
    leafId: data.leafId,
    exportNotice:
      "Conversation export: reasoning, harness instructions, tool data, images and internal metadata omitted. User/assistant text is retained and may contain sensitive information; review before sharing. This is not a resumable archive.",
  };
}

const marker = "PI_EXPORT_REDACTION_V2";
const legacyMarker = "PI_EXPORT_REDACTION_V1";
const helpers = [piRedactExportEntry, piRedactDiagnosticEntry, piRedactExportData]
  .map((fn) => fn.toString().replace(/^export /, ""))
  .join("\n");
function replaceOnce(source, oldText, replacement) {
  if (source.split(oldText).length !== 2)
    throw new Error(`Export redaction anchor changed: ${oldText.slice(0, 90)}`);
  return source.replace(oldText, replacement);
}
/**
 * V1 -> V2 migration for already-installed exports. V1 inlined only
 * piRedactExportEntry/piRedactExportData; V2 additionally inlines
 * piRedactDiagnosticEntry and routes custom entries through it. The
 * replacement targets the exact V1 custom-branch block, then inserts the new
 * helper before piRedactExportData. Anything unrecognized is drift, never a
 * silent skip.
 */
const v1CustomBranch = `  if (
    entry?.type !== "message" ||
    !["user", "assistant", "toolResult"].includes(entry.message?.role)
  ) {
    // Includes extension data, bashExecution, summaries, retained tails and unknown future entries.
    return { ...base, type: "custom", customType: "export-redacted", data: {} };
  }`;
const v2CustomBranch = `  if (
    entry?.type !== "message" ||
    !["user", "assistant", "toolResult"].includes(entry.message?.role)
  ) {
    const safe = piRedactDiagnosticEntry(entry);
    if (safe) return { ...base, ...safe };
    // Includes extension data, bashExecution, summaries, retained tails and unknown future entries.
    return { ...base, type: "custom", customType: "export-redacted", data: {} };
  }`;
function migrateV1ToV2(source) {
  if (!source.includes(legacyMarker) || source.includes(marker)) return source;
  if (source.split(v1CustomBranch).length !== 2) throw new Error("Export redaction V1 migration drift: custom branch changed");
  let next = source.replace(v1CustomBranch, () => v2CustomBranch);
  const helperText = piRedactDiagnosticEntry.toString().replace(/^export /, "");
  const dataFn = "function piRedactExportData(data) {";
  // Installed copies inline helpers without the export keyword.
  const installedDataFn = "function piRedactExportData(data) {";
  if (next.split(installedDataFn).length < 2) throw new Error("Export redaction V1 migration drift: export data anchor changed");
  if (next.includes("function piRedactDiagnosticEntry")) throw new Error("Export redaction V1 migration drift: unexpected helper present");
  next = next.replace(installedDataFn, () => `${helperText}\n${installedDataFn}`);
  next = next.split(legacyMarker).join(marker);
  return next;
}
function upgradeUnknownReasoning(source) {
  return source.replace(
    'if (blocks.some((b) => b.type === "thinking") && !source.usage.reasoning)',
    'if (source.usage.reasoning === null || blocks.some((b) => b.type === "thinking") && !source.usage.reasoning)',
  );
}
export function patchJsonl(source) {
  if (source.includes(marker) && !source.includes(legacyMarker)) return upgradeUnknownReasoning(source);
  if (source.includes(legacyMarker)) return migrateV1ToV2(source);
  let next = replaceOnce(
    source,
    "JSON.stringify(header)",
    "JSON.stringify(piRedactExportEntry(header))",
  );
  next = replaceOnce(
    next,
    "JSON.stringify({ ...entry, parentId })",
    "JSON.stringify(piRedactExportEntry({ ...entry, parentId }))",
  );
  next = replaceOnce(
    next,
    "JSON.stringify(entry)",
    "JSON.stringify(piRedactExportEntry(entry))",
  );
  return `/* ${marker} */\n${helpers}\n${next}`;
}
export function patchHtml(source) {
  if (source.includes(marker) && !source.includes(legacyMarker)) return upgradeUnknownReasoning(source);
  if (source.includes(legacyMarker)) return migrateV1ToV2(source);
  let next = replaceOnce(
    source,
    "function generateHtml(sessionData, themeName) {",
    "function generateHtml(sessionData, themeName) {\n    sessionData = piRedactExportData(sessionData);",
  );
  // Renderer callbacks may themselves expose raw data. Do not invoke them for exports.
  next = replaceOnce(
    next,
    "if (opts.toolRenderer) {",
    "if (false && opts.toolRenderer) {",
  );
  return `/* ${marker} */\n${helpers}\n${next}`;
}
export function patchBundle(source) {
  if (source.includes(marker) && !source.includes(legacyMarker)) return upgradeUnknownReasoning(source);
  if (source.includes(legacyMarker)) return migrateV1ToV2(source);
  let next = replaceOnce(
    source,
    "JSON.stringify(header)],parentId=null",
    "JSON.stringify(piRedactExportEntry(header))],parentId=null",
  );
  next = replaceOnce(
    next,
    "JSON.stringify({...entry,parentId})",
    "JSON.stringify(piRedactExportEntry({...entry,parentId}))",
  );
  next = replaceOnce(
    next,
    "of createTrailingEntries?.(parentId,timestamp)??[])lines.push(JSON.stringify(entry))",
    "of createTrailingEntries?.(parentId,timestamp)??[])lines.push(JSON.stringify(piRedactExportEntry(entry)))",
  );
  next = replaceOnce(
    next,
    "function generateHtml(sessionData,themeName){",
    "function generateHtml(sessionData,themeName){sessionData=piRedactExportData(sessionData);",
  );
  next = replaceOnce(
    next,
    "opts.toolRenderer&&(renderedTools=preRenderCustomTools",
    "false&&opts.toolRenderer&&(renderedTools=preRenderCustomTools",
  );
  return `/* ${marker} */\n${helpers}\n${next}`;
}
function migrateTemplateV1ToV2(source) {
  // V1 and V2 install byte-identical template edits; only the marker
  // advanced. Verify the V1 payload is intact, then swap the marker.
  // Anything unrecognized is drift, never a silent skip (a silent skip here
  // left template.js permanently MISSING after --fix converged everything
  // else, because isApplied requires the V2 marker).
  if (source.includes(marker))
    throw new Error(
      "Export redaction template V1 migration drift: mixed markers",
    );
  if (source.split(legacyMarker).length !== 2)
    throw new Error(
      "Export redaction template V1 migration drift: marker count changed",
    );
  const installed = [
    "const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, reasoningUnreported: 0 };",
    "else tokens.reasoningUnreported++;",
    "responses unreported (included in output, not added again)",
    "${data.exportNotice ? `<p>${escapeHtml(data.exportNotice)}</p>` : ''}",
  ];
  for (const snippet of installed)
    if (source.split(snippet).length !== 2)
      throw new Error(
        "Export redaction template V1 migration drift: installed payload changed",
      );
  return source.split(legacyMarker).join(marker);
}
export function patchTemplate(source) {
  if (source.includes(marker) && !source.includes(legacyMarker)) return source;
  if (source.includes(legacyMarker)) return migrateTemplateV1ToV2(source);
  let next = replaceOnce(
    source,
    "const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };",
    "const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, reasoningUnreported: 0 };",
  );
  next = replaceOnce(
    next,
    "tokens.cacheWrite += msg.usage.cacheWrite || 0;",
    "tokens.cacheWrite += msg.usage.cacheWrite || 0;\n                if (typeof msg.usage.reasoning === 'number') tokens.reasoning += msg.usage.reasoning;\n                else tokens.reasoningUnreported++;",
  );
  next = replaceOnce(
    next,
    "const msgParts = [];",
    "tokenParts.push(`reasoning ${formatTokens(globalStats.tokens.reasoning)} reported; ${globalStats.tokens.reasoningUnreported} responses unreported (included in output, not added again)`);\n        const msgParts = [];",
  );
  next = replaceOnce(
    next,
    "<h1>Session: ${escapeHtml(header?.id || 'unknown')}</h1>",
    "<h1>Session: ${escapeHtml(header?.id || 'unknown')}</h1>\n            ${data.exportNotice ? `<p>${escapeHtml(data.exportNotice)}</p>` : ''}",
  );
  return `/* ${marker} */\n${next}`;
}
export function targets() {
  const core = path.join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works/pi-coding-agent",
  );
  const chunks = path.join(core, "dist/bundle/chunks");
  const bundle = fs
    .readdirSync(chunks)
    .filter((n) => n.endsWith(".js"))
    .map((n) => path.join(chunks, n))
    .filter((f) =>
      fs.readFileSync(f, "utf8").includes("function exportSessionToJsonl("),
    );
  if (bundle.length !== 1)
    throw new Error("Export redaction: expected one runtime exporter bundle");
  return [
    [path.join(core, "dist/core/session-export.js"), patchJsonl],
    [path.join(core, "dist/core/export-html/index.js"), patchHtml],
    [path.join(core, "dist/core/export-html/template.js"), patchTemplate],
    [bundle[0], patchBundle],
  ].map(([file, patch]) => ({
    name: `export redaction: ${file}`,
    file,
    exists: () => fs.existsSync(file),
    isApplied: () => {
      const source = fs.readFileSync(file, "utf8");
      return source.includes(marker) && patch(source) === source;
    },
    apply: () => {
      const source = fs.readFileSync(file, "utf8");
      const next = patch(source);
      const temp = `${file}.export-redaction-${process.pid}`;
      fs.writeFileSync(temp, next, { mode: fs.statSync(file).mode });
      fs.renameSync(temp, file);
    },
  }));
}

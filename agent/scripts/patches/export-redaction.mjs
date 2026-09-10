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

export function piRedactExportData(data) {
  return {
    header: piRedactExportEntry({ ...data.header, type: "session" }),
    entries: (data.entries ?? []).map(piRedactExportEntry),
    leafId: data.leafId,
    exportNotice:
      "Conversation export: reasoning, harness instructions, tool data, images and internal metadata omitted. User/assistant text is retained and may contain sensitive information; review before sharing. This is not a resumable archive.",
  };
}

const marker = "PI_EXPORT_REDACTION_V1";
const helpers = [piRedactExportEntry, piRedactExportData]
  .map((fn) => fn.toString().replace(/^export /, ""))
  .join("\n");
function replaceOnce(source, oldText, replacement) {
  if (source.split(oldText).length !== 2)
    throw new Error(`Export redaction anchor changed: ${oldText.slice(0, 90)}`);
  return source.replace(oldText, replacement);
}
function upgradeUnknownReasoning(source) {
  return source.replace(
    'if (blocks.some((b) => b.type === "thinking") && !source.usage.reasoning)',
    'if (source.usage.reasoning === null || blocks.some((b) => b.type === "thinking") && !source.usage.reasoning)',
  );
}
export function patchJsonl(source) {
  if (source.includes(marker)) return upgradeUnknownReasoning(source);
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
  if (source.includes(marker)) return upgradeUnknownReasoning(source);
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
  if (source.includes(marker)) return upgradeUnknownReasoning(source);
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
export function patchTemplate(source) {
  if (source.includes(marker)) return source;
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

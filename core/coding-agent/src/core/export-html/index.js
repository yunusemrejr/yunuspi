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
      : Array.isArray(source.content) ? source.content.filter(block => block && typeof block === "object") : [];
  if (source.role === "toolResult") {
    Object.assign(message, pick(source, ["toolCallId", "toolName", "isError"]));
    message.content = [
      { type: "text", text: "[Tool output omitted from export]" },
    ];
  } else {
    message.content = blocks.flatMap((block) => {
      if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
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
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "path";
import { APP_NAME, getExportTemplateDir } from "../../config.js";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/interactive/theme/theme.js";
import { resolvePath } from "../../utils/paths.js";
import { writeSessionExport } from "../export-file.js";
import { SessionManager, loadEntriesFromFile } from "../session-manager.js";
/** Parse a color string to RGB values. Supports hex (#RRGGBB) and rgb(r,g,b) formats. */
function parseColor(color) {
    const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
    if (hexMatch) {
        return {
            r: Number.parseInt(hexMatch[1], 16),
            g: Number.parseInt(hexMatch[2], 16),
            b: Number.parseInt(hexMatch[3], 16),
        };
    }
    const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (rgbMatch) {
        return {
            r: Number.parseInt(rgbMatch[1], 10),
            g: Number.parseInt(rgbMatch[2], 10),
            b: Number.parseInt(rgbMatch[3], 10),
        };
    }
    return undefined;
}
/** Calculate relative luminance of a color (0-1, higher = lighter). */
function getLuminance(r, g, b) {
    const toLinear = (c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}
/** Adjust color brightness. Factor > 1 lightens, < 1 darkens. */
function adjustBrightness(color, factor) {
    const parsed = parseColor(color);
    if (!parsed)
        return color;
    const adjust = (c) => Math.min(255, Math.max(0, Math.round(c * factor)));
    return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}
/** Derive export background colors from a base color (e.g., userMessageBg). */
function deriveExportColors(baseColor) {
    const parsed = parseColor(baseColor);
    if (!parsed) {
        return {
            pageBg: "rgb(24, 24, 30)",
            cardBg: "rgb(30, 30, 36)",
            infoBg: "rgb(60, 55, 40)",
        };
    }
    const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
    const isLight = luminance > 0.5;
    if (isLight) {
        return {
            pageBg: adjustBrightness(baseColor, 0.96),
            cardBg: baseColor,
            infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
        };
    }
    return {
        pageBg: adjustBrightness(baseColor, 0.7),
        cardBg: adjustBrightness(baseColor, 0.85),
        infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
    };
}
/**
 * Generate CSS custom property declarations from theme colors.
 */
function generateThemeVars(themeName) {
    const colors = getResolvedThemeColors(themeName);
    const lines = [];
    for (const [key, value] of Object.entries(colors)) {
        lines.push(`--${key}: ${value};`);
    }
    // Use explicit theme export colors if available, otherwise derive from userMessageBg
    const themeExport = getThemeExportColors(themeName);
    const userMessageBg = colors.userMessageBg || "#343541";
    const derivedColors = deriveExportColors(userMessageBg);
    lines.push(`--exportPageBg: ${themeExport.pageBg ?? derivedColors.pageBg};`);
    lines.push(`--exportCardBg: ${themeExport.cardBg ?? derivedColors.cardBg};`);
    lines.push(`--exportInfoBg: ${themeExport.infoBg ?? derivedColors.infoBg};`);
    return lines.join("\n      ");
}
/**
 * Core HTML generation logic shared by both export functions.
 */
function generateHtml(sessionData, themeName) {
    sessionData = piRedactExportData(sessionData);
    const templateDir = getExportTemplateDir();
    const template = readFileSync(join(templateDir, "template.html"), "utf-8");
    const templateCss = readFileSync(join(templateDir, "template.css"), "utf-8");
    const templateJs = readFileSync(join(templateDir, "template.js"), "utf-8");
    const markedJs = readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf-8");
    const hljsJs = readFileSync(join(templateDir, "vendor", "highlight.min.js"), "utf-8");
    const themeVars = generateThemeVars(themeName);
    const colors = getResolvedThemeColors(themeName);
    const themeExport = getThemeExportColors(themeName);
    const derivedExportColors = deriveExportColors(colors.userMessageBg || "#343541");
    const bodyBg = themeExport.pageBg ?? derivedExportColors.pageBg;
    const containerBg = themeExport.cardBg ?? derivedExportColors.cardBg;
    const infoBg = themeExport.infoBg ?? derivedExportColors.infoBg;
    // Base64 encode session data to avoid escaping issues
    const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");
    // Build the CSS with theme variables injected
    const css = templateCss
        .replace("{{THEME_VARS}}", () => themeVars)
        .replace("{{BODY_BG}}", () => bodyBg)
        .replace("{{CONTAINER_BG}}", () => containerBg)
        .replace("{{INFO_BG}}", () => infoBg);
    return template
        .replace("{{CSS}}", () => css)
        .replace("{{JS}}", () => templateJs)
        .replace("{{SESSION_DATA}}", () => sessionDataBase64)
        .replace("{{MARKED_JS}}", () => markedJs)
        .replace("{{HIGHLIGHT_JS}}", () => hljsJs);
}
/** Tools rendered directly by the HTML template (not pre-rendered via TUI→ANSI→HTML pipeline) */
const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "edit", "ls"]);
/**
 * Pre-render custom tools to HTML using their TUI renderers.
 */
function preRenderCustomTools(entries, toolRenderer) {
    const renderedTools = {};
    for (const entry of entries) {
        if (entry.type !== "message")
            continue;
        const msg = entry.message;
        // Find tool calls in assistant messages
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === "toolCall" && !TEMPLATE_RENDERED_TOOLS.has(block.name)) {
                    const callHtml = toolRenderer.renderCall(block.id, block.name, block.arguments);
                    if (callHtml) {
                        renderedTools[block.id] = { callHtml };
                    }
                }
            }
        }
        // Find tool results
        if (msg.role === "toolResult" && msg.toolCallId) {
            const toolName = msg.toolName || "";
            // Only render if we have a pre-rendered call OR it's not template-rendered
            const existing = renderedTools[msg.toolCallId];
            if (existing || !TEMPLATE_RENDERED_TOOLS.has(toolName)) {
                const rendered = toolRenderer.renderResult(msg.toolCallId, toolName, msg.content, msg.details, msg.isError || false);
                if (rendered) {
                    renderedTools[msg.toolCallId] = {
                        ...existing,
                        resultHtmlCollapsed: rendered.collapsed,
                        resultHtmlExpanded: rendered.expanded,
                    };
                }
            }
        }
    }
    return renderedTools;
}
/**
 * Export session to HTML using SessionManager and AgentState.
 * Used by TUI's /export command.
 */
export async function exportSessionToHtml(sm, state, options) {
    const opts = typeof options === "string" ? { outputPath: options } : options || {};
    const sessionFile = sm.getSessionFile();
    const entries = sm.getEntries();
    if (!entries.length) {
        throw new Error("Nothing to export yet - start a conversation first");
    }
    // Pre-render custom tools if a tool renderer is provided
    let renderedTools;
    if (false && opts.toolRenderer) {
        renderedTools = preRenderCustomTools(entries, opts.toolRenderer);
        // Only include if we actually rendered something
        if (Object.keys(renderedTools).length === 0) {
            renderedTools = undefined;
        }
    }
    const sessionData = {
        header: sm.getHeader(),
        entries,
        leafId: sm.getLeafId(),
        systemPrompt: state?.systemPrompt,
        tools: state?.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
        renderedTools,
    };
    const html = generateHtml(sessionData, opts.themeName);
    let outputPath = opts.outputPath ? resolvePath(opts.outputPath) : undefined;
    if (!outputPath) {
        const sessionBasename = sessionFile ? basename(sessionFile, ".jsonl") : String(sm.getSessionId()).replace(/[^a-zA-Z0-9_-]/g, "_");
        outputPath = `${APP_NAME}-session-${sessionBasename}.html`;
    }
    return writeSessionExport(outputPath, html, sessionFile);
}
/**
 * Export session file to HTML (standalone, without AgentState).
 * Used by CLI for exporting arbitrary session files.
 */
export async function exportFromFile(inputPath, options) {
    const opts = typeof options === "string" ? { outputPath: options } : options || {};
    const resolvedInputPath = resolvePath(inputPath);
    if (!existsSync(resolvedInputPath)) {
        throw new Error(`File not found: ${resolvedInputPath}`);
    }
    // Loading an export must not migrate/rewrite the original session file.
    const fileEntries = loadEntriesFromFile(resolvedInputPath).filter(entry => entry && typeof entry === "object" && !Array.isArray(entry));
    if (!fileEntries.some(entry => entry.type === "session")) {
        throw new Error(`Session file is empty or invalid: ${resolvedInputPath}`);
    }
    const sm = SessionManager.inMemory(process.cwd(), undefined, fileEntries);
    const sessionData = {
        header: sm.getHeader(),
        entries: sm.getEntries(),
        leafId: sm.getLeafId(),
        systemPrompt: undefined,
        tools: undefined,
    };
    const html = generateHtml(sessionData, opts.themeName);
    let outputPath = opts.outputPath ? resolvePath(opts.outputPath) : undefined;
    if (!outputPath) {
        const inputBasename = basename(resolvedInputPath, ".jsonl");
        outputPath = `${APP_NAME}-session-${inputBasename}.html`;
    }
    return writeSessionExport(outputPath, html, resolvedInputPath);
}

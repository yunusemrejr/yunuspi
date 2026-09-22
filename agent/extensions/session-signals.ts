import { sessionObservability } from './lib/session-observability.ts';
import { collectSessionDiagnostics } from "./lib/session-diagnostics.ts";
import { shadowReport } from "./lib/intervention-registry.ts";
import {
  collectContextTraffic,
  buildSessionReport,
  reportText,
} from "./lib/session-report.ts";
import { collectSessionMetrics } from "./lib/session-metrics.ts";
import { collectSessionCost } from "./lib/session-cost.ts";
import {
  reduceChildEvents,
  projectTranscriptChildren,
  summarizeLedger,
  type LogicalChildTask,
} from "./pi-subagents/src/runs/shared/child-ledger.ts";
import { scanSessionAudit } from "./lib/session-audit.ts";
import { collectSessionErrors, type SessionErrorsReport } from "./lib/session-errors.ts";
import { stableToolOrder } from "./lib/stable-tool-order.ts";
import { createToolJsonCompactor } from "./lib/compact-tool-json.ts";
import { StringEnum } from "@yunuspi/ai";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { openExternal } from "./lib/project-intelligence/viewer.mjs";
import {
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@yunuspi/coding-agent";
import {
  PressureThresholds,
  pressureFacts,
  payloadPressureWarning,
  truncationDiagnostic,
  type OutputRequest,
  dateAnchor,
  sessionFacts,
} from "./lib/session-signals.ts";
const MESSAGE_CHARS = 400;
const MESSAGE_LIMIT = 50;
const CHILD_ROW_LIMIT = 100;
const REPORT_CHARS = 12000;

/** Every dynamic value in popup HTML passes through here; popups render
 * untrusted branch content (model text, file paths, errors). */
export function escapeHtml(text: unknown): string {
  return String(text ?? "").replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

const POPUP_CSS = [
  ":root{color-scheme:dark}",
  "body{margin:0;background:#14161a;color:#e8e6e1;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Color Emoji','Apple Color Emoji','Segoe UI Emoji',sans-serif;text-align:left;word-spacing:normal;letter-spacing:normal}",
  "main{max-width:860px;margin:0 auto;padding:24px 22px 40px}",
  "h1{font-size:20px;line-height:1.25;margin:0 0 5px}",
  "h2{font-size:14px;margin:20px 0 6px;color:#ffd479}",
  "h3{font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin:14px 0 5px;color:#9aa0a8}",
  "p.sub{margin:0 0 8px;color:#9aa0a8;font-size:12px}",
  "p.note{margin:7px 0 10px;color:#b4b8bf;font-size:12px}",
  "ul{list-style:none;margin:0;padding:0}",
  "li{padding:3px 0;border-bottom:1px solid #26292f;display:flex;gap:8px;align-items:baseline}",
  "li:last-child{border-bottom:0}",
  "code.row{flex:1;overflow-wrap:anywhere}",
  "b.count{color:#8fd0ff;white-space:nowrap}",
  "span.dim{color:#9aa0a8;font-size:12px}",
  ".overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:16px 0 10px}",
  ".stat{background:#1b1e23;border:1px solid #2b2f36;border-radius:9px;padding:10px 11px;min-width:0}",
  ".stat strong{display:block;color:#f7f4ed;font-size:19px;line-height:1.15;overflow-wrap:anywhere}",
  ".stat span{display:block;color:#9aa0a8;font-size:11px;margin-top:3px}",
  "details.group{margin:10px 0;border:1px solid #2b2f36;border-radius:10px;background:#191b20;overflow:hidden}",
  "details.group>summary{display:flex;align-items:center;gap:10px;cursor:pointer;padding:11px 13px;list-style:none;user-select:none}",
  "details.group>summary::-webkit-details-marker,details.item>summary::-webkit-details-marker{display:none}",
  "details.group>summary::before,details.item>summary::before{content:'›';color:#ffd479;font-size:18px;line-height:1;transform-origin:center;transition:transform .12s ease}",
  "details[open]>summary::before{transform:rotate(90deg)}",
  "details.group>summary:hover,details.group>summary:focus-visible,details.item>summary:hover,details.item>summary:focus-visible{background:#22252b;outline:none}",
  "details.group>summary:focus-visible,details.item>summary:focus-visible{box-shadow:inset 0 0 0 2px #8fd0ff}",
  ".group-title{font-weight:700;color:#f7f4ed;white-space:nowrap}",
  ".group-meta{margin-left:auto;color:#aeb3ba;font-size:12px;text-align:right}",
  ".group-body{border-top:1px solid #2b2f36;padding:9px 13px 13px}",
  "details.item{border-bottom:1px solid #292c32}",
  "details.item:last-child{border-bottom:0}",
  "details.item>summary{display:flex;align-items:center;gap:8px;cursor:pointer;padding:7px 3px;list-style:none}",
  ".item-name{min-width:0;flex:1;font-family:ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',monospace;overflow-wrap:anywhere}",
  ".item-meta{color:#9aa0a8;font-size:12px;text-align:right}",
  ".badge{display:inline-block;border:1px solid #3a3f48;border-radius:999px;padding:0 7px;color:#c8ccd2;font-size:11px;line-height:1.7;white-space:nowrap}",
  ".badge.current,.badge.complete,.badge.read{border-color:#315d4a;color:#9de1bd;background:#192a23}",
  ".badge.active,.badge.partial{border-color:#715d2a;color:#ffd479;background:#2b2518}",
  ".badge.failed{border-color:#743d43;color:#ff9da7;background:#2c1c20}",
  ".badge.info{border-color:#31566d;color:#8fd0ff;background:#182630}",
  "button#copy-errors{background:#2b6cb0;border:0;border-radius:8px;color:#fff;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:7px 16px;cursor:pointer}",
  "button#copy-errors:hover,button#copy-errors:focus-visible{background:#3580cc;outline:none}",
  "button#copy-errors:focus-visible{box-shadow:0 0 0 2px #8fd0ff}",
  ".copy-row{display:flex;align-items:center;gap:10px;margin:12px 0}",
  ".facts-grid{display:grid;grid-template-columns:minmax(105px,auto) 1fr;gap:3px 12px;margin:2px 0 10px;padding:0 0 0 23px;font-size:12px}",
  ".facts-grid dt{color:#858b94}",
  ".facts-grid dd{margin:0;overflow-wrap:anywhere;color:#d4d2cd}",
  ".empty{color:#777d86;padding:4px 0}",
  ".status-line{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px}",
  "pre{background:#0d0e11;border:1px solid #26292f;border-radius:8px;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}",
  "div.chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}",
  "div.chips span{background:#23262c;border-radius:6px;padding:1px 8px;font-size:12px}",
  "table.facts{border-collapse:collapse;margin:8px 0;font-size:13px}",
  "table.facts td{padding:2px 10px 2px 0;vertical-align:top}",
  "table.facts td:first-child{color:#9aa0a8;white-space:nowrap}",
  "@media(max-width:640px){main{padding:18px 12px 30px}.overview{grid-template-columns:repeat(2,minmax(0,1fr))}.group-meta{white-space:normal}.item-meta{display:none}}",
  "@media(prefers-reduced-motion:reduce){details.group>summary::before,details.item>summary::before{transition:none}}",
].join("\n");

export function renderPopupHtml(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${POPUP_CSS}</style></head><body><main>${bodyHtml}</main></body></html>`;
}

export function popupDir(): string {
  return path.join(path.dirname(getAgentDir()), "popups");
}

export function sysPromptDir(): string {
  return path.join(path.dirname(getAgentDir()), "sys-prompts");
}

export function sanitizeFileSegment(value: unknown): string {
  const clean = String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return clean || "session";
}

export function writePopupFile(dir: string, fileName: string, html: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, fileName);
  if (path.basename(fileName) !== fileName || fileName === "." || fileName === "..")
    throw new Error("Popup filename must be a single path segment");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, html, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return file;
}

/** Temporary popups must not accumulate; never removes the file just written. */
export function pruneStaleFiles(dir: string, ttlMs: number, keepBasename?: string): number {
  let removed = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - ttlMs;
  for (const name of names) {
    if (name === keepBasename) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff && fs.lstatSync(full).isFile()) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      // Retention must never break the popup.
    }
  }
  return removed;
}

export type SysSnapshot = {
  at: string;
  model?: string;
  system: string;
  truncated: boolean;
  tools: string[];
  toolCount: number;
};

const SYS_SYSTEM_CAP = 262144;

/** Text from a provider content value: a bare string or an array of text
 * parts (Anthropic, OpenAI and Responses shapes). Anything else yields "". */
function providerContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push(part);
    } else if (part && typeof part === "object" && typeof (part as any).text === "string") {
      if ((part as any).text) parts.push((part as any).text);
    }
  }
  return parts.join("\n");
}

/** System/developer-role text from a provider message list (OpenAI
 * completions `messages`, Responses `input`). Every other role is skipped —
 * user content stays out of the snapshot. */
function systemRoleText(list: unknown): string {
  if (!Array.isArray(list)) return "";
  const texts: string[] = [];
  for (const message of list) {
    if (!message || typeof message !== "object") continue;
    const role = (message as any).role;
    if (role !== "system" && role !== "developer") continue;
    const text = providerContentText((message as any).content);
    if (text) texts.push(text);
  }
  return texts.join("\n\n");
}

/** Tool names from a wire tool list, expanding Google's nested
 * functionDeclarations wrapper. Returns display names plus the true count. */
function wireToolNames(rawTools: unknown[]): { tools: string[]; toolCount: number } {
  const tools: string[] = [];
  let toolCount = 0;
  const push = (tool: any): void => {
    if (!tool || typeof tool !== "object") return;
    const nested = tool.functionDeclarations ?? tool.function_declarations;
    if (Array.isArray(nested)) {
      for (const entry of nested) push(entry);
      return;
    }
    toolCount++;
    if (tools.length < 300)
      tools.push(
        String(
          tool?.name ?? tool?.function?.name ?? tool?.functionDeclaration?.name ?? "?",
        ).slice(0, 160),
      );
  };
  for (const tool of rawTools) push(tool);
  return { tools, toolCount };
}

/** First-request envelope only: system text, model id and tool names. User,
 * assistant and tool content is never read — only top-level system fields
 * and system/developer-role messages. */
export function extractSysSnapshot(payload: unknown): SysSnapshot | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  let system: string | undefined;
  if (typeof record.system === "string") system = record.system;
  else if (typeof record.systemPrompt === "string") system = record.systemPrompt;
  else if (typeof record.instructions === "string") system = record.instructions;
  else if (typeof record.systemInstruction === "string") system = record.systemInstruction;
  else if (Array.isArray(record.system)) {
    // Anthropic-style [{ type: "text", text }]: prefer readable text over JSON.
    system = providerContentText(record.system) || undefined;
    if (!system) {
      try {
        system = JSON.stringify(record.system).slice(0, SYS_SYSTEM_CAP) || undefined;
      } catch {
        system = undefined;
      }
    }
  }
  // OpenAI-compatible chat payloads (OpenAI, DeepSeek, OpenRouter, ...) carry
  // the system prompt as a system/developer message, not a top-level field.
  if (!system) system = systemRoleText(record.messages) || undefined;
  // Responses APIs carry the same list as `input`.
  if (!system) system = systemRoleText(record.input) || undefined;
  // Google nests the instruction inside config.
  if (!system) {
    const config = record.config as Record<string, unknown> | undefined;
    if (config && typeof config === "object") {
      if (typeof config.systemInstruction === "string") system = config.systemInstruction;
      else if (config.systemInstruction && typeof config.systemInstruction === "object")
        system = providerContentText((config.systemInstruction as any).parts) || undefined;
    }
  }
  if (!system) return undefined;
  const truncated = system.length > SYS_SYSTEM_CAP;
  if (truncated) system = `${system.slice(0, SYS_SYSTEM_CAP)}\n[…truncated; ${system.length} characters total]`;
  const configTools = (record.config as any)?.tools;
  const rawTools = Array.isArray(record.tools)
    ? record.tools
    : Array.isArray(record.functions)
      ? record.functions
      : Array.isArray(configTools)
        ? configTools
        : [];
  const { tools, toolCount } = wireToolNames(rawTools);
  const model = typeof record.model === "string" ? record.model.slice(0, 200) : undefined;
  return { at: new Date().toISOString(), model, system, truncated, tools, toolCount };
}

export type UsedSummary = {
  tools: { name: string; count: number; errors: number }[];
  toolDistinctTotal: number;
  toolsOmitted: number;
  skillsRead: { name: string; count: number }[];
  skillsPartial: { name: string; count: number }[];
  skillsSuggested: string[];
  skillsSuggestedOnly: string[];
  skillTotals: { read: number; partial: number; suggested: number; suggestedOnly: number; omitted: number };
  routes: { route: string; thinking?: string; nested?: string; endpoint?: string; source?: string }[];
  models: {
    route: string;
    current: boolean;
    turns: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
    errors: number;
    selections: number;
    thinking: string[];
    routing: string[];
    endpoints: string[];
    sources: string[];
  }[];
  modelsOmitted: number;
  runs: {
    runId: string;
    childRunId?: string;
    index?: number;
    mode?: string;
    agent?: string;
    status: string;
    provider?: string;
    model?: string;
    thinking?: string;
    tokens: number;
    turns?: number;
    costUsd?: number;
    usageRecorded: boolean;
  }[];
  agents: {
    total: number;
    active: number;
    completed: number;
    failed: number;
    stopped: number;
    paused: number;
    unknown: number;
    shown: number;
    omitted: number;
  };
  session: {
    responses: number;
    toolCalls: number;
    toolResults: number;
    parentErrors: number;
    blockedTools: number;
    compactions: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    cacheRate: number | null;
    childTokens: number;
    hookCalls: number | null;
    hookChanged: number | null;
    hookErrors: number | null;
    cost: string;
    costUnknown: boolean;
    costPending: number;
  };
  hooks: { name: string; calls: number; errors: number; ms: number; changed: number }[];
  swarms: number;
  fusions: number;
  recoveries: number;
  councils: { status: string; evidence: number; incomplete: boolean }[];
  reviews: { rounds: number; disposition: string; aspects: { aspect: string; outcome: string }[] } | null;
  inspected: number;
  /** Canonical logical child tasks from the shared child ledger (aggregate-first). */
  logicalTasks: LogicalChildTask[];
  attemptsTotal: number;
  /** Linkage gaps: missing task ids / orphan accounting. Never called "omitted". */
  unresolvedLinkage: number;
  linkageNotes: string[];
};

export type UsedLiveModel = {
  provider?: unknown;
  id?: unknown;
  thinking?: unknown;
};

const SKILL_READ = /(?:^|[\\/])SKILL\.md$/i;
const skillName = (p: string) =>
  String(p).replace(/\\/g, "/").split("/").filter(Boolean).slice(-2, -1)[0] || String(p);

/** Session usage from retained branch entries: tool counts, skill reads,
 * selection-boundary routes, child runs, council deliberations and review
 * state. Unknown provider/thinking/nested values stay absent — the renderer
 * shows a dash rather than a guess. */
export function buildUsedSummary(entries: unknown, liveModel?: UsedLiveModel): UsedSummary {
  const list = Array.isArray(entries) ? entries : [];
  const metrics = collectSessionMetrics(list);
  const cost = collectSessionCost(list);
  const isNonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const finite = (value: unknown) => isNonnegative(value) ? value : 0;
  const bounded = (value: unknown, max = 160) => typeof value === "string" && value ? value.slice(0, max) : undefined;
  const calls = new Map<string, { name?: string; input?: any }>();
  for (const entry of list) {
    const message = (entry as any)?.type === "message" ? (entry as any).message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === "toolCall" && typeof part.id === "string" && !calls.has(part.id))
        calls.set(part.id, { name: part.name, input: part.arguments ?? {} });
    }
  }
  // Launch-level spawn args (model/thinking) keyed by every id a cost row
  // may carry. Management actions (status/stop/...) are not launches.
  const spawnArgs = new Map<string, any>();
  const launches: { data: any; args: any; fallback: string }[] = [];
  const readCounts = new Map<string, number>();
  const partialCounts = new Map<string, number>();
  const toolErrors = new Map<string, number>();
  for (const entry of list) {
    const message = (entry as any)?.type === "message" ? (entry as any).message : undefined;
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const call = calls.get(message.toolCallId);
    if (message.toolName === "subagent" && call && !call.input?.action) {
      for (const key of [message.details?.asyncId, message.details?.runId, message.toolCallId]) {
        if (typeof key === "string" && key && !spawnArgs.has(key)) spawnArgs.set(key, call.input);
      }
      launches.push({ data: message.details ?? {}, args: call.input, fallback: message.toolCallId });
    }
    if (message.isError || message.toolName === "web_search" && message.details?.queryCount > 0 && message.details?.successfulQueries === 0)
      toolErrors.set(message.toolName, (toolErrors.get(message.toolName) ?? 0) + 1);
    const target = call?.input?.path ?? call?.input?.file_path;
    if (!message.isError && call?.name === "read" && typeof target === "string" && SKILL_READ.test(target)) {
      const full = (call.input?.offset === undefined || call.input?.offset === 1) &&
        call.input?.limit === undefined &&
        message.details?.truncation?.truncated !== true;
      const bucket = full ? readCounts : partialCounts;
      const name = skillName(target).slice(0, 120);
      bucket.set(name, (bucket.get(name) ?? 0) + 1);
    }
  }
  const byCount = (a: { count: number }, b: { count: number }) => b.count - a.count;
  const tools = Object.entries(metrics.tools ?? {})
    .map(([name, count]) => ({
      name: String(name).slice(0, 120),
      count: Number(count) || 0,
      errors: toolErrors.get(name) ?? 0,
    }))
    .sort(byCount)
    .slice(0, 80);
  const counted = (names: unknown, bucket: Map<string, number>) =>
    (Array.isArray(names) ? names : [])
      .map((name) => ({ name: String(name).slice(0, 120), count: bucket.get(String(name)) ?? 0 }))
      .sort((a, b) => byCount(a, b) || a.name.localeCompare(b.name))
      .slice(0, 40);
  const allReadNames = [...(metrics.skillsRead ?? [])].map((name) => String(name).slice(0, 120)).sort();
  const allPartialNames = [...(metrics.skillsPartial ?? [])].map((name) => String(name).slice(0, 120)).sort();
  const allSuggestedNames = [...(metrics.skillsRouted ?? [])].map((name) => String(name).slice(0, 120)).sort();
  const openedNames = new Set([...allReadNames, ...allPartialNames]);
  const allSuggestedOnly = allSuggestedNames.filter((name) => !openedNames.has(name));
  const routes: UsedSummary["routes"] = [];
  const routeConfig = new Map<string, { selections: number; thinking: Set<string>; routing: Set<string>; endpoints: Set<string>; sources: Set<string> }>();
  for (const entry of list) {
    if ((entry as any)?.type !== "custom" || (entry as any)?.customType !== "model-config-v1") continue;
    const data = (entry as any)?.data;
    if (!data || typeof data.route !== "string" || !data.route.trim()) continue;
    let nested: string | undefined;
    const routing = data.openRouterRouting;
    if (routing && typeof routing === "object") {
      try {
        nested = JSON.stringify(routing).slice(0, 200);
      } catch {
        nested = undefined;
      }
    }
    const route = data.route.trim().slice(0, 160);
    routes.push({
      route,
      ...(typeof data.thinking === "string" && data.thinking ? { thinking: data.thinking.slice(0, 16) } : {}),
      ...(nested ? { nested } : {}),
      ...(typeof data.recoveryEndpointName === "string" && data.recoveryEndpointName
        ? { endpoint: data.recoveryEndpointName.slice(0, 160) }
        : {}),
      ...(typeof data.source === "string" && data.source ? { source: data.source.slice(0, 64) } : {}),
    });
    if (routes.length > 48) routes.shift();
    const aggregate = routeConfig.get(route) ?? { selections: 0, thinking: new Set(), routing: new Set(), endpoints: new Set(), sources: new Set() };
    aggregate.selections++;
    if (typeof data.thinking === "string" && data.thinking) aggregate.thinking.add(data.thinking.slice(0, 16));
    if (nested) aggregate.routing.add(nested);
    if (typeof data.recoveryEndpointName === "string" && data.recoveryEndpointName) aggregate.endpoints.add(data.recoveryEndpointName.slice(0, 160));
    if (typeof data.source === "string" && data.source) aggregate.sources.add(data.source.slice(0, 64));
    routeConfig.set(route, aggregate);
  }

  const liveId = bounded(liveModel?.id, 160);
  const liveProvider = bounded(liveModel?.provider, 80);
  const currentRoute = liveId ? (liveProvider ? `${liveProvider}/${liveId}` : liveId) : undefined;
  const modelRows = new Map<string, UsedSummary["models"][number]>();
  for (const row of metrics.modelsUsed ?? []) {
    if (!row || typeof row.route !== "string" || !row.route) continue;
    modelRows.set(row.route, {
      route: row.route.slice(0, 160),
      current: row.route === currentRoute,
      turns: finite(row.turns), input: finite(row.input), cacheRead: finite(row.cacheRead), cacheWrite: finite(row.cacheWrite),
      output: finite(row.output), reasoning: finite(row.reasoning), errors: finite(row.errors), selections: 0,
      thinking: Array.isArray(row.thinking) ? row.thinking.map((value: unknown) => String(value).slice(0, 16)).slice(0, 12) : [],
      routing: Array.isArray(row.routing) ? row.routing.map((value: unknown) => String(value).slice(0, 200)).slice(0, 12) : [],
      endpoints: Array.isArray(row.endpoints) ? row.endpoints.map((value: unknown) => String(value).slice(0, 160)).slice(0, 12) : [],
      sources: [],
    });
  }
  for (const [route, config] of routeConfig) {
    const row = modelRows.get(route) ?? {
      route, current: route === currentRoute, turns: 0, input: 0, cacheRead: 0, cacheWrite: 0,
      output: 0, reasoning: 0, errors: 0, selections: 0, thinking: [], routing: [], endpoints: [], sources: [],
    };
    row.selections = config.selections;
    row.thinking = [...new Set([...row.thinking, ...config.thinking])];
    row.routing = [...new Set([...row.routing, ...config.routing])];
    row.endpoints = [...new Set([...row.endpoints, ...config.endpoints])];
    row.sources = [...config.sources];
    modelRows.set(route, row);
  }
  if (currentRoute) {
    const liveThinking = bounded(liveModel?.thinking, 16);
    const current = modelRows.get(currentRoute);
    if (current) {
      current.current = true;
      if (liveThinking && !current.thinking.includes(liveThinking)) current.thinking.push(liveThinking);
      if (!current.sources.includes("live session")) current.sources.push("live session");
    } else {
      modelRows.set(currentRoute, {
        route: currentRoute, current: true, turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
        reasoning: 0, errors: 0, selections: 0,
        thinking: liveThinking ? [liveThinking] : [],
        routing: [], endpoints: [], sources: ["live session"],
      });
    }
  }
  const allModels = [...modelRows.values()].sort((a, b) => Number(b.current) - Number(a.current) || b.turns - a.turns || b.input - a.input || a.route.localeCompare(b.route));
  const models = allModels.slice(0, 64);

  const runRows = new Map<string, UsedSummary["runs"][number]>();
  const terminal = new Set(["completed", "failed", "stopped"]);
  const statusOf = (data: any, result: any) => {
    let status = String(result?.status ?? result?.state ?? data?.state ?? "unknown").slice(0, 32);
    if (result?.stopped) status = "stopped";
    else if (result?.interrupted) status = "paused";
    else if (result?.error || result?.timedOut || Number.isInteger(result?.exitCode) && result.exitCode !== 0) status = "failed";
    else if (result?.exitCode === 0 || result?.success === true) status = "completed";
    return status === "complete" ? "completed" : status || "unknown";
  };
  // Launch args name the agent; result rows rarely do. tasks[i].agent maps
  // positionally for parallel launches, else the single-launch agent.
  const launchAgent = (args: any, childIndex: unknown): string | undefined => {
    if (!args || typeof args !== "object") return undefined;
    if (Array.isArray(args.tasks)) {
      const step = Number.isInteger(childIndex) ? args.tasks[childIndex as number] : undefined;
      return bounded(step?.agent, 80);
    }
    return bounded(args.agent, 80);
  };
  const launchModel = (args: any, childIndex: unknown): string | undefined => {
    if (!args || typeof args !== "object") return undefined;
    if (Array.isArray(args.tasks)) {
      const step = Number.isInteger(childIndex) ? args.tasks[childIndex as number] : undefined;
      return bounded(step?.model, 240) ?? bounded(args.model, 240);
    }
    return bounded(args.model, 240);
  };
  const recordRun = (data: any, result: any, index: number, args: any, fallback: string) => {
    if (!data || typeof data !== "object") data = {};
    if (!result || typeof result !== "object") result = {};
    const parent = String(data.runId ?? data.asyncId ?? data.id ?? fallback ?? "unknown").slice(0, 80);
    const childIndex = Number.isInteger(result.index) ? result.index : index;
    const childKey = String(result.workflowKey ?? result.childId ?? childIndex).slice(0, 80);
    const key = `${parent}:${childKey}`;
    const previous = runRows.get(key);
    const modelText = bounded(result.model, 240) ?? launchModel(args, childIndex) ?? (previous?.provider && previous?.model ? `${previous.provider}/${previous.model}` : previous?.model);
    const slash = modelText?.indexOf("/") ?? -1;
    const usage = result.usage && typeof result.usage === "object" ? result.usage : result.evidence?.usage && typeof result.evidence.usage === "object" ? result.evidence.usage : undefined;
    const tokens = usage ? ["input", "output", "cacheRead", "cacheWrite"].reduce((sum, field) => sum + finite(usage[field]), 0) : 0;
    const rawCost = result.totalCost?.costUsd ?? usage?.cost?.total ?? usage?.cost;
    let status = statusOf(data, result);
    if (previous && terminal.has(previous.status) && !terminal.has(status)) status = previous.status;
    const agent = launchAgent(args, childIndex) ?? previous?.agent;
    runRows.set(key, {
      runId: parent,
      ...(bounded(result.runId, 80) ? { childRunId: bounded(result.runId, 80) } : previous?.childRunId ? { childRunId: previous.childRunId } : {}),
      ...(Number.isInteger(childIndex) ? { index: childIndex } : {}),
      ...(bounded(data.mode, 32) ? { mode: bounded(data.mode, 32) } : previous?.mode ? { mode: previous.mode } : {}),
      ...(agent ? { agent } : {}),
      status,
      ...(slash > 0 ? { provider: modelText!.slice(0, slash).slice(0, 80), model: modelText!.slice(slash + 1).slice(0, 160) } : modelText ? { model: modelText.slice(0, 160) } : previous?.model ? { ...(previous.provider ? { provider: previous.provider } : {}), model: previous.model } : {}),
      ...(bounded(args?.thinking ?? args?.thinkingOverride, 16) ? { thinking: bounded(args?.thinking ?? args?.thinkingOverride, 16) } : previous?.thinking ? { thinking: previous.thinking } : {}),
      tokens: Math.max(previous?.tokens ?? 0, tokens),
      ...(finite(usage?.turns) || previous?.turns ? { turns: Math.max(previous?.turns ?? 0, finite(usage?.turns)) } : {}),
      ...(isNonnegative(rawCost) || previous?.costUsd !== undefined ? { costUsd: Math.max(previous?.costUsd ?? 0, finite(rawCost)) } : {}),
      usageRecorded: previous?.usageRecorded === true || usage !== undefined,
    });
  };
  for (const launch of launches) {
    const data = launch.data ?? {};
    const rows = Array.isArray(data.results) && data.results.length ? data.results : data.asyncId || data.runId ? [{ index: 0, status: data.state ?? "queued" }] : [];
    rows.forEach((result: any, index: number) => recordRun(data, result, index, launch.args, launch.fallback));
  }
  for (const entry of list) {
    if ((entry as any)?.type !== "custom" || (entry as any)?.customType !== "subagent-cost-v1") continue;
    const data = (entry as any)?.data ?? {};
    for (const [index, result] of (Array.isArray(data.results) ? data.results : []).entries()) {
      const args = spawnArgs.get(data.runId) ?? spawnArgs.get(result?.runId);
      recordRun(data, result, index, args, String((entry as any)?.id ?? "unknown"));
    }
  }
  const allRuns = [...runRows.values()];
  const runs = allRuns.slice(-CHILD_ROW_LIMIT);
  const councils: UsedSummary["councils"] = [];
  let reviews: UsedSummary["reviews"] = null;
  for (const entry of list) {
    if ((entry as any)?.type !== "custom") continue;
    const data = (entry as any)?.data;
    if (!data || typeof data !== "object") continue;
    if ((entry as any).customType === "scope-deliberation-v1") {
      councils.push({
        status: String(data.status ?? "?").slice(0, 32),
        evidence: Number.isSafeInteger(data.evidenceCount) ? data.evidenceCount : 0,
        incomplete: data.incomplete !== false,
      });
      if (councils.length > 24) councils.shift();
    } else if ((entry as any).customType === "quality-review-v1") {
      reviews = {
        rounds: Number.isSafeInteger(data.rounds) ? data.rounds : 0,
        disposition: typeof data.disposition === "string" && data.disposition ? data.disposition.slice(0, 32) : "pending",
        aspects: Array.isArray(data.reports)
          ? data.reports.slice(0, 8).map((report: any) => ({
              aspect: String(report?.aspect ?? "?").slice(0, 32),
              outcome: String(report?.outcome ?? "?").slice(0, 16),
            }))
          : [],
      };
    }
  }
  // Canonical child state: /used projects the shared ledger — the same reducer
  // /metrics, recovery, and diagnostics read — instead of inferring child rows
  // a second time. Forensic run rows below stay for launch-args detail.
  const ledger = reduceChildEvents(projectTranscriptChildren(list));
  const ledgerSummary = summarizeLedger(ledger);
  const logicalTasks = ledger.tasks.slice(-CHILD_ROW_LIMIT);
  const totalAgents = ledger.tasks.length > 0 ? ledger.tasks.length : metrics.agents > 0 ? metrics.agents : allRuns.length;
  return {
    tools,
    toolDistinctTotal: metrics.distinctTools ?? tools.length,
    toolsOmitted: Math.max(0, (metrics.distinctTools ?? tools.length) - tools.length),
    skillsRead: counted(allReadNames, readCounts),
    skillsPartial: counted(allPartialNames, partialCounts),
    skillsSuggested: allSuggestedNames.slice(0, 40),
    skillsSuggestedOnly: allSuggestedOnly.slice(0, 40),
    skillTotals: {
      read: allReadNames.length,
      partial: allPartialNames.length,
      suggested: allSuggestedNames.length,
      suggestedOnly: allSuggestedOnly.length,
      omitted: Math.max(0, allReadNames.length - 40) + Math.max(0, allPartialNames.length - 40) + Math.max(0, allSuggestedOnly.length - 40),
    },
    routes,
    models,
    modelsOmitted: Math.max(0, allModels.length - models.length),
    runs,
    agents: {
      total: totalAgents,
      active: ledger.tasks.length > 0 ? ledgerSummary.running : metrics.agentsActive ?? 0,
      completed: ledger.tasks.length > 0 ? ledgerSummary.completed : metrics.agentsCompleted ?? 0,
      failed: ledger.tasks.length > 0 ? ledgerSummary.failed : metrics.agentFailures ?? 0,
      stopped: ledger.tasks.length > 0 ? ledgerSummary.stopped : metrics.agentsStopped ?? 0,
      paused: ledger.tasks.length > 0 ? ledgerSummary.paused : metrics.agentsPaused ?? 0,
      unknown: metrics.agentOutcomeUnknown ?? 0,
      shown: runs.length,
      // Display limit only: rows that exist but were cut by CHILD_ROW_LIMIT.
      // Missing linkage is reported separately as unresolved linkage.
      omitted: Math.max(0, allRuns.length - runs.length, ledger.tasks.length - logicalTasks.length),
    },
    session: {
      responses: metrics.responses ?? 0,
      toolCalls: metrics.toolCalls ?? 0,
      toolResults: metrics.toolResults ?? 0,
      parentErrors: (metrics.errors ?? 0) + (metrics.modelErrors ?? 0),
      blockedTools: metrics.blocked ?? 0,
      compactions: metrics.compactions ?? 0,
      input: metrics.input ?? 0,
      output: metrics.output ?? 0,
      cacheRead: metrics.cacheRead ?? 0,
      cacheWrite: metrics.cacheWrite ?? 0,
      reasoning: metrics.reasoning ?? 0,
      cacheRate: typeof metrics.cacheRate === "number" ? metrics.cacheRate : null,
      childTokens: metrics.childTokens ?? 0,
      hookCalls: metrics.telemetry ? metrics.hookCalls ?? 0 : null,
      hookChanged: metrics.telemetry ? metrics.hookChanged ?? 0 : null,
      hookErrors: metrics.telemetry ? metrics.hookErrors ?? 0 : null,
      cost: cost.formatted,
      costUnknown: cost.unknown === true,
      costPending: cost.pending ?? 0,
    },
    hooks: Object.entries(metrics.hooks ?? {}).sort((a: any, b: any) => b[1].calls - a[1].calls).slice(0, 24).map(([name, value]: [string, any]) => ({
      name: name.slice(0, 200), calls: finite(value.calls), errors: finite(value.errors), ms: finite(value.ms), changed: finite(value.changed),
    })),
    swarms: metrics.swarms ?? 0,
    fusions: metrics.fusions ?? 0,
    recoveries: metrics.recoveries ?? 0,
    councils,
    reviews,
    inspected: list.length,
    logicalTasks,
    attemptsTotal: ledgerSummary.attempts,
    unresolvedLinkage: ledger.unresolved.length + ledger.tasks.filter((task) => task.unresolvedLinkage === true).length,
    linkageNotes: ledger.unresolved.slice(0, 8).map((item) => `${item.kind}: ${item.detail}`),
  };
}

const formatCount = (value: number | undefined) => Number(value ?? 0).toLocaleString("en-US");
const plural = (value: number, singular: string, pluralForm = `${singular}s`) => `${formatCount(value)} ${value === 1 ? singular : pluralForm}`;
const usedRow = (label: string, badge?: string, detail?: string, tone = "info") =>
  `<li><code class="row">${escapeHtml(label)}${detail ? ` <span class="dim">${escapeHtml(detail)}</span>` : ""}</code>${badge ? `<span class="badge ${tone}">${escapeHtml(badge)}</span>` : ""}</li>`;
const factGrid = (rows: [string, unknown][]) => `<dl class="facts-grid">${rows.filter(([, value]) => value !== undefined && value !== null && value !== "").map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
const statusTone = (status: string) => status === "completed" || status === "complete" || status === "accepted" || status === "pass" ? "complete" : status === "failed" || status === "rejected" || status === "error" ? "failed" : ["queued", "running", "detached", "paused", "pending"].includes(status) ? "active" : "info";
const group = (title: string, meta: string, body: string, open = false) => `<details class="group"${open ? " open" : ""}><summary><span class="group-title">${title}</span><span class="group-meta">${escapeHtml(meta)}</span></summary><div class="group-body">${body}</div></details>`;

export function usedSummaryHtml(summary: UsedSummary): string {
  const tools = Array.isArray(summary.tools) ? summary.tools : [];
  const reads = Array.isArray(summary.skillsRead) ? summary.skillsRead : [];
  const partial = Array.isArray(summary.skillsPartial) ? summary.skillsPartial : [];
  const suggested = Array.isArray(summary.skillsSuggested) ? summary.skillsSuggested : [];
  const readNames = new Set(reads.map((skill) => skill.name));
  const partialNames = new Set(partial.map((skill) => skill.name));
  const suggestedOnly = Array.isArray(summary.skillsSuggestedOnly) ? summary.skillsSuggestedOnly : suggested.filter((name) => !readNames.has(name) && !partialNames.has(name));
  const skillTotals = summary.skillTotals ?? { read: reads.length, partial: partial.length, suggested: suggested.length, suggestedOnly: suggestedOnly.length, omitted: 0 };
  const models = Array.isArray(summary.models) ? summary.models : (summary.routes ?? []).map((route) => ({
    route: route.route, current: false, turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
    reasoning: 0, errors: 0, selections: 1, thinking: route.thinking ? [route.thinking] : [],
    routing: route.nested ? [route.nested] : [], endpoints: route.endpoint ? [route.endpoint] : [], sources: route.source ? [route.source] : [],
  }));
  const runs = Array.isArray(summary.runs) ? summary.runs : [];
  const agents = summary.agents ?? { total: runs.length, active: 0, completed: 0, failed: 0, stopped: 0, paused: 0, unknown: 0, shown: runs.length, omitted: 0 };
  const logicalTasks = Array.isArray((summary as Record<string, unknown>).logicalTasks) ? (summary as unknown as { logicalTasks: LogicalChildTask[] }).logicalTasks : [];
  const attemptsTotal = typeof (summary as Record<string, unknown>).attemptsTotal === "number" ? (summary as unknown as { attemptsTotal: number }).attemptsTotal : 0;
  const unresolvedLinkage = typeof (summary as Record<string, unknown>).unresolvedLinkage === "number" ? (summary as unknown as { unresolvedLinkage: number }).unresolvedLinkage : 0;
  const linkageNotes = Array.isArray((summary as Record<string, unknown>).linkageNotes) ? (summary as unknown as { linkageNotes: string[] }).linkageNotes : [];
  const session = summary.session ?? { responses: 0, toolCalls: 0, toolResults: tools.reduce((sum, tool) => sum + tool.count, 0), parentErrors: 0, blockedTools: 0, compactions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cacheRate: null, childTokens: 0, hookCalls: null, hookChanged: null, hookErrors: null, cost: "$?", costUnknown: true, costPending: 0 };
  const hooks = Array.isArray(summary.hooks) ? summary.hooks : [];
  const sections: string[] = [
    `<h1>📊 What this session used</h1><p class="sub">Snapshot of ${formatCount(summary.inspected)} retained branch entries. Select any section or row to expand its details.</p>`,
    `<div class="overview"><div class="stat"><strong>${formatCount(models.length + (summary.modelsOmitted ?? 0))}</strong><span>model routes recorded</span></div><div class="stat"><strong>${formatCount(summary.toolDistinctTotal ?? tools.length)}</strong><span>distinct tools used</span></div><div class="stat"><strong>${formatCount(skillTotals.read)}</strong><span>skills fully opened</span></div><div class="stat"><strong>${formatCount(agents.total)}</strong><span>child agents observed</span></div></div>`,
    `<p class="note">Counts describe recorded session activity. “Suggested” is not the same as opened or applied; missing model or usage data stays explicitly unknown.</p>`,
  ];

  const modelTurns = models.reduce((sum, model) => sum + model.turns, 0);
  const modelBody = models.length ? models.map((model) => {
    const traffic = model.input + model.cacheRead + model.cacheWrite + model.output;
    const badges = [
      ...(model.current ? [`<span class="badge current">● current</span>`] : []),
      `<span class="badge info">${plural(model.turns, "turn")}</span>`,
      ...(model.errors ? [`<span class="badge failed">${plural(model.errors, "error")}</span>`] : []),
    ].join(" ");
    return `<details class="item"${model.current ? " open" : ""}><summary><span class="item-name">${escapeHtml(model.route)}</span><span class="item-meta">${badges}</span></summary>${factGrid([
      ["Current route", model.current ? "yes" : "no"],
      ["Recorded use", model.turns ? plural(model.turns, "usage-bearing assistant turn") : "no assistant response usage recorded"],
      ["Token traffic", `${formatCount(traffic)} total · ${formatCount(model.input)} input · ${formatCount(model.cacheRead)} cache read · ${formatCount(model.cacheWrite)} cache write · ${formatCount(model.output)} output`],
      ["Reasoning", `${formatCount(model.reasoning)} tokens (included in output)`],
      ["Errors", formatCount(model.errors)],
      ["Selections", model.selections ? plural(model.selections, "recorded selection") : "none recorded"],
      ["Thinking levels", model.thinking.length ? model.thinking.join(", ") : "not recorded"],
      ["OpenRouter routing", model.routing.length ? model.routing.join(" · ") : "not recorded"],
      ["Recovery endpoints", model.endpoints.length ? model.endpoints.join(", ") : "none recorded"],
      ["Selection sources", model.sources.length ? model.sources.join(", ") : "not recorded"],
    ])}</details>`;
  }).join("") + ((summary.modelsOmitted ?? 0) ? `<p class="note">${plural(summary.modelsOmitted, "older model route")} omitted from this bounded view.</p>` : "") : `<div class="empty">No model route was recorded.</div>`;
  sections.push(group("🧠 Models used", `${plural(models.length + (summary.modelsOmitted ?? 0), "route")} · ${plural(modelTurns, "turn")}`, `<p class="note">A selected route can appear before it produces a response. Token totals come only from recorded usage.</p>${modelBody}`, true));

  const skillsBody = reads.length || partial.length || suggestedOnly.length
    ? `${reads.length ? `<h3>Fully opened (${reads.length})</h3><ul>${reads.map((skill) => usedRow(`📖 ${skill.name}`, skill.count ? plural(skill.count, "full read") : "recorded", suggested.includes(skill.name) ? "also suggested" : undefined, "read")).join("")}</ul>` : ""}` +
      `${partial.length ? `<h3>Partially opened only (${partial.length})</h3><ul>${partial.map((skill) => usedRow(`📄 ${skill.name}`, skill.count ? plural(skill.count, "partial read") : "recorded", "not fully read in the retained branch", "partial")).join("")}</ul>` : ""}` +
      `${suggestedOnly.length ? `<h3>Suggested, not opened (${suggestedOnly.length})</h3><ul>${suggestedOnly.map((name) => usedRow(`💡 ${name}`, "suggested", "no read recorded", "info")).join("")}</ul>` : ""}`
    : `<div class="empty">No skill activity was recorded.</div>`;
  sections.push(group("📚 Skills", `${skillTotals.read} fully opened · ${skillTotals.partial} partial only · ${skillTotals.suggestedOnly} suggested only`, `<p class="note">“Fully opened” means the complete SKILL.md was recorded as read. It does not prove every instruction was applied.</p>${skillsBody}${skillTotals.omitted ? `<p class="note">${plural(skillTotals.omitted, "older skill detail")} omitted from this bounded list; the totals above include them.</p>` : ""}`, true));

  const agentBadges = [
    `<span class="badge info">${agents.total} total</span>`,
    ...(agents.active ? [`<span class="badge active">${agents.active} active</span>`] : []),
    ...(agents.completed ? [`<span class="badge complete">${agents.completed} completed</span>`] : []),
    ...(agents.failed ? [`<span class="badge failed">${agents.failed} failed</span>`] : []),
    ...(agents.stopped ? [`<span class="badge info">${agents.stopped} stopped</span>`] : []),
    ...(agents.paused ? [`<span class="badge active">${agents.paused} paused</span>`] : []),
    ...(agents.unknown ? [`<span class="badge info">${agents.unknown} unknown</span>`] : []),
  ].join("");
  const runBody = runs.length ? runs.map((run, index) => {
    const route = run.provider && run.model ? `${run.provider}/${run.model}` : run.model ?? "model not recorded";
    const who = run.agent ? run.agent : `Agent ${index + 1}`;
    return `<details class="item"><summary><span class="item-name">${escapeHtml(who)} · ${escapeHtml(route)}</span><span class="badge ${statusTone(run.status)}">${escapeHtml(run.status)}</span></summary>${factGrid([
      ["Parent run", run.runId],
      ["Child run", run.childRunId ?? "not recorded"],
      ["Child position", Number.isInteger(run.index) ? `#${Number(run.index) + 1}` : "not recorded"],
      ["Launch mode", run.mode ?? "not recorded"],
      ["Agent", run.agent ?? "not recorded"],
      ["Provider", run.provider ?? "not recorded"],
      ["Model", run.model ?? "not recorded"],
      ["Thinking", run.thinking ?? "not recorded"],
      ["Last status", run.status],
      ["Token traffic", run.usageRecorded ? formatCount(run.tokens) : "not recorded"],
      ["Turns", run.turns === undefined ? "not recorded" : formatCount(run.turns)],
      ["Cost", run.costUsd === undefined ? "not recorded" : `$${run.costUsd.toFixed(6)}`],
    ])}</details>`;
  }).join("") : `<div class="empty">No child-agent run was recorded.</div>`;
  const taskBody = logicalTasks.length ? logicalTasks.map((task) => {
    const attemptRows = task.attempts.map((attempt) => {
      const cause = attempt.execution.cause;
      return `<details class="item"><summary><span class="item-name">Attempt ${attempt.attempt}${attempt.route ? ` · ${escapeHtml(attempt.route)}` : ""}</span><span class="badge ${statusTone(attempt.state)}">${escapeHtml(attempt.state)}</span></summary>${factGrid([
        ["Run", attempt.runId ?? "not recorded"],
        ["Route", attempt.route ?? "not recorded"],
        ["Backend", attempt.backend ?? "not recorded"],
        ["Execution", cause ? `${attempt.execution.status} (${cause.category}${cause.truncation !== "none" ? `, ${cause.truncation}` : ""})` : attempt.execution.status],
        ["Acceptance", attempt.acceptance.status + (attempt.acceptance.reason ? ` · ${attempt.acceptance.reason}` : "")],
        ["Usage", attempt.usage ? `${formatCount(attempt.usage.input ?? 0)} in · ${formatCount(attempt.usage.output ?? 0)} out` : "not recorded"],
        ["Exit code", attempt.exitCode === undefined ? "not recorded" : String(attempt.exitCode)],
      ])}</details>`;
    }).join("");
    return `<details class="item"><summary><span class="item-name">${escapeHtml(task.label)}</span><span class="badge ${statusTone(task.state)}">${escapeHtml(task.state)}</span></summary>${factGrid([
      ["Task", task.taskId],
      ["Todo", task.todoId ?? "not linked"],
      ["Scope", task.scopeId ?? "not recorded"],
      ["Agent", task.agent ?? "not recorded"],
      ["Execution", task.execution.cause ? `${task.execution.status} (${task.execution.cause.category})` : task.execution.status],
      ["Acceptance", task.acceptance.status],
      ["Attempts", plural(task.attempts.length, "attempt")],
    ])}${attemptRows}</details>`;
  }).join("") : `<div class="empty">No logical child task was recorded.</div>`;
  const linkageNote = unresolvedLinkage ? `<p class="note">${plural(unresolvedLinkage, "evidence item")} with unresolved linkage (missing lifecycle evidence) — not omitted rows. ${linkageNotes.length ? escapeHtml(linkageNotes.slice(0, 3).join(" · ")) : ""}</p>` : "";
  sections.push(group("🧩 Logical child tasks", `${agents.total} tasks · ${attemptsTotal} attempts`, `<p class="note">One logical task per delegated scope; retries are attempts under it, never anonymous new runs.</p>${taskBody}${linkageNote}`, true));
  sections.push(group("🤖 Child agent runs", `${agents.total} observed · ${agents.active} active · ${agents.failed} failed`, `<div class="status-line">${agentBadges}</div><p class="note">Forensic run rows (launch-level detail). Canonical state lives in Logical child tasks above.</p>${runBody}${agents.omitted ? `<p class="note">${plural(agents.omitted, "agent detail row")} omitted from this bounded view.</p>` : ""}${linkageNote}`, true));

  const toolErrorsTotal = tools.reduce((sum, tool) => sum + (tool.errors ?? 0), 0);
  sections.push(group("🔧 Tools", `${summary.toolDistinctTotal ?? tools.length} distinct · ${session.toolResults} results · ${toolErrorsTotal} failed`, tools.length ? `<p class="note">Counts are returned tool-result records, not a quality score.</p><ul>${tools.map((tool) => usedRow(tool.name, plural(tool.count, "result"), tool.errors ? `${plural(tool.errors, "failed result")}` : "no recorded failures", tool.errors ? "failed" : "info")).join("")}</ul>${summary.toolsOmitted ? `<p class="note">${plural(summary.toolsOmitted, "lower-volume tool")} omitted from this bounded list; the distinct total includes them.</p>` : ""}` : `<div class="empty">No tool result was recorded.</div>`));

  const review = summary.reviews;
  const coordinationBody = `<ul>${usedRow("🐝 Parallel agent groups (swarms)", plural(summary.swarms, "group"), "verified parallel child groups")}${usedRow("🌀 Multi-answer syntheses (fusions)", plural(summary.fusions, "fusion"), "recorded answer-combination operations")}${usedRow("🛟 Recovery plans", plural(summary.recoveries, "plan"), "recorded provider-recovery activity")}</ul>` +
    `<h3>Scope decisions (${summary.councils.length})</h3><ul>${summary.councils.length ? summary.councils.map((council, index) => usedRow(`🏛️ Decision ${index + 1}`, council.status, `${plural(council.evidence, "evidence item")}${council.incomplete ? " · incomplete" : ""}`, statusTone(council.status))).join("") : `<li><span class="empty">None recorded</span></li>`}</ul>`;
  sections.push(group("⚡ Coordination", `${summary.swarms} parallel groups · ${summary.fusions} fusions · ${summary.recoveries} recoveries`, coordinationBody));
  const reviewBody = `<ul>${review ? usedRow(`🔍 ${plural(review.rounds, "round")}`, review.disposition, review.aspects.length ? review.aspects.map((aspect) => `${aspect.aspect}: ${aspect.outcome}`).join(" · ") : "no aspect reports", statusTone(review.disposition)) : `<li><span class="empty">No review recorded</span></li>`}</ul>`;
  sections.push(group("🔍 Reviews", review ? `${plural(review.rounds, "round")} · ${review.disposition}` : "none recorded", `<p class="note">Reviews consume evidence; a review count is never a quality signal.</p>${reviewBody}`));

  const promptTokens = session.input + session.cacheRead + session.cacheWrite;
  sections.push(group("💰 Cost", session.cost, factGrid([
    ["Recorded cost", `${session.cost}${session.costUnknown ? " · incomplete/unknown coverage" : ""}${session.costPending ? ` · ${plural(session.costPending, "child operation")} pending` : ""}`],
    ["Child token traffic", formatCount(session.childTokens)],
  ]) + `<p class="note">Unknown cost is never rendered as $0. Verified zero and missing evidence are distinct states.</p>`));
  sections.push(group("🧠 Context/cache", session.cacheRate === null ? "reuse unknown" : `${session.cacheRate.toFixed(2)}% reuse`, factGrid([
    ["Prompt traffic", `${formatCount(promptTokens)} tokens · ${formatCount(session.input)} uncached input · ${formatCount(session.cacheRead)} cache read · ${formatCount(session.cacheWrite)} cache write`],
    ["Output", `${formatCount(session.output)} tokens · ${formatCount(session.reasoning)} reported reasoning (included in output)`],
    ["Prompt cache reuse", session.cacheRate === null ? "unknown" : `${session.cacheRate.toFixed(2)}% cumulative`],
    ["Compactions", formatCount(session.compactions)],
  ])));
  const hookHtml = hooks.length ? `<ul>${hooks.map((hook) => usedRow(hook.name, plural(hook.calls, "call"), `${plural(hook.changed, "returned result")} · ${plural(hook.errors, "error")} · ${Math.round(hook.ms)} ms`, hook.errors ? "failed" : "info")).join("")}</ul>` : `<div class="empty">No hook measurement was recorded.</div>`;
  sections.push(group("🪝 Hooks", session.hookCalls === null ? "unknown before telemetry" : plural(session.hookCalls, "call"), factGrid([
    ["Hook checks", session.hookCalls === null ? "unknown before telemetry" : `${formatCount(session.hookCalls)} calls · ${formatCount(session.hookChanged ?? 0)} returned results · ${formatCount(session.hookErrors ?? 0)} errors`],
  ]) + hookHtml));
  const failuresTotal = session.parentErrors + toolErrorsTotal;
  sections.push(group("🚨 Failures/recovery", `${failuresTotal} recorded · ${summary.recoveries} recoveries`, factGrid([
    ["Parent failures", `${formatCount(session.parentErrors)} total · ${formatCount(session.blockedTools)} blocked tools`],
    ["Tool failures", formatCount(toolErrorsTotal)],
    ["Child failures", formatCount(agents.failed)],
    ["Recovery plans", formatCount(summary.recoveries)],
    ["Unresolved linkage", unresolvedLinkage ? `${formatCount(unresolvedLinkage)} (missing lifecycle evidence)` : "none"],
  ]) + `<p class="note">Recovery is cause-specific; see Logical child tasks for per-attempt causes.</p>`));
  const sessionFactsHtml = factGrid([
    ["Retained branch entries", formatCount(summary.inspected)],
    ["Main responses", formatCount(session.responses)],
    ["Tool traffic", `${formatCount(session.toolCalls)} calls · ${formatCount(session.toolResults)} results`],
    ["Compactions", formatCount(session.compactions)],
  ]);
  sections.push(group("🧾 Session totals", `${session.responses} responses · ${session.compactions} compactions · ${session.cost}`, sessionFactsHtml));
  return sections.join("");
}

export function sysPromptHtml(snapshot: SysSnapshot): string {
  const facts = [
    ["captured", snapshot.at],
    ...(snapshot.model ? [["model", snapshot.model]] : []),
    ["tools", `${snapshot.toolCount} registered`],
  ];
  return `<h1>📜 Session system prompt</h1><p class="sub">First provider request of this session — exactly what the agent saw initially.</p>` +
    `<table class="facts">${facts.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</table>` +
    (snapshot.tools.length ? `<div class="chips">${snapshot.tools.map((tool) => `<span>${escapeHtml(tool)}</span>`).join("")}</div>` : "") +
    `<pre>${escapeHtml(snapshot.system)}</pre>`;
}

export function commandsHtml(commands: { name: string; description?: string; source?: string }[]): string {
  const rows = [...commands]
    .filter((command) => command && typeof command.name === "string" && command.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  return `<h1>⌨️ Slash commands</h1><p class="sub">${rows.length} registered</p><ul>${
    rows.length
      ? rows.map((command) => `<li><code class="row">/${escapeHtml(command.name)}${command.description ? ` <span class="dim">${escapeHtml(command.description)}</span>` : ""}</code></li>`).join("")
      : "<li><span class=\"dim\">—</span></li>"
  }</ul>`;
}

const COPY_SCRIPT = `<script>(function(){var btn=document.getElementById('copy-errors'),status=document.getElementById('copy-status');if(!btn)return;btn.addEventListener('click',function(){var el=document.getElementById('errors-json');var text=el?el.textContent:'';function done(msg){if(status)status.textContent=msg;}function fallback(){try{var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);done('Copied.');}catch(e){done('Copy failed — select the JSON manually.');}}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){done('Copied.');},fallback);}else{fallback();}});})();</script>`;

/** Deep session errors: per-error drill-down plus the full bounded JSON with a copy button. Newest first. */
export function errorsHtml(report: SessionErrorsReport): string {
  const errors = Array.isArray(report?.errors) ? report.errors : [];
  const groups = Array.isArray(report?.groups) ? report.groups : [];
  const signatures = Array.isArray(report?.signatures) ? report.signatures : [];
  const hookErrors = Array.isArray(report?.hookErrors) ? report.hookErrors : [];
  const byKind = report?.byKind && typeof report.byKind === "object" ? report.byKind : {};
  const oneLine = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "no excerpt";
  const sections: string[] = [
    `<h1>🚨 Session errors</h1><p class="sub">${formatCount(report?.total ?? 0)} errors in ${formatCount(report?.inspected ?? 0)} retained branch entries. Newest first. The JSON block is the copy source.</p>`,
    `<div class="copy-row"><button id="copy-errors" type="button">Copy JSON</button><span id="copy-status" class="dim"></span></div>`,
    `<div class="overview"><div class="stat"><strong>${formatCount(report?.total ?? 0)}</strong><span>errors recorded</span></div><div class="stat"><strong>${formatCount(byKind.tool ?? 0)}</strong><span>tool failures</span></div><div class="stat"><strong>${formatCount((byKind.model ?? 0) + (byKind.child ?? 0) + (byKind.workflow ?? 0))}</strong><span>model / child / workflow</span></div><div class="stat"><strong>${formatCount(hookErrors.reduce((sum, row) => sum + row.errors, 0))}</strong><span>hook errors</span></div></div>`,
  ];
  sections.push(group("🧮 Groups", `${groups.length} groups`, groups.length ? `<ul>${groups.map((item) => usedRow(`${item.kind} / ${item.tool} / ${item.category}`, plural(item.count, "error"), undefined, "failed")).join("")}</ul>${report?.omittedGroups ? `<p class="note">${plural(report.omittedGroups, "group")} omitted.</p>` : ""}` : `<div class="empty">No error groups.</div>`));
  sections.push(group("🔁 Recurring signatures", `${signatures.length} signatures`, signatures.length ? `<ul>${signatures.map((item) => usedRow(`${item.tool} / ${item.category}`, plural(item.count, "occurrence"), `${item.signature} · entries ${formatCount(item.firstEntry)}–${formatCount(item.lastEntry)}${item.precedingTools?.length ? ` · after: ${item.precedingTools.map((row) => `${row.tool} ×${row.count}`).join(", ")}` : " · no preceding tool context"}`, "failed")).join("")}</ul>${report?.omittedSignatures ? `<p class="note">${plural(report.omittedSignatures, "signature")} omitted.</p>` : ""}<p class="note">One signature is one recurring cause across calls, counted over the full window — not one row per failure. “After” lists the tools most often seen just before it.</p>` : `<div class="empty">No recurring signatures.</div>`));
  const body = errors.length ? errors.map((item) => {
    const usage = item.usage ? `${formatCount(item.usage.input ?? 0)} in · ${formatCount(item.usage.output ?? 0)} out${item.usage.turns !== undefined ? ` · ${formatCount(item.usage.turns)} turns` : ""}` : undefined;
    return `<details class="item"><summary><span class="item-name">#${item.seq} · ${escapeHtml(item.kind)} / ${escapeHtml(item.tool)} · ${escapeHtml(oneLine(item.error))}</span><span class="badge failed">${escapeHtml(item.category)}</span></summary>${factGrid([
      ["Incident", item.incident],
      ["Signature", item.signature ?? "—"],
      ["Module", item.module],
      ["Timestamp", item.timestamp ?? "not recorded"],
      ["Call", item.callId ?? "—"],
      ["Run", item.runId ?? "—"],
      ["Agent", item.agent ?? (item.kind === "child" ? "not recorded" : "—")],
      ["Provider", item.provider ?? (item.kind === "model" || item.kind === "child" ? "not recorded" : "—")],
      ["Model", item.model ?? (item.kind === "model" || item.kind === "child" ? "not recorded" : "—")],
      ["Backend", item.backend ?? "—"],
      ["Route", item.route ?? "—"],
      ["Stop reason", item.stopReason ?? "—"],
      ["Status code", item.statusCode ?? "—"],
      ["Exit code", item.exitCode === undefined ? "—" : String(item.exitCode)],
      ["Attempts", item.attempts === undefined ? "—" : formatCount(item.attempts)],
      ["Output", item.outputPresence ?? "—"],
      ["Execution", item.execution ?? "—"],
      ["Acceptance", item.acceptance ?? "—"],
      ["Usage", usage ?? "—"],
      ["Error chars", `${formatCount(item.errorChars)}${item.truncated ? " · truncated" : ""}`],
    ])}<p class="note">${escapeHtml(item.why)}</p><h3>Error</h3><pre>${escapeHtml(item.error) || "—"}</pre>${item.payload !== undefined ? `<h3>Failed payload (redacted)</h3><pre>${escapeHtml(JSON.stringify(item.payload, null, 2))}</pre>` : ""}${item.details !== undefined ? `<h3>Details (redacted)</h3><pre>${escapeHtml(JSON.stringify(item.details, null, 2))}</pre>` : ""}</details>`;
  }).join("") : `<div class="empty">No tool, model, child or workflow failures in this window. This does not certify task quality.</div>`;
  sections.push(group("📋 Errors (newest first)", `${errors.length} shown${report?.omitted ? ` · ${report.omitted} omitted` : ""}`, body, true));
  sections.push(group("🪝 Hook errors", `${hookErrors.length} hooks`, hookErrors.length ? `<ul>${hookErrors.map((row) => usedRow(`${row.owner}:${row.hook}`, plural(row.errors, "error"), `${plural(row.calls, "call")} · ${Math.round(row.ms)} ms`, "failed")).join("")}</ul><p class="note">Telemetry summaries without excerpts; inspect the named owner.</p>` : `<div class="empty">No hook errors recorded.</div>`));
  let json = "[]";
  try {
    json = JSON.stringify(report, null, 2);
  } catch {
    json = JSON.stringify({ total: report?.total ?? 0, errors: [], note: "report was not serializable" });
  }
  sections.push(`<h2>JSON (copy source)</h2><pre id="errors-json">${escapeHtml(json)}</pre>${COPY_SCRIPT}`);
  return sections.join("");
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) =>
      part?.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** This session's own user turns — the request list an agent otherwise has to
 * reconstruct from a truncated branch. Bounded and sanitized for output. */
function sessionMessages(ctx: any) {
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  const all = branch.filter(
    (entry: any) => entry?.type === "message" && entry.message?.role === "user",
  );
  const selected = all.slice(-MESSAGE_LIMIT);
  return {
    view: "messages",
    total: all.length,
    omitted: all.length - selected.length,
    items: selected.map((entry: any, index: number) => {
      const text = reportText(messageText(entry.message?.content));
      return {
        ordinal: all.length - selected.length + index + 1,
        timestamp: entry.timestamp ?? null,
        chars: text.length,
        text:
          text.length > MESSAGE_CHARS
            ? `${text.slice(0, MESSAGE_CHARS)}…`
            : text,
      };
    }),
  };
}

/** Per-child subagent usage from the transcript ledger. A row without usage is a
 * non-terminal placeholder, not zero traffic; live runner totals can be higher
 * until the run settles. */
function sessionChildren(ctx: any) {
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  const rows = new Map<string, any>();
  for (const entry of branch) {
    if (entry?.type !== "custom" || entry.customType !== "subagent-cost-v1")
      continue;
    const data = entry.data ?? {};
    for (const result of data.results ?? []) {
      const key = `${data.runId ?? "unknown"}:${result?.index ?? rows.size}`;
      const previous = rows.get(key);
      const usage = result?.usage;
      const total = usage
        ? ["input", "output", "cacheRead", "cacheWrite"].reduce(
            (sum: number, field: string) =>
              sum + (Number.isFinite(usage[field]) ? usage[field] : 0),
            0,
          )
        : 0;
      rows.set(key, {
        runId: data.runId ?? null,
        index: result?.index ?? null,
        mode: data.mode ?? null,
        state: data.state ?? null,
        status:
          result?.status ??
          result?.state ??
          (result?.success === true
            ? "completed"
            : result?.success === false
              ? "failed"
              : null),
        model: result?.model ?? previous?.model ?? null,
        exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
        turns: usage?.turns ?? previous?.turns ?? null,
        tokens: Math.max(previous?.tokens ?? 0, total),
        usage: usage
          ? {
              input: usage.input ?? 0,
              output: usage.output ?? 0,
              cacheRead: usage.cacheRead ?? 0,
              cacheWrite: usage.cacheWrite ?? 0,
            }
          : (previous?.usage ?? null),
        costUsd: usage?.cost?.total ?? previous?.costUsd ?? null,
        sessionFile: result?.sessionFile
          ? path.basename(result.sessionFile)
          : (previous?.sessionFile ?? null),
      });
    }
  }
  const list = [...rows.values()];
  return {
    view: "children",
    runs: new Set(list.map((row) => row.runId)).size,
    total: list.length,
    omitted: Math.max(0, list.length - CHILD_ROW_LIMIT),
    rows: list.slice(-CHILD_ROW_LIMIT),
    note: "Transcript ledger rows only; absence of usage means the row was recorded before the child settled, not that it used no tokens.",
  };
}

/** Workflow usage: suggested vs actually read, plus capability call counts. */
function sessionSkills(ctx: any) {
  const entries = ctx?.sessionManager?.getEntries?.() ?? [];
  const metrics = collectSessionMetrics(entries);
  const capabilityTools = [
    "project_report",
    "module_report",
    "symbol_search",
    "context_slice",
    "context_score",
    "handoff_capsule",
    "evidence_cache",
    "quality_review",
    "skill_review",
    "subagent",
    "bg_wait",
    "web_search",
    "browser_session",
    // Session introspection without shell archaeology: email, background,
    // project, planning and research bundles are capability usage too.
    "agentmail_status",
    "agentmail_send",
    "agentmail_messages",
    "agentmail_search",
    "agentmail_message",
    "bg_run",
    "bg_status",
    "bg_logs",
    "bg_kill",
    "project_intel",
    "project_tests",
    "todo",
    "tool_search",
    "obs_read",
    "checkpoint_read",
    "research_toolkit",
    "web_research",
    "fetch_content",
    "source_check",
    "lsp_diagnostics",
    "symbol_expand",
    "syntax_check",
  ];
  return {
    view: "skills",
    suggested: metrics.skillsRouted,
    read: metrics.skillsRead,
    partial: metrics.skillsPartial,
    suggestedWithoutRead: metrics.skillsRouted.filter(
      (name: string) =>
        !metrics.skillsRead.includes(name) &&
        !metrics.skillsPartial.includes(name),
    ),
    capabilityUses: Object.fromEntries(
      Object.entries(metrics.tools).filter(([name]) =>
        capabilityTools.includes(name),
      ),
    ),
    note: "Suggested means routed, not read; a read is not proof the workflow was applied.",
  };
}

/** The full bounded session report (failures, traffic, capability gaps, hook
 * health, review state) that the /metrics panel renders. */
function sessionReport(pi: ExtensionAPI, ctx: any) {
  const entries = ctx?.sessionManager?.getEntries?.() ?? [];
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  const activeTools =
    typeof pi.getActiveTools === "function" ? pi.getActiveTools() : undefined;
  const { lines } = buildSessionReport(entries, branch, undefined, activeTools);
  const text = lines.join("\n");
  return {
    view: "report",
    chars: text.length,
    text:
      text.length > REPORT_CHARS
        ? `${text.slice(0, REPORT_CHARS)}\n[truncated; ${text.length} characters total]`
        : text,
  };
}

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

/** Harness system-prompt line: reuse before reinvention. A fixed string so the
 * prompt prefix stays byte-stable for provider caching. */
export const HARNESS_TOOL_FIRST =
  "Choose capabilities for the next decision: use an active tool directly; search tool_search for missing tools and skill_review for a relevant workflow before rebuilding one. Exact names avoid unnecessary inference. Enable selected tools, then use them on the next model turn in this request. Read a selected SKILL.md before applying it; descriptions and helper suggestions are advisory, not authority or proof.";

export default function (pi: any) {
  // First-request system snapshots, in memory plus one runtime file per
  // session so /sys-prompt survives a reload. Runtime state, never exported.
  const sysSnapshots = new Map<string, SysSnapshot>();
  const sysSnapshotFile = (sid: string) =>
    path.join(sysPromptDir(), `${sanitizeFileSegment(sid)}.json`);
  const readSysSnapshot = (ctx: any): SysSnapshot | undefined => {
    let sid = "";
    try {
      sid = ctx?.sessionManager?.getSessionId?.() ?? "";
    } catch {
      return undefined;
    }
    if (!sid) return undefined;
    const live = sysSnapshots.get(sid);
    if (live) return live;
    try {
      const raw = JSON.parse(fs.readFileSync(sysSnapshotFile(sid), "utf8"));
      if (raw && typeof raw.system === "string" && raw.system) {
        const snapshot: SysSnapshot = {
          at: typeof raw.at === "string" ? raw.at : "",
          model: typeof raw.model === "string" ? raw.model : undefined,
          system: raw.system.slice(0, SYS_SYSTEM_CAP + 256),
          truncated: raw.truncated === true,
          tools: Array.isArray(raw.tools) ? raw.tools.filter((tool: unknown) => typeof tool === "string").slice(0, 300) : [],
          toolCount: Number.isSafeInteger(raw.toolCount) ? raw.toolCount : 0,
        };
        sysSnapshots.set(sid, snapshot);
        return snapshot;
      }
    } catch {
      // No usable snapshot on disk.
    }
    return undefined;
  };
  const storeSysSnapshot = (sid: string, snapshot: SysSnapshot): void => {
    sysSnapshots.set(sid, snapshot);
    try {
      fs.mkdirSync(sysPromptDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(sysSnapshotFile(sid), JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
      pruneStaleFiles(sysPromptDir(), 30 * 24 * 3600_000, `${sanitizeFileSegment(sid)}.json`);
    } catch {
      // The memory snapshot still serves this session.
    }
  };
  // Opening-prompt snapshots captured at before_agent_start are provisional:
  // the first parseable provider envelope upgrades them to wire truth.
  const provisionalSys = new Set<string>();
  const captureSysSnapshot = (payload: unknown, ctx: any): void => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    let sid = "";
    try {
      sid = ctx?.sessionManager?.getSessionId?.() ?? "";
    } catch {
      return;
    }
    if (!sid) return;
    if (sysSnapshots.has(sid) && !provisionalSys.has(sid)) return;
    if (!sysSnapshots.has(sid) && readSysSnapshot(ctx)) return;
    const snapshot = extractSysSnapshot(payload);
    if (!snapshot) return;
    // Some wire payloads (e.g. Google) carry no model id; the request context
    // identifies it.
    if (!snapshot.model && typeof ctx?.model?.id === "string" && ctx.model.id)
      snapshot.model = ctx.model.id.slice(0, 200);
    // Some envelopes omit the wire tool list; fall back to the live registry
    // so the snapshot still names what the session could call.
    if (!snapshot.toolCount) {
      try {
        const active = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
        if (Array.isArray(active) && active.length) {
          snapshot.tools = active.map((tool) => String(tool).slice(0, 160)).slice(0, 300);
          snapshot.toolCount = active.length;
        }
      } catch {
        // Wire truth stands without the fallback.
      }
    }
    storeSysSnapshot(sid, snapshot);
    provisionalSys.delete(sid);
  };
  /** Failsafe capture from the assembled opening prompt. Provider payload
   * shapes drift per API; this keeps /sys-prompt working even for an
   * envelope extractSysSnapshot does not understand yet. */
  const captureSysText = (systemText: unknown, ctx: any): void => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    if (typeof systemText !== "string" || !systemText) return;
    let sid = "";
    try {
      sid = ctx?.sessionManager?.getSessionId?.() ?? "";
    } catch {
      return;
    }
    if (!sid || sysSnapshots.has(sid)) return;
    if (readSysSnapshot(ctx)) return;
    const truncated = systemText.length > SYS_SYSTEM_CAP;
    let tools: string[] = [];
    try {
      const active = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
      if (Array.isArray(active)) tools = active.map((tool) => String(tool).slice(0, 160)).slice(0, 300);
    } catch {
      tools = [];
    }
    storeSysSnapshot(sid, {
      at: new Date().toISOString(),
      model: typeof ctx?.model?.id === "string" ? ctx.model.id.slice(0, 200) : undefined,
      system: truncated
        ? `${systemText.slice(0, SYS_SYSTEM_CAP)}\n[…truncated; ${systemText.length} characters total]`
        : systemText,
      truncated,
      tools,
      toolCount: tools.length,
    });
    provisionalSys.add(sid);
  };
  const openHtmlPopup = async (kind: string, title: string, bodyHtml: string, ctx: any): Promise<string> => {
    let sid = "";
    try {
      sid = ctx?.sessionManager?.getSessionId?.() ?? "";
    } catch {
      sid = "";
    }
    const dir = popupDir();
    const file = writePopupFile(dir, `${kind}-${sanitizeFileSegment(sid || "session")}.html`, renderPopupHtml(title, bodyHtml));
    pruneStaleFiles(dir, 7 * 24 * 3600_000, path.basename(file));
    if (ctx.hasUI === false) return file;
    const error = await openExternal(pathToFileURL(file).href);
    if (error) throw new Error(`Could not open a browser window: ${error}. Open the popup manually: ${file}`);
    return file;
  };
  const popupError = (command: string, error: unknown, ctx: any) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.("hook.error", { hook: "command", owner: "session-signals.ts", isError: true });
    } catch { /* A diagnostic sink cannot hide the original failure. */ }
    try {
      ctx.ui?.notify?.(`/${command} failed: ${message.slice(0, 300)}`, "error");
    } catch {
      // Notification is best-effort.
    }
  };
  pi.registerCommand("cost", {
    description:
      "Session cost by model, child runs and auxiliary usage, with pricing coverage",
    handler: async (_args: string, ctx: any) => {
      const cost = collectSessionCost(ctx.sessionManager.getEntries());
      const money = (n: number) =>
        n > 0 && n < 0.000001 ? `$${n.toExponential(3)}` : `$${n.toFixed(6)}`;
      const lines = [
        `${cost.formatted} total (USD)`,
        `Provider-reported: ${money(cost.reported)}; estimated: ${money(cost.estimated)}.`,
        ...cost.rows.map(
          (r: any) =>
            `${r.scope} · ${r.route}: ${money(r.reported + r.estimated)}${r.estimatedUsage ? " estimated" : ""}${r.unknown ? " + unpriced usage" : ""}${r.subscription ? " · subscription" : ""}`,
        ),
        ...(cost.pending
          ? [`${cost.pending} child operation(s) awaiting final cost evidence.`]
          : []),
        ...(cost.unknown
          ? [
              "Partial total: some recorded activity has missing prices or usage.",
            ]
          : []),
        "Main responses, child runs, retries, compactions and usage-bearing tools are included when recorded. Repeated child snapshots count once.",
        "Estimates use the rates attached to each response. Provider-reported amounts take precedence. Unreported external tools, storage, taxes, credit purchases and subscription fees are outside this total.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
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
  let anchorText: string | undefined;
  const resetPressureSignals = () => {
    pressureGeneration++;
    anchorText = undefined; // session/model boundary: the prefix is rebuilt anyway
  };
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
    const risk = riskAnnounced
      ? undefined
      : payloadPressureWarning(contextPercent);
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
    let abortedDropped = 0;
    const isAbortedEmpty = (m: any) => {
      if (m?.role !== "assistant") return false;
      const content = (m as any).content;
      const hasToolCall = Array.isArray(content) && content.some((p: any) => p?.type === "toolCall");
      if (hasToolCall) return false;
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("")
        : "";
      if (text.trim().length > 0) return false;
      // Only aborted/errored attempts are safe to withhold: provider
      // continuity (e.g. thinking blocks) on successful turns is preserved.
      const stop = (m as any).stopReason;
      return stop === "aborted" || stop === "error";
    };
    const messages = toolJson
      .transform(event.messages)
      .flatMap(
        (m: {
          role: string;
          customType?: string;
          content?: unknown;
          details?: { kind?: string; tag?: string };
        }) => {
          // Aborted/zero-content assistant attempts are telemetry, not
          // model-visible conversation: drop from projection, count in sink.
          if (isAbortedEmpty(m)) { abortedDropped++; return []; }
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
                !(
                  isPressureLine(line) &&
                  (!taggedPressure || staleTaggedPressure)
                ),
            )
            .join("\n");
          return content ? [content === m.content ? m : { ...m, content }] : [];
        },
      );

    if (abortedDropped > 0) {
      try {
        const sink = (globalThis as any)[Symbol.for("yunus-pi.metrics.v1")];
        if (typeof sink === "function") for (let i = 0; i < abortedDropped; i++) sink("aborted");
      } catch { /* telemetry loss must not break projection */ }
    }
    if (
      abortedDropped === 0 &&
      messages.length === event.messages.length &&
      messages.every((m: any, i: number) => m === event.messages[i])
    )
      return;
    return { messages };
  });
  const retainedTokens = (ctx: any): number | null => {
    try {
      const raw = ctx?.getContextUsage?.()?.tokens;
      return Number.isFinite(raw) && raw >= 0 ? raw : null;
    } catch {
      return null;
    }
  };
  const compactTokens = (n: number): string =>
    n >= 1000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`;
  pi.on("model_select", (event: any, ctx: any) => {
    resetPressureSignals();
    outputRequest = undefined;
    requested = undefined;
    thresholds.reset();
    riskAnnounced = false;
    // A mid-session switch to a smaller window can strand the session: when
    // the retained context already exceeds the new window, even the
    // compaction summary request cannot fit. Warn immediately with the
    // numbers instead of letting the next request fail cryptically.
    try {
      const next = event?.model;
      const window = next?.contextWindow;
      if (!Number.isFinite(window) || window <= 0) return;
      const prev = event?.previousModel;
      if (prev && Number.isFinite(prev.contextWindow) && prev.contextWindow <= window) return;
      const tokens = retainedTokens(ctx);
      if (tokens === null || tokens <= window) return;
      ctx.ui?.notify?.(
        `Model switched to ${next.provider ?? "?"}/${next.id ?? "?"} (${compactTokens(window)} context) with ${compactTokens(tokens)} tokens retained — over the new window. Compact with the previous model first (/compact), or start a fresh session; the next request cannot fit otherwise.`,
        "warning",
      );
    } catch {
      // A diagnostics notice must never break model selection.
    }
  });
  pi.on("session_compact_failed", (event: any, ctx: any) => {
    // When automatic compaction fails while retained context still exceeds
    // the window, the summary itself could not fit. Point at the recovery
    // that works instead of leaving the raw headroom error unexplained.
    try {
      if (event?.aborted) return;
      if (event?.reason !== "overflow" && event?.reason !== "threshold") return;
      const window = ctx?.model?.contextWindow;
      if (!Number.isFinite(window) || window <= 0) return;
      const tokens = retainedTokens(ctx);
      if (tokens === null || tokens <= window) return;
      ctx.ui?.notify?.(
        `Compaction (${event.reason}) failed with ${compactTokens(tokens)} tokens retained on a ${compactTokens(window)} window: the summary request itself cannot fit. Switch back to a larger-context model and /compact there, or start a fresh session.`,
        "warning",
      );
    } catch {
      // Notification is best-effort.
    }
  });
  pi.on("before_provider_request", (e: any, ctx: any) => {
    captureSysSnapshot(e?.payload, ctx);
    const p = stableToolOrder(e.payload);
    const changed = p === e.payload ? undefined : p;
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
    // Freeze the date for the whole session: re-anchoring (e.g. a midnight
    // flip) would rewrite the system prompt and with it the entire prompt
    // prefix the provider caches. Current time stays available on demand
    // via session_self.
    if (anchorText === undefined) anchorText = dateAnchor().text;
    // Stable for the whole run, including tool continuations and compaction.
    // Unlike custom messages this is metadata, not a fresh conversational turn.
    const finalSystemPrompt = `${_e.systemPrompt}\n\n${anchorText}\n\n${HARNESS_TOOL_FIRST}`;
    captureSysText(finalSystemPrompt, ctx);
    return {
      systemPrompt: finalSystemPrompt,
      ...(n
        ? {
            message: pressureSignal(n),
          }
        : {}),
    };
  });
  pi.on("turn_end", async (e: any, ctx: any) => {
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
      await pi.sendMessage(pressureSignal(lines.join("\n")), { deliverAs: "steer" });
  });
  const self = (ctx: any) => sessionFacts(ctx.sessionManager.getEntries());
  // Bounded, newest-first failure read: diagnose without re-running any work.
  const recentFailures = (ctx: any) =>
    collectSessionDiagnostics(
      ctx.sessionManager?.getBranch?.() ??
        ctx.sessionManager?.getEntries?.() ??
        [],
    );
  pi.registerCommand("self", {
    description: "Current-session token and failure diagnostics",
    handler: async (_a: any, ctx: any) =>
      ctx.ui.notify(JSON.stringify(self(ctx)), "info"),
  });
  pi.registerCommand("sys-prompt", {
    description:
      "Show this session's captured opening system prompt in a separate window.",
    handler: (_args: string, ctx: any) => {
      // Await only the popup operation, never model idleness or a session abort.
      return (async () => {
        const snapshot = readSysSnapshot(ctx);
        if (!snapshot) {
          ctx.ui?.notify?.(
            "No system prompt captured yet — it is recorded when this session's first agent run starts.",
            "info",
          );
          return;
        }
        const file = await openHtmlPopup("sys-prompt", "Session system prompt", sysPromptHtml(snapshot), ctx);
        ctx.ui?.notify?.(`System prompt ${ctx.hasUI === false ? "saved" : "opened"}: ${file}`, "info");
      })().catch((error) => popupError("sys-prompt", error, ctx));
    },
  });
  pi.registerCommand("used", {
    description:
      "Open expandable session details for models, tools, skills, child agents and Harness activity.",
    handler: (_args: string, ctx: any) => {
      return (async () => {
        let entries: unknown;
        try {
          entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
        } catch (error) {
          throw new Error(
            `Session usage is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const summary = buildUsedSummary(entries, {
          provider: ctx?.model?.provider,
          id: ctx?.model?.id,
          thinking: ctx?.thinkingLevel,
        });
        const file = await openHtmlPopup("used", "What this session used", usedSummaryHtml(summary), ctx);
        ctx.ui?.notify?.(`Detailed session usage ${ctx.hasUI === false ? "saved" : "opened"}: ${file}`, "info");
      })().catch((error) => popupError("used", error, ctx));
    },
  });
  pi.registerCommand("errors", {
    description:
      "Open a detailed JSON list of this session's errors (payloads, modules, causes) with a copy button.",
    handler: (_args: string, ctx: any) => {
      return (async () => {
        let entries: unknown;
        try {
          entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
        } catch (error) {
          throw new Error(
            `Session errors are unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const list = Array.isArray(entries) ? entries : [];
        let ledgerTasks;
        try {
          ledgerTasks = reduceChildEvents(projectTranscriptChildren(list)).tasks;
        } catch {
          ledgerTasks = undefined;
        }
        const report = collectSessionErrors(list, { ledgerTasks });
        const file = await openHtmlPopup("errors", "Session errors", errorsHtml(report), ctx);
        ctx.ui?.notify?.(`Detailed session errors ${ctx.hasUI === false ? "saved" : "opened"}: ${file}`, "info");
      })().catch((error) => popupError("errors", error, ctx));
    },
  });
  pi.registerCommand("commands", {
    description: "List all registered slash commands in a separate window.",
    handler: (_args: string, ctx: any) => {
      return (async () => {
        let registered: unknown;
        try {
          registered = typeof pi.getCommands === "function" ? pi.getCommands() : undefined;
        } catch (error) {
          throw new Error(
            `Command registry is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!Array.isArray(registered)) throw new Error("Command registry is unavailable.");
        const file = await openHtmlPopup(
          "commands",
          "Slash commands",
          commandsHtml(
            registered.map((command: any) => ({
              name: String(command?.name ?? ""),
              description: typeof command?.description === "string" ? command.description : "",
              source: typeof command?.source === "string" ? command.source : "",
            })),
          ),
          ctx,
        );
        ctx.ui?.notify?.(`Command list ${ctx.hasUI === false ? "saved" : "opened"}: ${file}`, "info");
      })().catch((error) => popupError("commands", error, ctx));
    },
  });
  pi.registerTool({
    name: "session_self",
    promptGuidelines: [
      "When useful, explore tool_search or find a task-specific skill with skill_review. Read a SKILL.md on demand when it helps the next decision. Discovery is optional; tool access and suggestions do not grant authorization or prove success.",
    ],
    label: "Session self",
    description:
      "Current session diagnostics. view:context for full-window occupancy, the automatic compaction threshold and separate output/safety headroom; view:failures for grouped tool/model/child/workflow evidence and recovery clues; view:efficiency for the largest returned text and exact repeated request/result pairs; view:runtime for live cwd, model, active tools and background-handle owners; view:messages to list this session's own user messages (bounded); view:children to list subagent usage per child and run (status, model, tokens, cache, cost, turns); view:skills to list suggested, read and partial skill usage plus capability call counts; view:report for the full bounded session report; view:shadow for the control-plane shadow rollup (per-subsystem would-admit/suppress audits, observation only). Use efficiency after repeated inspection or large output to choose focused native tools and evidence reuse. Runtime facts do not authorize new work. session_audit provides aggregate counts from past sessions.",
    parameters: Type.Object({
      view: Type.Optional(
        StringEnum([
          "session",
          "context",
          "runtime",
          "failures",
          "efficiency",
          "messages",
          "children",
          "skills",
          "report",
          "shadow",
        ]),
      ),
    }),
    async execute(_id: any, p: any, _s: any, _u: any, ctx: any) {
      const details =
        p.view === "efficiency"
          ? (() => {
              const traffic = collectContextTraffic(
                ctx.sessionManager.getBranch?.() ??
                  ctx.sessionManager.getEntries(),
              );
              return {
                ...traffic,
                tools: traffic.tools.slice(0, 8),
                omittedTools: Math.max(0, traffic.tools.length - 8),
                interpretation:
                  "Last 2000 branch entries; raw returned characters before projection, not current occupancy or billed tokens. Exact repeated observations can be legitimate polling. Prefer focused source queries, retained evidence, and completion notifications when appropriate; do not skip necessary verification.",
              };
            })()
          : p.view === "failures"
            ? recentFailures(ctx)
            : p.view === "runtime"
              ? runtimeFacts(pi, ctx)
              : p.view === "messages"
                ? sessionMessages(ctx)
                : p.view === "children"
                  ? sessionChildren(ctx)
                  : p.view === "skills"
                    ? sessionSkills(ctx)
                    : p.view === "report"
                      ? sessionReport(pi, ctx)
                      : p.view === "shadow"
                        ? shadowReport()
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

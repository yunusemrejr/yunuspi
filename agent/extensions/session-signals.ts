import { collectSessionDiagnostics } from "./lib/session-diagnostics.ts";
import { shadowReport } from "./lib/intervention-registry.ts";
import {
  collectContextTraffic,
  buildSessionReport,
  reportText,
} from "./lib/session-report.ts";
import { collectSessionMetrics } from "./lib/session-metrics.ts";
import { collectSessionCost } from "./lib/session-cost.ts";
import { scanSessionAudit } from "./lib/session-audit.ts";
import { stableToolOrder } from "./lib/stable-tool-order.ts";
import { createToolJsonCompactor } from "./lib/compact-tool-json.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { openExternal } from "./lib/project-intelligence/viewer.mjs";
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
  "body{margin:0;background:#14161a;color:#e8e6e1;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Color Emoji','Apple Color Emoji','Segoe UI Emoji',sans-serif}",
  "main{max-width:760px;margin:0 auto;padding:20px 22px 34px}",
  "h1{font-size:17px;margin:0 0 4px}",
  "h2{font-size:14px;margin:20px 0 6px;color:#ffd479}",
  "p.sub{margin:0 0 8px;color:#9aa0a8;font-size:12px}",
  "ul{list-style:none;margin:0;padding:0}",
  "li{padding:3px 0;border-bottom:1px solid #26292f;display:flex;gap:8px;align-items:baseline}",
  "li:last-child{border-bottom:0}",
  "code.row{flex:1;overflow-wrap:anywhere}",
  "b.count{color:#8fd0ff;white-space:nowrap}",
  "span.dim{color:#9aa0a8;font-size:12px}",
  "pre{background:#0d0e11;border:1px solid #26292f;border-radius:8px;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}",
  "div.chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}",
  "div.chips span{background:#23262c;border-radius:6px;padding:1px 8px;font-size:12px}",
  "table.facts{border-collapse:collapse;margin:8px 0;font-size:13px}",
  "table.facts td{padding:2px 10px 2px 0;vertical-align:top}",
  "table.facts td:first-child{color:#9aa0a8;white-space:nowrap}",
].join("\n");

export function renderPopupHtml(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${POPUP_CSS}</style></head><body><main>${bodyHtml}</main></body></html>`;
}

export function popupDir(): string {
  return path.join(os.homedir(), ".pi", "popups");
}

export function sysPromptDir(): string {
  return path.join(os.homedir(), ".pi", "sys-prompts");
}

export function sanitizeFileSegment(value: unknown): string {
  const clean = String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return clean || "session";
}

export function writePopupFile(dir: string, fileName: string, html: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, html, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best-effort: the file already holds the bytes.
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

/** First-request envelope only: system text, model id and tool names. Never
 * messages — user content stays out of the snapshot. */
export function extractSysSnapshot(payload: unknown): SysSnapshot | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  let system: string | undefined;
  if (typeof record.system === "string") system = record.system;
  else if (typeof record.systemPrompt === "string") system = record.systemPrompt;
  else if (Array.isArray(record.system)) {
    try {
      system = JSON.stringify(record.system).slice(0, SYS_SYSTEM_CAP);
    } catch {
      system = undefined;
    }
  }
  if (!system) return undefined;
  const truncated = system.length > SYS_SYSTEM_CAP;
  if (truncated) system = `${system.slice(0, SYS_SYSTEM_CAP)}\n[…truncated; ${system.length} characters total]`;
  const rawTools = Array.isArray(record.tools)
    ? record.tools
    : Array.isArray(record.functions)
      ? record.functions
      : [];
  const toolCount = rawTools.length;
  const tools = rawTools
    .slice(0, 300)
    .map((tool: any) => String(tool?.name ?? tool?.function?.name ?? "?").slice(0, 160));
  const model = typeof record.model === "string" ? record.model.slice(0, 200) : undefined;
  return { at: new Date().toISOString(), model, system, truncated, tools, toolCount };
}

export type UsedSummary = {
  tools: { name: string; count: number }[];
  skillsRead: { name: string; count: number }[];
  skillsPartial: { name: string; count: number }[];
  skillsSuggested: string[];
  routes: { route: string; thinking?: string; nested?: string; endpoint?: string; source?: string }[];
  runs: { runId: string; mode?: string; status: string; provider?: string; model?: string; thinking?: string }[];
  swarms: number;
  fusions: number;
  recoveries: number;
  councils: { status: string; evidence: number; incomplete: boolean }[];
  reviews: { rounds: number; disposition: string; aspects: { aspect: string; outcome: string }[] } | null;
  inspected: number;
};

const SKILL_READ = /(?:^|[\\/])SKILL\.md$/i;
const skillName = (p: string) =>
  String(p).replace(/\\/g, "/").split("/").filter(Boolean).slice(-2, -1)[0] || String(p);

/** Session usage from retained branch entries: tool counts, skill reads,
 * selection-boundary routes, child runs, council deliberations and review
 * state. Unknown provider/thinking/nested values stay absent — the renderer
 * shows a dash rather than a guess. */
export function buildUsedSummary(entries: unknown): UsedSummary {
  const list = Array.isArray(entries) ? entries : [];
  const metrics = collectSessionMetrics(list);
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
  const readCounts = new Map<string, number>();
  const partialCounts = new Map<string, number>();
  for (const entry of list) {
    const message = (entry as any)?.type === "message" ? (entry as any).message : undefined;
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const call = calls.get(message.toolCallId);
    if (message.toolName === "subagent" && call && !call.input?.action) {
      for (const key of [message.details?.asyncId, message.details?.runId, message.toolCallId]) {
        if (typeof key === "string" && key && !spawnArgs.has(key)) spawnArgs.set(key, call.input);
      }
    }
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
    .map(([name, count]) => ({ name: String(name).slice(0, 120), count: Number(count) || 0 }))
    .sort(byCount)
    .slice(0, 80);
  const counted = (bucket: Map<string, number>) =>
    [...bucket].map(([name, count]) => ({ name, count })).sort(byCount).slice(0, 40);
  const routes: UsedSummary["routes"] = [];
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
    routes.push({
      route: data.route.trim().slice(0, 160),
      ...(typeof data.thinking === "string" && data.thinking ? { thinking: data.thinking.slice(0, 16) } : {}),
      ...(nested ? { nested } : {}),
      ...(typeof data.recoveryEndpointName === "string" && data.recoveryEndpointName
        ? { endpoint: data.recoveryEndpointName.slice(0, 160) }
        : {}),
      ...(typeof data.source === "string" && data.source ? { source: data.source.slice(0, 64) } : {}),
    });
    if (routes.length >= 24) break;
  }
  const runs: UsedSummary["runs"] = [];
  for (const entry of list) {
    if ((entry as any)?.type !== "custom" || (entry as any)?.customType !== "subagent-cost-v1") continue;
    const data = (entry as any)?.data ?? {};
    for (const result of data.results ?? []) {
      const args = spawnArgs.get(data.runId) ?? spawnArgs.get(result?.runId);
      const modelText = typeof result?.model === "string" && result.model
        ? result.model
        : typeof args?.model === "string"
          ? args.model
          : "";
      const slash = modelText.indexOf("/");
      runs.push({
        runId: String(data.runId ?? result?.runId ?? "?").slice(0, 48),
        ...(typeof data.mode === "string" ? { mode: data.mode.slice(0, 32) } : {}),
        status: String(result?.status ?? data.state ?? "?").slice(0, 32),
        ...(slash > 0 ? { provider: modelText.slice(0, slash).slice(0, 80), model: modelText.slice(slash + 1).slice(0, 120) } : {}),
        ...(slash <= 0 && modelText ? { model: modelText.slice(0, 120) } : {}),
        ...(typeof (args?.thinking ?? args?.thinkingOverride) === "string" && (args.thinking ?? args.thinkingOverride)
          ? { thinking: String(args.thinking ?? args.thinkingOverride).slice(0, 16) }
          : {}),
      });
      if (runs.length >= CHILD_ROW_LIMIT) break;
    }
    if (runs.length >= CHILD_ROW_LIMIT) break;
  }
  const councils: UsedSummary["councils"] = [];
  let reviews: UsedSummary["reviews"] = null;
  for (const entry of list) {
    if ((entry as any)?.type !== "custom") continue;
    const data = (entry as any)?.data;
    if (!data || typeof data !== "object") continue;
    if ((entry as any).customType === "scope-deliberation-v1") {
      if (councils.length >= 24) continue;
      councils.push({
        status: String(data.status ?? "?").slice(0, 32),
        evidence: Number.isSafeInteger(data.evidenceCount) ? data.evidenceCount : 0,
        incomplete: data.incomplete !== false,
      });
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
  return {
    tools,
    skillsRead: counted(readCounts),
    skillsPartial: counted(partialCounts),
    skillsSuggested: [...(metrics.skillsRouted ?? [])].map((name) => String(name).slice(0, 120)).sort().slice(0, 40),
    routes,
    runs,
    swarms: metrics.swarms ?? 0,
    fusions: metrics.fusions ?? 0,
    recoveries: metrics.recoveries ?? 0,
    councils,
    reviews,
    inspected: list.length,
  };
}

const usedRow = (label: string, count: number | undefined, detail?: string) =>
  `<li><code class="row">${escapeHtml(label)}${detail ? ` <span class="dim">${escapeHtml(detail)}</span>` : ""}</code>${count === undefined ? "" : `<b class="count">x${count}</b>`}</li>`;

export function usedSummaryHtml(summary: UsedSummary): string {
  const sections: string[] = [];
  sections.push(`<h1>📊 Session usage</h1><p class="sub">${summary.inspected} retained branch entries inspected</p>`);
  if (summary.routes.length) {
    sections.push(`<h2>🧠 Main routes</h2><ul>${summary.routes.map((route) => {
      const bits = [
        route.thinking ? `thinking ${route.thinking}` : "",
        route.endpoint ? `endpoint ${route.endpoint}` : "",
        route.nested ? `openrouter ${route.nested}` : "",
      ].filter(Boolean).join(" · ");
      return `<li><code class="row">${escapeHtml(route.route)}${bits ? ` <span class="dim">${escapeHtml(bits)}</span>` : ""}</code></li>`;
    }).join("")}</ul>`);
  }
  sections.push(`<h2>🔧 Tools</h2><ul>${summary.tools.length ? summary.tools.map((tool) => usedRow(tool.name, tool.count)).join("") : "<li><span class=\"dim\">—</span></li>"}</ul>`);
  const skills: string[] = [
    ...summary.skillsRead.map((skill) => usedRow(`📖 ${skill.name}`, skill.count)),
    ...summary.skillsPartial.map((skill) => usedRow(`📄 ${skill.name} (partial)`, skill.count)),
    ...summary.skillsSuggested.filter((name) => !summary.skillsRead.some((read) => read.name === name)).map((name) => usedRow(`💡 ${name} (suggested)`, undefined)),
  ];
  sections.push(`<h2>📚 Skills</h2><ul>${skills.length ? skills.join("") : "<li><span class=\"dim\">—</span></li>"}</ul>`);
  sections.push(`<h2>🤖 Subagent runs</h2><ul>${summary.runs.length ? summary.runs.map((run) => {
    const detail = [
      run.mode ? run.mode : "",
      run.provider ? run.provider : "–",
      run.model ? run.model : "–",
      run.thinking ? `thinking ${run.thinking}` : "thinking –",
      run.status,
    ].join(" · ");
    return `<li><code class="row">${escapeHtml(run.runId)} <span class="dim">${escapeHtml(detail)}</span></code></li>`;
  }).join("") : "<li><span class=\"dim\">—</span></li>"}</ul>`);
  sections.push(`<h2>⚡ Activity</h2><ul>${usedRow("🐝 Swarms", summary.swarms)}${usedRow("🌀 Fusions", summary.fusions)}${usedRow("🛟 Recoveries", summary.recoveries)}</ul>`);
  sections.push(`<h2>🏛️ Council deliberations</h2><ul>${summary.councils.length ? summary.councils.map((council, index) => usedRow(`deliberation ${index + 1}`, undefined, `${council.status} · ${council.evidence} evidence${council.incomplete ? " · incomplete" : ""}`)).join("") : "<li><span class=\"dim\">—</span></li>"}</ul>`);
  const review = summary.reviews;
  sections.push(`<h2>🔍 Quality reviews</h2><ul>${review ? usedRow(`${review.rounds} round(s) · ${review.disposition}`, undefined, review.aspects.length ? review.aspects.map((aspect) => `${aspect.aspect}:${aspect.outcome}`).join(", ") : "no reports") : "<li><span class=\"dim\">—</span></li>"}</ul>`);
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
  const captureSysSnapshot = (payload: unknown, ctx: any): void => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    let sid = "";
    try {
      sid = ctx?.sessionManager?.getSessionId?.() ?? "";
    } catch {
      return;
    }
    if (!sid || sysSnapshots.has(sid)) return;
    if (readSysSnapshot(ctx)) return;
    const snapshot = extractSysSnapshot(payload);
    if (!snapshot) return;
    sysSnapshots.set(sid, snapshot);
    try {
      fs.mkdirSync(sysPromptDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(sysSnapshotFile(sid), JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
      pruneStaleFiles(sysPromptDir(), 30 * 24 * 3600_000, `${sanitizeFileSegment(sid)}.json`);
    } catch {
      // The memory snapshot still serves this session.
    }
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
    const url = `file://${file.split(path.sep).map((segment) => encodeURIComponent(segment)).join("/")}`;
    const error = await openExternal(url);
    if (error) throw new Error(`Could not open a browser window: ${error}. Open the popup manually: ${file}`);
    return file;
  };
  const popupError = (command: string, error: unknown, ctx: any) => {
    const message = error instanceof Error ? error.message : String(error);
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
  pi.on("model_select", () => {
    resetPressureSignals();
    outputRequest = undefined;
    requested = undefined;
    thresholds.reset();
    riskAnnounced = false;
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
    return {
      // Stable for the whole run, including tool continuations and compaction.
      // Unlike custom messages this is metadata, not a fresh conversational turn.
      systemPrompt: `${_e.systemPrompt}\n\n${anchorText}`,
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
      // Deliberately return immediately: no waitForIdle, model prompt or session abort.
      void (async () => {
        const snapshot = readSysSnapshot(ctx);
        if (!snapshot) {
          ctx.ui?.notify?.(
            "No system prompt captured yet — it is recorded on this session's first provider request.",
            "info",
          );
          return;
        }
        await openHtmlPopup("sys-prompt", "Session system prompt", sysPromptHtml(snapshot), ctx);
        ctx.ui?.notify?.("System prompt opened.", "info");
      })().catch((error) => popupError("sys-prompt", error, ctx));
    },
  });
  pi.registerCommand("used", {
    description:
      "Show session usage (tools, skills, runs, reviews) in a separate window.",
    handler: (_args: string, ctx: any) => {
      void (async () => {
        let entries: unknown;
        try {
          entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
        } catch (error) {
          throw new Error(
            `Session usage is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await openHtmlPopup("used", "Session usage", usedSummaryHtml(buildUsedSummary(entries)), ctx);
        ctx.ui?.notify?.("Session usage opened.", "info");
      })().catch((error) => popupError("used", error, ctx));
    },
  });
  pi.registerCommand("commands", {
    description: "List all registered slash commands in a separate window.",
    handler: (_args: string, ctx: any) => {
      void (async () => {
        let registered: unknown;
        try {
          registered = typeof pi.getCommands === "function" ? pi.getCommands() : undefined;
        } catch (error) {
          throw new Error(
            `Command registry is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!Array.isArray(registered)) throw new Error("Command registry is unavailable.");
        await openHtmlPopup(
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
        ctx.ui?.notify?.("Command list opened.", "info");
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

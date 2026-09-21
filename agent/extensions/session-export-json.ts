/**
 * /export-json — local, UNREDACTED session diagnostics archive (JSON).
 *
 * Stock /export is redacted for sharing (reasoning, tool I/O, images and
 * harness metadata are stripped). This command is the opposite contract for
 * debugging the harness itself: thinking, tool calls/results with errors,
 * per-response provider/API records, user prompts, intercession signals
 * (reminders, follow-ups, background notifications), model/thinking changes,
 * compactions and harness ledger entries — plus sortable analytics (tool
 * usage, thinking hotspots, repeat calls, failure groups).
 *
 * Local only: zero LLM/API calls, zero network. The archive may contain
 * secrets — it is written 0600 and must never be shared or published.
 * Pure builder lives in `lib/session-export-json.ts` (unit-tested).
 *
 * Usage: /export-json [path] [--all] [--no-raw] [--min]
 *   path     output file (default: pi-session-<session>-diagnostics.json in cwd)
 *   --all    export all retained entries instead of the current branch
 *   --no-raw omit full raw entry payloads (normalized rows + analytics only)
 *   --min    minified JSON instead of pretty-printed
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@yunuspi/coding-agent";
import { buildSessionJsonExport } from "./lib/session-export-json.ts";
import { shadowReport } from "./lib/intervention-registry.ts";
import { activityView } from "./lib/activity-indicators.ts";
import { collectRuntimeProvenance } from "./lib/diagnostic-provenance.ts";

const USAGE =
  "Usage: /export-json [path] [--all] [--no-raw] [--min]\n" +
  "Local unredacted diagnostics archive (thinking, tool I/O, API records, signals). Written 0600 — never share.";

function parseArgs(raw: string): { output: string | null; all: boolean; includeRaw: boolean; min: boolean; help: boolean } {
  const parsed = { output: null as string | null, all: false, includeRaw: true, min: false, help: false };
  for (const token of String(raw ?? "").split(/\s+/).filter(Boolean)) {
    if (token === "--all") parsed.all = true;
    else if (token === "--no-raw") parsed.includeRaw = false;
    else if (token === "--min") parsed.min = true;
    else if (token === "--help" || token === "-h") parsed.help = true;
    else if (token.startsWith("--")) parsed.help = true;
    else if (parsed.output === null) parsed.output = token;
    else parsed.help = true;
  }
  return parsed;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("export-json", {
    description:
      "Export the session as unredacted local diagnostics JSON (thinking, tool I/O, API records, signals, analytics) — private, never share",
    handler: async (args: string, ctx: any) => {
      const options = parseArgs(args);
      if (options.help) {
        if (ctx.hasUI) ctx.ui.notify(USAGE, "info");
        else console.log(USAGE);
        return;
      }
      let retained: any[];
      try {
        retained = ctx.sessionManager.getEntries() ?? [];
      } catch (error) {
        const msg = `export-json: cannot read session entries: ${(error?.message ?? String(error)).slice(0, 200)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else console.error(msg);
        return;
      }
      let branch = retained;
      try {
        const current = ctx.sessionManager.getBranch?.();
        if (Array.isArray(current)) branch = current;
      } catch {
        branch = retained;
      }
      const header = ctx.sessionManager.getHeader?.() ?? null;
      const sessionFile = ctx.sessionManager.getSessionFile?.() ?? null;
      const leafId = ctx.sessionManager.getLeafId?.() ?? null;
      if (!retained.length && !branch.length) {
        const msg = "export-json: nothing to export yet — start a conversation first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else console.log(msg);
        return;
      }
      const scope = options.all ? "all" : "branch";
      let controlPlaneShadow = null;
      try {
        controlPlaneShadow = shadowReport();
      } catch { /* live rollup is best-effort diagnostics */ }
      let activity = null;
      try {
        activity = activityView() ?? null;
      } catch { /* live rollup is best-effort diagnostics */ }
      let currentRouting: unknown;
      try {
        const text = JSON.stringify(ctx.model?.compat?.openRouterRouting);
        if (text && text !== "{}" && text.length <= 1024) currentRouting = JSON.parse(text);
      } catch { currentRouting = undefined; }
      const currentEndpoint = typeof ctx.model?.compat?.recoveryEndpointName === "string" && ctx.model.compat.recoveryEndpointName.trim()
        ? ctx.model.compat.recoveryEndpointName.trim().slice(0, 160) : undefined;
      let provenance = null;
      try {
        provenance = collectRuntimeProvenance({});
      } catch { /* provenance is best-effort diagnostics */ }
      const report = buildSessionJsonExport({
        header,
        sessionFile,
        leafId,
        cwd: ctx.cwd ?? null,
        scope,
        branch,
        retained,
        model: ctx.model ? {
          provider: ctx.model.provider, id: ctx.model.id,
          ...(currentRouting ? { routing: currentRouting } : {}),
          ...(currentEndpoint ? { endpoint: currentEndpoint } : {}),
        } : null,
        thinkingLevel: ctx.thinkingLevel ?? null,
        includeRaw: options.includeRaw,
        controlPlaneShadow,
        activity,
        provenance,
      });
      const sessionTag = typeof header?.id === "string" && header.id
        ? header.id.slice(0, 8)
        : typeof sessionFile === "string" && sessionFile
          ? path.basename(sessionFile, ".jsonl").slice(-32)
          : "session";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outputPath = options.output
        ? path.resolve(ctx.cwd ?? process.cwd(), options.output)
        : path.resolve(ctx.cwd ?? process.cwd(), `pi-session-${sessionTag}-${stamp}-diagnostics.json`);
      const json = options.min ? JSON.stringify(report) : JSON.stringify(report, null, 2);
      try {
        fs.writeFileSync(outputPath, json, { encoding: "utf8", mode: 0o600 });
        try {
          fs.chmodSync(outputPath, 0o600);
        } catch {
          // Best effort: the create-mode already applied for new files.
        }
      } catch (error) {
        const msg = `export-json: write failed: ${(error?.message ?? String(error)).slice(0, 300)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else console.error(msg);
        return;
      }
      const summary = report.summary;
      const kb = (Buffer.byteLength(json) / 1024).toFixed(1);
      const lines = [
        `export-json: wrote ${outputPath} (${kb} KB, ${scope}, ${report.events.length} events, 0600).`,
        `${summary.userTurns} prompts · ${summary.assistantTurns} responses · ${summary.toolCalls} tool calls (${summary.toolErrors} errors) · ${summary.modelErrors} provider errors · ${summary.thinkingBlocks} thinking blocks.`,
        "Private diagnostics — never share or publish this file.",
      ].join("\n");
      if (ctx.hasUI) ctx.ui.notify(lines, "info");
      else console.log(lines);
    },
  });
}

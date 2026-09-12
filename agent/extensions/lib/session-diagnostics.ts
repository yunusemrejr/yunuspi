import { collectSessionMetrics } from "./session-metrics.ts";

const LIMIT = 2000;
const text = (content: any): string => typeof content === "string" ? content.slice(0, 16000) :
  Array.isArray(content) ? content.slice(0, 32).filter(p => p?.type === "text" && typeof p.text === "string")
    .map(p => p.text.slice(0, 1000)).join(" ").slice(0, 16000) : "";

/** Classifications are clues, never permission to change a model or budget. */
export function failureCategory(error: string) {
  if (/blocked:|outside.{0,30}(?:scope|workspace)|permission denied|\bEPERM\b|not authorized/i.test(error))
    return { category: "permission", recovery: "Check the declared scope and execution environment; retain the guard and request missing authority if required." };
  if (/budget|economy|price cap|cost limit/i.test(error))
    return { category: "budget", recovery: "Use an eligible route within the existing budget; do not increase caps or substitute an unauthorized model." };
  if (/\b429\b|rate.?limit|quota|cooldown/i.test(error))
    return { category: "capacity", recovery: "Honor retry-after or shared cooldown evidence; preserve successful work and avoid immediate fan-out retries." };
  if (/context.{0,30}(?:limit|exceed|large)|too many tokens|request.{0,20}(?:large|size)|\b413\b/i.test(error))
    return { category: "context", recovery: "Reduce the failed request's payload or compact retained evidence before retrying that scope." };
  if (/timed?\s*out|timeout|deadline/i.test(error))
    return { category: "timeout", recovery: "Inspect the owned task status and partial artifacts before retrying; do not duplicate work that may still be running." };
  if (/Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|ENOENT|command not found/i.test(error))
    return { category: "dependency", recovery: "Check the exact missing path or executable and its loader environment before relaunching." };
  if (/acceptance|verification|outside.{0,20}file|contract/i.test(error))
    return { category: "verification", recovery: "Inspect the changed files and failed acceptance condition; repair the specific result before treating the child as complete." };
  if (/invalid.{0,20}(?:argument|parameter|schema)|validation|unknown (?:tool|action)/i.test(error))
    return { category: "input", recovery: "Read the active tool schema and correct the rejected arguments before retrying." };
  return { category: "unclassified", recovery: "Inspect the original error and retained evidence; an error count alone does not establish a harness defect." };
}

/** Bounded branch diagnostics shared by session_self and the offline auditor. */
export function collectSessionDiagnostics(allEntries: any[], { excerpts = true } = {}) {
  const entries = Array.isArray(allEntries) ? allEntries.slice(-LIMIT) : [];
  const calls = new Map();
  for (const entry of entries) if (entry?.message?.role === "assistant" && Array.isArray(entry.message.content))
    for (const call of entry.message.content.slice(0, 256)) if (call?.type === "toolCall") calls.set(call.id, call.arguments);
  // A truncated window may contain a status result but no corresponding call.
  // Preserve its tool accounting while withholding unproven child ownership.
  const unownedReceipt = (entry: any) => entry?.type === "message" && entry.message?.role === "toolResult" &&
    entry.message.toolName === "subagent" && !calls.has(entry.message.toolCallId);
  const metrics = collectSessionMetrics(entries.map(entry => unownedReceipt(entry)
    ? { ...entry, message: { ...entry.message, details: undefined } } : entry));
  const failures: any[] = [], seen = new Set();
  const add = (kind: string, tool: string, key: string, error: string, callId?: string) => {
    if (seen.has(key)) return; seen.add(key);
    if (failures.length >= 12) return;
    failures.push({ kind, tool, ...(callId ? { callId } : {}), ...failureCategory(error),
      ...(excerpts ? { error: error.replace(/\s+/g, " ").slice(0, 180) } : {}) });
  };
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i], msg = e?.type === "message" ? e.message : undefined;
    if (msg?.role === "assistant" && msg.stopReason === "error")
      add("model", "provider", `model:${e.id ?? i}`, String(msg.errorMessage ?? text(msg.content)).slice(0,16000));
    const toolFailed = msg?.isError || msg?.toolName === "web_search" && msg.details?.queryCount > 0 && msg.details?.successfulQueries === 0;
    if (msg?.role === "toolResult" && toolFailed)
      add("tool", msg.toolName ?? "unknown", `tool:${msg.toolCallId ?? i}`, text(msg.content), msg.toolCallId);
    const owned = e?.type === "custom" && ["subagent-cost-v1", "subagent-lifecycle-v1"].includes(e.customType);
    const launch = msg?.role === "toolResult" && msg.toolName === "subagent" && calls.has(msg.toolCallId) && !calls.get(msg.toolCallId)?.action;
    const d = owned ? e.data : launch ? msg.details : undefined;
    if (!d || typeof d !== "object") continue;
    const root = d.runId ?? d.asyncId ?? e.id ?? msg?.toolCallId ?? i;
    const state = d.state ?? d.workflowChildren?.workflowState;
    const workflowKey = `workflow:${root}`;
    if (d.mode === "workflow" && !seen.has(workflowKey)) {
      if (["failed", "rejected"].includes(state) || d.success === false)
        add("workflow", "subagent", workflowKey, String(d.error ?? d.errorMessage ?? "Workflow controller failed"));
      else if (["complete", "completed", "stopped"].includes(state)) seen.add(workflowKey);
    }
    const rows = d.workflowChildren?.children ?? d.results;
    if (!Array.isArray(rows)) continue;
    for (const [j, r] of rows.slice(0, 64).entries()) {
      if (!r || typeof r !== "object") continue;
      const key = `child:${r.runId ?? root}:${r.runId ? 0 : r.workflowKey ?? r.childId ?? r.index ?? j}`;
      if (seen.has(key)) continue;
      const status = r.state ?? r.status;
      if (r.stopped || r.interrupted || ["stopped", "paused"].includes(status)) { seen.add(key); continue; }
      if (r.error || r.timedOut || r.exitCode !== undefined && r.exitCode !== 0 || ["failed", "rejected"].includes(status))
        add("child", "subagent", key, String(r.error ?? r.errorMessage ?? (r.timedOut ? "Child timed out" : "Child failed")), msg?.toolCallId);
      else if (r.exitCode === 0 || ["complete", "completed"].includes(status)) seen.add(key);
    }
  }
  return {
    inspected: entries.length, truncated: Array.isArray(allEntries) && allEntries.length > entries.length, count: failures.length, failures,
    activity: { tools: metrics.tools, parentToolErrors:metrics.errors, parentModelErrors:metrics.modelErrors,
      children:metrics.agents, childFailures:metrics.agentFailures, workflowFailures:metrics.workflowFailures,
      skillsOpened:metrics.skillsRead.length + metrics.skillsPartial.length, skillsSuggested:metrics.skillsRouted.length,
      cacheRate:metrics.cacheRate, swarms:metrics.swarms, fusions:metrics.fusions },
    scope: "Newest evidence within the last 2000 branch entries; at most 12 diagnostics. Child/controller records are deduplicated; error categories are recovery clues, not proof of a harness defect. Model aborts are not failures. Unmatched subagent tool receipts cannot establish child ownership. Activity counts apply only to this window; missing earlier evidence remains unknown.",
  };
}

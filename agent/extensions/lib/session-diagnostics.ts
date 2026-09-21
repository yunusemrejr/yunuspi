import { collectSessionMetrics } from "./session-metrics.ts";

const LIMIT = 2000;
const text = (content: any): string => typeof content === "string" ? content.slice(0, 16000) :
  Array.isArray(content) ? content.slice(0, 32).filter(p => p?.type === "text" && typeof p.text === "string")
    .map(p => p.text.slice(0, 1000)).join(" ").slice(0, 16000) : "";

/** Classifications are clues, never permission to change a model or budget. */
export function failureCategory(error: string) {
  // Recovery prose is not failure evidence (e.g. a hook mentioning timeout).
  error = error.split('[session-hooks]')[0];
  // Validator messages echo schema field names and user input. Classify the
  // failed validation itself before words such as acceptance/budget in that echo.
  if (/^\s*Validation failed for tool\b/i.test(error))
    return { category: "input", recovery: "Read the active tool schema and correct the rejected arguments before retrying." };
  if (/^\s*Before (?:edit|write|bulk_edit|bash)\b[\s\S]*read the matching workflow/i.test(error))
    return { category: "guard", recovery: "Read the required skill completely or record a concise applicable deferral. If a complete read was rejected, inspect the skill-read receipt; do not repeat the same edit." };
  if (/Current independent reviews.*missing evidence|Current project test evidence is unresolved/i.test(error))
    return { category: "verification", recovery: "Inspect current review and test evidence. Record unavailable evidence as blocked; do not repeat an accepted assessment while gaps remain." };
  if (/No verified read-tool coverage|Edit without read|RE-READ REQUIRED/i.test(error))
    return {category:"read-coverage",recovery:"Read the target range with the native read tool, then retry the edit. Shell output and previews do not establish edit coverage."};
  if (/Edit target not found|oldText.*(?:not found|appears \d+ times)/i.test(error))
    return {category:"edit-conflict",recovery:"Read the current target and rebuild a unique oldText match; do not retry the same stale or ambiguous edit."};
  if (/Offset \d+ is beyond end of file/i.test(error))
    return {category:"read-range",recovery:"Refresh the file's current line range. If a same-file write is running, let it finish before reading."};
  if (/Inspection selector timeout/i.test(error))
    return {category:"selector",recovery:"Inspect the page DOM and choose a selector that exists in the requested state; repeating the missing selector will not help."};
  if (/\"status\"\s*:\s*\"failed\"/.test(error) && /\"stage\"\s*:\s*\"navigation\"/.test(error))
    return {category:"navigation",recovery:"Read the renderer's transport code and nextStep; localhost is supported. Check the server task and readiness before retrying."};
  if (/(?:Inspection|Render) navigation unreachable/i.test(error))
    return {category:"navigation",recovery:"Check the dev server and requested HTTP address before rendering again."};
  if (/Browser (?:open|action) failed \(navigation\//i.test(error) || /^Render failed:.*page\.goto:/is.test(error))
    return {category:"navigation",recovery:"Check the browser's navigation cause and the server task/URL. Localhost is supported; this does not establish a provider failure."};
  if (/Command exited with code (?:137|143)\b/.test(error))
    return {category:"process",recovery:"The command reported a signal-style exit (137/143). Inspect cancellation, timeout and process ownership evidence before restarting; the exit alone does not establish the cause."};
  // Output truncation is its own family: length stops, max_tokens, answer
  // budgets, and structured-output cut-offs are neither provider-health nor
  // acceptance failures. Framed reports only — bare "length" or "budget"
  // nouns in data never match.
  if (/finish.{0,24}reason.{0,12}length|stop.{0,24}reason.{0,12}length|\bmax_tokens\b.{0,48}(?:exceeded|reached|exhausted)|response.{0,24}truncat|answer.{0,24}budget.{0,24}exhaust|output.{0,24}(?:cut off|truncat)/i.test(error))
    return {category:"truncated",recovery:"Resume the retained session and synthesize only the missing output; do not restart the investigation. Without retained state, split the work or narrow the scope."};
  // Framed reports only below: bare nouns ("budget", "quota", "contract",
  // "timeout", "deadline") also appear in SQL columns, filenames, and quoted
  // data, so every branch requires failure verbs, provider codes, or harness
  // gate phrasing. Structured child evidence bypasses text via reasonText.
  if (/(?:path|file|request|access|operation).{0,24}outside.{0,24}(?:scope|workspace)|outside.{0,24}(?:scope|workspace).{0,24}(?:denied|blocked|refused|not permitted)|permission denied|\bEPERM\b|not authorized/i.test(error))
    return { category: "permission", recovery: "Check the declared scope and execution environment; retain the guard and request missing authority if required." };
  if (/(?:budget|economy|price cap|cost limit).{0,48}(?:exceeded|exhausted|blocked|denied|failure|limit\b)|exceeded.{0,48}(?:budget|cost limit)/i.test(error))
    return { category: "budget", recovery: "Use an eligible route within the existing budget; do not increase caps or substitute an unauthorized model." };
  if (/\b429\b|rate.?limit.{0,32}(?:exceeded|reached|hit)|quota.{0,32}(?:exceeded|exhausted|reached|hit|insufficient)|cooldown.{0,32}(?:active|until|remaining|in effect)/i.test(error))
    return { category: "capacity", recovery: "Honor retry-after or shared cooldown evidence; preserve successful work and avoid immediate fan-out retries." };
  if (/context.{0,30}(?:limit|exceed)|too many tokens|request.{0,24}(?:too large|exceeds|too big|maximum)|\b413\b/i.test(error))
    return { category: "context", recovery: "Reduce the failed request's payload or compact retained evidence before retrying that scope." };
  if (/timed?\s+out|timedout|deadline exceeded|exceeded.{0,24}timeout|timeout.{0,24}(?:exceeded|after|reached)/i.test(error))
    return { category: "timeout", recovery: "Inspect the owned task status and partial artifacts before retrying; do not duplicate work that may still be running." };
  if (/Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|ENOENT|command not found/i.test(error))
    return { category: "dependency", recovery: "Check the exact missing path or executable and its loader environment before relaunching." };
  if (/acceptance.{0,32}(?:failed|rejected|missing|required|unresolved|not met)|verification.{0,32}(?:failed|missing|required|unresolved)|outside.{0,20}file|contract.{0,32}(?:violation|breach|failed|mismatch|required|not met)/i.test(error))
    return { category: "verification", recovery: "Inspect the changed files and failed acceptance condition; repair the specific result before treating the child as complete." };
  if (/invalid.{0,20}(?:argument|parameter|schema)|validation|unknown (?:tool|action)/i.test(error))
    return { category: "input", recovery: "Read the active tool schema and correct the rejected arguments before retrying." };
  if (/invalid[- ]output|structured.?output|invalid.?json|no (?:final|useful) output/i.test(error))
    return { category: "output", recovery: "Inspect the required output contract and retained artifacts; missing or invalid output is not successful completion." };
  if (/transport failure|\b(?:502|503|504|524|529)\b|fetch failed|socket hang up|connection.{0,20}(?:reset|closed|error)/i.test(error))
    return { category: "transport", recovery: "Check provider and connection health, preserve partial results, and retry only through the owned bounded recovery route." };
  if (/process[- ]signal/i.test(error))
    return { category: "process", recovery: "Inspect the recorded exit signal and resource limits before restarting the owned process." };
  if (/^\s*blocked:/i.test(error))
    return { category: "guard", recovery: "Inspect the guard's specific reason and satisfy the missing precondition; do not repeat the rejected call or bypass the guard." };
  return { category: "unclassified", recovery: "Inspect the original error and retained evidence; an error count alone does not establish a harness defect." };
}

function fnv1aHex(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function normalizeIncidentError(error) {
  return String(error ?? '').toLowerCase().replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>').replace(/\b\d{4,}\b/g, '<n>').replace(/\/[^\s:;,]{3,}/g, ' <path>').replace(/\s+/g, ' ').trim().slice(0, 120);
}
/** Stable incident id: same category + same normalized cause + same linkage (call/run) is one incident, however many records describe it. Exported so /errors shares the exact incident ids /metrics shows. */
export function incidentId(category, error, link) {
  return `inc-${fnv1aHex(`${category}|${normalizeIncidentError(error)}|${link ?? ''}`).slice(0, 8)}`;
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
  // Lifecycle receipts can arrive after richer accounting. Retain the latest
  // category-only ledger evidence so a later generic 'failed' cannot hide it.
  const childEvidence = new Map();
  for (const entry of entries) {
    if (entry?.type !== 'custom' || entry.customType !== 'subagent-cost-v1' || !Array.isArray(entry.data?.results)) continue;
    for (const [index, row] of entry.data.results.slice(0, 64).entries()) {
      if (row?.evidence?.version !== 1) continue;
      const id = `${row.runId ?? entry.data.runId}:${row.runId ? 0 : row.workflowKey ?? row.childId ?? row.index ?? index}`;
      childEvidence.set(metrics.agentAliases[id] ?? id, row.evidence);
    }
  }
  const reasonText: Record<string, string> = { budget: 'budget limit', context: 'context limit', capacity: '429 capacity',
    timeout: 'timed out', permission: 'permission denied', dependency: 'ERR_MODULE_NOT_FOUND',
    'invalid-output': 'invalid-output', acceptance: 'acceptance failed', transport: 'transport failure', 'process-signal': 'process-signal',
    truncated: 'response truncated (length)' };
  const failures: any[] = [], seen = new Set(), groups = new Map();
  const incidents = new Map();
  let total = 0;
  const add = (kind: string, tool: string, key: string, error: string, callId?: string, evidence?: any) => {
    if (seen.has(key)) return; seen.add(key);
    total++;
    const reason = evidence?.outcomeReason;
    const classification = failureCategory(typeof reason === 'string' && Object.hasOwn(reasonText, reason) ? reasonText[reason] : error);
    const groupKey = JSON.stringify([kind, tool, classification.category]);
    const group = groups.get(groupKey) ?? { kind, tool, ...classification, count: 0 };
    group.count++; groups.set(groupKey, group);
    // Parent tool errors, child failures, workflow and budget records that share
    // one cause + one linkage (same tool call / same child run) are one incident.
    // Diagnostic records (every sighting) stay distinct from unique incidents.
    const link = callId ?? (kind === "child" ? key.slice(6) : key);
    const id = incidentId(classification.category, error, link);
    const incident = incidents.get(id) ?? { id, category: classification.category, kinds: new Set(), tools: new Set(), records: 0, callId: callId ?? null, runId: kind === "child" ? key.slice(6) : null };
    incident.kinds.add(kind); incident.tools.add(tool); incident.records++;
    if (incident.representative === undefined && failures.length < 12) incident.representative = failures.length;
    incidents.set(id, incident);
    if (failures.length >= 12) return;
    failures.push({ kind, tool, incident: id, ...(callId ? { callId } : {}), ...(kind === "child" ? {runId:key.slice(6)} : {}), ...classification,
      ...(Number.isSafeInteger(evidence?.attemptCount) && evidence.attemptCount >= 0 ? { attempts: evidence.attemptCount } : {}),
      ...(['present', 'absent', 'unknown'].includes(evidence?.output) ? { outputPresence: evidence.output } : {}),
      ...(excerpts ? { error: error.replace(/\s+/g, " ").slice(0, 360) } : {}) });
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
      const id = `${r.runId ?? root}:${r.runId ? 0 : r.workflowKey ?? r.childId ?? r.index ?? j}`;
      const canonical = metrics.agentAliases[id] ?? id;
      const key = `child:${canonical}`;
      if (["completed", "stopped", "paused"].includes(metrics.agentStates[canonical])) { seen.add(key); continue; }
      if (seen.has(key)) continue;
      const status = r.state ?? r.status;
      if (r.stopped || r.interrupted || ["stopped", "paused"].includes(status)) { seen.add(key); continue; }
      if (r.error || r.timedOut || r.exitCode !== undefined && r.exitCode !== 0 || ["failed", "rejected"].includes(status))
        add("child", "subagent", key, String(r.error ?? r.errorMessage ?? (r.timedOut ? "Child timed out" : "Child failed")), msg?.toolCallId, childEvidence.get(canonical));
      else if (r.exitCode === 0 || ["complete", "completed"].includes(status)) seen.add(key);
    }
  }
  const incidentList = [...incidents.values()].map(row => ({ id: row.id, category: row.category, kinds: [...row.kinds].sort(), tools: [...row.tools].sort(), records: row.records, ...(row.callId ? { callId: row.callId } : {}), ...(row.runId ? { runId: row.runId } : {}) })).sort((a, b) => b.records - a.records || a.id.localeCompare(b.id)).slice(0, 12);
  return {
    inspected: entries.length, truncated: Array.isArray(allEntries) && allEntries.length > entries.length,
    count: failures.length, total, omitted: total - failures.length, failures,
    diagnosticRecords: total, uniqueIncidents: incidents.size, incidents: incidentList, omittedIncidents: Math.max(0, incidents.size - incidentList.length),
    groups: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 16),
    omittedGroups: Math.max(0, groups.size - 16),
    activity: { tools: metrics.tools, parentToolErrors:metrics.errors, parentModelErrors:metrics.modelErrors,
      children:metrics.agents, childFailures:metrics.agentFailures, workflowFailures:metrics.workflowFailures,
      skillsOpened:metrics.skillsRead.length + metrics.skillsPartial.length, skillsSuggested:metrics.skillsRouted.length,
      cacheRate:metrics.cacheRate, swarms:metrics.swarms, fusions:metrics.fusions },
    scope: "Newest evidence within the last 2000 branch entries; at most 12 diagnostics. diagnosticRecords counts every sighting; uniqueIncidents counts stable incident ids (same cause + same call/run linkage). Parent/child/workflow/budget records for one incident share one incident id. Model aborts are not failures. Unmatched subagent tool receipts cannot establish child ownership. Activity counts apply only to this window; missing earlier evidence remains unknown.",
  };
}

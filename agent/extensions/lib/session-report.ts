import { createHash } from 'node:crypto';
import { collectSessionMetrics } from './session-metrics.ts';
import { collectSessionDiagnostics } from './session-diagnostics.ts';

const number = (value: number) => value.toLocaleString('en-US');
// Excerpts are private UI text, never terminal instructions or persisted telemetry.
export const reportText = (value: unknown) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
const contentText = (content: any) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';

/** Inspect a bounded branch window. Repetition is an observation, not a waste verdict. */
export function collectContextTraffic(entries: any[]) {
  const window = entries.slice(-2000), calls = new Map(), seen = new Set(), repeats = new Map(), tools = new Map();
  for (const entry of window) {
    const message = entry?.type === 'message' ? entry.message : undefined;
    if (message?.role === 'assistant') for (const call of Array.isArray(message.content) ? message.content : []) {
      if (call?.type === 'toolCall' && call.id) calls.set(call.id, call);
    }
    if (message?.role !== 'toolResult') continue;
    if (message.toolCallId && seen.has(message.toolCallId)) continue;
    if (message.toolCallId) seen.add(message.toolCallId);
    const tool = message.toolName ?? 'unknown', text = contentText(message.content);
    const row = tools.get(tool) ?? { tool, calls: 0, chars: 0, largest: 0, repeated: 0, repeatedChars: 0 };
    row.calls++; row.chars += text.length; row.largest = Math.max(row.largest, text.length);
    const call = calls.get(message.toolCallId);
    // Require exact request AND exact complete text; missing arguments, images,
    // huge outputs and failures cannot establish a redundant read.
    const textOnly = typeof message.content === 'string' || Array.isArray(message.content) && message.content.every(part => part?.type === 'text');
    if (call?.name === tool && call.arguments && !message.isError && textOnly && text.length >= 512 && text.length <= 262144) {
      const input = JSON.stringify(call.arguments);
      if (input.length <= 16384) {
        const key = createHash('sha256').update(JSON.stringify([tool, input, text])).digest('hex');
        if (repeats.has(key)) { row.repeated++; row.repeatedChars += text.length; }
        repeats.set(key, true);
      }
    }
    tools.set(tool, row);
  }
  return { inspected: window.length, truncated: entries.length > window.length,
    tools: [...tools.values()].sort((a, b) => b.chars - a.chars) };
}

/** Local-only panel: cumulative activity and explicitly scoped branch evidence. */
export function buildSessionReport(entries: any[], branch: any[], live?: any, activeTools?: string[]) {
  const metrics = collectSessionMetrics(entries, live);
  const diagnostics = collectSessionDiagnostics(branch);
  const traffic = collectContextTraffic(branch);
  const lines = [
    'Failure evidence · current branch',
    `${diagnostics.total} diagnostic records in ${diagnostics.inspected} inspected entries${diagnostics.truncated ? ' (older entries outside this window)' : ''}; ${diagnostics.count} recent examples, ${diagnostics.omitted} additional records grouped below. Parent and child records can describe the same incident; do not add them as unique incidents.`,
    ...diagnostics.groups.slice(0, 16).map(group => `${group.count} × ${group.kind} / ${group.tool} / ${group.category}. Next: ${group.recovery}`),
    ...(diagnostics.omittedGroups ? [`${diagnostics.omittedGroups} additional failure groups omitted; inspect retained session evidence for the full window.`] : []),
    ...(diagnostics.total ? diagnostics.failures.map(failure => `${failure.kind} · ${failure.tool} · ${failure.category}${failure.callId ? ` · call ${failure.callId}` : ''}${failure.attempts !== undefined ? ` · ${failure.attempts} attempts` : ''}${failure.outputPresence ? ` · output ${failure.outputPresence}` : ''}: ${failure.error || 'No error excerpt recorded.'}`)
      : ['No recorded tool/model/child failures in this window. This does not certify task quality.']),
    '', 'Context traffic · current branch',
    `Raw returned text across ${traffic.inspected} entries${traffic.truncated ? ' (window truncated)' : ''}; these are characters before context projection, not current occupancy, tokens or billed savings.`,
    ...traffic.tools.slice(0, 8).map(row => `${row.tool}: ${number(row.chars)} chars in ${row.calls} results; largest ${number(row.largest)}; ${row.repeated} exact repeated request/result pairs (${number(row.repeatedChars)} repeated chars).`),
  ];
  if (traffic.tools.some(row => row.repeated >= 2)) lines.push('Repeated observations may be legitimate polling or verification. For unchanged source, reuse retained evidence and request a focused slice; inspect owned background tasks through completion notifications.');
  const suggestions = metrics.skillsRouted.filter((name: string) => !metrics.skillsRead.includes(name) && !metrics.skillsPartial.includes(name));
  lines.push('', 'Capabilities and evidence gaps',
    `Suggested skills without a recorded read: ${suggestions.slice(0, 12).join(', ') || 'none recorded'}. Suggestions can be irrelevant; use skill_review for the current task rather than reading every skill.`,
    `Partial skill reads: ${metrics.skillsPartial.slice(0, 12).join(', ') || 'none recorded'}. Read coverage is not proof that checks were applied.`);
  for (const [label, names] of [
    ['Source exploration', ['project_report', 'module_report', 'symbol_search', 'context_slice']],
    ['Context and local processing', ['context_score', 'handoff_capsule', 'evidence_cache', 'output_distill', 'mini_preprocess']],
    ['Verification', ['quality_review', 'quality_check', 'test_run', 'render_see', 'math_check']],
  ] as const) {
    const enabled = activeTools ? names.filter(name => activeTools.includes(name)) : undefined;
    const observed = names.filter(name => metrics.tools[name]);
    lines.push(`${label}: ${enabled ? `active ${enabled.join(', ') || 'none'}` : 'active inventory unavailable'}; observed ${observed.map(name => `${name} ${metrics.tools[name]}`).join(', ') || 'none'}.`);
  }
  lines.push('Use capabilities when they fit the task; activity counts do not prove useful execution. Local model inference availability is unknown without its own health/runtime evidence.');
  const review = branch.findLast(entry => entry?.type === 'custom' && entry.customType === 'quality-review-v1')?.data;
  if (review) {
    const current = review.reviewed === review.revision;
    const reports = current && Array.isArray(review.reports) ? review.reports : [];
    lines.push(`Latest quality review: revision ${review.revision}; disposition ${review.disposition || 'unassessed'}; ${current ? 'current' : 'stale or missing'} reports; ${reports.filter((r: any) => r.outcome === 'unknown' || r.gap?.trim()).length} evidence gaps; ${reports.flatMap((r: any) => r.findings ?? []).filter((f: any) => f.severity === 'blocking').length} blocking findings. Inspect quality_review status before deciding completion.`);
  } else lines.push('Quality review: no lifecycle record on this branch; this is unavailable evidence, not a pass.');
  lines.push('', 'Hook health · all retained entries');
  if (metrics.telemetry) {
    const hooks = Object.entries(metrics.hooks).sort(([, a]: any, [, b]: any) => b.errors - a.errors || b.ms - a.ms);
    for (const [key, value] of hooks.slice(0, 8) as [string, any][]) lines.push(`${key}: ${value.errors} errors / ${value.calls} checks; ${number(Math.round(value.ms))} ms cumulative, ${value.calls ? (value.ms / value.calls).toFixed(1) : '?'} ms/check. Includes waiting; not a CPU profile.`);
  } else lines.push('Hook measurements unavailable; missing instrumentation does not mean zero errors.');
  lines.push('', ...metrics.detail);
  return { lines: lines.map(reportText), diagnostics, traffic };
}

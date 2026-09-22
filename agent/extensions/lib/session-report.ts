import { createHash } from 'node:crypto';
import { collectSessionMetrics } from './session-metrics.ts';
import { collectSessionDiagnostics } from './session-diagnostics.ts';
import { activityView } from './activity-indicators.ts';

const number = (value: number) => value.toLocaleString('en-US');
// Excerpts are private UI text, never terminal instructions or persisted telemetry.
export const reportText = (value: unknown) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
const contentText = (content: any) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';

/** Inspect a bounded branch window. Repetition is an observation, not a waste verdict. */
export function collectContextTraffic(entries: any[]) {
  const window = entries.slice(-2000), calls = new Map(), seen = new Set(), repeats = new Map(), contents = new Set(), tools = new Map();
  for (const entry of window) {
    const message = entry?.type === 'message' ? entry.message : undefined;
    if (message?.role === 'assistant') for (const call of Array.isArray(message.content) ? message.content : []) {
      if (call?.type === 'toolCall' && call.id) calls.set(call.id, call);
    }
    if (message?.role !== 'toolResult') continue;
    if (message.toolCallId && seen.has(message.toolCallId)) continue;
    if (message.toolCallId) seen.add(message.toolCallId);
    const tool = message.toolName ?? 'unknown', text = contentText(message.content);
    const row = tools.get(tool) ?? { tool, calls: 0, chars: 0, largest: 0, repeated: 0, repeatedChars: 0, repeatedContent: 0, repeatedContentChars: 0 };
    row.calls++; row.chars += text.length;
    const call = calls.get(message.toolCallId);
    if (text.length > row.largest) {
      row.largest = text.length;
      row.largestCallId = typeof message.toolCallId === 'string' && /^[a-zA-Z0-9_:.-]{1,96}$/.test(message.toolCallId) ? message.toolCallId : undefined;
      const target = call?.arguments?.path ?? call?.arguments?.file_path ?? call?.arguments?.file;
      // Only a filename locator, never full paths, URLs, commands or arguments.
      const basename = typeof target === 'string' && !/[:?#]/.test(target) ? target.split(/[\\/]/).at(-1) : undefined;
      row.largestTarget = basename && /^[a-zA-Z0-9_. -]{1,80}$/.test(basename) ? basename : undefined;
    }
    // Require exact request AND exact complete text; missing arguments, images,
    // huge outputs and failures cannot establish a redundant read.
    const textOnly = typeof message.content === 'string' || Array.isArray(message.content) && message.content.every(part => part?.type === 'text');
    if (!message.isError && textOnly && text.length >= 512 && text.length <= 262144) {
      const contentKey = createHash('sha256').update(JSON.stringify([tool, text])).digest('hex');
      if (contents.has(contentKey)) { row.repeatedContent++; row.repeatedContentChars += text.length; }
      contents.add(contentKey);
    }
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
  const rows = [...tools.values()].sort((a, b) => b.chars - a.chars);
  return { inspected: window.length, truncated: entries.length > window.length,
    totalChars: rows.reduce((sum, row) => sum + row.chars, 0), totalResults: rows.reduce((sum, row) => sum + row.calls, 0),
    tools: rows };

}

export interface CurrentModelConfig {
  route: string;
  thinking?: string;
  routing?: string;
  endpoint?: string;
}

/** Local-only panel: cumulative activity and explicitly scoped branch evidence. */
export function buildSessionReport(entries: any[], branch: any[], live?: any, activeTools?: string[], current?: CurrentModelConfig) {
  const metrics = collectSessionMetrics(entries, live);
  const diagnostics = collectSessionDiagnostics(branch);
  const traffic = collectContextTraffic(branch);
  const lines = [
    'Overview · current branch',
    `${traffic.totalResults} tool results · ${number(traffic.totalChars)} raw returned chars · ${diagnostics.activity.parentToolErrors} tool errors · ${diagnostics.activity.parentModelErrors} provider errors · ${diagnostics.activity.childFailures} child failures · ${diagnostics.uniqueIncidents ?? diagnostics.total} unique incidents`,
    'Jump: 1 failures · 2 traffic · 3 skills/review · 4 hook health · 5 totals · 6 cache/models/costs', '',
    'Failure evidence · current branch',
    `${diagnostics.total} diagnostic records (${diagnostics.uniqueIncidents ?? diagnostics.total} unique incidents by stable incident id) in ${diagnostics.inspected} inspected entries${diagnostics.truncated ? ' (older entries outside this window)' : ''}; ${diagnostics.count} recent examples, ${diagnostics.omitted} additional records grouped below. Records sharing one incident id are one incident, not unique failures.`,
    ...diagnostics.groups.slice(0, 16).map(group => `${group.count} × ${group.kind} / ${group.tool} / ${group.category}. Next: ${group.recovery}`),
    ...(diagnostics.omittedGroups ? [`${diagnostics.omittedGroups} additional failure groups omitted; inspect retained session evidence for the full window.`] : []),
    ...((diagnostics.incidents ?? []).slice(0, 12).map(row => `${row.id} · ${row.category} · ${row.kinds.join('+')} · ${row.tools.join('+')} · ${row.records} record(s)${row.callId ? ` · call ${row.callId}` : ''}${row.runId ? ` · run ${row.runId}` : ''}`)),
    ...(diagnostics.total ? diagnostics.failures.map(failure => `${failure.incident ?? 'inc-unknown'} · ${failure.kind} · ${failure.tool} · ${failure.category}${failure.callId ? ` · call ${failure.callId}` : ''}${failure.runId ? ` · run ${failure.runId}` : ''}${failure.attempts !== undefined ? ` · ${failure.attempts} attempts` : ''}${failure.outputPresence ? ` · output ${failure.outputPresence}` : ''}: ${failure.error || 'No error excerpt recorded.'}`)
      : ['No recorded tool/model/child failures in this window. This does not certify task quality.']),
    '', 'Context traffic · current branch',
    `${number(traffic.totalChars)} raw returned characters in ${traffic.totalResults} results across ${traffic.inspected} entries${traffic.truncated ? ' (window truncated)' : ''}; these are characters before context projection, not current occupancy, tokens or billed savings.`,
    ...traffic.tools.slice(0, 8).map(row => `${row.tool}: ${number(row.chars)} chars (${traffic.totalChars ? (100 * row.chars / traffic.totalChars).toFixed(1) : '0'}%) in ${row.calls} results; largest ${number(row.largest)}.${row.repeatedContent ? ` Identical returned content: ${row.repeatedContent} repeats / ${number(row.repeatedContentChars)} chars.` : ''}${row.repeated ? ` Exact request/result pairs: ${row.repeated} repeats / ${number(row.repeatedChars)} chars (subset).` : ''}`),
  ];
  const largest = traffic.tools.reduce((best, row) => !best || row.largest > best.largest ? row : best, undefined);
  if (largest?.largest) lines.push(`Largest result: ${largest.tool} · ${number(largest.largest)} chars${largest.largestTarget ? ` · ${largest.largestTarget}` : ''}${largest.largestCallId ? ` · call ${largest.largestCallId}` : ''}. Inspect that result for a narrower query or focused slice.`);
  if (traffic.tools.some(row => row.repeatedContent > 0)) lines.push('Repeated observations may be legitimate polling or verification. For unchanged source, reuse retained evidence and request a focused slice; inspect owned background tasks through completion notifications.');
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
  lines.push('Use capabilities when they fit the task; activity counts do not prove useful execution. Local provider refresh evidence, when this process observed any, is under Local intelligence & activity below.');
  const review = branch.findLast(entry => entry?.type === 'custom' && entry.customType === 'quality-review-v1')?.data;
  if (review) {
    const current = review.reviewed === review.revision;
    const reports = current && Array.isArray(review.reports) ? review.reports : [];
    lines.push(`Latest quality review: revision ${review.revision}; disposition ${review.disposition || 'unassessed'}; ${current ? 'current' : 'stale or missing'} reports; ${reports.filter((r: any) => r.outcome === 'unknown' || r.gap?.trim()).length} evidence gaps; ${reports.flatMap((r: any) => r.findings ?? []).filter((f: any) => f.severity === 'blocking').length} blocking findings. Inspect quality_review status before deciding completion.`);
  } else lines.push('Quality review: no lifecycle record on this branch; this is unavailable evidence, not a pass.');
  lines.push('', 'Local intelligence & activity · this process');
  {
    const activity = activityView();
    if (!activity) {
      lines.push('Activity tap unavailable in this process; counts below come from retained entries only. Offline detail: scripts/read-health-log.mjs over ~/.pi/agent/logs/health.');
    } else {
      const ev = activity.events, dec = activity.decisions;
      const split = (kind: string) => Object.entries(dec[kind] ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
      const routed = ev['skill.route'] ?? 0, resolved = ev['skill.resolve'] ?? 0;
      lines.push(`Skills: routed ${number(routed)} suggestion${routed === 1 ? '' : 's'} (${metrics.skillsRouted.slice(0, 8).join(', ') || 'none recorded'}); fully read ${metrics.skillsRead.length} (${metrics.skillsRead.slice(0, 8).join(', ') || 'none recorded'}); spawn-resolved ${number(resolved)}${split('skill.resolve') ? ` (${split('skill.resolve')})` : ''}.`);
      lines.push(`Local helpers: intent ${number(ev['ml.intent'] ?? 0)} · mini select ${number(ev['ml.mini.select'] ?? 0)}${split('ml.mini.select') ? ` (${split('ml.mini.select')})` : ''} · smol take ${number(ev['ml.smol.take'] ?? 0)}${split('ml.smol.take') ? ` (${split('ml.smol.take')})` : ''} · guidance delivered ${number(ev['guidance.delivered'] ?? 0)}.`);
      const localRows = Object.entries(activity.local).map(([k, v]) => `${k}: ${v.outcome} ×${v.count}`);
      const picks = ev['model.mix'] ?? 0, skipped = ev['model.skip'] ?? 0;
      lines.push(`Local providers: ${localRows.join(' · ') || 'no refresh observed yet'}. Historical mixed routing: ${number(picks)} pick${picks === 1 ? '' : 's'}${split('model.mix') ? ` (${split('model.mix')})` : ''}; ${number(skipped)} preferred skip${skipped === 1 ? '' : 's'}${Object.entries(activity.skips).map(([k, v]) => ` ${k} ${v}`).join(',') || ''}.`);
      const delivered = ev['reminder.delivery'] ?? 0;
      lines.push(`Reminders: ${number(delivered)} manual deliver${delivered === 1 ? 'y' : 'ies'}${delivered && dec['reminder.ack'] ? ` · acked ${dec['reminder.ack']['acked'] ?? 0} / ignored ${dec['reminder.ack']['ignored'] ?? 0}` : ''}${dec['reminder.follow'] ? ` · follow-through: ${split('reminder.follow')}` : ''}. Indicator lines shown: ${number(activity.lines)}${activity.dropped ? ` (${number(activity.dropped)} deduped/over budget)` : ''}.`);
      if (activity.errors.length) lines.push(`Recent activity errors: ${activity.errors.slice(-4).map(e => `${e.kind} ${e.label}${e.detail ? ` (${e.detail})` : ''}`).join(' · ')}.`);
    }
  }
  lines.push('', 'Hook health · all retained entries');
  if (metrics.telemetry) {
    const hooks = Object.entries(metrics.hooks).sort(([, a]: any, [, b]: any) => b.errors - a.errors || b.ms - a.ms);
    for (const [key, value] of hooks.slice(0, 8) as [string, any][]) lines.push(`${key}: ${value.errors} errors / ${value.calls} checks; ${number(Math.round(value.ms))} ms cumulative, ${value.calls ? (value.ms / value.calls).toFixed(1) : '?'} ms/check. Includes waiting; not a CPU profile.`);
    lines.push(`Hook payload accounting: unique context removed ${number(metrics.uniqueContextRemovedChars ?? metrics.trimmedChars)} chars; repeated projection churn re-added ${number(metrics.projectionChurnChars ?? metrics.addedChars)} chars. Churn is reprocessing, never unique savings.`);
  } else lines.push('Hook measurements unavailable; missing instrumentation does not mean zero errors.');
  lines.push('', 'Cache, models and costs · all retained entries');
  lines.push(`Prompt cache: reuse ${number(metrics.cachedReuse ?? metrics.cacheRead)} tokens (${metrics.cacheRate === null ? 'unknown' : metrics.cacheRate.toFixed(2) + '%'} of prompt); uncached input ${number(metrics.uncachedInput ?? metrics.input)} tokens in ${metrics.assistantTurns ?? metrics.responses} assistant turns; no-cache turns ${metrics.noCacheTurns ?? 0} (${number(metrics.noCacheInput ?? 0)} tokens on routes without caching); invalidation turns ${metrics.invalidationTurns ?? 0} with ~${number(metrics.invalidationExcessTokens ?? 0)} excess tokens (prefix stopped matching, rebilled at full price).`);
  lines.push('Reuse avoids full-price rebill of the matched prefix; it is not a billed-amount saving. Repeated churn must never be counted as savings. Actual billed amounts: /cost (provider-reported vs estimated, per scope and route).');
  lines.push(`Reasoning usage: ${number(metrics.reasoning)} tokens (subset of output, not additional traffic). Child traffic: ${number(metrics.childTokens)} tokens from ${metrics.childRowsWithUsage} of ${metrics.childRows} usage-bearing child rows. Raw returned chars: ${number(traffic.totalChars)} pre-projection bytes, not occupancy or billed tokens.`);
  const used = (metrics.modelsUsed ?? []).map((row: any) => ({ ...row, thinking: [...(row.thinking ?? [])], routing: [...(row.routing ?? [])], endpoints: [...(row.endpoints ?? [])] }));
  if (current && typeof current.route === 'string' && current.route) {
    let row = used.find((r: any) => r.route === current.route);
    if (!row) {
      row = { route: current.route, turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, errors: 0, thinking: [], routing: [], endpoints: [] };
      used.push(row);
    }
    if (current.thinking && !row.thinking.includes(current.thinking)) row.thinking.push(current.thinking);
    if (current.routing && !row.routing.includes(current.routing)) row.routing.push(current.routing);
    if (current.endpoint && !row.endpoints.includes(current.endpoint)) row.endpoints.push(current.endpoint);
    row.current = true;
  }
  if (!used.length) lines.push('Models: no per-route usage recorded; cache stability by route is unknown.');
  else {
    lines.push(`Models (${used.length} route${used.length === 1 ? '' : 's'} · all retained entries):`);
    for (const row of used.slice(0, 8)) {
      const parts = [`${row.turns}t`, `in${number(row.input)}`, `reuse${number(row.cacheRead)}`, `out${number(row.output)}`];
      if (row.errors) parts.push(`${row.errors} err`);
      if (row.thinking?.length) parts.push(`thinking: ${row.thinking.join(' → ')}`);
      if (row.routing?.length) parts.push(`OR: ${row.routing.join(' | ')}`);
      if (row.endpoints?.length) parts.push(`endpoint: ${row.endpoints.join(', ')}`);
      lines.push(`  ${row.route} ${parts.join(' ')}${row.current ? ' ● current' : ''}.`);
    }
    if (used.length > 8) lines.push(`  ${used.length - 8} further route(s) omitted; /export-json carries the full table.`);
  }
  if (metrics.abortedTelemetry) lines.push(`Aborted/zero-content assistant attempts held as telemetry (not projected context): ${metrics.abortedTelemetry}.`);
  lines.push('', ...metrics.detail);
  return { lines: lines.map(reportText), diagnostics, traffic };
}

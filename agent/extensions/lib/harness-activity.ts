/** Transient terminal activity only. Never writes messages, model context or
 * session entries, and never inspects tool arguments or result contents. */
export const HARNESS_ACTIVITY = Symbol.for('yunus-pi.activity.v1');
export type ActivityLabel = 'skills' | 'browser' | 'project' | 'review' | 'search' | 'model' | 'tool' | 'jev' | 'needle' | 'smol' | 'kompress' | 'council' | 'swarm' | 'fusion' | 'agents' | 'interpretation';
export type ActivityOutcome = 'ok' | 'error' | 'cancelled' | 'skipped' | 'cached';
export type FinishActivity = (outcome?: ActivityOutcome) => void;
type ActivityRequest = { action: 'start' | 'end'; id: string; label?: ActivityLabel; outcome?: ActivityOutcome };
type Context = { hasUI?: boolean; signal?: AbortSignal; cwd?: string; sessionManager?: { getSessionId?: () => string }; ui?: { theme?: { fg: (color: any, text: string) => string }; setStatus?: (key: string, text: string | undefined) => void } };
export type HarnessActivityService = (request: ActivityRequest, ctx?: Context) => FinishActivity | undefined;
const labels: Record<ActivityLabel, string> = { skills: 'Skill discovery', browser: 'Browser', project: 'Project', review: 'Review', search: 'Search', model: 'SLM processing', tool: 'Tool', jev: 'JEV', needle: 'Needle', smol: 'Smol', kompress: 'Kompress', council: 'Council', swarm: 'Swarm', fusion: 'Fusion', agents: 'Agents', interpretation: 'Interpretation' };
const helpers = new Set(['JEV', 'Needle', 'Smol', 'Kompress']);
let sequence = 0;
/** No payloads, global status handles or model messages escape this boundary. */
export function beginHarnessActivity(label: ActivityLabel): FinishActivity {
  try { return (globalThis as any)[HARNESS_ACTIVITY]?.({ action: 'start', id: `helper-${++sequence}`, label }) ?? (() => {}); }
  catch { return () => {}; }
}
const toolLabels: Record<string, string> = {
  read: 'Read', write: 'Write', edit: 'Edit', bulk_edit: 'Edit', bash: 'Shell',
  skill_review: 'Skills', render_see: 'Browser', web_probe: 'Browser',
  project_intel: 'Project', project_report: 'Project', git_info: 'Git',
  web_search: 'Search', grep: 'Search', find: 'Search', symbol_search: 'Symbols',
  read_symbol: 'Symbols', symbol_expand: 'Symbols', context_code: 'Code', context_slice: 'Code',
  fetch_content: 'Fetch', http_request: 'HTTP', subagent: 'Agents', subagent_wait: 'Agents',
  memory_write: 'Memory', memory_search: 'Memory',
  package_probe: 'Package probe', sqlite_probe: 'SQLite probe', openapi_probe: 'API probe',
  coverage_probe: 'Coverage', json_shape_diff: 'Shape diff', env_audit: 'Environment audit',
  quality_review: 'Review', project_review: 'Review', error_review: 'Review',
  net_probe: 'Network probe', archive_probe: 'Archive probe',
  browser: 'Browser', browser_navigate: 'Browser', browser_snapshot: 'Browser',
  browser_click: 'Browser', browser_screenshot: 'Browser',
};
const owners = new WeakMap<object, HarnessActivityService>();

export function registerHarnessActivity(pi: { on: (name: any, handler: any) => void }): HarnessActivityService {
  const installed = owners.get(pi);
  if (installed) return installed;
  const active = new Map<string, { label: string; token: object; started: number }>();
  let context: Context | undefined, session: string | undefined, status: string | undefined;
  let blocked = false, closed = false, signal: AbortSignal | undefined;
  let completed: string | undefined, completionTimer: ReturnType<typeof setTimeout> | undefined;
  const color = (name: string, text: string) => {
    try { return context?.ui?.theme?.fg(name, text) ?? text; } catch { return text; }
  };
  const sessionOf = (ctx?: Context) => {
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      return id ? `${ctx?.cwd ?? ''}\0${id}` : undefined;
    } catch { return undefined; } // The session manager can close before late UI events.
  };
  function render() {
    const counts = new Map<string, number>();
    for (const value of active.values()) counts.set(value.label, (counts.get(value.label) ?? 0) + 1);
    const shown = [...counts].slice(-2);
    const extra = active.size - shown.reduce((sum, [, count]) => sum + count, 0);
    const running = active.size ? color('accent', '◌ ' + shown.map(([label, count]) => label + (helpers.has(label) ? ' called' : '') + (count > 1 ? ` ×${count}` : '')).join(' · ') + (extra ? ` +${extra}` : '')) : undefined;
    const next = [running, completed].filter(Boolean).join(' · ') || undefined;
    if (next === status) return;
    status = next;
    try { context?.ui?.setStatus?.('00-harness-activity', next); } catch { /* UI can close before the final tool event. */ }
  }
  function clear() {
    clearTimeout(completionTimer); completionTimer = undefined; completed = undefined;
    active.clear(); render();
    signal?.removeEventListener('abort', cancel);
    signal = undefined;
  }
  function cancel() { clear(); blocked = true; }
  function finish(id: string, outcome: ActivityOutcome = 'ok') {
    const item = active.get(id);
    if (!item) return;
    active.delete(id);
    clearTimeout(completionTimer);
    const elapsed = Math.max(0, Date.now() - item.started);
    const duration = helpers.has(item.label) ? ` · ${elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`}` : '';
    const success = outcome === 'ok' || outcome === 'cached';
    const word = outcome === 'ok' ? helpers.has(item.label) ? 'returned' : 'finished' : outcome === 'error' ? 'failed' : outcome;
    completed = color(success ? 'success' : outcome === 'error' ? 'error' : 'warning', `${success ? '✓' : outcome === 'error' ? '✗' : '○'} ${item.label} ${word}${duration}`);
    completionTimer = setTimeout(() => { completed = undefined; completionTimer = undefined; render(); }, 2500);
    completionTimer.unref?.();
    render();
  }
  function begin(id: string, label: string, ctx: Context): FinishActivity | undefined {
    if (closed || blocked || ctx?.hasUI === false || !ctx?.ui?.setStatus || ctx.signal?.aborted) return;
    const target = sessionOf(ctx);
    if (!target || (session && target !== session)) return;
    if (id.length > 180 || !id || (!active.has(id) && active.size >= 64)) return;
    session = target; context = ctx;
    if (signal !== ctx.signal) {
      signal?.removeEventListener('abort', cancel);
      signal = ctx.signal;
      signal?.addEventListener('abort', cancel, { once: true });
    }
    const token = {};
    active.set(id, { label, token, started: Date.now() }); render();
    return (outcome) => { if (active.get(id)?.token === token) finish(id, outcome); };
  }
  const service: HarnessActivityService = (request, ctx) => {
    if (!request || typeof request.id !== 'string') return;
    ctx ??= context;
    if (!ctx) return;
    const id = 'auto:' + request.id;
    if (request.action === 'end') {
      if (sessionOf(ctx) === session) finish(id, request.outcome);
      return;
    }
    if (request.action === 'start' && request.label && Object.hasOwn(labels, request.label)) return begin(id, labels[request.label], ctx);
  };
  owners.set(pi, service);
  (globalThis as any)[HARNESS_ACTIVITY] = service;
  pi.on('tool_execution_start', (event: any, ctx: Context) => {
    if (typeof event.toolCallId !== 'string') return;
    begin('tool:' + event.toolCallId, Object.hasOwn(toolLabels, event.toolName) ? toolLabels[event.toolName] :
      typeof event.toolName === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(event.toolName) ?
        event.toolName[0].toUpperCase() + event.toolName.slice(1).replaceAll('_', ' ') : 'Tool', ctx);
  });
  pi.on('tool_execution_end', (event: any, ctx: Context) => {
    if (sessionOf(ctx) === session && typeof event.toolCallId === 'string') finish('tool:' + event.toolCallId, event.isError || event.result?.isError ? 'error' : 'ok');
  });
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree']) pi.on(event, cancel);
  for (const event of ['session_start', 'session_switch', 'session_fork', 'session_tree']) pi.on(event, (_event: unknown, ctx: Context) => {
    clear(); context = ctx; session = sessionOf(ctx); blocked = false;
  });
  for (const event of ['before_agent_start', 'agent_start']) pi.on(event, (_event: unknown, ctx: Context) => {
    if (sessionOf(ctx) === session || !session) { context = ctx; session = sessionOf(ctx); blocked = false; }
  });
  pi.on('agent_end', () => { active.clear(); blocked = true; render(); });
  pi.on('message_end', (event: any) => { if (event.message?.role === 'assistant' && event.message.stopReason === 'aborted') cancel(); });
  pi.on('session_shutdown', () => {
    clear(); closed = true;
    if ((globalThis as any)[HARNESS_ACTIVITY] === service) delete (globalThis as any)[HARNESS_ACTIVITY];
    owners.delete(pi);
  });
  return service;
}

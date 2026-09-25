import { recallProjectContext } from "./lib/project-memory-context.ts";
import { createHash, randomUUID } from 'node:crypto';
import { isHarnessOwnedChild, projectTranscriptChildren, reduceChildEvents } from './pi-subagents/src/runs/shared/child-ledger.ts';
import { promptRequestFocus } from './lib/prompt-interpretation.ts';
import { createContextAnchor } from './lib/context-anchor.ts';
import { boundedObserverText, createSessionObserver, observerAdviceText, observerDispatch, peerReviewerNotes, publishReviewerNote, reviewerSessionKey, wantsNoObserver, type ObserverEvidence, type ObserverCapability } from './lib/session-observer.ts';
import { buildWatchmakerPacket, createWatchmakerScratchpad, formatWatchmakerDuration, formatWatchmakerPace, validateWatchmakerAdvice, WATCHMAKER_CONTEXT, WATCHMAKER_DEADLINE_MS, WATCHMAKER_INTERVAL_MS, WATCHMAKER_DELIVERY_TYPE, WATCHMAKER_MEMO_TYPE, WATCHMAKER_MESSAGE, WATCHMAKER_OUTPUT_TOKENS, WATCHMAKER_TOOLS, type WatchmakerAdvice } from './lib/session-watchmaker.ts';
import { resolveWatchmakerPreferenceChain } from './pi-subagents/src/runs/shared/model-fallback.ts';
import { toModelInfo } from './pi-subagents/src/shared/model-info.ts';
import { explicitRecoveryConstraints } from './pi-subagents/src/extension/autonomous-recovery.ts';
import { isProvenFreeRoute } from './pi-subagents/src/runs/shared/free-route-evidence.ts';
import { createObserverJournal } from './lib/observer-journal.ts';
import { displayText, messageText, renderHarnessNotice } from './lib/harness-notice.ts';
import { readRemindersState } from './lib/reminders-state.ts';

/** Mr. Watchmaker: an autonomous time-only reviewer beside the session
 * observer. Same scheduler, journal, read-only tools, dispatch guards and
 * delivery receipts; no book. It judges time versus progress from
 * timestamps, durations and counts — never from tool output bodies — and
 * keeps durable conclusions in a small session scratchpad. */
export default function sessionWatchmaker(pi: any, testing: any = {}) {
  if (process.env.PI_SUBAGENT_CHILD === '1') return;
  let ctx: any, manager: any, owner = '', ownerIdentity = '', epoch = 0, taskEpoch = 0, request = '', userRequest = false, recent: ObserverEvidence[] = [], sequence = 0;
  let skills: ObserverCapability[] = [], closed = false, revision = 0, salience = 0;
  let todos: any[] = [], adviceHistory: string[] = [];
  let latestAdviceId: string | undefined;
  let preparedAdvice: { id: string; sha256: string; taskEpoch: number; signal: any } | undefined;
  let pendingAdviceText: string | undefined;
  const timings = new Map<string, { name: string; input: string; startedAt: number }>();
  const ledger = new Map<string, { calls: number; errors: number; ms: number }>();
  const repeats = new Map<string, { count: number; firstAt: number; lastAt: number; sample: string }>();
  const now = testing.now ?? Date.now;
  let inputRestrictions: any = {}, inputBlocked = false, taskStartAt = 0, agentStartAt = 0, sessionStartAt = 0, watchOff = false;
  const scratchpad = createWatchmakerScratchpad();
  /** Tick-efficiency watermarks (same contract as the session observer). */
  let optOutMark = { length: -1, first: undefined as unknown, last: undefined as unknown, request: '', blocked: false };
  let childReduceMark = { window: 0, length: -1, first: undefined as unknown, last: undefined as unknown, value: undefined as any };
  const reducedChildren = (window: number) => {
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    const first = branch.length ? branch[Math.max(0, branch.length - window)] : undefined;
    const last = branch.length ? branch[branch.length - 1] : undefined;
    if (childReduceMark.window === window && childReduceMark.length === branch.length && childReduceMark.first === first && childReduceMark.last === last && childReduceMark.value) return childReduceMark.value;
    const value = reduceChildEvents(projectTranscriptChildren(branch.slice(-window)));
    childReduceMark = { window, length: branch.length, first, last, value };
    return value;
  };
  const routeHealth = new Map<string, { failures: number; coolUntil: number }>();
  const countedDispatches = new Set<string>();
  let fallbackNotice = '';
  const journal = createObserverJournal({ maxChars: 512_000 });
  let projectHistory = '';
  let prompts: Array<{ id: string; text: string; focused?: string }> = [], promptSequence = 0, interpretation = '';
  const toolsEnabled = () => (process.env.PI_WATCHMAKER_TOOLS ?? process.env.PI_OBSERVER_TOOLS ?? '').toLowerCase() !== 'off';
  const anchor = createContextAnchor();
  const identity = (context: any) => JSON.stringify([context?.cwd ?? '', context?.sessionManager?.getSessionId?.() ?? '', context?.sessionManager?.getSessionFile?.() ?? '']);
  const owns = (context: any) => { try { return !closed && context && context.sessionManager === manager && identity(context) === ownerIdentity; } catch { return false; } };
  const pending = new Map<string, { request: string; raw: string; restrictions: any; blocked: boolean; signal?: AbortSignal; cleanup: () => void }>();
  const clearPending = () => { for (const item of pending.values()) item.cleanup(); pending.clear(); };
  const compactInput = (input: any) => {
    if (!input || typeof input !== 'object') return '';
    return Object.entries(input).filter(([key, value]) => ['path', 'file_path', 'query', 'pattern', 'command', 'action', 'operation', 'runId', 'taskId', 'id'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`).join(' ').slice(0, 140);
  };
  const add = (kind: string, text: string, tool?: string) => {
    if (!text || !request) return;
    const id = `event-${++sequence}`;
    journal.add({ id, kind, at: now(), text, ...(tool ? { tool } : {}) });
    recent.push({ id, kind, text: boundedObserverText(text, 220), ...(tool ? { tool } : {}) });
    if (recent.length > 96) recent = recent.slice(-96);
    return id;
  };
  const repeatKey = (tool: string, input: string) => `${tool} ${(input.match(/(?:path|file_path|query|pattern|command)=([^\s]+)/)?.[1] ?? '').slice(0, 80)}`.trim();
  /** Time rows: elapsed, ledger, repeats, stall/flow, children, todos. Counts
   * and durations only; output bodies and thinking never enter the packet. */
  const timeRows = (): ObserverEvidence[] => {
    const rows: ObserverEvidence[] = [];
    const elapsed = now() - taskStartAt;
    // Harness preparation (prompt analysis, a scope council) runs before the
    // agent's first response; it is not the agent's idle time.
    const prep = agentStartAt > taskStartAt ? agentStartAt - taskStartAt : 0;
    rows.push({ id: 'time-elapsed', kind: 'time', text: `task wall ${formatWatchmakerDuration(elapsed)}${prep >= 5_000 ? ` (first ${formatWatchmakerDuration(prep)} was harness preparation before the agent's first response)` : ''} · session wall ${formatWatchmakerDuration(now() - sessionStartAt)} · ${sequence} observed events this task` });
    const entries = [...ledger.entries()].sort((a, b) => b[1].ms - a[1].ms);
    const calls = entries.reduce((sum, [, row]) => sum + row.calls, 0);
    const wall = entries.reduce((sum, [, row]) => sum + row.ms, 0);
    rows.push({ id: 'time-ledger', kind: 'time', text: entries.length ? `${calls} calls in ${formatWatchmakerDuration(wall)} tool wall: ${entries.slice(0, 8).map(([tool, row]) => `${tool}×${row.calls}/${formatWatchmakerDuration(row.ms)}${row.errors ? `/${row.errors} failed` : ''}`).join(' · ')}` : 'no tool calls recorded this task' });
    const dupes = [...repeats.entries()].filter(([, row]) => row.count >= 3).sort((a, b) => b[1].count - a[1].count).slice(0, 4);
    rows.push({ id: 'time-repeats', kind: 'time', text: dupes.length ? dupes.map(([key, row]) => `${key} ×${row.count} in ${formatWatchmakerDuration(row.lastAt - row.firstAt)}`).join(' · ') : 'no 3x+ repeated tool+target this task' });
    let reduced: ReturnType<typeof reduceChildEvents> | undefined, childrenUnavailable = false;
    try { reduced = reducedChildren(512); } catch { childrenUnavailable = true; }
    const ownTasks = reduced ? reduced.tasks.filter(task => !isHarnessOwnedChild(task)) : [];
    const harnessTasks = reduced ? reduced.tasks.filter(isHarnessOwnedChild) : [];
    const activeChildren = ownTasks.filter(task => task.state === 'running' || task.state === 'queued').length;
    const edits = (ledger.get('edit')?.calls ?? 0) + (ledger.get('write')?.calls ?? 0) + (ledger.get('bulk_edit')?.calls ?? 0);
    const reads = ledger.get('read')?.calls ?? 0;
    const delegated = ledger.get('subagent')?.calls ?? 0;
    rows.push({ id: 'time-pace', kind: 'time', text: formatWatchmakerPace({ elapsed, calls, edits, reads, delegated, activeChildren }) });
    if (childrenUnavailable || !reduced) rows.push({ id: 'time-children', kind: 'time', text: 'child-agent evidence unavailable' });
    else {
      const harnessActive = harnessTasks.filter(task => task.state === 'running' || task.state === 'queued').length;
      const harness = harnessTasks.length ? ` · harness-owned automatic runs (council, skill discovery, review; not launched by the agent, results arrive on their own, nothing to harvest): ${harnessActive} active, ${harnessTasks.length - harnessActive} finished` : '';
      if (ownTasks.length) {
        const failed = ownTasks.filter(task => task.execution.status === 'failed' || task.acceptance.status === 'failed');
        const done = ownTasks.filter(task => task.state === 'completed' && task.acceptance.status !== 'failed').length;
        rows.push({ id: 'time-children', kind: 'time', text: `${ownTasks.length} agent-launched children: ${activeChildren} active · ${failed.length} failed · ${done} done${failed.length ? ` (${failed.slice(0, 3).map(task => task.label.slice(0, 40)).join('; ')})` : ''}${harness}` });
      } else rows.push({ id: 'time-children', kind: 'time', text: `no agent-launched child agents this task${harness}` });
    }
    const visible = todos.filter(task => task.status !== 'deleted');
    if (visible.length) {
      const open = visible.filter(task => task.status !== 'completed').length;
      rows.push({ id: 'time-todos', kind: 'time', text: `${visible.length - open}/${visible.length} todos done · oldest open: ${visible.filter(task => task.status !== 'completed').slice(0, 4).map(task => String(task.title ?? task.subject ?? task.id).slice(0, 50)).join('; ') || 'none'}` });
    }
    if (timings.size) rows.push({ id: 'time-running', kind: 'time', text: [...timings.values()].slice(-3).map(tool => `${tool.name} running ${formatWatchmakerDuration(now() - tool.startedAt)} ${tool.input}`).join('; ') });
    return rows;
  };
  const intentRows = (): ObserverEvidence[] => {
    const rows: ObserverEvidence[] = [];
    for (const prompt of prompts.slice(0, -1).slice(-3)) {
      const focused = prompt.focused ?? promptRequestFocus(prompt.text).replace(/\s+/g, ' ').trim();
      rows.push({ id: prompt.id, kind: 'earlier user prompt', text: focused.length <= 220 ? focused : `${focused.slice(0, 140)} … ${focused.slice(-70)}` });
    }
    if (interpretation) rows.push({ id: 'interpretation', kind: 'harness interpretation', text: `Helper's reading of the latest prompt (advisory, not the user's words): ${interpretation}` });
    try {
      const sid = ctx?.sessionManager?.getSessionId?.();
      const active = sid ? readRemindersState(sid).manual.filter(reminder => reminder.active) : [];
      if (active.length) rows.push({ id: 'user-reminders', kind: 'user reminders', text: `Standing instructions: ${active.slice(0, 4).map((reminder, index) => `${index + 1}) ${reminder.text.replace(/\s+/g, ' ').slice(0, 120)}`).join(' ')}` });
    } catch { /* Reminder state is optional evidence. */ }
    return rows;
  };
  const reset = (context: any) => { clearPending(); ctx = context; manager = context?.sessionManager; ownerIdentity = identity(context); owner = `${ownerIdentity}:${++epoch}`; request = ''; projectHistory = ''; userRequest = false; recent = []; journal.clear(); prompts = []; promptSequence = 0; interpretation = ''; skills = []; todos = []; adviceHistory = []; latestAdviceId = undefined; preparedAdvice = undefined; pendingAdviceText = undefined; timings.clear(); ledger.clear(); repeats.clear(); revision++; sequence = 0; salience = 0; inputRestrictions = {}; inputBlocked = false; taskStartAt = 0; agentStartAt = 0; sessionStartAt = now(); taskEpoch = 0; optOutMark = { length: -1, first: undefined, last: undefined, request: '', blocked: false }; childReduceMark = { window: 0, length: -1, first: undefined, last: undefined, value: undefined }; runtime.begin(owner); };
  const peerRows = (): ObserverEvidence[] => peerReviewerNotes(reviewerSessionKey(ctx), 'watchmaker', now()).slice(0, 2)
    .map(peer => ({ id: `peer-note-${peer.reviewer}`, kind: 'peer reviewer note', text: `${peer.reviewer === 'guardian' ? 'Guardian' : peer.reviewer === 'observer' ? 'Observer' : 'Watchmaker'} already told the agent ${Math.max(0, Math.round((now() - peer.at) / 1000))}s ago: ${peer.note}` }));
  const runtime = createSessionObserver({
    salience: () => salience,
    peerNotes: () => peerReviewerNotes(reviewerSessionKey(ctx), 'watchmaker', now()),
    ...testing,
    label: 'Watchmaker',
    intervalMs: WATCHMAKER_INTERVAL_MS,
    deadlineMs: WATCHMAKER_DEADLINE_MS,
    validate: (text: string, packet: any, extra: any) => validateWatchmakerAdvice(text, packet, extra),
    dispatch: testing.dispatch ?? ((route: any, packet: any, signal: AbortSignal, registry: any, host: any) => observerDispatch(route, packet, signal, registry, host, undefined, { outputTokens: WATCHMAKER_OUTPUT_TOKENS, tools: WATCHMAKER_TOOLS })),
    snapshot() {
      // Cheap guards run before any evidence or packet work; the scheduler
      // never reads the packet of a routeless snapshot, so cold paths build a
      // minimal one and the dispatch path builds exactly once below.
      const idlePacket = () => buildWatchmakerPacket({ request, rows: [], tools: [], skills: [], memos: [] });
      if (!owns(ctx) || !userRequest || ctx.isIdle?.() === true) return { packet: idlePacket(), reason: 'No active user work', silent: true };
      // Nothing of the agent's to time before its first response this task.
      if (!agentStartAt) return { packet: idlePacket(), reason: 'Waiting for the main agent\'s first response', silent: true };
      if (['1', 'true'].includes(process.env.PI_OFFLINE ?? '') || (process.env.PI_WATCHMAKER ?? '').toLowerCase() === 'off' || watchOff) return { packet: idlePacket(), reason: 'Watchmaker disabled or offline', silent: true };
      if (pending.size) return { packet: idlePacket(), reason: 'User input is pending', silent: true };
      let blocked: boolean;
      try {
        const branch = ctx.sessionManager.getBranch?.() ?? [];
        if (optOutMark.request === request && optOutMark.length === branch.length
          && (branch.length === 0 || (optOutMark.first === branch[0] && optOutMark.last === branch[branch.length - 1]))) blocked = optOutMark.blocked;
        else {
          blocked = inputBlocked || wantsNoObserver(request);
          for (const entry of branch) if (entry.type === 'message' && entry.message?.role === 'user') {
            const parts = typeof entry.message.content === 'string' ? [entry.message.content]
              : (entry.message.content ?? []).filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text);
            for (const text of parts) blocked ||= wantsNoObserver(text);
          }
          optOutMark = { length: branch.length, first: branch[0], last: branch[branch.length - 1], request, blocked };
        }
      } catch { return { packet: idlePacket(), reason: 'User constraints unavailable' }; }
      if (blocked) return { packet: idlePacket(), reason: 'User requested no background observer or network' };
      scratchpad.seed(ctx?.sessionManager?.getBranch?.() ?? []);
      const evidence = [...timeRows(), ...intentRows(), ...(projectHistory ? [{ id: 'project-history', kind: 'historical project evidence', text: projectHistory }] : []), ...peerRows(), ...adviceHistory.slice(-3).map((text, index) => ({ id: `prior-advice-${index}`, kind: 'previous advice already delivered', text })), ...recent.slice(0, 10)];
      const active = new Set<string>(pi.getActiveTools?.() ?? []);
      const tools = (pi.getAllTools?.() ?? []).map((tool: any) => ({ name: tool.name, description: tool.description ?? '', availability: active.has(tool.name) ? 'active' as const : 'discoverable' as const }));
      const currentPacket = buildWatchmakerPacket({ request, rows: evidence, tools, skills, memos: scratchpad.list().map(memo => memo.text) });
      let available = ctx.modelRegistry.getAvailable();
      if (ctx.scopedModels?.length) { const scope = new Set(ctx.scopedModels.map((row: any) => `${row.model?.provider}/${row.model?.id}`)); available = available.filter((model: any) => scope.has(`${model.provider}/${model.id}`)); }
      const selection = resolveWatchmakerPreferenceChain(available.map(toModelInfo));
      const entry = selection.routes.find(route => (routeHealth.get(route.route)?.coolUntil ?? 0) <= now()) ?? selection.routes[0];
      if (entry && selection.routes[0] && entry.route !== selection.routes[0].route && fallbackNotice !== entry.route) {
        fallbackNotice = entry.route;
        pi.sendMessage({ customType: WATCHMAKER_MESSAGE, content: `Watchmaker route ${selection.routes[0].route} failed repeatedly; using configured fallback ${entry.route} for up to 10 minutes.`, display: true, excludeFromContext: true, details: { status: 'fallback', route: entry.route } }, { triggerTurn: false });
      } else if (entry?.route === selection.routes[0]?.route) fallbackNotice = '';
      if (!entry) return { packet: currentPacket, reason: selection.status === 'disabled' ? 'Watchmaker disabled in model preferences' : 'Configured watchmaker model unavailable' };
      const model = available.find((candidate: any) => `${candidate.provider}/${candidate.id}` === entry.route);
      if (!model || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 2048) return { packet: currentPacket, reason: 'Configured watchmaker model lacks output capacity' };
      const constraints = explicitRecoveryConstraints(ctx, request, ctx.model);
      for (const key of ['fixedRoute', 'sameModel', 'freeOnly']) constraints[key] ||= inputRestrictions[key];
      if ((constraints.fixedRoute || constraints.sameModel) && `${ctx.model?.provider}/${ctx.model?.id}` !== entry.route) return { packet: currentPacket, reason: 'User model restriction prevents watchmaker route' };
      if (constraints.freeOnly && !isProvenFreeRoute(model)) return { packet: currentPacket, reason: 'User free-only restriction prevents watchmaker route' };
      const capturedSequence = sequence;
      // Time rows only grow: a note goes stale only when the model changed
      // under it. Overlap is named in the delivery caveat by the scheduler.
      const stillCurrent = () => capturedModel === `${ctx.model?.provider}/${ctx.model?.id}` ? true : false;
      const capturedModel = `${ctx.model?.provider}/${ctx.model?.id}`;
      const reviewKey = JSON.stringify({ taskEpoch, revision, sequence, unread: recent[0]?.id ?? null, ledger: [...ledger.entries()].map(([tool, row]) => [tool, row.calls, row.errors, Math.round(row.ms / 1000)]), model: capturedModel, route: entry.route, tools: tools.map(tool => [tool.name, tool.availability]), skills: skills.map(skill => skill.name) });
      const routeName = entry.route;
      const toolHost = toolsEnabled() && typeof ctx.cwd === 'string' ? { journal, cwd: ctx.cwd } : undefined;
      return { packet: currentPacket, registry: ctx.modelRegistry, reviewKey, current: stillCurrent, toolHost, knownIds: () => journal.list().map(entry => entry.id),
        reviewed: () => { recent = recent.filter(row => !new Set(currentPacket.evidence.map(item => item.id)).has(row.id)); }, route: { ...entry, model, officialDefault: selection.source === 'default', requireFree: constraints.freeOnly },
        backlog: recent.filter(row => !new Set(currentPacket.evidence.map(item => item.id)).has(row.id)).length,
        dispatched: () => {},
        applied: (advice: any) => {
          if (!owns(ctx)) return undefined;
          const memo = (advice as WatchmakerAdvice)?.memo;
          if (memo) {
            scratchpad.add(memo, now());
            try { pi.appendEntry(WATCHMAKER_MEMO_TYPE, { memo, at: now() }); } catch { /* The ring keeps the memo; persistence is best-effort. */ }
            return 'kept memo';
          }
          return (advice as WatchmakerAdvice)?.memoRejected ? `memo dropped (${(advice as WatchmakerAdvice).memoRejected})` : undefined;
        } };
    },
    notice(status: string, detail: string, advice: any) {
      if (!owns(ctx)) return;
      if (advice) {
        publishReviewerNote(reviewerSessionKey(ctx), 'watchmaker', advice.note, [...(advice.tools ?? []), ...(advice.skills ?? [])], now());
        if (latestAdviceId && preparedAdvice?.id !== latestAdviceId) {
          try { pi.appendEntry(WATCHMAKER_DELIVERY_TYPE, { adviceId: latestAdviceId, status: 'dropped:superseded', at: now() }); } catch { /* Accounting cannot suppress otherwise valid advice. */ }
        }
        latestAdviceId = `watchmaker-advice-${randomUUID()}`; preparedAdvice = undefined; pendingAdviceText = observerAdviceText(advice);
      }
      const content = advice ? `Watchmaker returned a note · snapshot ${advice.evidence.join(', ')} · ${detail}\n${observerAdviceText(advice)}` : `Watchmaker ${status}: ${detail}`;
      const delivery = pi.sendMessage({ customType: WATCHMAKER_MESSAGE, content, display: true, excludeFromContext: true, details: { status, detail: displayText(detail, 240),
        ...(advice ? { adviceId: latestAdviceId, note: advice.note, evidence: advice.evidence, tools: advice.tools, skills: advice.skills, ...(advice.discoverableTools?.length ? { discoverableTools: advice.discoverableTools } : {}) } : {}) } }, { triggerTurn: false });
      void Promise.resolve(delivery).catch(() => { /* Native delivery reports display failures independently. */ });
    },
    receipt(data: any, origin: string) {
      const route = typeof data?.provider === 'string' && typeof data?.model === 'string' ? `${data.provider}/${data.model}` : '';
      const dispatch = typeof data?.id === 'string' ? data.id : '';
      if (route && ['failed', 'timeout', 'completed'].includes(data.status) && !countedDispatches.has(dispatch)) {
        if (dispatch) { countedDispatches.add(dispatch); if (countedDispatches.size > 64) countedDispatches.delete(countedDispatches.values().next().value!); }
        const health = routeHealth.get(route) ?? { failures: 0, coolUntil: 0 };
        if (data.status === 'completed') { health.failures = 0; health.coolUntil = 0; }
        else if (++health.failures >= 2) health.coolUntil = now() + 600_000;
        routeHealth.set(route, health); if (routeHealth.size > 32) routeHealth.delete(routeHealth.keys().next().value!);
      }
      if (owns(ctx) && origin === owner) pi.appendEntry('auxiliary-model-usage-v1', data);
    },
  });
  pi.registerMessageRenderer(WATCHMAKER_MESSAGE, (message: any, options: any, theme: any) => {
    const details = message.details ?? {}, text = messageText(message);
    if (details.status === 'completed') {
      const [first, ...note] = text.split('\n');
      const summary = typeof details.detail === 'string' ? details.detail : first.replace(/^Watchmaker returned a note(?: · )?/, '');
      return renderHarnessNotice({ icon: '◷', tone: 'accent', title: 'Watchmaker note', summary: displayText(summary, 240), body: note.join('\n') }, options, theme);
    }
    const tone = details.status === 'unavailable' ? 'warning' : details.status === 'fallback' ? 'warning' : 'muted';
    const title = { started: 'Watchmaker reviewing', checked: 'Watchmaker', reviewed: 'Watchmaker reviewed', skipped: 'Watchmaker skipped', stopped: 'Watchmaker stopped', unavailable: 'Watchmaker unavailable', fallback: 'Watchmaker route' }[details.status as string] ?? 'Watchmaker';
    return renderHarnessNotice({ icon: '◷', tone, title, summary: text.replace(/^Watchmaker [a-z]+: /, '').replace(/\s+/g, ' ').slice(0, 400) }, options, theme);
  });
  pi.registerCommand?.('watchmaker', {
    description: 'Mr. Watchmaker: status and scratchpad memos — usage: /watchmaker [memos | on | off]',
    argumentHint: '[memos|on|off]',
    handler: async (args: string, context: any) => {
      const say = (text: string, level: 'info' | 'warning' = 'info') => {
        if (context?.hasUI && typeof context.ui?.notify === 'function') context.ui.notify(text, level);
        else pi.sendMessage({ customType: WATCHMAKER_MESSAGE, content: text, display: true, excludeFromContext: true, details: { status: 'checked' } }, { triggerTurn: false });
      };
      const [verb = ''] = String(args ?? '').trim().split(/\s+/).filter(Boolean);
      if (verb === 'off' || verb === 'on') { watchOff = verb === 'off'; say(`Mr. Watchmaker ${watchOff ? 'paused' : 'resumed'} for this session.`); return; }
      if (verb === 'memos') {
        const memos = scratchpad.list();
        say(memos.length ? memos.map((memo, index) => `${index + 1}. ${memo.text}`).join('\n') : 'No watchmaker memos this session yet.');
        return;
      }
      say([`Mr. Watchmaker ${watchOff ? 'paused' : 'watching'} · task wall ${formatWatchmakerDuration(now() - taskStartAt)} · ${sequence} events · ${scratchpad.list().length} memos.`,
        `Ledger: ${[...ledger.entries()].map(([tool, row]) => `${tool}×${row.calls}`).join(', ') || 'no calls'}.`,
        `Advice: ${adviceHistory.length ? 'last note delivered' : 'none delivered yet'}${latestAdviceId ? ' · one note awaiting provider confirmation' : ''}.`].join('\n'));
    },
  });
  pi.on('session_start', (_event: any, context: any) => { closed = false; reset(context); });
  for (const event of ['session_switch', 'session_tree', 'session_fork']) pi.on(event, (_: any, context: any) => reset(context));
  pi.on('input', (event: any, context: any) => {
    if (!['interactive', 'rpc'].includes(event.source) || typeof event.requestId !== 'string') return;
    if (!owns(context)) reset(context);
    ctx = context; const raw = typeof (event.originalText ?? event.text) === 'string' ? (event.originalText ?? event.text) : '';
    let restrictions: any = {}, blocked = wantsNoObserver(raw);
    try { restrictions = explicitRecoveryConstraints(context, raw, context.model); } catch { blocked = true; }
    runtime.stop('New user input');
    latestAdviceId = undefined; preparedAdvice = undefined; pendingAdviceText = undefined;
    const id = event.requestId;
    const abort = () => { pending.get(id)?.cleanup(); pending.delete(id); if (owns(context) && userRequest && !pending.size && context.isIdle?.() === false) runtime.start(); };
    const cleanup = () => event.signal?.removeEventListener('abort', abort);
    pending.get(id)?.cleanup();
    const focused = promptRequestFocus(raw);
    const boundedRequest = focused.length <= 4000 ? focused : `${focused.slice(0, 2000)}\n[Middle omitted from watchmaker packet]\n${focused.slice(-1900)}`;
    pending.set(id, { request: boundedObserverText(boundedRequest, 4000), raw, restrictions, blocked, signal: event.signal, cleanup });
    event.signal?.addEventListener('abort', abort, { once: true });
    if (event.signal?.aborted) abort();
    while (pending.size > 8) { const oldest = pending.keys().next().value!; pending.get(oldest)?.cleanup(); pending.delete(oldest); }
  });
  pi.on('message_start', (event: any, context: any) => {
    if (owns(context) && event.message?.role === 'assistant' && userRequest && !agentStartAt) { agentStartAt = now(); revision++; return; }
    if (!owns(context) || event.message?.role !== 'user') return;
    const id = event.message[Symbol.for('yunuspi.guardian.request-meta.v1')]?.requestId;
    const accepted = pending.get(id);
    if (!accepted || accepted.signal?.aborted) return;
    accepted.cleanup(); pending.delete(id); ctx = context;
    request = accepted.request; userRequest = Boolean(request.trim()); inputRestrictions = accepted.restrictions; inputBlocked = accepted.blocked;
    if (userRequest) {
      const promptId = `prompt-${++promptSequence}`;
      prompts.push({ id: promptId, text: accepted.raw, focused: promptRequestFocus(accepted.raw).replace(/\s+/g, ' ').trim() }); if (prompts.length > 24) prompts.shift();
      journal.add({ id: promptId, kind: 'user prompt', at: now(), text: accepted.raw });
      interpretation = '';
    }
    recent = []; revision++; taskEpoch++; taskStartAt = now(); agentStartAt = 0; ledger.clear(); repeats.clear();
    runtime.begin(owner); if (userRequest) runtime.start();
    projectHistory = '';
    const memoryOwner = owner, memoryTask = taskEpoch;
    if (userRequest && !inputBlocked && process.env.PI_WATCHMAKER !== 'off' && !['1', 'true', 'yes'].includes(process.env.PI_OFFLINE ?? '') && !wantsNoObserver(accepted.raw)) void recallProjectContext(context.cwd, accepted.raw, 'watchmaker', accepted.signal).then(text => {
      if (!text || !owns(context) || owner !== memoryOwner || taskEpoch !== memoryTask) return;
      projectHistory = text;
      journal.add({ id: 'project-history', kind: 'historical project evidence', at: now(), text });
      revision++;
    });
  });
  pi.on('before_agent_start', (event: any, context: any) => {
    if (!owns(context)) reset(context); ctx = context;
    skills = (event.systemPromptOptions?.skills ?? []).filter((skill: any) => !skill.disableModelInvocation && typeof skill.name === 'string' && typeof skill.description === 'string').slice(0, 1024).map((skill: any) => ({ name: skill.name, description: skill.description }));
  });
  pi.on('agent_start', (_: any, context: any) => { if (owns(context) && userRequest) { ctx = context; runtime.start(); } });
  pi.on('message_end', (event: any, context: any) => {
    if (!owns(context)) return;
    if (event.message?.role === 'custom') { observeHarnessMessage(event.message); return; }
    if (event.message?.role !== 'assistant') return;
    if (userRequest && !agentStartAt) agentStartAt = now();
    const said = Array.isArray(event.message.content) ? event.message.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') : '';
    const calls = Array.isArray(event.message.content) ? event.message.content.filter((part: any) => part?.type === 'toolCall').length : 0;
    // Counts and a short head only; bodies and thinking stay out of the packet.
    add('assistant text', `${calls} tool call${calls === 1 ? '' : 's'}${said.trim() ? ` · ${boundedObserverText(said.replace(/\s+/g, ' '), 160)}` : ''}`);
    revision++;
  });
  const observeHarnessMessage = (message: any) => {
    if ([WATCHMAKER_MESSAGE, WATCHMAKER_CONTEXT, 'session-observer', 'session-observer-context'].includes(message.customType)) return;
    const text = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') : '';
    if (!text.trim()) return;
    if (message.customType === 'prompt-analysis') {
      interpretation = boundedObserverText(text.replace(/\n?Original user prompt preserved\.[^\n]*/, '').replace(/\s*\n\s*/g, ' · '), 300);
      revision++; return;
    }
    if (message.customType === 'reminders') {
      const own = text.split('\n').filter(line => line.startsWith('[custom-reminder] ')).map(line => line.slice(18));
      if (own.length) add('user reminder delivered', `Delivered: ${boundedObserverText(own.join(' | '), 200)}`);
      revision++; return;
    }
    if (message.customType === 'guardian_intervention' && !message.excludeFromContext) { publishReviewerNote(reviewerSessionKey(ctx), 'guardian', text, [], now()); add('guardian intervention', boundedObserverText(text, 200)); salience++; revision++; return; }
    if (['memory-prime', 'todo-plan', 'relevant-guidance'].includes(message.customType)) { add('harness guidance to agent', boundedObserverText(text, 160)); revision++; }
  };
  pi.on('tool_execution_start', (event: any, context: any) => {
    if (!owns(context)) return;
    if (userRequest && !agentStartAt) agentStartAt = now();
    if (event.toolCallId) {
      timings.set(event.toolCallId, { name: event.toolName, input: compactInput(event.args), startedAt: now() });
      if (timings.size > 128) timings.delete(timings.keys().next().value!);
    }
    revision++;
  });
  pi.on('tool_result', (event: any, context: any) => {
    if (!owns(context)) return;
    if (userRequest && !agentStartAt) agentStartAt = now();
    const started = timings.get(event.toolCallId);
    timings.delete(event.toolCallId);
    const ms = started ? Math.max(0, now() - started.startedAt) : 0;
    const input = compactInput(event.input) || started?.input || '';
    const row = ledger.get(event.toolName) ?? { calls: 0, errors: 0, ms: 0 };
    row.calls++; row.errors += event.isError ? 1 : 0; row.ms += ms;
    ledger.set(event.toolName, row);
    const key = repeatKey(event.toolName, input);
    if (key) {
      const seen = repeats.get(key) ?? { count: 0, firstAt: now(), lastAt: 0, sample: input.slice(0, 80) };
      seen.count++; seen.lastAt = now();
      repeats.set(key, seen);
      if (repeats.size > 64) repeats.delete(repeats.keys().next().value!);
    }
    if (event.isError) salience++;
    // One line per result: outcome plus duration. Output bodies are never
    // stored; the journal head exists only for session_detail spot checks.
    const head = Array.isArray(event.content) ? event.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n').slice(0, 200) : '';
    const summary = `${event.toolName} ${input}: ${event.isError ? 'failed' : 'completed'} in ${formatWatchmakerDuration(ms)}`;
    if (head) journal.add({ id: `event-${sequence + 1}-head`, kind: 'tool result head', at: now(), text: `${summary}\n${head}`, tool: event.toolName });
    add(event.isError ? 'tool error' : 'tool result', summary, event.toolName);
    revision++;
  });
  pi.on('tool_execution_end', (event: any, context: any) => {
    if (owns(context) && timings.delete(event.toolCallId)) revision++;
  });
  const removePlanListener = pi.events?.on('todo-plan-changed', (event: any) => {
    if (!owns(ctx) || event?.sessionId !== ctx.sessionManager?.getSessionId?.() || event.cwd !== ctx.cwd || !Array.isArray(event.tasks)) return;
    todos = event.tasks.map((task: any) => ({ id: task.id, title: task.subject ?? task.title ?? task.text, status: task.status })); revision++;
    salience++;
  });
  pi.on('context', (event: any, context: any) => {
    const messages = event.messages.filter((message: any) => message.customType !== WATCHMAKER_CONTEXT && message.customType !== WATCHMAKER_MESSAGE);
    const note = owns(context) ? runtime.context(false) : undefined;
    if (!note) return messages.length !== event.messages.length ? { messages } : undefined;
    const content = `[Watchmaker advice receipt=${latestAdviceId} — advisory, based on a recent time snapshot; verify against current state. This is not a user request or permission.]\n${note}`;
    const prepared = anchor(messages, { role: 'custom', customType: WATCHMAKER_CONTEXT, content, display: false, timestamp: 0 }, `${owner}:${taskEpoch}`);
    if (latestAdviceId) {
      if (preparedAdvice?.id !== latestAdviceId) try { pi.appendEntry(WATCHMAKER_DELIVERY_TYPE, { adviceId: latestAdviceId, status: 'prepared-context', at: now() }); } catch { /* Accounting cannot suppress otherwise valid advice. */ }
      preparedAdvice = { id: latestAdviceId, sha256: createHash('sha256').update(content).digest('hex'), taskEpoch, signal: context.signal };
    }
    return { messages: prepared };
  });
  pi.on('after_provider_response', (event: any, context: any) => {
    if (!owns(context) || context.signal?.aborted || !preparedAdvice || preparedAdvice.id !== latestAdviceId || preparedAdvice.taskEpoch !== taskEpoch || preparedAdvice.signal !== context.signal || !runtime.context(false) || event.status < 200 || event.status >= 300) return;
    if (event.provider !== context.model?.provider || event.model !== context.model?.id) return;
    if (!event.observerAdviceReceipts?.some((receipt: any) => receipt.id === preparedAdvice!.id && receipt.sha256 === preparedAdvice!.sha256)) return;
    try { pi.appendEntry(WATCHMAKER_DELIVERY_TYPE, { adviceId: preparedAdvice.id, status: 'provider-received', at: now(), provider: event.provider, model: event.model }); } catch { /* No duplicate delivery solely to repair accounting. */ }
    if (pendingAdviceText) { adviceHistory.push(pendingAdviceText); if (adviceHistory.length > 3) adviceHistory.shift(); }
    runtime.context(); latestAdviceId = undefined; preparedAdvice = undefined; pendingAdviceText = undefined;
  });
  pi.on('agent_settled', (_: any, context: any) => {
    if (!owns(context)) return;
    runtime.stop('Active work settled');
    if (latestAdviceId && preparedAdvice?.id !== latestAdviceId) {
      try { pi.appendEntry(WATCHMAKER_DELIVERY_TYPE, { adviceId: latestAdviceId, status: 'dropped:settled', at: now() }); } catch { /* Accounting only. */ }
    }
    latestAdviceId = undefined; preparedAdvice = undefined; pendingAdviceText = undefined;
  });
  pi.on('session_shutdown', () => { runtime.close(); clearPending(); removePlanListener?.(); closed = true; recent = []; request = ''; });
}

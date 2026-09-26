import { recallProjectContext } from "./lib/project-memory-context.ts";
import { createHash, randomUUID } from 'node:crypto';
import { isHarnessOwnedChild, projectTranscriptChildren, reduceChildEvents } from './pi-subagents/src/runs/shared/child-ledger.ts';
import { observerModelEvidence } from './lib/observer-model-evidence.ts';
import { promptRequestFocus } from './lib/prompt-interpretation.ts';
import { createContextAnchor } from './lib/context-anchor.ts';
import { buildObserverPacket, boundedObserverText, carriedReviewerNoteText, createSessionObserver, digestObserverEvents, observerAdviceText, peerReviewerNotes, publishReviewerNote, reviewerSessionKey, wantsNoObserver, OBSERVER_CONTEXT, OBSERVER_MESSAGE, type CarriedReviewerNote, type ObserverEvidence, type ObserverCapability } from './lib/session-observer.ts';
import { resolveSessionObserverPreferenceChain } from './pi-subagents/src/runs/shared/model-fallback.ts';
import { toModelInfo } from './pi-subagents/src/shared/model-info.ts';
import { explicitRecoveryConstraints } from './pi-subagents/src/extension/autonomous-recovery.ts';
import { isProvenFreeRoute } from './pi-subagents/src/runs/shared/free-route-evidence.ts';
import { projectMemoryKey } from './pi-memory/project-identity.ts';
import { needleHealth, needleRank } from './lib/needle-runtime.ts';
import { needlePolicy } from './lib/needle-policy.ts';
import { createBookSelectionState, createMarginStore, createSessionProfile, findSemanticMarginDuplicate, loadObserverBook, marginStoreDir, noteBookCitations, noteBookmarks, noteBookReview, profileRow, renderBookSection,
  selectBookPassages, selectMargins, type BookSection, type BookSelection, type MarginStore, type ObserverBook } from './lib/observer-book.ts';
import path from 'node:path';
import { createObserverJournal } from './lib/observer-journal.ts';
import { displayText, messageText, renderHarnessNotice } from './lib/harness-notice.ts';
import { readRemindersState } from './lib/reminders-state.ts';
import { expertReviewerRows } from './lib/expert-convergence.ts';
import { currentTaskStateService } from './lib/task-state/service.ts';

/** Shared task-state projection for the reviewer packet; empty when the graph is unavailable. */
function taskStateObserverRows(): ObserverEvidence[] {
  try {
    const service = currentTaskStateService();
    if (!service || !service.available) return [];
    const text = service.project('observer', 1500);
    if (!text || text === '(task state unavailable)') return [];
    return [{ id: 'task-state', kind: 'task state graph', text }];
  } catch {
    return [];
  }
}

/** Opt-in/default-configured direct observer; it owns no tools or child agents. */
export default function sessionObserver(pi: any, testing: any = {}) {
  if (process.env.PI_SUBAGENT_CHILD === '1') return;
  let ctx: any, manager: any, owner = '', ownerIdentity = '', epoch = 0, taskEpoch = 0, request = '', userRequest = false, recent: ObserverEvidence[] = [], sequence = 0;
  let skills: ObserverCapability[] = [], streaming: ObserverEvidence[] = [], closed = false, revision = 0, dropped = 0, reportedDropped = 0;
  let todos: any[] = [], adviceHistory: string[] = [];
  let latestAdviceId: string | undefined;
  // The last persisted start line; identical starts ride the footer status.
  let lastStartedDetail: string | undefined;
  let preparedAdvice: { id: string; sha256: string; taskEpoch: number; signal: any } | undefined;
  // Note text awaiting provider confirmation. Only confirmed-delivered notes
  // join adviceHistory; unconfirmed notes must not pose as "already delivered".
  let pendingAdviceText: string | undefined;
  // The newest completed note that never reached a provider request. The next
  // context build delivers it as its own capsule alongside the current note.
  let carriedAdvice: CarriedReviewerNote | undefined;
  let preparedCarried: { id: string; sha256: string; taskEpoch: number; signal: any } | undefined;
  /** Queue the pending note for the next context build instead of dropping it.
   * Prepared notes keep their prepared-context signal; only unprepared notes
   * (never in any request) are carried. One deep; a replacement is ledgered. */
  const stashCarried = (via: string) => {
    if (!latestAdviceId || preparedAdvice?.id === latestAdviceId || !pendingAdviceText) return false;
    if (carriedAdvice && carriedAdvice.id !== latestAdviceId) {
      try { pi.appendEntry('session-observer-delivery-v1', { adviceId: carriedAdvice.id, status: 'dropped:replaced', at: now() }); } catch { /* Accounting cannot suppress otherwise valid advice. */ }
    }
    carriedAdvice = { id: latestAdviceId, text: pendingAdviceText, at: now() };
    try { pi.appendEntry('session-observer-delivery-v1', { adviceId: latestAdviceId, status: 'carried', via, at: now() }); } catch { /* Accounting cannot suppress otherwise valid advice. */ }
    return true;
  };
  // Task-level momentum for repeat escalation: completed notes vs parent edits.
  let notesThisTask = 0, parentEditsThisTask = 0;
  /** Set at the agent's first assistant message of the task: before it, only
   * harness preparation runs and there is no agent work to review. */
  let agentResponded = false;
  const failureKeys = new Map<string, string>();
  const completed = new Map<string, string>(), toolInputs = new Map<string, string>(), startedEvents = new Map<string, string>();
  const runningTools = new Map<string, { name: string; input: string; startedAt: number; foreground: boolean }>();
  const now = testing.now ?? Date.now;
  let inputRestrictions: any = {}, inputBlocked = false;
  // Observer Book state. The profile and selection belong to the current task;
  // margin notes belong to the project and persist across sessions.
  const profile = createSessionProfile(now);
  let bookState = createBookSelectionState(), bookOff = false, salience = 0, childSummary = { total: 0, failed: 0 };
  let marginStore: MarginStore | undefined, marginKey = '', needleFlight = false;
  /** Margin notes written or raised this session (see the book selection). */
  const sessionMargins = new Set<string>();
  /** Parent edit count when the wrap-up note on finished work was delivered;
   * -1 while none was. Finished work gets one closing note, not a loop. */
  let closeNoteEdits = -1;
  const workFinished = () => { const visible = todos.filter(task => task.status !== 'deleted'); return visible.length > 0 && visible.every(task => task.status === 'completed'); };
  let routingEpoch = -1, routingChildState = '', lastFired = '';
  let lastBookView: Array<{ id: string; title: string; trigger?: string }> = [];
  // Full text behind every excerpt, searchable by the observer's read-only
  // tools. Session-scoped: a new prompt keeps it, a new session clears it.
  const journal = createObserverJournal();
  let projectHistory = '';
  let prompts: Array<{ id: string; text: string; focused?: string }> = [], promptSequence = 0, interpretation = '';
  /** Tick-efficiency watermarks. The transcript branch is append-mostly, so the
   * opt-out scan and the child-ledger reduce reuse their result while the
   * window identity (length + first/last refs) is unchanged; any rewrite
   * (compaction, switch) misses the watermark and recomputes exactly. */
  let optOutMark = { length: -1, first: undefined as unknown, last: undefined as unknown, request: '', blocked: false };
  let childReduceMark = { window: 0, length: -1, first: undefined as unknown, last: undefined as unknown, value: undefined as any };
  const toolsEnabled = () => (process.env.PI_OBSERVER_TOOLS ?? '').toLowerCase() !== 'off';
  const routeHealth = new Map<string, { failures: number; coolUntil: number }>();
  // A timed-out request reports twice: at its deadline and again when the
  // aborted transport settles. Each dispatch counts once toward cooling.
  const countedDispatches = new Set<string>();
  let fallbackNotice = '';
  const bookEnabled = () => !bookOff && (process.env.PI_OBSERVER_BOOK ?? '').toLowerCase() !== 'off';
  const loadBook = (): ObserverBook | undefined => {
    if (!bookEnabled()) return undefined;
    try { const book = (testing.loadBook ?? loadObserverBook)(); return book?.chapters?.length ? book : undefined; } catch { return undefined; }
  };
  const margins = (context: any): MarginStore | undefined => {
    const dir = testing.marginDir !== undefined ? testing.marginDir : marginStoreDir();
    if (!dir || typeof context?.cwd !== 'string') return undefined;
    try {
      const key = projectMemoryKey(context.cwd);
      if (!marginStore || marginKey !== key) { marginStore?.flush(); marginStore = createMarginStore({ dir, project: key, label: path.basename(context.cwd), now }); marginKey = key; }
      return marginStore;
    } catch { return undefined; }
  };
  const needleUsable = () => {
    if (testing.needleRank) return true;
    try { return needlePolicy().enabled && ['healthy', 'degraded'].includes(needleHealth().state); } catch { return false; }
  };
  /** Refine the next selection with Needle when it is already serving other
   * callers; never starts the worker for the observer and never blocks. */
  async function refineWithNeedle(selection: BookSelection, query: string) {
    if (needleFlight || selection.candidates.length < 3 || bookState.needle?.signature === selection.signature || !needleUsable()) return;
    needleFlight = true;
    const state = bookState;
    try {
      const result = await (testing.needleRank ?? needleRank)({ query: query.slice(0, 160), candidates: selection.candidates, topK: selection.candidates.length });
      if (result?.ok && state === bookState && Array.isArray(result.value?.ranked)) state.needle = { signature: selection.signature, order: result.value.ranked.map((row: any) => String(row.id)) };
    } catch { /* Lexical order remains authoritative. */ } finally { needleFlight = false; }
  }
  const anchor = createContextAnchor();
  const identity = (context: any) => JSON.stringify([context?.cwd ?? '', context?.sessionManager?.getSessionId?.() ?? '', context?.sessionManager?.getSessionFile?.() ?? '']);
  const owns = (context: any) => { try { return !closed && context && context.sessionManager === manager && identity(context) === ownerIdentity; } catch { return false; } };
  const pending = new Map<string, { request: string; raw: string; restrictions: any; blocked: boolean; signal?: AbortSignal; cleanup: () => void }>();
  const clearPending = () => { for (const item of pending.values()) item.cleanup(); pending.clear(); };
  const textParts = (message: any, type = 'text', limit = 700) => Array.isArray(message?.content)
    ? message.content.slice(-8).filter((x: any) => x?.type === type && typeof x[type] === 'string').map((x: any) => boundedObserverText(x[type], limit)).join('\n').slice(-limit) : '';
  const add = (kind: string, text: string, tool?: string, full?: string) => {
    if (!text || !request) return;
    const id = `event-${++sequence}`;
    journal.add({ id, kind, at: now(), text: full && full.length > text.length ? full : text, ...(tool ? { tool } : {}) });
    recent.push({ id, kind, text: boundedObserverText(text, 700), ...(tool ? { tool } : {}) });
    // Overflow is folded into one digest row, never silently dropped.
    if (recent.length > 256) { const fold = recent.splice(0, recent.length - 200); dropped += fold.filter(row => row.kind !== 'event digest').length; recent.unshift(digestObserverEvents(fold, `digest-${id}`)); }
    return id;
  };
  const compactInput = (input: any) => {
    if (!input || typeof input !== 'object') return '';
    return Object.entries(input).filter(([key, value]) => ['path', 'file_path', 'offset', 'limit', 'action', 'operation', 'runId', 'taskId', 'id', 'query', 'pattern', 'command', 'timeout', 'timeoutMs', 'timeoutSeconds', 'async', 'background'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => `${key}=${String(value).slice(0, 140)}`).join(' ').slice(0, 220);
  };
  /** Child-ledger reduction over the trailing branch window, memoized on the
   * window identity. Tool/todo rows stay live; only the O(window) transcript
   * projection is reused, and any branch rewrite recomputes it. */
  const reducedChildren = (window: number) => {
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    const first = branch.length ? branch[Math.max(0, branch.length - window)] : undefined;
    const last = branch.length ? branch[branch.length - 1] : undefined;
    if (childReduceMark.window === window && childReduceMark.length === branch.length && childReduceMark.first === first && childReduceMark.last === last && childReduceMark.value) return childReduceMark.value;
    const value = reduceChildEvents(projectTranscriptChildren(branch.slice(-window)));
    childReduceMark = { window, length: branch.length, first, last, value };
    return value;
  };
  const currentState = (withElapsed = true): ObserverEvidence[] => {
    const rows: ObserverEvidence[] = [];
    if (runningTools.size) rows.push({ id: 'running-tools', kind: 'current state', text: [...runningTools.values()].slice(-3).map(tool => `${tool.name} ${tool.foreground ? 'foreground' : 'running'}${withElapsed ? ` elapsed=${Math.floor((now() - tool.startedAt) / 1000)}s` : ''} ${tool.input}`).join('; ') });
    if (completed.size) rows.push({ id: 'completed-tools', kind: 'current state', text: 'Recently completed tools (do not suggest repeating without a new reason): ' + [...completed.values()].join('; ').slice(-370) });
    const visibleTodos = todos.filter(task => task.status !== 'deleted');
    if (visibleTodos.length) {
      const inProgress = visibleTodos.filter(task => task.status === 'in_progress');
      const pending = visibleTodos.filter(task => task.status === 'pending');
      const completedTodos = visibleTodos.filter(task => task.status === 'completed');
      const selected = [...inProgress, ...pending, ...completedTodos.slice(-2)].slice(0, 12);
      rows.push({ id: 'todo-state', kind: 'current state', text: `${inProgress.length + pending.length} open, ${completedTodos.length} completed: ${selected.map(task => `${String(task.id).slice(0, 30)} ${String(task.status).slice(0, 30)} ${String(task.subject ?? task.title ?? task.text ?? '').slice(0, 70)}`).join('; ')}`.slice(0, 450) });
    }
    try {
      const ledger = reducedChildren(2048);
      // Harness-owned automatic runs (councils, skill discovery, automatic
      // review) are not the agent's delegation and need no harvesting.
      const own = ledger.tasks.filter(task => !isHarnessOwnedChild(task)), harness = ledger.tasks.length - own.length;
      childSummary = { total: own.length, failed: own.filter(task => task.execution.status === 'failed' || task.acceptance.status === 'failed').length };
      if (harness) rows.push({ id: 'harness-runs', kind: 'current state', text: `${harness} harness-owned automatic run${harness === 1 ? '' : 's'} (scope council, skill discovery or automatic review) this session: launched by the harness, not the agent; results arrive in context on their own and need no harvesting.` });
      if (own.length) {
        const unresolved = own.filter(task => task.state !== 'completed' || task.acceptance.status === 'failed');
        const finished = own.filter(task => task.state === 'completed' && task.acceptance.status !== 'failed');
        const selected = [...unresolved.slice(-6), ...finished.slice(-2)].slice(0, 6);
        rows.push({ id: 'child-state', kind: 'current state', text: selected.map(task => `${task.label.slice(0, 55)}: ${task.state}; execution=${task.execution.status}${task.execution.cause ? ` (${task.execution.cause.category})` : ''}; acceptance=${task.acceptance.status}${task.acceptance.status === 'failed' && task.acceptance.reason ? ` (${boundedObserverText(task.acceptance.reason, 70)})` : ''}; attempts=${task.attempts.length}${task.todoId ? `; todo=${task.todoId.slice(0, 30)}` : ''}${task.unresolvedLinkage ? '; identity unresolved' : ''}`).join(' | ').slice(0, 450) });
      }
      if (ledger.unresolved.length) rows.push({ id: 'child-uncertainty', kind: 'current state', text: `${ledger.unresolved.length} child identity/accounting links are unresolved; task coverage and attribution may be incomplete.` });
    } catch { rows.push({ id: 'children-unavailable', kind: 'current state', text: 'Child-agent lifecycle evidence is unavailable; do not infer that there are no children.' }); }
    if (dropped) rows.push({ id: `overflow-${dropped}`, kind: 'current state', text: `${dropped} early events were folded into digest rows; their details are summarized, not shown. Full text is searchable with session_search. Do not infer omitted work was not done.` });
    try {
      for (const row of expertReviewerRows(ctx?.sessionManager?.getBranch?.() ?? [])) rows.push(row);
    } catch { /* Reviewer rows are advisory; never break state assembly. */ }
    return rows;
  };
  /** Unread events for one review. Within the window they are shown as they
   * are; a larger backlog shows the newest events and recent failures
   * verbatim and folds the rest into one digest, so every review keeps pace
   * with the session instead of trailing it by hundreds of events. */
  const QUEUE_WINDOW = 12;
  const queueRows = (): { rows: ObserverEvidence[]; folded: Set<string> } => {
    if (recent.length <= QUEUE_WINDOW) return { rows: recent.slice(), folded: new Set() };
    const newest = recent.slice(-8), older = recent.slice(0, -8);
    const errors = older.filter(row => row.kind === 'tool error').slice(-3);
    const rest = older.filter(row => !errors.includes(row));
    return { rows: [digestObserverEvents(rest, `digest-${rest[rest.length - 1]?.id ?? 'backlog'}`), ...errors, ...newest], folded: new Set(rest.map(row => row.id)) };
  };
  /** What the user wants, across the whole session: earlier prompts (the
   * current one is the "request" row), the harness interpretation and the
   * user's active reminders. Excerpts; full text via session_detail. */
  const intentRows = (): ObserverEvidence[] => {
    const rows: ObserverEvidence[] = [];
    const earlier = prompts.slice(0, -1).slice(-6);
    const each = earlier.length > 3 ? 200 : 300;
    for (const prompt of earlier) {
      const focused = prompt.focused ?? promptRequestFocus(prompt.text).replace(/\s+/g, ' ').trim();
      rows.push({ id: prompt.id, kind: 'earlier user prompt', text: focused.length <= each ? focused : `${focused.slice(0, Math.floor(each * .62))} … ${focused.slice(-Math.floor(each * .33))}` });
    }
    if (prompts.length > 7) rows.push({ id: 'prompt-count', kind: 'earlier user prompt', text: `${prompts.length - 1} earlier prompts this session; older ones are searchable with session_search.` });
    if (interpretation) rows.push({ id: 'interpretation', kind: 'harness interpretation', text: `Helper's reading of the latest prompt (advisory, not the user's words): ${interpretation}` });
    try {
      const sid = ctx?.sessionManager?.getSessionId?.();
      const active = sid ? readRemindersState(sid).manual.filter(reminder => reminder.active) : [];
      if (active.length) {
        const text = `User's standing reminders, re-sent to the agent about every 5 minutes; check the work honors them: ${active.map((reminder, index) => `${index + 1}) ${reminder.text.replace(/\s+/g, ' ')}`).join(' ')}`;
        rows.push({ id: 'user-reminders', kind: 'user reminders', text });
        journal.add({ id: 'user-reminders', kind: 'user reminder', at: now(), text });
      }
    } catch { /* Reminder state is optional evidence. */ }
    return rows;
  };
  const reset = (context: any) => { clearPending(); ctx = context; manager = context?.sessionManager; ownerIdentity = identity(context); owner = `${ownerIdentity}:${++epoch}`; request = ''; projectHistory = ''; userRequest = false; recent = []; streaming = []; journal.clear(); prompts = []; promptSequence = 0; interpretation = ''; skills = []; todos = []; adviceHistory = []; latestAdviceId = undefined; lastStartedDetail = undefined; preparedAdvice = undefined; pendingAdviceText = undefined; carriedAdvice = undefined; preparedCarried = undefined; notesThisTask = 0; parentEditsThisTask = 0; agentResponded = false; completed.clear(); failureKeys.clear(); sessionMargins.clear(); closeNoteEdits = -1; toolInputs.clear(); startedEvents.clear(); runningTools.clear(); revision++; dropped = 0; reportedDropped = 0; inputRestrictions = {}; inputBlocked = false; optOutMark = { length: -1, first: undefined, last: undefined, request: '', blocked: false }; childReduceMark = { window: 0, length: -1, first: undefined, last: undefined, value: undefined };
    profile.reset(''); bookState = createBookSelectionState(); childSummary = { total: 0, failed: 0 }; routingEpoch = -1; routingChildState = ''; lastFired = ''; runtime.begin(owner); };
  const peerRows = (): ObserverEvidence[] => peerReviewerNotes(reviewerSessionKey(ctx), 'observer', now()).slice(0, 2)
    .map(peer => ({ id: `peer-note-${peer.reviewer}`, kind: 'peer reviewer note', text: `${peer.reviewer === 'guardian' ? 'Guardian' : peer.reviewer === 'observer' ? 'Observer' : 'Watchmaker'} already told the agent ${Math.max(0, Math.round((now() - peer.at) / 1000))}s ago: ${peer.note}` }));
  const runtime = createSessionObserver({
    salience: () => salience,
    position: () => sequence,
    peerNotes: () => peerReviewerNotes(reviewerSessionKey(ctx), 'observer', now()),
    ...testing,
    snapshot() {
      // Cheap guards run before any evidence or packet work; the scheduler
      // never reads the packet of a routeless snapshot, so cold paths build a
      // minimal one and the dispatch path builds exactly once below.
      const idlePacket = () => buildObserverPacket(request, [], [], []);
      if (!owns(ctx) || !userRequest || ctx.isIdle?.() === true) return { packet: idlePacket(), reason: 'No active user work', silent: true };
      if (!agentResponded) return { packet: idlePacket(), reason: 'Waiting for the main agent\'s first response', silent: true };
      if (['1', 'true'].includes(process.env.PI_OFFLINE ?? '') || process.env.PI_SESSION_OBSERVER === 'off') return { packet: idlePacket(), reason: 'Observer disabled or offline', silent: true };
      if (pending.size) return { packet: idlePacket(), reason: 'User input is pending', silent: true };
      // Measured: eight "confirm once more before closing" notes after all
      // todos were done. After the wrap-up note only new edits reopen review.
      if (workFinished() && closeNoteEdits === parentEditsThisTask) return { packet: idlePacket(), reason: 'Work is finished and its wrap-up note was delivered; waiting for new edits', silent: true };
      let blocked: boolean;
      try {
        // Tool traffic must never age an explicit user opt-out out of authority.
        // Inspect retained user text in bounded chunks, including long sessions.
        // The branch is append-mostly: reuse the verdict while the branch
        // identity is unchanged; any rewrite rescans from scratch.
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
      const queue = queueRows();
      const state = currentState(), evidence = [...state, ...intentRows(), ...(projectHistory ? [{ id: 'project-history', kind: 'historical project evidence', text: projectHistory }] : []), ...peerRows(), ...adviceHistory.slice(-2).map((text, index) => ({ id: `prior-advice-${index}`, kind: 'previous advice already delivered', text })), ...streaming, ...queue.rows];
      const active = new Set<string>(pi.getActiveTools?.() ?? []);
      const tools = (pi.getAllTools?.() ?? []).map((tool: any) => ({ name: tool.name, description: tool.description ?? '', availability: active.has(tool.name) ? 'active' as const : 'discoverable' as const }));
      // Route-selection failures are cold paths: one minimal packet each. The
      // dispatch path below builds the full packet exactly once.
      const routePacket = () => buildObserverPacket(request, evidence, tools, skills);
      let available = ctx.modelRegistry.getAvailable();
      if (ctx.scopedModels?.length) { const scope = new Set(ctx.scopedModels.map((row: any) => `${row.model?.provider}/${row.model?.id}`)); available = available.filter((model: any) => scope.has(`${model.provider}/${model.id}`)); }
      const selection = resolveSessionObserverPreferenceChain(available.map(toModelInfo));
      // A configured route that failed twice in a row cools down for ten
      // minutes while the next configured route serves; with one route, or
      // all cooling, the first route is retried (failures stay visible).
      const entry = selection.routes.find(route => (routeHealth.get(route.route)?.coolUntil ?? 0) <= now()) ?? selection.routes[0];
      if (entry && selection.routes[0] && entry.route !== selection.routes[0].route && fallbackNotice !== entry.route) {
        fallbackNotice = entry.route;
        pi.sendMessage({ customType: OBSERVER_MESSAGE, content: `Observer route ${selection.routes[0].route} failed repeatedly; using configured fallback ${entry.route} for up to 10 minutes.`, display: true, excludeFromContext: true, details: { status: 'fallback', route: entry.route } }, { triggerTurn: false });
      } else if (entry?.route === selection.routes[0]?.route) fallbackNotice = '';
      if (!entry) return { packet: routePacket(), reason: selection.status === 'disabled' ? 'Observer disabled in model preferences' : 'Configured observer model unavailable' };
      const model = available.find((candidate: any) => `${candidate.provider}/${candidate.id}` === entry.route);
      if (!model || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 4096) return { packet: routePacket(), reason: 'Configured observer model lacks output capacity' };
      const constraints = explicitRecoveryConstraints(ctx, request, ctx.model);
      for (const key of ['fixedRoute', 'sameModel', 'freeOnly']) constraints[key] ||= inputRestrictions[key];
      if ((constraints.fixedRoute || constraints.sameModel) && `${ctx.model?.provider}/${ctx.model?.id}` !== entry.route) return { packet: routePacket(), reason: 'User model restriction prevents observer route' };
      if (constraints.freeOnly && !isProvenFreeRoute(model)) return { packet: routePacket(), reason: 'User free-only restriction prevents observer route' };
      if (dropped !== reportedDropped) {
        reportedDropped = dropped;
        pi.sendMessage({ customType: OBSERVER_MESSAGE, content: `Observer coverage: ${dropped} older events summarized into a digest; full text stays searchable.`, display: true, excludeFromContext: true, details: { status: 'coverage', dropped } }, { triggerTurn: false });
      }
      const capturedStates = new Map(currentState(false).map(row => [row.id, row.text]));
      // Deterministic working-pattern measurements for the observer and the book.
      profile.foreground(Math.max(0, ...[...runningTools.values()].filter(tool => tool.foreground).map(tool => now() - tool.startedAt)));
      profile.children(childSummary);
      const measured = profile.snapshot();
      const profileEvidence: ObserverEvidence = { id: 'session-profile', kind: 'session profile', text: `Harness measurement, not a verdict: ${profileRow(measured)}` };
      const focusText = `${request} ${[...recent.slice(0, 16), ...streaming].map(row => row.text).join(' ')} ${todos.map(task => task.title ?? '').join(' ')}`;
      // The book: static rules and contents, sticky passages, relevant margin
      // notes. Chapters name the tools and skills their doctrine relies on;
      // those lead the capability shortlist so advice can name them exactly.
      const book = loadBook();
      let section: BookSection | undefined, bookSelection: BookSelection | undefined;
      const preferTools: string[] = [], preferSkills: string[] = [];
      if (book) {
        try {
          const focus = { request, recent: focusText.slice(request.length) };
          bookSelection = selectBookPassages(book, focus, profile, bookState);
          const store = margins(ctx);
          // A margin note written or already raised this session is not shown
          // back: the observer re-read its own notes and restated them (13
          // notes in 45 minutes, one concern raised again after proof).
          const notes = store ? selectMargins(store.list().filter(note => !sessionMargins.has(note.id)), focus, now()) : [];
          section = renderBookSection(book, bookSelection, notes);
          lastBookView = (section?.passages ?? []).map(id => ({ id, title: section!.titles[id] ?? id, ...(bookSelection!.passages.find(row => row.passage.id === id)?.trigger ? { trigger: bookSelection!.passages.find(row => row.passage.id === id)!.trigger } : {}) }));
          for (const row of bookSelection.passages) { const chapter = book.chapterById.get(row.passage.chapter); if (chapter) { preferTools.push(...chapter.tools); preferSkills.push(...chapter.skills); } }
          const firedKey = bookSelection.fired.join(',');
          if (firedKey && firedKey !== lastFired && bookSelection.fired.some(name => !lastFired.split(',').includes(name))) salience++;
          lastFired = firedKey;
        } catch { section = undefined; bookSelection = undefined; }
      }
      // Routing evidence is the largest row and matters for delegation and
      // model advice. Send it on the first review of a task, when child state
      // changed, when the work is about models or delegation, or on request.
      const childState = capturedStates.get('child-state') ?? '';
      const routingAsked = bookState.bookmarkReview === bookState.review && bookState.bookmarks.includes('routing');
      const routingTopic = /\b(?:models?|rout(?:e|es|ing)|providers?|costs?|pric(?:e|es|ing)|budgets?|subagents?|councils?|swarms?|fusion|delegat\w*|parallel|cheap\w*|expensive)\b/i.test(focusText.slice(0, 6_000));
      const includeRouting = routingEpoch !== taskEpoch || childState !== routingChildState || routingTopic || routingAsked;
      let routing: string;
      if (includeRouting) try {
        const focus = `${request} ${recent.slice(0, 12).map(row => row.text).join(' ')}`;
        const preferredRoles = [/\b(?:swarm|parallel|fanout)\b/i.test(focus) ? 'swarm' : '', /\b(?:fusion|reconcile|conflicting)\b/i.test(focus) ? 'fusion' : ''].filter(Boolean);
        routing = observerModelEvidence({ models: available, entries: ctx.sessionManager.getBranch?.() ?? [], currentModel: ctx.model, restrictions: constraints, preferredRoles });
      }
      catch { routing = 'Current model preference, usage and performance evidence unavailable; do not infer route cost or quality.'; }
      else routing = 'Omitted this review to save tokens: model preferences, usage and child outcomes are unchanged since they were last shown for this task. Ask to read "routing" when model or delegation advice needs them.';
      const [stateRows, restRows] = [evidence.filter(row => row.kind === 'current state'), evidence.filter(row => row.kind !== 'current state')];
      const currentPacket = buildObserverPacket(request, [{ id: 'model-routing', kind: 'current model routing', text: routing }, ...stateRows, profileEvidence, ...taskStateObserverRows(), ...restRows], tools, skills, { book: section, preferTools, preferSkills });
      const capturedSequence = sequence, capturedRunning = new Set(runningTools.keys()), capturedModel = `${ctx.model?.provider}/${ctx.model?.id}`;
      const reviewedIds = new Set(currentPacket.evidence.map(row => row.id));
      const commonWords = new Set(['have', 'this', 'that', 'with', 'from', 'before', 'after', 'could', 'would', 'should', 'source', 'current', 'check', 'read', 'inspect', 'consider', 'required', 'field', 'completed', 'started', 'result', 'event', 'tool', 'file', 'path', 'limit', 'offset']);
      const relevantWords = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []).filter(word => !commonWords.has(word)));
      const resources = (text: string) => new Set(text.toLowerCase().match(/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.[a-z0-9]{1,8}\b/g) ?? []);
      const stillCurrent = (advice?: any) => {
        if (capturedModel !== `${ctx.model?.provider}/${ctx.model?.id}`) return false;
        const currentStates = new Map(currentState(false).map(row => [row.id, row.text]));
        const cited = currentPacket.evidence.filter(row => advice?.evidence?.includes(row.id));
        const changed = cited.filter(row => row.kind === 'current state' && capturedStates.get(row.id) !== currentStates.get(row.id)).map(row => row.id);
        // Discard only when the premise is gone: advice about running work
        // whose every cited command has finished, or routing advice after the
        // child state it weighed changed. Todo/child/completed-tool rows change
        // on almost every step of an active session (measured 18 of 20 paid
        // reviews discarded); such changes are named in the delivery caveat.
        // A finished command or changed child state no longer voids a paid
        // review that also rests on other evidence (it discarded 10k-token
        // notes); the agent gets it with a caveat naming what changed. A model
        // switch, or advice resting only on the finished command, still voids it.
        const runningDone = changed.includes('running-tools') && ![...capturedRunning].some(id => runningTools.has(id));
        // A cited failure that the same call has since passed is a superseded
        // premise (the observer cited a fixed failure thirty minutes later).
        const citedFailures = (advice?.evidence ?? []).map((id: string) => failureKeys.get(id)).filter(Boolean) as string[];
        if (citedFailures.length && citedFailures.every(key => completed.get(key)?.endsWith(': completed'))) return false;
        // Advice resting only on work that was running is moot once it ends.
        if (runningDone && (advice?.evidence ?? []).every((id: string) => ['running-tools', 'request'].includes(id))) return false;
        const premise = [
          runningDone ? 'the running command it cited has since finished' : '',
          advice?.evidence?.includes('model-routing') && capturedStates.get('child-state') !== currentStates.get('child-state') ? 'the child state its routing advice weighed has since changed' : '',
        ].filter(Boolean).join('; ');
        const citedText = cited.filter(row => row.kind !== 'user request').map(row => row.text).join(' ');
        const targets = resources(`${citedText} ${advice?.note ?? ''}`), focus = relevantWords(advice?.note ?? '');
        const suggestedTools = new Set<string>(advice?.tools ?? []);
        // Overlapping later work does not falsify a review either: the note is
        // delivered, labelled so the agent checks whether it was already addressed.
        let overlap = '';
        for (const row of recent) {
          const index = Number(row.id.replace('event-', ''));
          if (index <= capturedSequence || !['tool started', 'tool result', 'tool error', 'assistant text'].includes(row.kind)) continue;
          const changedTargets = resources(row.text), changedFocus = relevantWords(row.text);
          const target = [...targets].find(item => changedTargets.has(item));
          const word = target ? undefined : [...focus].find(item => changedFocus.has(item));
          // A suggested tool without a named resource may already be doing the
          // requested work. Distinct named resources permit unrelated progress.
          overlap = target ? `later work touched ${target}` : word ? `later work continued on "${word}"`
            : row.tool && suggestedTools.has(row.tool) && (!targets.size || !changedTargets.size) ? `a later ${row.tool} call may have covered this` : '';
          if (overlap) break;
        }
        // Evidence fetched from the journal can be far older than the packet;
        // name its age so the agent re-validates instead of acting on it.
        const oldest = (advice?.evidence ?? []).map((id: string) => journal.list().find(entry => entry.id === id)?.at).filter((at: unknown): at is number => typeof at === 'number').reduce((min: number, at: number) => Math.min(min, at), Infinity);
        const aged = Number.isFinite(oldest) && now() - oldest > 600_000 ? `it cites evidence from ${Math.round((now() - oldest) / 60_000)} min ago that may be superseded` : '';
        return [premise, changed.length && !premise ? `cited ${changed.join(', ')} changed` : '', aged, overlap].filter(Boolean).join('; ') || true;
      };
      // Reviewer billing and its own prior note must not create new work for
      // itself. Task activity, queue progress and available capabilities do.
      // The key excludes everything the observer's own reviews change (billing,
      // advice history, book rotation, margin notes); newly fired book triggers
      // are session facts and may start a review.
      const reviewKey = JSON.stringify({ taskEpoch, revision, sequence, unread: recent[0]?.id ?? null, state: [...capturedStates], streaming, model: capturedModel, route: entry.route, tools: tools.map(tool => [tool.name, tool.availability]), skills: skills.map(skill => skill.name), fired: bookSelection?.fired ?? [], book: Boolean(section) });
      const routeName = entry.route;
      const bookReader = book ? { read(id: string) {
        const passage = book.passages.get(id), chapter = book.chapterById.get(id);
        if (passage) return `${book.chapterById.get(passage.chapter)?.title ?? passage.chapter} › ${passage.title} [${passage.id}]\n${passage.body}`;
        if (chapter) return `${chapter.title} [${chapter.id}] — ${chapter.summary}\n${chapter.passages.map((row: any) => `${row.id}: ${row.title}`).join('\n')}`;
        return undefined;
      } } : undefined;
      const toolHost = toolsEnabled() && typeof ctx.cwd === 'string' ? { journal, cwd: ctx.cwd, book: bookReader } : undefined;
      return { packet: currentPacket, registry: ctx.modelRegistry, reviewKey, current: stillCurrent, toolHost, knownIds: () => journal.list().map(entry => entry.id), position: capturedSequence,
        reviewed: () => { recent = recent.filter(row => !reviewedIds.has(row.id) && !queue.folded.has(row.id)); }, route: { ...entry, model, officialDefault: selection.source === 'default', requireFree: constraints.freeOnly },
        backlog: recent.filter(row => !reviewedIds.has(row.id) && !queue.folded.has(row.id)).length,
        bookPassages: section?.passages ?? [],
        dispatched: () => {
          noteBookReview(bookState, section?.passages ?? []);
          if (includeRouting) { routingEpoch = taskEpoch; routingChildState = childState; }
          if (bookSelection) void refineWithNeedle(bookSelection, `${promptRequestFocus(request).slice(0, 100)} ${focusText.slice(-120)}`);
        },
        applied: (advice: any) => {
          if (!owns(ctx)) return undefined;
          const parts: string[] = [];
          const store = advice.book?.length || advice.margin || advice.strike?.length ? margins(ctx) : undefined;
          if (advice.book?.length) { noteBookCitations(bookState, advice.book); store?.cite(advice.book); parts.push(`book: ${advice.book.join(', ')}`); }
          if (advice.read?.length) { noteBookmarks(bookState, advice.read); parts.push(`reading ${advice.read.join(', ')}`); }
          if (advice.strike?.length && store) { try { if (store.strike(advice.strike)) parts.push(`struck margin ${advice.strike.join(', ')}`); } catch { /* A read-only store keeps its notes. */ } }
          if (advice.margin && store) {
            try {
              const kept = store.add(advice.margin, { passage: advice.book?.[0], model: routeName });
              sessionMargins.add(kept.id);
              parts.push(`${kept.status === 'added' ? 'kept' : 're-confirmed'} margin note ${kept.id}`);
              // Paraphrase duplicates slip past the store's deterministic
              // match. A Needle-only semantic pass folds the new note into
              // the existing one (strike + confirm); failure keeps both.
              if (kept.status === 'added' && (process.env.PI_OBSERVER_SEMANTIC_MARGINS ?? 'on').toLowerCase() !== 'off' && needleUsable()) {
                const noteId = kept.id, noteText = advice.margin, passage = advice.book?.[0];
                const rank = (query: string, candidates: Array<{ id: string; text: string }>, topK: number) =>
                  (testing.needleRank ?? needleRank)({ query, candidates, topK });
                void (async () => {
                  try {
                    const notes = store.list().filter((note: any) => note.id !== noteId);
                    const dup = await findSemanticMarginDuplicate(noteText, notes, rank);
                    if (!dup || !owns(ctx)) return;
                    const existing = notes.find((note: any) => note.id === dup);
                    if (!existing) return;
                    try { store.strike([noteId]); } catch { return; }
                    try { store.add(existing.text, { passage, model: routeName }); } catch { /* the strike already removed the duplicate */ }
                    sessionMargins.delete(noteId);
                    sessionMargins.add(dup);
                  } catch { /* both notes survive */ }
                })();
              }
            }
            catch { parts.push('margin note not saved'); }
          } else if (advice.marginRejected) parts.push(`margin note dropped (${advice.marginRejected})`);
          return parts.join(' · ') || undefined;
        } };
    },
    notice(status: string, detail: string, advice: any) {
      if (!owns(ctx)) return;
      // A review starts every interval with the same route and settings. Keep
      // the in-flight state in the footer and persist a start line only when
      // its route/settings change; the completion line still records each run.
      if (status === 'started') { try { ctx?.ui?.setStatus?.(OBSERVER_MESSAGE, `Observer reviewing · ${displayText(detail, 80)}`); } catch { /* Footer status is optional. */ } }
      else if (status !== 'checked') { try { ctx?.ui?.setStatus?.(OBSERVER_MESSAGE, undefined); } catch { /* Footer status is optional. */ } }
      if (status === 'started') { if (detail === lastStartedDetail) return; lastStartedDetail = detail; }
      if (advice) {
        publishReviewerNote(reviewerSessionKey(ctx), 'observer', advice.note, [...(advice.tools ?? []), ...(advice.skills ?? [])], now());
        for (const id of String(advice.note).match(/\bm\d+\b/g) ?? []) sessionMargins.add(id);
        closeNoteEdits = workFinished() ? parentEditsThisTask : -1;
        // A previous note that never reached a context build is superseded but
        // not dropped: its text is carried into the next delivery. Only a note
        // with nothing to carry is ledgered as dropped (defensive; ids always
        // ship with text). Prepared-but-unconfirmed notes keep their
        // prepared-context receipt as the existing honest signal.
        if (latestAdviceId && preparedAdvice?.id !== latestAdviceId && !stashCarried('supersede')) {
          try { pi.appendEntry('session-observer-delivery-v1', { adviceId: latestAdviceId, status: 'dropped:superseded', at: now() }); } catch { /* Accounting cannot suppress otherwise valid advice. */ }
        }
        latestAdviceId = `observer-advice-${randomUUID()}`; preparedAdvice = undefined; pendingAdviceText = observerAdviceText(advice); notesThisTask++;
      }
      const content = advice ? `Observer returned a note · snapshot ${advice.evidence.join(', ')} · ${detail}\n${observerAdviceText(advice)}` : `Observer ${status}: ${detail}`;
      const delivery = pi.sendMessage({ customType: OBSERVER_MESSAGE, content, display: true, excludeFromContext: true, details: { status, detail: displayText(detail, 240),
        ...(advice ? { adviceId: latestAdviceId, note: advice.note, evidence: advice.evidence, tools: advice.tools, skills: advice.skills, ...(advice.discoverableTools?.length ? { discoverableTools: advice.discoverableTools } : {}) } : {}) } }, { triggerTurn: false });
      void Promise.resolve(delivery).catch(() => { /* Native delivery reports display failures independently. */ });
    },
    receipt(data: any, origin: string) {
      // Route health is a property of the provider, not of the session that
      // happened to own the request, so it is tracked for late replies too.
      const route = typeof data?.provider === 'string' && typeof data?.model === 'string' ? `${data.provider}/${data.model}` : '';
      const dispatch = typeof data?.id === 'string' ? data.id : '';
      if (route && ['failed', 'timeout', 'completed'].includes(data.status) && !countedDispatches.has(dispatch)) {
        if (dispatch) { countedDispatches.add(dispatch); if (countedDispatches.size > 64) countedDispatches.delete(countedDispatches.values().next().value!); }
        const health = routeHealth.get(route) ?? { failures: 0, coolUntil: 0 };
        if (data.status === 'completed') { health.failures = 0; health.coolUntil = 0; }
        // One timeout already cost a full deadline; a configured fallback serves
        // next instead of the same route timing out a second time.
        else if (++health.failures >= 2 || data.status === 'timeout') health.coolUntil = now() + 600_000;
        routeHealth.set(route, health); if (routeHealth.size > 32) routeHealth.delete(routeHealth.keys().next().value!);
      }
      // The exposed append owner is the current session only. Retain an honest
      // pending/unknown receipt in the old session if a provider ignores abort;
      // never reopen its file or charge the replacement session for a late reply.
      if (owns(ctx) && origin === owner) pi.appendEntry('auxiliary-model-usage-v1', data);
    },
  });
  pi.registerMessageRenderer(OBSERVER_MESSAGE, (message: any, options: any, theme: any) => {
    const details = message.details ?? {}, text = messageText(message);
    if (details.status === 'completed') {
      const [first, ...advice] = text.split('\n');
      const summary = typeof details.detail === 'string' ? details.detail : first.replace(/^Observer returned a note(?: · )?/, '');
      return renderHarnessNotice({ icon: '◉', tone: 'accent', title: 'Observer note', summary: displayText(summary, 240), body: advice.join('\n') }, options, theme);
    }
    const tone = details.status === 'unavailable' ? 'warning' : details.status === 'fallback' ? 'warning' : 'muted';
    const title = { started: 'Observer reviewing', checked: 'Observer', reviewed: 'Observer reviewed', skipped: 'Observer skipped', stopped: 'Observer stopped', unavailable: 'Observer unavailable', coverage: 'Observer coverage', fallback: 'Observer route', book: 'Observer Book' }[details.status as string] ?? 'Observer';
    return renderHarnessNotice({ icon: '◉', tone, title, summary: text.replace(/^Observer [a-z]+: /, '').replace(/\s+/g, ' ').slice(0, 400) }, options, theme);
  });
  // The user can read the observer's book and manage its margin notes. The
  // command changes no model context and never wakes the agent.
  pi.registerCommand?.('observer-book', {
    description: 'Observer Book: status, contents and margin notes — usage: /observer-book [toc | read <id> | margins [clear] | on | off]',
    argumentHint: '[toc|read <id>|margins [clear]|on|off]',
    handler: async (args: string, context: any) => {
      const say = (text: string, level: 'info' | 'warning' = 'info') => {
        if (context?.hasUI && typeof context.ui?.notify === 'function') context.ui.notify(text, level);
        else pi.sendMessage({ customType: OBSERVER_MESSAGE, content: text, display: true, excludeFromContext: true, details: { status: 'book' } }, { triggerTurn: false });
      };
      const [verb = '', ...rest] = String(args ?? '').trim().split(/\s+/).filter(Boolean);
      const target = rest.join(' ');
      if (verb === 'off' || verb === 'on') { bookOff = verb === 'off'; say(`Observer Book ${bookOff ? 'disabled' : 'enabled'} for this session; the observer ${bookOff ? 'reviews without doctrine or margin notes' : 'reads its book again from the next review'}.`); return; }
      const wasOff = bookOff; bookOff = false;
      const book = loadBook(); bookOff = wasOff;
      if (!book) { say('Observer Book unavailable: disabled by PI_OBSERVER_BOOK=off or no readable chapters.', 'warning'); return; }
      const store = margins(context ?? ctx);
      if (verb === 'toc') {
        const parts = [...new Set(book.chapters.map(chapter => chapter.part))];
        say(parts.map(part => `${part}: ${book.chapters.filter(chapter => chapter.part === part).map(chapter => `${chapter.id} (${chapter.title}, ${chapter.passages.length})`).join('; ')}`).join('\n'));
        return;
      }
      if (verb === 'read') {
        const chapter = book.chapterById.get(target), passage = book.passages.get(target);
        if (passage) { const owner = book.chapterById.get(passage.chapter); say(`${owner?.title ?? passage.chapter} › ${passage.title} [${passage.id}]\n${passage.body}`); return; }
        if (chapter) { say(`${chapter.title} [${chapter.id}] — ${chapter.summary}\n${chapter.passages.map(row => `${row.id}: ${row.title}`).join('\n')}`); return; }
        say(`Unknown chapter or passage "${target.slice(0, 80)}". Use /observer-book toc for chapter ids.`, 'warning');
        return;
      }
      if (verb === 'margins') {
        if (!store) { say('Margin notes are disabled (PI_OBSERVER_MARGINS=off) or this project has no readable identity.', 'warning'); return; }
        if (rest[0] === 'clear') { const count = store.clear(); say(`Struck ${count} margin note${count === 1 ? '' : 's'} for this project; they will not be shown to the observer again.`); return; }
        const notes = store.list();
        const age = (at: number) => { const hours = Math.max(0, (now() - at) / 3_600_000); return hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`; };
        say(notes.length ? notes.map(note => `${note.id}${note.confirmations > 1 ? ` ×${note.confirmations}` : ''} (${age(note.updatedAt)}): ${note.text}`).join('\n') : 'No margin notes for this project yet.');
        return;
      }
      const userChapters = book.chapters.filter(chapter => chapter.source === 'user').length;
      const reading = lastBookView.length ? lastBookView.map(row => `${row.title}${row.trigger ? ` (⚑ ${row.trigger})` : ''}`).join('; ') : 'nothing selected yet';
      say([`Observer Book ${book.hash.slice(0, 8)}: ${book.chapters.length} chapters, ${book.passages.size} passages${userChapters ? ` (${userChapters} user chapters)` : ''}${bookOff ? ' · disabled for this session' : ''}.`,
        `Last review read: ${reading}.`, `Margin notes for this project: ${store ? store.list().length : 'disabled'}.`,
        ...book.diagnostics.slice(0, 3)].join('\n'));
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
    // New input stops the scheduler and clears its undelivered note; carry the
    // text into the next task instead of losing advice the agent never saw.
    stashCarried('input');
    runtime.stop('New user input');
    latestAdviceId = undefined; preparedAdvice = undefined; pendingAdviceText = undefined;
    const id = event.requestId;
    const abort = () => { pending.get(id)?.cleanup(); pending.delete(id); if (owns(context) && userRequest && !pending.size && context.isIdle?.() === false) runtime.start(); };
    const cleanup = () => event.signal?.removeEventListener('abort', abort);
    pending.get(id)?.cleanup();
    const focused = promptRequestFocus(raw);
    const boundedRequest = focused.length <= 4000 ? focused : `${focused.slice(0, 2000)}\n[Middle omitted from observer packet]\n${focused.slice(-1900)}`;
    pending.set(id, { request: boundedObserverText(boundedRequest, 4000), raw, restrictions, blocked, signal: event.signal, cleanup });
    event.signal?.addEventListener('abort', abort, { once: true });
    if (event.signal?.aborted) abort();
    while (pending.size > 8) { const oldest = pending.keys().next().value!; pending.get(oldest)?.cleanup(); pending.delete(oldest); }
  });
  pi.on('message_start', (event: any, context: any) => {
    if (owns(context) && event.message?.role === 'assistant' && userRequest && !agentResponded) { agentResponded = true; revision++; return; }
    if (!owns(context) || event.message?.role !== 'user') return;
    const id = event.message[Symbol.for('yunuspi.guardian.request-meta.v1')]?.requestId;
    const accepted = pending.get(id);
    if (!accepted || accepted.signal?.aborted) return;
    accepted.cleanup(); pending.delete(id); ctx = context;
    request = accepted.request; userRequest = Boolean(request.trim()); inputRestrictions = accepted.restrictions; inputBlocked = accepted.blocked;
    if (userRequest) {
      const promptId = `prompt-${++promptSequence}`;
      // Prompt text is immutable: focus once at push instead of every tick.
      prompts.push({ id: promptId, text: accepted.raw, focused: promptRequestFocus(accepted.raw).replace(/\s+/g, ' ').trim() }); if (prompts.length > 64) prompts.shift();
      journal.add({ id: promptId, kind: 'user prompt', at: now(), text: accepted.raw });
      journal.add({ id: 'request', kind: 'user prompt', at: now(), text: accepted.raw });
      interpretation = '';
    }
    recent = []; streaming = []; revision++; dropped = 0; reportedDropped = 0; taskEpoch++; notesThisTask = 0; parentEditsThisTask = 0; closeNoteEdits = -1; agentResponded = false;
    profile.reset(request); if (todos.length) profile.todos(todos); bookState = createBookSelectionState(); lastFired = '';
    runtime.begin(owner); if (userRequest) runtime.start();
    projectHistory = '';
    const memoryOwner = owner, memoryTask = taskEpoch;
    if (userRequest && !inputBlocked && process.env.PI_SESSION_OBSERVER !== 'off' && !['1', 'true', 'yes'].includes(process.env.PI_OFFLINE ?? '') && !wantsNoObserver(accepted.raw)) void recallProjectContext(context.cwd, accepted.raw, 'observer', accepted.signal).then(text => {
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
  pi.on('message_update', (event: any, context: any) => {
    if (!owns(context) || event.message?.role !== 'assistant') return;
    if (userRequest && event.message?.role === 'assistant') agentResponded = true;
    const text = textParts(event.message), thinking = textParts(event.message, 'thinking', 450);
    streaming = [text ? { id: 'current-assistant', kind: 'assistant text', text } : null,
      thinking ? { id: 'current-thinking', kind: 'provider-returned thinking', text: thinking } : null].filter(Boolean) as ObserverEvidence[];
  });
  pi.on('message_end', (event: any, context: any) => {
    if (!owns(context)) return;
    if (event.message?.role === 'custom') { observeHarnessMessage(event.message); return; }
    if (event.message?.role !== 'assistant') return;
    if (userRequest) agentResponded = true;
    const said = textParts(event.message);
    add('assistant text', said, undefined, textParts(event.message, 'text', 64_000));
    add('provider-returned thinking', textParts(event.message, 'thinking', 450), undefined, textParts(event.message, 'thinking', 64_000)); streaming = []; revision++;
    if (said && profile.assistant(said)) salience++;
  });
  // Harness messages the agent receives (reminders, interpretation, Guardian,
  // guidance) are part of what the observer must see, labelled by source.
  const observeHarnessMessage = (message: any) => {
    if ([OBSERVER_MESSAGE, OBSERVER_CONTEXT].includes(message.customType)) return;
    const text = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') : '';
    if (!text.trim()) return;
    if (message.customType === 'prompt-analysis') {
      interpretation = boundedObserverText(text.replace(/\n?Original user prompt preserved\.[^\n]*/, '').replace(/\s*\n\s*/g, ' · '), 600);
      journal.add({ id: 'interpretation', kind: 'harness interpretation', at: now(), text: `${text}${typeof message.details?.advisory === 'string' ? `\n\nExact text given to the main agent:\n${message.details.advisory}` : ''}` });
      revision++; return;
    }
    if (message.customType === 'reminders') {
      const own = text.split('\n').filter(line => line.startsWith('[custom-reminder] ')).map(line => line.slice(18));
      if (own.length) { add('user reminder delivered', `Delivered to the agent: ${own.join(' | ')}`, undefined, text); salience++; }
      const guidance = text.split('\n').filter(line => /^\[(?:capability hint|signal|workspace warning)\]/.test(line));
      if (guidance.length) add('harness guidance to agent', guidance.join(' | '), undefined, text);
      revision++; return;
    }
    if (message.customType === 'guardian_intervention' && !message.excludeFromContext) { publishReviewerNote(reviewerSessionKey(ctx), 'guardian', text, [], now()); add('guardian intervention', text, undefined, text); salience++; revision++; return; }
    if (['memory-prime', 'todo-plan', 'relevant-guidance'].includes(message.customType)) { add('harness guidance to agent', text, undefined, text); revision++; }
  };
  pi.on('tool_execution_start', (event: any, context: any) => {
    if (!owns(context)) return;
    if (userRequest && true) agentResponded = true;
    const input = compactInput(event.args);
    if (event.toolCallId) { runningTools.set(event.toolCallId, { name: event.toolName, input, startedAt: now(), foreground: ['bash', 'powershell'].includes(event.toolName) && event.args?.background !== true && event.args?.async !== true });
      if (runningTools.size > 128) runningTools.delete(runningTools.keys().next().value!);
      toolInputs.set(event.toolCallId, input); if (toolInputs.size > 128) toolInputs.delete(toolInputs.keys().next().value!); }
    const started = add('tool started', `${event.toolName} started. ${input}`, event.toolName); revision++;
    if (event.toolCallId && started) { startedEvents.set(event.toolCallId, started); if (startedEvents.size > 128) startedEvents.delete(startedEvents.keys().next().value!); }
  });
  pi.on('tool_result', (event: any, context: any) => {
    if (!owns(context)) return;
    if (userRequest && true) agentResponded = true;
    if (!event.isError && ['edit', 'write', 'bulk_edit'].includes(event.toolName)) parentEditsThisTask++;
    const input = compactInput(event.input) || toolInputs.get(event.toolCallId) || '';
    toolInputs.delete(event.toolCallId); runningTools.delete(event.toolCallId);
    // The result row repeats the input, so an unread start row only doubles
    // queue pressure (and the overflow that loses coverage).
    const started = startedEvents.get(event.toolCallId);
    if (started) { startedEvents.delete(event.toolCallId); recent = recent.filter(row => row.id !== started); }
    const outputChars = Array.isArray(event.content) ? event.content.reduce((sum: number, part: any) => sum + (typeof part?.text === 'string' ? part.text.length : 0), 0) : 0;
    if (profile.tool(event.toolName, event.input ?? {}, { error: Boolean(event.isError), outputChars })) salience++;
    const summary = `${event.toolName} ${input}: ${event.isError ? 'failed' : 'completed'}`;
    completed.set(`${event.toolName}:${input}`, summary);
    if (completed.size > 16) completed.delete(completed.keys().next().value!);
    const fullOutput = Array.isArray(event.content) ? event.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') : '';
    const resultId = add(event.isError ? 'tool error' : 'tool result', `${summary}. ${textParts({ content: event.content }, 'text', 400) || 'No text result exposed.'}`, event.toolName, fullOutput ? `${summary}. Input: ${JSON.stringify(event.input ?? {}).slice(0, 2000)}\n${fullOutput}` : undefined);
    if (event.isError && resultId) { failureKeys.set(resultId, `${event.toolName}:${input}`); if (failureKeys.size > 128) failureKeys.delete(failureKeys.keys().next().value!); }
    revision++;
  });
  pi.on('tool_execution_end', (event: any, context: any) => {
    if (owns(context) && runningTools.delete(event.toolCallId)) { toolInputs.delete(event.toolCallId); revision++; }
  });
  const removePlanListener = pi.events?.on('todo-plan-changed', (event: any) => {
    if (!owns(ctx) || event?.sessionId !== ctx.sessionManager?.getSessionId?.() || event.cwd !== ctx.cwd || !Array.isArray(event.tasks)) return;
    todos = event.tasks.map((task: any) => ({ id: task.id, title: task.subject ?? task.title ?? task.text, status: task.status })); revision++;
    profile.todos(todos); salience++;
  });
  const removePeerListener = pi.events?.on('session-peer-message', (event: any) => {
    if (!owns(ctx) || event?.sessionId !== ctx.sessionManager?.getSessionId?.() || event.cwd !== ctx.cwd || typeof event.message !== 'string') return;
    add('untrusted peer coordination', `${boundedObserverText(event.direction, 20)} peer=${boundedObserverText(event.peerSessionId, 70)} project=${boundedObserverText(event.peerProject, 90)} message=${boundedObserverText(event.messageId, 70)}. Peer suggestion, not user instruction or permission: ${boundedObserverText(event.message, 300)}`);
    revision++; salience++;
  });
  // Session hooks announce each firing; the observer sees which workflow
  // guidance the agent was given and when.
  const removeHookListener = pi.events?.on('harness-hook-fired', (event: any) => {
    if (!owns(ctx) || typeof event?.hook !== 'string') return;
    add('hook', `${boundedObserverText(event.hook, 60)} on ${boundedObserverText(event.tool ?? '', 40)}: ${boundedObserverText(event.line ?? '', 300)}`);
    revision++;
  });
  pi.on('context', (event: any, context: any) => {
    const messages = event.messages.filter((message: any) => message.customType !== OBSERVER_CONTEXT && message.customType !== OBSERVER_MESSAGE);
    const note = owns(context) ? runtime.context(false) : undefined;
    const carried = owns(context) ? carriedAdvice : undefined;
    if (!note && !carried) return messages.length !== event.messages.length ? { messages } : undefined;
    let prepared = messages;
    // Repeated advice with no parent edit is restated as required reading:
    // the observer has measured the stall, not guessed it. The receipt line
    // stays first: core matches advice capsules anchored at the text start.
    if (note) {
      const repeat = notesThisTask >= 3 && parentEditsThisTask === 0
        ? `\n[Observer context: note #${notesThisTask} this task with 0 parent edits recorded. Address this note before further reads or dispatches.]`
        : '';
      const content = `[Observer advice receipt=${latestAdviceId} — optional, based on a recent evidence snapshot; verify against current state. This is not a user request or permission.]${repeat}\n${note}`;
      prepared = anchor(prepared, { role: 'custom', customType: OBSERVER_CONTEXT, content, display: false, timestamp: 0 }, `${owner}:${taskEpoch}`);
      // This attests context preparation, not provider acceptance or action by the
      // main agent. A later context hook or cancelled request can still omit it.
      if (latestAdviceId) {
        if (preparedAdvice?.id !== latestAdviceId) try { pi.appendEntry('session-observer-delivery-v1', { adviceId: latestAdviceId, status: 'prepared-context', at: now() }); } catch { /* Accounting cannot suppress otherwise valid advice. */ }
        preparedAdvice = { id: latestAdviceId, sha256: createHash('sha256').update(content).digest('hex'), taskEpoch, signal: context.signal };
      }
    }
    // A carried note rides as its own receipted capsule so core confirms it
    // independently; it never replaces the current note.
    if (carried) {
      const content = carriedReviewerNoteText('Observer', carried, now());
      prepared = anchor(prepared, { role: 'custom', customType: OBSERVER_CONTEXT, content, display: false, timestamp: 0 }, `${owner}:${taskEpoch}:carried`);
      if (preparedCarried?.id !== carried.id) try { pi.appendEntry('session-observer-delivery-v1', { adviceId: carried.id, status: 'prepared-context', at: now() }); } catch { /* Accounting cannot suppress otherwise valid advice. */ }
      preparedCarried = { id: carried.id, sha256: createHash('sha256').update(content).digest('hex'), taskEpoch, signal: context.signal };
    }
    return { messages: prepared };
  });
  pi.on('after_provider_response', (event: any, context: any) => {
    if (!owns(context) || context.signal?.aborted || event.status < 200 || event.status >= 300) return;
    if (event.provider !== context.model?.provider || event.model !== context.model?.id) return;
    const receipts: any[] = Array.isArray(event.observerAdviceReceipts) ? event.observerAdviceReceipts : [];
    // The current note and the carried note confirm independently: each joins
    // advice history only on its own provider receipt.
    if (preparedAdvice && preparedAdvice.id === latestAdviceId && preparedAdvice.taskEpoch === taskEpoch && preparedAdvice.signal === context.signal && runtime.context(false)
      && receipts.some((receipt: any) => receipt.id === preparedAdvice!.id && receipt.sha256 === preparedAdvice!.sha256)) {
      try { pi.appendEntry('session-observer-delivery-v1', { adviceId: preparedAdvice.id, status: 'provider-received', at: now(), provider: event.provider, model: event.model }); } catch { /* No duplicate delivery solely to repair accounting. */ }
      // Only confirmed-delivered notes join the history the next packet calls
      // "previous advice already delivered".
      if (pendingAdviceText) { adviceHistory.push(pendingAdviceText); if (adviceHistory.length > 8) adviceHistory.shift(); }
      runtime.context(); latestAdviceId = undefined; preparedAdvice = undefined; pendingAdviceText = undefined;
    }
    if (preparedCarried && preparedCarried.id === carriedAdvice?.id && preparedCarried.taskEpoch === taskEpoch && preparedCarried.signal === context.signal
      && receipts.some((receipt: any) => receipt.id === preparedCarried!.id && receipt.sha256 === preparedCarried!.sha256)) {
      try { pi.appendEntry('session-observer-delivery-v1', { adviceId: preparedCarried.id, status: 'provider-received', at: now(), provider: event.provider, model: event.model }); } catch { /* No duplicate delivery solely to repair accounting. */ }
      if (carriedAdvice) { adviceHistory.push(carriedAdvice.text); if (adviceHistory.length > 8) adviceHistory.shift(); }
      carriedAdvice = undefined; preparedCarried = undefined;
    }
  });
  // Native agent_end may be followed by retry/compaction/queued continuation.
  // Only agent_settled closes the current active run and its observer cadence.
  pi.on('agent_settled', (_: any, context: any) => {
    if (!owns(context)) return;
    runtime.stop('Active work settled'); streaming = [];
    // A note the settling turn never delivered is carried into the next task
    // (e.g. an objection to premature completion) rather than dropped.
    if (latestAdviceId && preparedAdvice?.id !== latestAdviceId && !stashCarried('settle')) {
      try { pi.appendEntry('session-observer-delivery-v1', { adviceId: latestAdviceId, status: 'dropped:settled', at: now() }); } catch { /* Accounting only. */ }
    }
    latestAdviceId = undefined; preparedAdvice = undefined; pendingAdviceText = undefined;
  });
  pi.on('session_shutdown', () => { runtime.close(); clearPending(); removePlanListener?.(); removePeerListener?.(); removeHookListener?.(); closed = true; recent = []; streaming = []; request = ''; try { marginStore?.flush(); } catch { /* Statistics are advisory. */ } });
}

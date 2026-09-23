import { Text } from '@yunuspi/tui';
import { projectTranscriptChildren, reduceChildEvents } from './pi-subagents/src/runs/shared/child-ledger.ts';
import { observerModelEvidence } from './lib/observer-model-evidence.ts';
import { promptRequestFocus } from './lib/prompt-interpretation.ts';
import { createContextAnchor } from './lib/context-anchor.ts';
import { buildObserverPacket, boundedObserverText, createSessionObserver, observerAdviceText, OBSERVER_CONTEXT, OBSERVER_MESSAGE, type ObserverEvidence, type ObserverCapability } from './lib/session-observer.ts';
import { resolveSessionObserverPreferenceChain } from './pi-subagents/src/runs/shared/model-fallback.ts';
import { toModelInfo } from './pi-subagents/src/shared/model-info.ts';
import { explicitRecoveryConstraints } from './pi-subagents/src/extension/autonomous-recovery.ts';
import { isProvenFreeRoute } from './pi-subagents/src/runs/shared/free-route-evidence.ts';

/** Opt-in/default-configured direct observer; it owns no tools or child agents. */
export default function sessionObserver(pi: any, testing: any = {}) {
  if (process.env.PI_SUBAGENT_CHILD === '1') return;
  let ctx: any, manager: any, owner = '', ownerIdentity = '', epoch = 0, taskEpoch = 0, request = '', userRequest = false, recent: ObserverEvidence[] = [], sequence = 0;
  let skills: ObserverCapability[] = [], streaming: ObserverEvidence[] = [], closed = false, revision = 0, dropped = 0, reportedDropped = 0;
  let todos: any[] = [], adviceHistory: string[] = [];
  const completed = new Map<string, string>(), toolInputs = new Map<string, string>();
  const runningTools = new Map<string, { name: string; input: string; startedAt: number; foreground: boolean }>();
  const now = testing.now ?? Date.now;
  let inputRestrictions: any = {}, inputBlocked = false;
  const observerOptOutChunk = (text: string) => /\b(?:work|stay|remain|operate)\s+offline\b|\boffline[- ]only\b|\b(?:no|without)\s+(?:network|internet)\b|\b(?:do not|don't|never)\s+(?:use|access)\s+(?:the\s+)?(?:network|internet)\b|\b(?:no|disable|stop|do not use|don't use)\s+(?:(?:background|automatic|periodic)\s+)*(?:observers?|advis[oe]rs?)\b/i.test(text);
  const noObserver = (text: string) => {
    // Constraint scanning is incremental, not a reason to disable long tasks.
    // Overlap covers opt-out phrases crossing the inspection boundary.
    for (let offset = 0; offset < text.length; offset += 65_536) if (observerOptOutChunk(text.slice(Math.max(0, offset - 256), offset + 65_536))) return true;
    return false;
  };
  const anchor = createContextAnchor();
  const identity = (context: any) => JSON.stringify([context?.cwd ?? '', context?.sessionManager?.getSessionId?.() ?? '', context?.sessionManager?.getSessionFile?.() ?? '']);
  const owns = (context: any) => { try { return !closed && context && context.sessionManager === manager && identity(context) === ownerIdentity; } catch { return false; } };
  const pending = new Map<string, { request: string; restrictions: any; blocked: boolean; signal?: AbortSignal; cleanup: () => void }>();
  const clearPending = () => { for (const item of pending.values()) item.cleanup(); pending.clear(); };
  const textParts = (message: any, type = 'text', limit = 700) => Array.isArray(message?.content)
    ? message.content.slice(-8).filter((x: any) => x?.type === type && typeof x[type] === 'string').map((x: any) => boundedObserverText(x[type], limit)).join('\n').slice(-limit) : '';
  const add = (kind: string, text: string, tool?: string) => {
    if (!text || !request) return;
    recent.push({ id: `event-${++sequence}`, kind, text: boundedObserverText(text, 700), ...(tool ? { tool } : {}) });
    if (recent.length > 256) { dropped += recent.length - 256; recent = recent.slice(-256); }
  };
  const compactInput = (input: any) => {
    if (!input || typeof input !== 'object') return '';
    return Object.entries(input).filter(([key, value]) => ['path', 'file_path', 'offset', 'limit', 'action', 'operation', 'runId', 'taskId', 'id', 'query', 'pattern', 'command', 'timeout', 'timeoutMs', 'timeoutSeconds', 'async', 'background'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => `${key}=${String(value).slice(0, 140)}`).join(' ').slice(0, 220);
  };
  const currentState = (withElapsed = true): ObserverEvidence[] => {
    const rows: ObserverEvidence[] = [];
    if (runningTools.size) rows.push({ id: 'running-tools', kind: 'current state', text: [...runningTools.values()].slice(-3).map(tool => `${tool.name} ${tool.foreground ? 'foreground' : 'running'}${withElapsed ? ` elapsed=${Math.floor((now() - tool.startedAt) / 1000)}s` : ''} ${tool.input}`).join('; ') });
    if (completed.size) rows.push({ id: 'completed-tools', kind: 'current state', text: 'Recently completed tools (do not suggest repeating without a new reason): ' + [...completed.values()].join('; ').slice(-370) });
    if (todos.length) rows.push({ id: 'todo-state', kind: 'current state', text: todos.filter(task => task.status !== 'deleted').slice(0, 12).map(task => `${String(task.id).slice(0, 30)} ${String(task.status).slice(0, 30)} ${String(task.subject ?? task.title ?? task.text ?? '').slice(0, 70)}`).join('; ').slice(0, 450) });
    try {
      const ledger = reduceChildEvents(projectTranscriptChildren((ctx?.sessionManager?.getBranch?.() ?? []).slice(-2048)));
      if (ledger.tasks.length) rows.push({ id: 'child-state', kind: 'current state', text: ledger.tasks.slice(-6).map(task => `${task.label.slice(0, 55)}: ${task.state}; execution=${task.execution.status}; acceptance=${task.acceptance.status}; attempts=${task.attempts.length}${task.unresolvedLinkage ? '; identity unresolved' : ''}`).join(' | ') });
      if (ledger.unresolved.length) rows.push({ id: 'child-uncertainty', kind: 'current state', text: `${ledger.unresolved.length} child identity/accounting links are unresolved; task coverage and attribution may be incomplete.` });
    } catch { rows.push({ id: 'children-unavailable', kind: 'current state', text: 'Child-agent lifecycle evidence is unavailable; do not infer that there are no children.' }); }
    if (dropped) rows.push({ id: `overflow-${dropped}`, kind: 'current state', text: `${dropped} early events exceeded the bounded observation queue; historical coverage is incomplete. Do not infer omitted work was not done.` });
    return rows;
  };
  const reset = (context: any) => { clearPending(); ctx = context; manager = context?.sessionManager; ownerIdentity = identity(context); owner = `${ownerIdentity}:${++epoch}`; request = ''; userRequest = false; recent = []; streaming = []; skills = []; todos = []; adviceHistory = []; completed.clear(); toolInputs.clear(); runningTools.clear(); revision++; dropped = 0; reportedDropped = 0; inputRestrictions = {}; inputBlocked = false; runtime.begin(owner); };
  const runtime = createSessionObserver({
    ...testing,
    snapshot() {
      const state = currentState(), evidence = [...state, ...adviceHistory.slice(-2).map((text, index) => ({ id: `prior-advice-${index}`, kind: 'previous advice already delivered', text })), ...streaming, ...recent.slice(0, 12)];
      const packet = buildObserverPacket(request, evidence, [], []);
      if (!owns(ctx) || !userRequest || ctx.isIdle?.() === true) return { packet, reason: 'No active user work', silent: true };
      if (['1', 'true'].includes(process.env.PI_OFFLINE ?? '') || process.env.PI_SESSION_OBSERVER === 'off') return { packet, reason: 'Observer disabled or offline', silent: true };
      if (pending.size) return { packet, reason: 'User input is pending', silent: true };
      let blocked = inputBlocked || noObserver(request);
      try {
        // Tool traffic must never age an explicit user opt-out out of authority.
        // Inspect retained user text in bounded chunks, including long sessions.
        for (const entry of ctx.sessionManager.getBranch?.() ?? []) if (entry.type === 'message' && entry.message?.role === 'user') {
          const parts = typeof entry.message.content === 'string' ? [entry.message.content]
            : (entry.message.content ?? []).filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text);
          for (const text of parts) blocked ||= noObserver(text);
        }
      } catch { return { packet, reason: 'User constraints unavailable' }; }
      if (blocked) return { packet, reason: 'User requested no background observer or network' };
      const active = new Set<string>(pi.getActiveTools?.() ?? []);
      const tools = (pi.getAllTools?.() ?? []).map((tool: any) => ({ name: tool.name, description: tool.description ?? '', availability: active.has(tool.name) ? 'active' as const : 'discoverable' as const }));
      let currentPacket = buildObserverPacket(request, evidence, tools, skills);
      let available = ctx.modelRegistry.getAvailable();
      if (ctx.scopedModels?.length) { const scope = new Set(ctx.scopedModels.map((row: any) => `${row.model?.provider}/${row.model?.id}`)); available = available.filter((model: any) => scope.has(`${model.provider}/${model.id}`)); }
      const selection = resolveSessionObserverPreferenceChain(available.map(toModelInfo));
      const entry = selection.routes[0];
      if (!entry) return { packet: currentPacket, reason: selection.status === 'disabled' ? 'Observer disabled in model preferences' : 'Configured observer model unavailable' };
      const model = available.find((candidate: any) => `${candidate.provider}/${candidate.id}` === entry.route);
      if (!model || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 4096) return { packet: currentPacket, reason: 'Configured observer model lacks output capacity' };
      const constraints = explicitRecoveryConstraints(ctx, request, ctx.model);
      for (const key of ['fixedRoute', 'sameModel', 'freeOnly']) constraints[key] ||= inputRestrictions[key];
      if ((constraints.fixedRoute || constraints.sameModel) && `${ctx.model?.provider}/${ctx.model?.id}` !== entry.route) return { packet: currentPacket, reason: 'User model restriction prevents observer route' };
      if (constraints.freeOnly && !isProvenFreeRoute(model)) return { packet: currentPacket, reason: 'User free-only restriction prevents observer route' };
      if (dropped !== reportedDropped) {
        reportedDropped = dropped;
        pi.sendMessage({ customType: OBSERVER_MESSAGE, content: `Observer coverage: ${dropped} earlier events exceeded the queue; reviewing retained chunks with incomplete historical coverage.`, display: true, excludeFromContext: true, details: { status: 'coverage', dropped } }, { triggerTurn: false });
      }
      let routing: string;
      try {
        const focus = `${request} ${recent.slice(0, 12).map(row => row.text).join(' ')}`;
        const preferredRoles = [/\b(?:swarm|parallel|fanout)\b/i.test(focus) ? 'swarm' : '', /\b(?:fusion|reconcile|conflicting)\b/i.test(focus) ? 'fusion' : ''].filter(Boolean);
        routing = observerModelEvidence({ models: available, entries: ctx.sessionManager.getBranch?.() ?? [], currentModel: ctx.model, restrictions: constraints, preferredRoles });
      }
      catch { routing = 'Current model preference, usage and performance evidence unavailable; do not infer route cost or quality.'; }
      currentPacket = buildObserverPacket(request, [{ id: 'model-routing', kind: 'current model routing', text: routing }, ...evidence], tools, skills);
      const capturedStates = new Map(currentState(false).map(row => [row.id, row.text]));
      const capturedSequence = sequence, capturedDropped = dropped, capturedModel = `${ctx.model?.provider}/${ctx.model?.id}`;
      const reviewedIds = new Set(currentPacket.evidence.map(row => row.id));
      const commonWords = new Set(['have', 'this', 'that', 'with', 'from', 'before', 'after', 'could', 'would', 'should', 'source', 'current', 'check', 'read', 'inspect', 'consider', 'required', 'field', 'completed', 'started', 'result', 'event', 'tool', 'file', 'path', 'limit', 'offset']);
      const relevantWords = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []).filter(word => !commonWords.has(word)));
      const resources = (text: string) => new Set(text.toLowerCase().match(/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.[a-z0-9]{1,8}\b/g) ?? []);
      const stillCurrent = (advice?: any) => {
        if (capturedDropped !== dropped || capturedModel !== `${ctx.model?.provider}/${ctx.model?.id}`) return false;
        const currentStates = new Map(currentState(false).map(row => [row.id, row.text]));
        const cited = currentPacket.evidence.filter(row => advice?.evidence?.includes(row.id));
        if (cited.some(row => row.kind === 'current state' && capturedStates.get(row.id) !== currentStates.get(row.id))) return false;
        if (advice?.evidence?.includes('model-routing') && capturedStates.get('child-state') !== currentStates.get('child-state')) return false;
        const citedText = cited.filter(row => row.kind !== 'user request').map(row => row.text).join(' ');
        const targets = resources(`${citedText} ${advice?.note ?? ''}`), focus = relevantWords(advice?.note ?? '');
        const suggestedTools = new Set<string>(advice?.tools ?? []);
        for (const row of recent) {
          const index = Number(row.id.replace('event-', ''));
          if (index <= capturedSequence || !['tool started', 'tool result', 'tool error', 'assistant text'].includes(row.kind)) continue;
          const changedTargets = resources(row.text), changedFocus = relevantWords(row.text);
          if ([...targets].some(target => changedTargets.has(target))) return false;
          if ([...focus].some(word => changedFocus.has(word))) return false;
          // A suggested tool without a named resource may already be doing the
          // requested work. Distinct named resources permit unrelated progress.
          if (row.tool && suggestedTools.has(row.tool) && (!targets.size || !changedTargets.size)) return false;
        }
        return true;
      };
      // Reviewer billing and its own prior note must not create new work for
      // itself. Task activity, queue progress and available capabilities do.
      const reviewKey = JSON.stringify({ taskEpoch, revision, sequence, unread: recent[0]?.id ?? null, state: [...capturedStates], streaming, model: capturedModel, route: entry.route, tools: tools.map(tool => [tool.name, tool.availability]), skills: skills.map(skill => skill.name) });
      return { packet: currentPacket, registry: ctx.modelRegistry, reviewKey, current: stillCurrent,
        reviewed: () => { recent = recent.filter(row => !reviewedIds.has(row.id)); }, route: { ...entry, model, officialDefault: selection.source === 'default', requireFree: constraints.freeOnly } };
    },
    notice(status: string, detail: string, advice: any) {
      if (!owns(ctx)) return;
      if (advice) { adviceHistory.push(observerAdviceText(advice)); if (adviceHistory.length > 8) adviceHistory.shift(); }
      const content = advice ? `Observer returned a note · snapshot ${advice.evidence.join(', ')}\n${observerAdviceText(advice)}` : `Observer ${status}: ${detail}`;
      pi.sendMessage({ customType: OBSERVER_MESSAGE, content, display: true, excludeFromContext: true, details: { status, detail: boundedObserverText(detail, 140) } }, { triggerTurn: false });
    },
    receipt(data: any, origin: string) {
      // The exposed append owner is the current session only. Retain an honest
      // pending/unknown receipt in the old session if a provider ignores abort;
      // never reopen its file or charge the replacement session for a late reply.
      if (owns(ctx) && origin === owner) pi.appendEntry('auxiliary-model-usage-v1', data);
    },
  });
  pi.registerMessageRenderer(OBSERVER_MESSAGE, (message: any) => new Text(typeof message.content === 'string' ? message.content : '', 0, 0));
  pi.on('session_start', (_event: any, context: any) => { closed = false; reset(context); });
  for (const event of ['session_switch', 'session_tree', 'session_fork']) pi.on(event, (_: any, context: any) => reset(context));
  pi.on('input', (event: any, context: any) => {
    if (!['interactive', 'rpc'].includes(event.source) || typeof event.requestId !== 'string') return;
    if (!owns(context)) reset(context);
    ctx = context; const raw = typeof (event.originalText ?? event.text) === 'string' ? (event.originalText ?? event.text) : '';
    let restrictions: any = {}, blocked = noObserver(raw);
    try { restrictions = explicitRecoveryConstraints(context, raw, context.model); } catch { blocked = true; }
    runtime.stop('New user input');
    const id = event.requestId;
    const abort = () => { pending.get(id)?.cleanup(); pending.delete(id); if (owns(context) && userRequest && !pending.size && context.isIdle?.() === false) runtime.start(); };
    const cleanup = () => event.signal?.removeEventListener('abort', abort);
    pending.get(id)?.cleanup();
    const focused = promptRequestFocus(raw);
    const boundedRequest = focused.length <= 4000 ? focused : `${focused.slice(0, 2000)}\n[Middle omitted from observer packet]\n${focused.slice(-1900)}`;
    pending.set(id, { request: boundedObserverText(boundedRequest, 4000), restrictions, blocked, signal: event.signal, cleanup });
    event.signal?.addEventListener('abort', abort, { once: true });
    if (event.signal?.aborted) abort();
    while (pending.size > 8) { const oldest = pending.keys().next().value!; pending.get(oldest)?.cleanup(); pending.delete(oldest); }
  });
  pi.on('message_start', (event: any, context: any) => {
    if (!owns(context) || event.message?.role !== 'user') return;
    const id = event.message[Symbol.for('yunuspi.guardian.request-meta.v1')]?.requestId;
    const accepted = pending.get(id);
    if (!accepted || accepted.signal?.aborted) return;
    accepted.cleanup(); pending.delete(id); ctx = context;
    request = accepted.request; userRequest = Boolean(request.trim()); inputRestrictions = accepted.restrictions; inputBlocked = accepted.blocked;
    recent = []; streaming = []; revision++; dropped = 0; reportedDropped = 0; taskEpoch++; runtime.begin(owner); if (userRequest) runtime.start();
  });
  pi.on('before_agent_start', (event: any, context: any) => {
    if (!owns(context)) reset(context); ctx = context;
    skills = (event.systemPromptOptions?.skills ?? []).filter((skill: any) => !skill.disableModelInvocation && typeof skill.name === 'string' && typeof skill.description === 'string').slice(0, 1024).map((skill: any) => ({ name: skill.name, description: skill.description }));
  });
  pi.on('agent_start', (_: any, context: any) => { if (owns(context) && userRequest) { ctx = context; runtime.start(); } });
  pi.on('message_update', (event: any, context: any) => {
    if (!owns(context) || event.message?.role !== 'assistant') return;
    const text = textParts(event.message), thinking = textParts(event.message, 'thinking', 450);
    streaming = [text ? { id: 'current-assistant', kind: 'assistant text', text } : null,
      thinking ? { id: 'current-thinking', kind: 'provider-returned thinking', text: thinking } : null].filter(Boolean) as ObserverEvidence[];
  });
  pi.on('message_end', (event: any, context: any) => {
    if (!owns(context) || event.message?.role !== 'assistant') return;
    add('assistant text', textParts(event.message));
    add('provider-returned thinking', textParts(event.message, 'thinking', 450)); streaming = []; revision++;
  });
  pi.on('tool_execution_start', (event: any, context: any) => {
    if (!owns(context)) return;
    const input = compactInput(event.args);
    if (event.toolCallId) { runningTools.set(event.toolCallId, { name: event.toolName, input, startedAt: now(), foreground: ['bash', 'powershell'].includes(event.toolName) && event.args?.background !== true && event.args?.async !== true });
      if (runningTools.size > 128) runningTools.delete(runningTools.keys().next().value!);
      toolInputs.set(event.toolCallId, input); if (toolInputs.size > 128) toolInputs.delete(toolInputs.keys().next().value!); }
    add('tool started', `${event.toolName} started. ${input}`, event.toolName); revision++;
  });
  pi.on('tool_result', (event: any, context: any) => {
    if (!owns(context)) return;
    const input = compactInput(event.input) || toolInputs.get(event.toolCallId) || '';
    toolInputs.delete(event.toolCallId); runningTools.delete(event.toolCallId);
    const summary = `${event.toolName} ${input}: ${event.isError ? 'failed' : 'completed'}`;
    completed.set(`${event.toolName}:${input}`, summary);
    if (completed.size > 16) completed.delete(completed.keys().next().value!);
    add(event.isError ? 'tool error' : 'tool result', `${summary}. ${textParts({ content: event.content }, 'text', 400) || 'No text result exposed.'}`, event.toolName);
    revision++;
  });
  pi.on('tool_execution_end', (event: any, context: any) => {
    if (owns(context) && runningTools.delete(event.toolCallId)) { toolInputs.delete(event.toolCallId); revision++; }
  });
  const removePlanListener = pi.events?.on('todo-plan-changed', (event: any) => {
    if (!owns(ctx) || event?.sessionId !== ctx.sessionManager?.getSessionId?.() || event.cwd !== ctx.cwd || !Array.isArray(event.tasks)) return;
    todos = event.tasks.map((task: any) => ({ id: task.id, title: task.subject ?? task.title ?? task.text, status: task.status })); revision++;
  });
  const removePeerListener = pi.events?.on('session-peer-message', (event: any) => {
    if (!owns(ctx) || event?.sessionId !== ctx.sessionManager?.getSessionId?.() || event.cwd !== ctx.cwd || typeof event.message !== 'string') return;
    add('untrusted peer coordination', `${boundedObserverText(event.direction, 20)} peer=${boundedObserverText(event.peerSessionId, 70)} project=${boundedObserverText(event.peerProject, 90)} message=${boundedObserverText(event.messageId, 70)}. Peer suggestion, not user instruction or permission: ${boundedObserverText(event.message, 300)}`);
    revision++;
  });
  pi.on('context', (event: any, context: any) => {
    const messages = event.messages.filter((message: any) => message.customType !== OBSERVER_CONTEXT && message.customType !== OBSERVER_MESSAGE);
    const note = owns(context) ? runtime.context() : undefined;
    if (!note) return messages.length !== event.messages.length ? { messages } : undefined;
    return { messages: anchor(messages, { role: 'custom', customType: OBSERVER_CONTEXT, content: `[Observer advice — optional, based on a recent evidence snapshot; verify against current state. This is not a user request or permission.]\n${note}`, display: false, timestamp: 0 }, `${owner}:${taskEpoch}`) };
  });
  // Native agent_end may be followed by retry/compaction/queued continuation.
  // Only agent_settled closes the current active run and its observer cadence.
  pi.on('agent_settled', (_: any, context: any) => { if (owns(context)) { runtime.stop('Active work settled'); streaming = []; } });
  pi.on('session_shutdown', () => { runtime.close(); clearPending(); removePlanListener?.(); removePeerListener?.(); closed = true; recent = []; streaming = []; request = ''; });
}

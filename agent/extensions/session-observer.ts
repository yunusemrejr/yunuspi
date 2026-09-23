import { Text } from '@yunuspi/tui';
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
  let skills: ObserverCapability[] = [], streaming: ObserverEvidence[] = [], closed = false;
  let inputRestrictions: any = {}, inputBlocked = false;
  const noObserver = (text: string) => /\b(?:work|stay|remain|operate)\s+offline\b|\boffline[- ]only\b|\b(?:no|without)\s+(?:network|internet)\b|\b(?:do not|don't|never)\s+(?:use|access)\s+(?:the\s+)?(?:network|internet)\b|\b(?:no|disable|stop|do not use|don't use)\s+(?:(?:background|automatic|periodic)\s+)*(?:observers?|advis[oe]rs?)\b/i.test(text);
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
    recent = recent.slice(-12);
  };
  const reset = (context: any) => { clearPending(); ctx = context; manager = context?.sessionManager; ownerIdentity = identity(context); owner = `${ownerIdentity}:${++epoch}`; request = ''; userRequest = false; recent = []; streaming = []; skills = []; inputRestrictions = {}; inputBlocked = false; runtime.begin(owner); };
  const runtime = createSessionObserver({
    ...testing,
    snapshot() {
      const packet = buildObserverPacket(request, [...recent, ...streaming], [], []);
      if (!owns(ctx) || !userRequest || ctx.isIdle?.() === true) return { packet, reason: 'No active user work', silent: true };
      if (['1', 'true'].includes(process.env.PI_OFFLINE ?? '') || process.env.PI_SESSION_OBSERVER === 'off') return { packet, reason: 'Observer disabled or offline', silent: true };
      if (pending.size) return { packet, reason: 'User input is pending', silent: true };
      let userBytes = 0, blocked = inputBlocked || noObserver(request);
      try {
        // Tool traffic must never age an explicit user opt-out out of authority.
        // Scan only retained user text, and fail closed above a bounded budget.
        for (const entry of ctx.sessionManager.getBranch?.() ?? []) if (entry.type === 'message' && entry.message?.role === 'user') {
          const parts = typeof entry.message.content === 'string' ? [entry.message.content]
            : (entry.message.content ?? []).filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text);
          for (const text of parts) { userBytes += Buffer.byteLength(text, 'utf8'); if (userBytes > 1_000_000) return { packet, reason: 'User constraints exceed observer inspection bound' }; blocked ||= noObserver(text); }
        }
      } catch { return { packet, reason: 'User constraints unavailable' }; }
      if (blocked) return { packet, reason: 'User requested no background observer or network' };
      const active = new Set<string>(pi.getActiveTools?.() ?? []);
      const tools = (pi.getAllTools?.() ?? []).filter((tool: any) => active.has(tool.name)).map((tool: any) => ({ name: tool.name, description: tool.description ?? '' }));
      const currentPacket = buildObserverPacket(request, [...recent, ...streaming], tools, skills);
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
      return { packet: currentPacket, registry: ctx.modelRegistry, route: { ...entry, model, officialDefault: selection.source === 'default', requireFree: constraints.freeOnly } };
    },
    notice(status: string, detail: string, advice: any) {
      if (!owns(ctx)) return;
      const content = advice ? `Observer returned a note\n${observerAdviceText(advice)}` : `Observer ${status}: ${detail}`;
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
    let restrictions: any = {}, blocked = raw.length > 1_000_000 || noObserver(raw);
    try { restrictions = explicitRecoveryConstraints(context, raw, context.model); } catch { blocked = true; }
    runtime.stop('New user input');
    const id = event.requestId;
    const abort = () => { pending.get(id)?.cleanup(); pending.delete(id); if (owns(context) && userRequest && !pending.size && context.isIdle?.() === false) runtime.start(); };
    const cleanup = () => event.signal?.removeEventListener('abort', abort);
    pending.get(id)?.cleanup();
    pending.set(id, { request: boundedObserverText(raw, 4000), restrictions, blocked, signal: event.signal, cleanup });
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
    recent = []; streaming = []; taskEpoch++; runtime.begin(owner); if (userRequest) runtime.start();
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
    add('provider-returned thinking', textParts(event.message, 'thinking', 450)); streaming = [];
  });
  pi.on('tool_execution_start', (event: any, context: any) => { if (owns(context)) add('tool started', `Tool ${event.toolName} started.`, event.toolName); });
  pi.on('tool_result', (event: any, context: any) => { if (owns(context)) add(event.isError ? 'tool error' : 'tool result', textParts({ content: event.content }, 'text', 500) || 'No text result exposed.', event.toolName); });
  pi.on('context', (event: any, context: any) => {
    const messages = event.messages.filter((message: any) => message.customType !== OBSERVER_CONTEXT && message.customType !== OBSERVER_MESSAGE);
    const note = owns(context) ? runtime.context() : undefined;
    if (!note) return messages.length !== event.messages.length ? { messages } : undefined;
    return { messages: anchor(messages, { role: 'custom', customType: OBSERVER_CONTEXT, content: `[Observer advice — optional, based on a recent evidence snapshot; verify against current state. This is not a user request or permission.]\n${note}`, display: false, timestamp: 0 }, `${owner}:${taskEpoch}`) };
  });
  // Native agent_end may be followed by retry/compaction/queued continuation.
  // Only agent_settled closes the current active run and its observer cadence.
  pi.on('agent_settled', (_: any, context: any) => { if (owns(context)) { runtime.stop('Active work settled'); streaming = []; } });
  pi.on('session_shutdown', () => { runtime.close(); clearPending(); closed = true; recent = []; streaming = []; request = ''; });
}

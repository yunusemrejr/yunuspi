/** Session-owned execution state. Routing and schedulers read this live getter;
 * pipeline receipts index existing evidence and never execute a second test. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { getAgentDir } from '@yunuspi/coding-agent';
import { createAdaptiveExecutionController, registerAdaptiveExecution, adaptiveExecutionEnabled, createAdaptiveThinkingController } from './lib/adaptive-execution.ts';
import { selectTaskPipelines, automaticPipelineTools, createPipelineLedger, recordPipelineEvidence, pendingPipelineStages, buildPipelineContext, inspectPipelineSource, resolveRoutingTask, pipelineToolExcluded, PIPELINE_EVIDENCE_KINDS, type PipelineSelection, type PipelineSourceMetadata } from './lib/task-pipelines.ts';
import { projectCheckCommand } from './lib/project-tests.ts';
import { isLiveByteVerification } from './lib/session-hooks.ts';
import { classifyToolOutcome, createCompetenceEstimator, createStepTracker, fleetRateFromAggregate, priorFromAggregate, type ControlSnapshot, type StepOutcome } from './lib/model-competence.ts';
import { competenceStoreFile, FLEET_KEY, readCompetenceStore, writeCompetenceDeltas, type CompetenceStore } from './lib/competence-store.ts';

/** One targeted sentence per burst: what keeps failing and the cheapest way out. */
const burstNote = (family: string) => {
  const advice = ['edit', 'bulk_edit', 'write'].includes(family)
    ? 'Re-read the exact region with the read tool (offset and limit) and copy oldText verbatim from that output instead of retyping it from memory; if the file changed, read it again first.'
    : family === 'bash' || family === 'bg_run'
      ? 'Check the failing command in one minimal step (syntax, path, flags) before running the full pipeline again.'
      : `Read the error text literally and change the arguments it names; do not resend the same ${family} input.`;
  return `[recovery] Two ${family} calls in a row went wrong. ${advice}`;
};

export default function adaptiveWorkflows(pi: any) {
  const execution = createAdaptiveExecutionController();
  const thinking = createAdaptiveThinkingController(pi);
  let dispose: (() => void) | undefined, owner: any, ownerFile = '', ownerCwd = '', ownerId = '', epoch = 0;
  let task = '', scope = 'task', revision = 'initial', selection = selectTaskPipelines({ prompt: '' });
  let ledger = createPipelineLedger(), pendingInput: { text: string; id: string; signal?: AbortSignal } | undefined, acceptedId = '';
  const scopes = new Map<string, { selection: PipelineSelection; revision: string; task: string }>();
  let parentNoDelegation = false;
  // Measured reliability of the executing route: one estimator per route used this session.
  const competence = new Map<string, ReturnType<typeof createCompetenceEstimator>>();
  let stepTracker = createStepTracker(), store: CompetenceStore = {}, storeFile = '', sinceFlush = 0, shownLevel = 'standard', burstFamily = '';
  const routeOf = (ctx: any): string => { const provider = ctx?.model?.provider, id = ctx?.model?.id; return typeof provider === 'string' && typeof id === 'string' && provider && id ? `${provider}/${id}` : ''; };
  const flushCompetence = () => {
    sinceFlush = 0;
    if (!storeFile) return;
    const deltas: Record<string, ReturnType<ReturnType<typeof createCompetenceEstimator>['takeDelta']>> = {};
    for (const [route, estimator] of competence) deltas[route] = estimator.takeDelta();
    try { store = writeCompetenceDeltas(storeFile, deltas, Date.now()); } catch { /* advisory evidence */ }
  };
  type Observation = { sequence: number; revision: number; tree?: string; complete: boolean };
  const changed = new Map<string, string>(), calls = new Map<string, { tool: string; scope: string; revision: string; key: string; observation?: number; deployment?: string }>();
  type OwnedCheck = { scope: string; revision: string; key: string; callId: string; candidate: boolean; failedObserved?: boolean };
  const ownedChecks = new Map<string, OwnedCheck>(), backgroundChecks = new Map<string, OwnedCheck>();
  const pendingTerminals = new Map<string, { task: any; after: number }>();
  const scopeFiles = new Map<string, Set<string>>();
  const discoveredFiles = new Map<string, Set<string>>();
  const sourceMetadata = new Map<string, Map<string, PipelineSourceMetadata>>();
  const impactCoverage = new Map<string, { revision: string; files: Set<string>; source: string; summary?: string }>();
  let routingSnapshot = '';
  let sourceRevision = 'initial';
  let sourceSeed = '', nativeIdentity = '', uncertainSource = '', observation: Observation | undefined, observationSequence = 0;
  const enabled = () => adaptiveExecutionEnabled();
  const contentRevision = (text: string) => createHash('sha256').update(`${sourceRevision}:${text}`).digest('hex').slice(0, 20);
  const reset = (_event?: any, ctx?: any) => {
    flushCompetence(); competence.clear(); stepTracker = createStepTracker(); shownLevel = 'standard'; burstFamily = '';
    // Child agents (reviewers, helpers) are a different workload with their own routes; they never
    // feed the installation's record or move its thresholds.
    storeFile = process.env.PI_COMPETENCE_STORE === 'off' || process.env.PI_SUBAGENT_CHILD === '1' ? '' : (() => { try { return competenceStoreFile(getAgentDir()); } catch { return ''; } })();
    store = storeFile ? readCompetenceStore(storeFile) : {};
    thinking.reset(ctx);
    dispose?.(); dispose = undefined; execution.reset(); owner = ctx?.sessionManager;
    ownerFile = owner?.getSessionFile?.() ?? ''; task = ''; scope = 'task'; revision = 'initial';
    ownerCwd = ctx?.cwd ?? ''; ownerId = owner?.getSessionId?.() ?? '';
    sourceSeed = ''; nativeIdentity = ''; uncertainSource = ''; observation = undefined; observationSequence = 0;
    selection = selectTaskPipelines({ prompt: '' }); ledger = createPipelineLedger(); scopes.clear(); changed.clear(); scopeFiles.clear(); discoveredFiles.clear(); sourceMetadata.clear(); impactCoverage.clear(); calls.clear(); ownedChecks.clear(); backgroundChecks.clear(); pendingTerminals.clear(); pendingInput = undefined; acceptedId = ''; parentNoDelegation = false; routingSnapshot = '';
    if (owner && enabled()) dispose = registerAdaptiveExecution(ctx, () => execution.profile());
    if (owner && enabled()) {
      // Restore authored purpose, never stale passes or executed side effects.
      const entries = owner.getBranch?.() ?? [];
      const stored = entries.findLast((entry: any) => entry.type === 'custom' && entry.customType === 'adaptive-routing-v1' && entry.data?.version === 1)?.data;
      const goal = entries.findLast((entry: any) => entry.type === 'custom' && entry.customType === 'goal-state-v1' && entry.data?.version === 1)?.data;
      const restored = typeof stored?.task === 'string' && stored.task.length <= 24000 ? stored.task : goal?.status === 'active' && typeof goal.text === 'string' ? goal.text.slice(0, 24000) : '';
      if (restored) {
        task = restored; sourceSeed = `restored:${ownerId}`; refreshRevision();
        execution.begin({ task, scope: 'task' }, 'task'); parentNoDelegation = execution.profile().constraints.noDelegation;
        selection = selectTaskPipelines({ prompt: task }); save(ctx, true);
      }
    }
  };
  for (const event of ['session_start', 'session_switch', 'session_tree', 'session_fork']) pi.on(event, reset);
  pi.on('session_shutdown', () => reset());
  pi.on('thinking_level_select', (event: any, ctx: any) => thinking.onSelection(event, ctx));
  pi.on('agent_settled', (_event: any, ctx: any) => { thinking.restore(ctx); flushCompetence(); });
  // A different route has its own record; its evidence replaces the previous route's control.
  pi.on('model_select', (_event: any, ctx: any) => {
    if (!enabled() || !owns(ctx)) return;
    const estimator = competence.get(routeOf(ctx));
    if (execution.setControl(estimator ? controlOf(estimator.snapshot()) : undefined)) save(ctx);
  });
  const controlOf = (snapshot: ControlSnapshot) => ({ level: snapshot.level, ...(snapshot.burst ? { burst: snapshot.burst } : {}) });
  const announce = (text: string, detail: string) => {
    try { pi.sendMessage?.({ customType: 'harness-activity', content: `Oversight · ${text}`, display: true, excludeFromContext: true, details: { kind: 'intelligence.activity', label: 'Oversight', status: 'ok', detail: `${text} · ${detail}`.slice(0, 240), count: 1 } }, { triggerTurn: false }); } catch { /* visibility only */ }
  };
  /** Feed one classified step to the executing route's estimator; returns a recovery note when a burst begins. */
  const observeStep = (route: string, outcome: StepOutcome, ctx: any): string | undefined => {
    if (!route || process.env.PI_SUBAGENT_CHILD === '1') return;
    let estimator = competence.get(route);
    if (!estimator) {
      const now = Date.now();
      estimator = createCompetenceEstimator(priorFromAggregate(store[route], now), { fleetRate: fleetRateFromAggregate(store[FLEET_KEY], now) });
      competence.set(route, estimator);
    }
    const snapshot = estimator.observe(outcome);
    if (++sinceFlush >= 25) flushCompetence();
    let note: string | undefined;
    if (snapshot.burst && !burstFamily) { burstFamily = snapshot.burst.family; note = burstNote(burstFamily); announce('burst', `${snapshot.burst.slips} ${burstFamily} slips in a row; targeted recovery note sent`); }
    else if (!snapshot.burst) burstFamily = '';
    if (snapshot.level !== shownLevel) {
      shownLevel = snapshot.level;
      announce(snapshot.level === 'earned' ? 'earned autonomy' : snapshot.level === 'guarded' ? 'tightened' : 'standard', snapshot.reason);
    }
    if (execution.setControl(controlOf(snapshot))) save(ctx);
    return note;
  };
  const stepOf = (event: any, ctx: any, mutated: boolean): StepOutcome | undefined => {
    const text = (event.content ?? []).filter((row: any) => row.type === 'text').map((row: any) => row.text).join('\n');
    const shell = ['bash', 'bg_run'].includes(event.toolName);
    const flags = stepTracker.track({ toolName: event.toolName, args: event.input ?? {}, text, isError: event.isError === true, mutated });
    return classifyToolOutcome({ toolName: event.toolName, isError: event.isError === true, text, check: shell && Boolean(projectCheckCommand(event.input?.command, ctx.cwd)), ...flags });
  };
  const owns = (ctx: any) => ctx?.sessionManager === owner && ctx?.cwd === ownerCwd && (owner?.getSessionId?.() ?? '') === ownerId && (owner?.getSessionFile?.() ?? '') === ownerFile;
  const refreshRevision = () => {
    sourceRevision = createHash('sha256').update(JSON.stringify([sourceSeed, nativeIdentity, uncertainSource, [...changed].sort()])).digest('hex');
    revision = contentRevision(scopes.get(scope)?.task ?? task);
  };
  const fileIdentity = (ctx: any, raw: string): { relative: string; hash: string } | undefined => {
    const file = path.resolve(ctx.cwd, raw), relative = path.relative(ctx.cwd, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return;
      const actual = path.relative(fs.realpathSync(ctx.cwd), fs.realpathSync(file));
      if (!actual || actual.startsWith('..') || path.isAbsolute(actual)) return;
      return { relative, hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    } catch { return; }
  };
  const mutation = (event: any, ctx: any, call?: { observation?: number }) => {
    const paths = new Set<string>();
    const nativePath = event.details?.fileMutation?.resolved ?? event.input?.path;
    if (['edit', 'write'].includes(event.toolName) && (!event.isError || event.details?.fileMutation) && typeof nativePath === 'string') paths.add(nativePath);
    if (event.toolName === 'ui_recipe' && event.input?.action === 'scaffold' && !event.isError && event.details?.action === 'scaffold')
      for (const file of event.details.files ?? []) if (typeof file?.path === 'string' && typeof file.sha256 === 'string') paths.add(file.path);
    if (event.toolName === 'bulk_edit' && event.input?.action === 'apply') {
      // The native bulk tool returns committed paths in its JSON result;
      // input.files alone is a requested set, not a commit receipt.
      for (const block of event.content ?? []) if (block.type === 'text') {
        try {
          const receipt = JSON.parse(block.text);
          if (receipt.action === 'apply' && Array.isArray(receipt.files)) for (const file of receipt.files) if (typeof file === 'string') paths.add(file);
        } catch { /* descriptive output is not a path receipt */ }
      }
      if (!paths.size && !event.isError && event.details?.files > 0 && Array.isArray(event.input?.files)) for (const file of event.input.files) if (typeof file === 'string') paths.add(file);
    }
    const shell = ['bash', 'bg_run'].includes(event.toolName);
    const affected: string[] = [];
    let uncertain = false;
    for (const raw of paths) {
      const current = fileIdentity(ctx, raw);
      if (current) { changed.set(current.relative, current.hash); affected.push(current.relative); }
      else uncertain = true; // Deleted, oversized or unobserved targets cannot retain a pass.
    }
    if (shell) {
      // Rehash only already observed artifacts: exact local receipts remain
      // useful even when the native scan is unavailable or misses a path.
      for (const [raw, previous] of changed) {
        const current = fileIdentity(ctx, raw);
        if (!current) { changed.set(raw, `unobserved:${++epoch}`); uncertain = true; }
        else if (current.hash !== previous) { changed.set(raw, current.hash); affected.push(raw); }
      }
      const fresh = observation && observation.sequence !== call?.observation && observation.complete;
      // Unknown shell input is never evidence that an artifact stayed the
      // same. With no complete native observation, retire its old receipts.
      // Recognized checks still have their command receipt; changed known
      // source bytes above prevent that receipt from verifying a stale tree.
      if (!fresh && (observation || !projectCheckCommand(event.input?.command, ctx.cwd))) uncertain = true;
    }
    if (event.toolName === 'bulk_edit' && event.input?.action === 'apply' && !paths.size && event.details?.files !== 0) uncertain = true;
    if (uncertain) uncertainSource = `unobserved:${++epoch}`;
    const before = revision; refreshRevision();
    return { paths: affected, changed: revision !== before, complete: !uncertain };
  };
  const scopeBrief = () => scopes.get(scope)?.task ?? task;
  const routingTask = () => scope === 'task' ? task : resolveRoutingTask(task, scopeBrief()).task;
  const constraintsTask = () => scope === 'task' ? task : `${task}\n[Subtask]\n${scopeBrief()}`;
  const inheritedConstraints = () => scope === 'task' ? undefined : task;
  const scopedFiles = () => [...(scopeFiles.get(scope) ?? []), ...(discoveredFiles.get(scope) ?? [])];
  const selectScope = () => {
    const metadata = [...(sourceMetadata.get(scope)?.values() ?? [])];
    return selectTaskPipelines({ prompt: routingTask(), constraints: constraintsTask(), inheritedConstraints: inheritedConstraints(), files: scopedFiles(), dependencies: metadata.flatMap(row => row.dependencies), signals: metadata.flatMap(row => row.signals) });
  };
  const inspectSource = (raw: string, ctx: any) => {
    const identity = fileIdentity(ctx, raw);
    if (!identity) return;
    try {
      const file = path.resolve(ctx.cwd, identity.relative);
      if (fs.statSync(file).size > 262144) return;
      const metadata = sourceMetadata.get(scope) ?? new Map<string, PipelineSourceMetadata>();
      metadata.set(identity.relative, inspectPipelineSource(identity.relative, fs.readFileSync(file, 'utf8')));
      while (metadata.size > 64) metadata.delete(metadata.keys().next().value!);
      sourceMetadata.set(scope, metadata);
    } catch { /* Missing source supplies no dependency or syntax evidence. */ }
  };
  const automaticNames = () => automaticPipelineTools(selection, { prompt: routingTask(), constraints: constraintsTask(), inheritedConstraints: inheritedConstraints(), profile: execution.profile(), files: scopedFiles(), ledger, coordinate: coordinate() });
  const save = (ctx: any, beforeStart = false) => {
    thinking.update(execution.profile(), ctx);
    scopes.set(scope, { selection, revision, task: scopes.get(scope)?.task ?? task });
    try { pi.appendEntry?.('adaptive-execution-v1', { scope, revision, ...execution.profile(), pipelines: selection.ids }); } catch { /* diagnostics */ }
    const snapshot = JSON.stringify({ version: 1, task });
    if (routingSnapshot !== snapshot) { routingSnapshot = snapshot; try { pi.appendEntry?.('adaptive-routing-v1', JSON.parse(snapshot)); } catch { /* restoration only */ } }
    try { pi.events?.emit?.('adaptive-pipeline-selection', { sessionManager: ctx.sessionManager, beforeStart, scope, task: constraintsTask(), tier: execution.profile().tier, names: automaticNames() }); } catch { /* optional discovery host */ }
  };
  pi.events?.on?.('project-source-observed', (event: any) => {
    if (!enabled() || !owns(event?.ctx)) return;
    const previous = observation;
    observation = { sequence: ++observationSequence, revision: event.revision, tree: event.tree, complete: event.complete === true && !event.unavailable };
    if (!task) return;
    const changed = previous ? previous.revision !== observation.revision || previous.tree !== observation.tree
      : ledger.receipts.some(row => row.status === 'passed' && row.stageId === 'validation');
    if (changed) { nativeIdentity = `${observation.revision}:${observation.tree ?? ''}`; refreshRevision(); }
    const progressed = settleTerminals();
    if (changed || progressed) save(event.ctx);
  });
  const coordinate = () => ({ scope, revision, maxChars: Math.min(2400, execution.profile().contextChars) });
  const record = (stageId: string, evidenceKind: any, source: string, status: any = 'passed', summary?: string) => {
    if (status === 'passed' && ledger.receipts.some(row => row.scope === scope && row.revision === revision && row.stageId === stageId && row.status === 'passed')) return false;
    try { return recordPipelineEvidence(ledger, { ...coordinate(), stageId, evidenceKind, source, status, summary }, selection).recorded; } catch { return false; }
  };
  const observeCheckFailure = (check: OwnedCheck | undefined) => {
    if (!check || check.failedObserved || check.scope !== scope || check.revision !== revision) return false;
    check.failedObserved = true;
    execution.observe({ ok: false, failureKey: check.key });
    record('validation', 'execution', `tool:${check.callId}`, 'failed');
    return true;
  };
  const terminalFailure = (task: any) => Boolean(task?.signal) || ['failed', 'killed', 'timed_out'].includes(task?.status ?? task?.state)
    || typeof task?.exitCode === 'number' && task.exitCode !== 0;
  const rememberTerminal = (task: any, after = observationSequence) => {
    if (typeof task?.id !== 'string' || !task.id || task.id.length > 256 || /^(?:running|pending|queued|starting)$/.test(task.status ?? task.state ?? '')) return;
    if (!pendingTerminals.has(task.id)) pendingTerminals.set(task.id, { task, after });
    while (pendingTerminals.size > 32) pendingTerminals.delete(pendingTerminals.keys().next().value!);
  };
  const settleTerminals = () => {
    if (!observation?.complete) return false;
    let progressed = false;
    for (const [id, receipt] of pendingTerminals) {
      const check = backgroundChecks.get(id);
      if (!check || observation.sequence <= receipt.after || check.scope !== scope) continue;
      pendingTerminals.delete(id);
      if (terminalFailure(receipt.task)) progressed = observeCheckFailure(check) || progressed;
      // A terminal exit alone does not certify coverage. Successful native
      // project_tests receipts retain their existing verification owner.
    }
    return progressed;
  };
  pi.events?.on?.('pi-background-tasks:terminal:v1', (event: any) => {
    if (!enabled() || !owner || !task) return;
    rememberTerminal(event?.task);
    // The native project-test owner scans before publishing its source
    // observation. Settle only after that fresh observation reaches us.
  });
  pi.on('message_end', (event: any, ctx: any) => {
    if (enabled() && owns(ctx) && task && event.message?.customType === 'background-task-notification') rememberTerminal(event.message.details);
  });
  pi.on('input', (event: any) => {
    if (!enabled() || !['interactive', 'rpc'].includes(event.source)) return;
    const text = typeof event.originalText === 'string' ? event.originalText : event.text;
    if (typeof text === 'string' && text.trim()) pendingInput = { text, id: event.requestId ?? `input-${++epoch}`, signal: event.signal };
  });
  pi.on('before_agent_start', (event: any, ctx: any) => {
    if (!enabled()) return;
    if (pendingInput?.signal?.aborted && !task) return;
    const queued = pendingInput;
    if (!owns(ctx)) reset(undefined, ctx);
    if (queued) pendingInput = queued;
    if (pendingInput?.signal?.aborted && !task) return;
    const next = pendingInput && !pendingInput.signal?.aborted && pendingInput.id !== acceptedId ? pendingInput : undefined;
    if (task && !next) return; // Continuations retain failures and current scope.
    const resolved = resolveRoutingTask(task, next?.text ?? String(event.prompt ?? ''));
    const previousRevision = contentRevision(task), previousSelection = scopes.get('task')?.selection ?? selection;
    const carry = resolved.continuing ? ledger.receipts.filter(row => row.scope === 'task' && row.revision === previousRevision && row.status === 'passed') : [];
    task = resolved.task; acceptedId = next?.id ?? `task-${++epoch}`;
    scope = 'task';
    if (!resolved.continuing) {
      sourceSeed = acceptedId; nativeIdentity = observation ? `${observation.revision}:${observation.tree ?? ''}` : ''; uncertainSource = '';
      changed.clear(); scopeFiles.clear(); discoveredFiles.clear(); sourceMetadata.clear(); impactCoverage.clear(); scopes.clear(); calls.clear(); ownedChecks.clear(); backgroundChecks.clear(); pendingTerminals.clear(); ledger = createPipelineLedger();
      execution.begin({ task, scope: 'task' }, scope);
    } else {
      if (!execution.select(scope)) execution.begin({ task, scope: 'task' }, scope);
      execution.update({ task });
      scopes.set(scope, { selection, revision, task });
    }
    refreshRevision();
    parentNoDelegation = execution.profile().constraints.noDelegation;
    selection = selectScope();
    if (resolved.continuing) {
      // Same-source steering keeps observed discovery and the prepared
      // artifact when the requirements are unchanged. New user criteria
      // still retire validation, appearance and interaction approvals.
      const unchanged = previousSelection.fingerprint === selection.fingerprint;
      for (const stage of selection.stages.filter(stage => stage.phase === 'discovery' || unchanged && stage.phase === 'implementation')) {
        const prior = carry.find(row => row.stageId === stage.id);
        const oldStage = previousSelection.stages.find(row => row.id === stage.id);
        if (prior && oldStage && JSON.stringify(oldStage.dependsOn) === JSON.stringify(stage.dependsOn)) record(stage.id, prior.evidenceKind, prior.source, 'passed', prior.summary);
      }
      const impact = impactCoverage.get('task');
      if (impact?.revision === previousRevision && ledger.receipts.some(row => row.scope === 'task' && row.revision === revision && row.stageId === 'source-impact' && row.status === 'passed')) impact.revision = revision;
    }
    save(ctx, true);
    const content = buildPipelineContext(selection, ledger, coordinate());
    if (content) return { message: { customType: 'task-pipeline', content, display: false } };
  });
  pi.on('context', (event: any, ctx: any) => {
    if (!enabled() || !owns(ctx) || !task || !Array.isArray(event.messages)) return;
    // Replace the old discovery hint at every model boundary, after native
    // receipts and source changes; never accumulate obsolete next steps.
    const messages = event.messages.filter((message: any) => message.customType !== 'task-pipeline');
    let content = buildPipelineContext(selection, ledger, coordinate());
    if (content && typeof pi.getAllTools === 'function') {
      try {
        const registered = new Set(pi.getAllTools().map((tool: any) => tool.name));
        const missing = [...new Set(pendingPipelineStages(selection, ledger, coordinate()).filter(stage => stage.ready).flatMap(stage => stage.tools))].filter(name => !registered.has(name));
        if (missing.length) content = (`Missing tools here: ${missing.slice(0, 8).join(', ')}. Inspect an available equivalent or retain the specific verification gap.\n` + content).slice(0, coordinate().maxChars);
      } catch { /* Tool availability is unknown on hosts without a readable inventory. */ }
    }
    if (content) messages.push({ role: 'custom', customType: 'task-pipeline', content, display: false, timestamp: 0 });
    return { messages };
  });
  pi.on('tool_call', (event: any, ctx: any) => {
    if (!enabled() || !owns(ctx) || !task || !event.toolCallId) return;
    const key = createHash('sha256').update(JSON.stringify([event.toolName, event.input])).digest('hex');
    const deployment = event.toolName === 'seo_toolkit' && event.input?.action === 'audit'
      ? ledger.receipts.find(row => row.scope === scope && row.revision === revision && row.stageId === 'deploy-remote' && row.status === 'passed')?.source : undefined;
    calls.set(event.toolCallId, { tool: event.toolName, scope, revision, key, observation: observation?.sequence, deployment });
    if (['bash', 'bg_run'].includes(event.toolName) && event.input?.isAgent !== true) {
      ownedChecks.set(event.toolCallId, { scope, revision, key, callId: event.toolCallId, candidate: Boolean(projectCheckCommand(event.input?.command, ctx.cwd)) });
      while (ownedChecks.size > 256) ownedChecks.delete(ownedChecks.keys().next().value!);
    }
    if (calls.size > 256) calls.delete(calls.keys().next().value!);
  });
  pi.on('tool_result', (event: any, ctx: any) => {
    const call = calls.get(event.toolCallId);
    if (!enabled() || !owns(ctx) || !call || call.tool !== event.toolName) return;
    calls.delete(event.toolCallId);
    const owned = ownedChecks.get(event.toolCallId);
    if (owned?.candidate) {
      const text = (event.content ?? []).filter((row: any) => row.type === 'text').map((row: any) => row.text).join('\n');
      const handle = event.details?.task?.id ?? /\[managed bash\] Still running[^\n]*\n[^\n]*job\s+([a-f0-9]+)/i.exec(text)?.[1];
      if (typeof handle === 'string') {
        backgroundChecks.set(handle, owned);
        while (backgroundChecks.size > 256) backgroundChecks.delete(backgroundChecks.keys().next().value!);
        if (event.details?.task) rememberTerminal(event.details.task, call.observation ?? observationSequence);
      }
    }
    if (call.scope !== scope) {
      // Failure/progress belongs to the dispatching scope. Source bytes are
      // shared, so even its delayed write retires another scope's old checks.
      const changedNow = mutation(event, ctx, call).changed;
      if (changedNow) save(ctx);
      const note = observeStep(routeOf(ctx), stepOf(event, ctx, changedNow)!, ctx);
      if (note) return { content: [...(event.content ?? []), { type: 'text', text: note }] };
      return;
    }
    const before = execution.profile().tier, beforeTools = automaticNames().join('\n');
    const command = event.input?.command;
    // A background launch or a read cannot resolve failures. The native
    // project-check parser rejects status masking and shell composition.
    const text = (event.content ?? []).filter((row: any) => row.type === 'text').map((row: any) => row.text).join('\n');
    const noTests = /\bno tests? (?:found|ran|collected|to run)|\btests? (?:are )?skipped\b|\b(?:tests?|pass|passed|passing)\s*[:=]?\s*0\b|\b(?:Ran 0 tests?|0 passing)\b/i.test(text);
    const nativeExit = event.details?.execution?.exitCode ?? event.details?.exitCode ?? event.details?.exit_code;
    const incomplete = Boolean(event.details?.task?.id || event.details?.execution?.signal || event.details?.signal || /\[managed bash\] Still running/.test(text) || noTests);
    const failed = event.isError === true || typeof nativeExit === 'number' && nativeExit !== 0 || Boolean(event.details?.execution?.signal || event.details?.signal);
    const currentCall = call.revision === revision;
    const resultMutation = mutation(event, ctx, call);
    const burstAdvice = observeStep(routeOf(ctx), stepOf(event, ctx, resultMutation.changed || resultMutation.paths.length > 0)!, ctx);
    let nativeTests: any;
    if (event.toolName === 'project_tests' && !failed && ['inspect', 'assess'].includes(event.input?.action)) {
      try {
        const parsed = event.details?.projectTests ?? JSON.parse(text.slice(text.indexOf('{')));
        if (!parsed.disabled && !parsed.paused && !parsed.optedOut && parsed.revision === event.details?.revision && parsed.need === event.details?.need) nativeTests = parsed;
      } catch { /* No structured native receipt means no indexed success. */ }
    }
    const currentAssessment = nativeTests?.assessment?.revision === nativeTests?.revision ? nativeTests?.assessment : undefined;
    const nativePass = currentAssessment?.disposition === 'required' && nativeTests?.need === null
      && (nativeTests.plannedChecks?.length ? nativeTests.plannedChecks.every((row: any) => row.outcome === 'passed') : nativeTests.checks?.some((row: any) => row.revision === nativeTests.revision && row.outcome === 'passed'));
    const verified = event.isError === false && !failed && !incomplete && call.revision === revision
      && (event.toolName === 'bash' && Boolean(projectCheckCommand(command, ctx.cwd)) || Boolean(nativePass));
    execution.observe({ ok: !failed, verified, failureKey: call.key });
    if (failed && owned) owned.failedObserved = true; // Later inspections must not recount the same foreground failure.
    if (event.toolName === 'bg_status') for (const terminal of event.details?.tasks ?? []) rememberTerminal(terminal, call.observation ?? observationSequence);
    if (event.toolName === 'process') rememberTerminal(event.details?.managedJob, call.observation ?? observationSequence);
    settleTerminals();
    if (nativeTests) for (const receipt of [...(nativeTests.checks ?? []), ...(nativeTests.evidence ?? [])]) {
      if (receipt.outcome === 'failed' && receipt.revision === nativeTests.revision && nativeTests.treeComplete === true && receipt.tree === nativeTests.tree)
        observeCheckFailure(ownedChecks.get(receipt.callId));
    }
    const source = `tool:${event.toolCallId}`;
    const currentSource = (item: any) => {
      if (typeof item?.source !== 'string' || item.sourceChanged === true) return false;
      if (/^https?:\/\//i.test(item.source)) return item.revision === 'live';
      const identity = fileIdentity(ctx, item.source) ?? fileIdentity(ctx, item.source.replace(/[?#].*$/, ''));
      return Boolean(identity && identity.hash.slice(0, 16) === item.revision);
    };
    if (call.revision === revision && ['ui_consistency', 'motion_inspect'].includes(event.toolName)) {
      const data = event.details;
      const problem = failed || data?.blocking > 0 || data?.findings?.some((finding: any) => finding?.severity === 'FAIL');
      let stage = '', observed = false;
      if (event.toolName === 'ui_consistency') {
        stage = 'ui-consistency';
        observed = data?.coverage?.complete === true && data.captures?.length >= 2 && data.captures.every((item: any) => item.ok === true && currentSource(item)) && !data.missing?.length && !data.findings?.length
          && (data.coverage.comparedRoles > 0 || data.coverage.comparedTokens > 0);
      } else {
        stage = event.input?.mode === 'scroll' ? 'ui-scroll' : 'ui-motion';
        observed = currentSource(data) && data.coverage?.complete === true && data.samples?.length >= 2 && data.reducedPass === 'checked' && !data.findings?.length
          && (stage !== 'ui-scroll' || data.mode === 'scroll' && data.coverage?.complete === true && data.coverage.persistentDocument === true && data.coverage.hasScrollRange === true);
      }
      record(stage, 'inspection', source, problem ? 'failed' : observed ? 'passed' : 'blocked');
      if (problem && !failed) execution.observe({ ok: false, failureKey: call.key });
      // These are bounded measurement receipts. Appearance and interaction
      // keep their existing independent review owners and remain open.
    }
    if (call.revision === revision && event.toolName === 'seo_toolkit' && ['inspect', 'audit'].includes(event.input?.action)) {
      const data = event.details;
      const observed = data?.coverage?.rawHtml === true && (data.sha256 || data.pages?.length > 0);
      const errors = data?.findings?.some((finding: any) => finding.severity === 'error');
      const partial = data?.coverage?.complete === false && !data?.coverage?.boundedSample || data?.coverage?.findingsTruncated || data?.coverage?.robotsKnown === false || data?.failures?.length > 0 || data?.coverage?.reason === 'deadline';
      const outcome = failed || errors ? 'failed' : !observed || partial ? 'blocked' : 'passed';
      const deployed = call.deployment && ledger.receipts.some(row => row.scope === scope && row.revision === revision && row.stageId === 'deploy-remote' && row.status === 'passed' && row.source === call.deployment);
      const origin = event.input?.canonicalOrigin;
      if (deployed && event.input?.action === 'audit' && typeof origin === 'string' && data?.origin === origin.replace(/\/$/, '') && isLiveByteVerification('http_request', { url: origin })) record('seo-live', 'live', source, outcome);
      else record('seo-raw', 'inspection', source, outcome);
    }
    if (call.revision === revision && event.toolName === 'ui_explore') {
      // Index the native owner's current, complete DOM/design matrix once.
      // coverage.complete alone does not replace its consistency, measured
      // status or required narrow/desktop coverage. Pixels stay unapproved.
      const data = event.details;
      const widths = (data?.cells ?? []).filter((cell: any) => cell.ok && cell.dom?.available).map((cell: any) => cell.width);
      const coverage = widths.some((width: number) => width <= 320) && widths.some((width: number) => width >= 1024);
      const observed = data?.consistent === true && data.status === 'measured' && data.coverage?.complete === true && coverage && currentSource(data);
      record('ui-responsive', 'inspection', source, failed || data?.status === 'fail' ? 'failed' : observed ? 'passed' : 'blocked');
    }
    if (call.revision === revision && !failed && event.toolName === 'visual_review' && event.input?.action === 'record' && event.details?.recorded) {
      // The creative owner enforces capture, revision and pixel provenance.
      record(selection.ids.includes('ui-quality') ? 'ui-pixels' : 'art-pixels', 'pixels', source, event.details.recorded.blocking ? 'blocked' : 'passed');
    }
    if (call.revision === revision && !failed && event.toolName === 'browser_session' && event.input?.action === 'verify' && event.details?.ok && event.details?.verification?.matches === true)
      record('ui-interaction', 'interaction', source);
    if (call.revision === revision && !failed && event.toolName === 'code_quality' && event.input?.operation === 'baseline') {
      const data = event.details;
      if (data?.operation === 'baseline' && data.status === 'inspected' && data.scope?.targetFiles > 0)
        record('source-quality', 'inspection', source, data.scope.truncated || data.scope.missingFocus?.length ? 'blocked' : 'passed');
    }
    if (call.revision === revision && !failed && event.toolName === 'research_toolkit' && event.input?.action === 'dossier') {
      const data = event.details;
      if (data?.operation === 'dossier' && data.counts?.claims > 0) {
        record('research-evidence', 'inspection', source, data.counts.claimsWithGaps ? 'blocked' : 'passed');
        if (selection.ids.every(id => id === 'research')) record('validation', 'inspection', source, data.counts.claimsWithGaps ? 'blocked' : 'passed');
      }
    }
    const mediaOnly = selection.ids.length > 0 && selection.ids.every(id => ['video', 'audio', 'svg-art'].includes(id));
    const inspectedSource = typeof event.details?.path === 'string' || typeof event.details?.source === 'string' || event.details?.files?.length > 0;
    if (mediaOnly && call.revision === revision && !failed && ['media_info', 'audio_analyze', 'svg_inspect'].includes(event.toolName) && inspectedSource && !event.details?.disabled) {
      record('discovery', 'inspection', source);
    }
    if (mediaOnly && call.revision === revision && !failed && ['media_pipeline', 'audio_mix', 'video_compose', 'media_edit', 'scene_render'].includes(event.toolName)) {
      const artifact = event.details?.artifact ?? event.details?.video;
      if (event.details?.decodeVerified === true && typeof artifact?.path === 'string' && artifact.bytes > 0) {
        record('implementation', 'artifact', source);
        const technicalFailure = Object.values(event.details?.automatedChecks ?? {}).some(value => value === false);
        record('validation', 'execution', source, technicalFailure ? 'failed' : 'passed');
      }
    }
    // Office documents and folder organization verify themselves; their results are the receipts.
    if (call.revision === revision && !event.isError && !event.details?.disabled && ['fs_organize', 'office_doc', 'deliverable_check'].includes(event.toolName)) {
      const details = event.details ?? {}, action = event.input?.action;
      const built = ledger.receipts.some(row => row.scope === scope && row.stageId === 'implementation' && row.status === 'passed');
      if (event.toolName === 'fs_organize') {
        if (action === 'scan' || action === 'plan') record('discovery', 'inspection', source);
        if (action === 'apply' && details.moved > 0) {
          record('discovery', 'inspection', source); record('implementation', 'artifact', source);
          record('validation', 'execution', source, details.verification?.ok === false ? 'failed' : 'passed');
        }
        if (action === 'verify' && built) record('validation', 'execution', source, details.ok === false ? 'failed' : 'passed');
      } else if (event.toolName === 'office_doc' && action === 'build') {
        record('discovery', 'inspection', source); record('implementation', 'artifact', source);
        record('validation', 'execution', source, details.verification?.status === 'fail' ? 'failed' : 'passed');
      } else {
        const rows = event.toolName === 'deliverable_check' ? details.checked ?? [] : [details];
        record('discovery', 'inspection', source);
        if (built) record('validation', 'execution', source, rows.some((row: any) => row?.status === 'fail') ? 'failed' : 'passed');
      }
    }
    if (['bash', 'bg_run'].includes(event.toolName) && call.revision === revision && projectCheckCommand(command, ctx.cwd)) {
      if (failed) record('validation', 'execution', source, 'failed');
      else if (incomplete || event.toolName === 'bg_run') record('validation', 'execution', source, 'blocked');
    }
    if (!event.isError && event.details?.available !== false && ['read', 'context_slice', 'symbol_search', 'project_report', 'module_report'].includes(event.toolName)) {
      const file = typeof event.input?.path === 'string' ? event.input.path : '';
      if (file) {
        const files = discoveredFiles.get(scope) ?? new Set<string>(); files.add(file); discoveredFiles.set(scope, files);
        inspectSource(file, ctx);
        const discovered = selectScope();
        if (discovered.fingerprint !== selection.fingerprint) { selection = discovered; save(ctx); }
      }
      record('discovery', 'inspection', source);
    }
    if (resultMutation.paths.length) {
      const files = scopeFiles.get(scope) ?? new Set<string>();
      for (const relative of resultMutation.paths) files.add(relative);
      scopeFiles.set(scope, files);
      for (const relative of resultMutation.paths) inspectSource(relative, ctx);
      selection = selectScope();
      execution.update({ changedFiles: [...files] });
      // Inspection remains relevant after the agent's own write; checks
      // and visual evidence must be collected for the new source bytes.
      const inspected = ledger.receipts.findLast(row => row.scope === scope && row.stageId === 'discovery' && row.status === 'passed');
      if (inspected) record('discovery', 'inspection', inspected.source);
      // The agent's own edit can retain the previously reviewed owner set.
      // An external/stale edit or a newly affected owner needs fresh impact
      // discovery; execution and visual receipts always bind to new bytes.
      const impact = impactCoverage.get(scope);
      const priorImpact = ledger.receipts.some(row => row.scope === scope && row.revision === call.revision && row.stageId === 'source-impact' && row.status === 'passed');
      if (currentCall && resultMutation.complete && impact?.revision === call.revision && priorImpact && resultMutation.paths.every(file => impact.files.has(file))) {
        if (record('source-impact', 'inspection', impact.source, 'passed', impact.summary)) impact.revision = revision;
      }
      record('implementation', 'artifact', source); save(ctx);
    } else if (resultMutation.changed) save(ctx);
    if (verified && call.revision === revision) record('validation', 'execution', source);
    if (nativeTests && call.revision === revision) {
      // The native API owns both execution receipts and scoped exceptions.
      // Merely inspecting a setup, or recording blocked, is never a pass.
      if (currentAssessment?.disposition === 'blocked') record('validation', 'assessment', source, 'blocked');
      else if (nativeTests.need === 'failed') {
        const receipt = [...(nativeTests.checks ?? []), ...(nativeTests.evidence ?? [])].findLast(row => row.outcome === 'failed');
        record('validation', 'execution', receipt?.callId ? `tool:${receipt.callId}` : `project_tests:${nativeTests.revision}:failed`, 'failed');
      }
      else if (nativeTests.need) record('validation', 'assessment', source, 'blocked');
      else if (currentAssessment?.disposition === 'not_needed') record('validation', 'assessment', source);
    }
    if (!event.isError && event.toolName === 'todo' && Array.isArray(event.details?.tasks)) {
      const activeRows = event.details.tasks.filter((row: any) => row.status === 'in_progress' && typeof (row.subject ?? row.title) === 'string');
      const target = event.input?.id ?? event.details?.params?.id;
      const active = activeRows.find((row: any) => row.id === target) ?? activeRows.find((row: any) => `todo:${row.id}` === scope) ?? activeRows[0];
      if (active) {
        const key = `todo:${active.id}`;
        const title = active.subject ?? active.title;
        const replaced = scopes.get(key)?.task !== title;
        if (!execution.select(key) || replaced) execution.begin({ task: title, scope: 'todo', noDelegation: parentNoDelegation }, key);
        if (scope !== key || replaced) {
          scopes.set(scope, { selection, revision, task: scopes.get(scope)?.task ?? task }); scope = key;
          const previous = scopes.get(key); revision = contentRevision(title);
          scopes.set(key, { selection: previous?.selection ?? selection, revision, task: title });
          selection = !replaced && previous ? previous.selection : selectScope(); scopes.set(key, { selection, revision, task: title }); save(ctx);
        }
      } else if (scope !== 'task') {
        scopes.set(scope, { selection, revision, task: scopes.get(scope)?.task ?? task }); scope = 'task'; execution.select(scope);
        const previous = scopes.get(scope); if (previous) selection = previous.selection; revision = contentRevision(task); save(ctx);
      }
    }
    if (before !== execution.profile().tier || beforeTools !== automaticNames().join('\n')) save(ctx);
    const notes = [burstAdvice, event.isError && execution.profile().failures === 2 ? '[adaptive] Two unresolved failures raised support. Inspect the actual error and current source/state before retrying; preserve completed work. A passing substantive check can lower support again.' : undefined].filter((note): note is string => Boolean(note));
    if (notes.length) return { content: [...(event.content ?? []), ...notes.map(text => ({ type: 'text', text }))] };
  });
  pi.registerTool({
    name: 'task_pipeline', label: 'Task pipeline',
    description: 'Inspect automatic workflow selection and execution policy; select a subtask scope or index existing evidence by source revision. Does not run tools, tests, training or deployments. Receipts are evidence references, not independent approval.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union(['status', 'scope', 'record'].map(value => Type.Literal(value)))),
      task: Type.Optional(Type.String({ maxLength: 4000 })),
      scope: Type.Optional(Type.String({ maxLength: 160 })),
      stageId: Type.Optional(Type.String({ maxLength: 80 })),
      status: Type.Optional(Type.Union(['passed', 'failed', 'blocked'].map(value => Type.Literal(value)))),
      evidenceKind: Type.Optional(Type.Union(PIPELINE_EVIDENCE_KINDS.map(value => Type.Literal(value)))),
      source: Type.Optional(Type.String({ maxLength: 2048 })),
      summary: Type.Optional(Type.String({ maxLength: 1200 })),
    }),
    async execute(_id: string, input: any, signal: AbortSignal, _update: any, ctx: any) {
      signal?.throwIfAborted();
      if (!enabled() || !owns(ctx) || !task) throw Error('No active adaptive task');
      if (input.action === 'scope') {
        if (!input.task?.trim() || !input.scope?.trim()) throw Error('Provide a subtask scope and task');
        scopes.set(scope, { selection, revision, task: scopes.get(scope)?.task ?? task }); scope = `subtask:${input.scope}`;
        if (!execution.select(scope) || scopes.get(scope)?.task !== input.task) execution.begin({ task: input.task, scope: 'subtask', noDelegation: parentNoDelegation }, scope);
        const previous = scopes.get(scope); revision = contentRevision(input.task);
        scopes.set(scope, { selection: previous?.selection ?? selection, revision, task: input.task });
        selection = previous?.task === input.task ? previous.selection : selectScope(); scopes.set(scope, { selection, revision, task: input.task }); save(ctx);
      }
      if (input.action === 'record') {
        recordPipelineEvidence(ledger, { ...coordinate(), stageId: input.stageId, status: input.status, evidenceKind: input.evidenceKind, source: input.source, summary: input.summary }, selection);
        if (input.stageId === 'source-impact') {
          if (input.status === 'passed') {
            const files = new Set(scopedFiles().flatMap(raw => { const identity = fileIdentity(ctx, raw); return identity ? [identity.relative] : []; }));
            impactCoverage.set(scope, { revision, files, source: input.source, summary: input.summary });
          } else impactCoverage.delete(scope);
        }
        save(ctx);
      }
      let registered: Set<string> | undefined, active: Set<string> | undefined;
      try { if (typeof pi.getAllTools === 'function') registered = new Set(pi.getAllTools().map((tool: any) => tool.name)); if (typeof pi.getActiveTools === 'function') active = new Set(pi.getActiveTools()); } catch { /* Unavailable means unknown, not configured. */ }
      const details = { scope, revision, execution: execution.profile(), pipelines: selection.ids, pending: pendingPipelineStages(selection, ledger, coordinate()), evidence: ledger.receipts.filter(row => row.scope === scope && row.revision === revision),
        decisions: { task: routingTask().slice(-4000), automaticTools: automaticNames(), sourceFiles: scopedFiles().slice(-64) },
        toolAvailability: selection.tools.filter(name => !pipelineToolExcluded(constraintsTask(), name) && !pipelineToolExcluded(inheritedConstraints() ?? '', name)).map(name => ({ name, registered: registered ? registered.has(name) : null, active: active ? active.has(name) : null })) };
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });
}

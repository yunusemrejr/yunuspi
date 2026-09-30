/** Session-owned execution state. Routing and schedulers read this live getter;
 * pipeline receipts index existing evidence and never execute a second test. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { createAdaptiveExecutionController, registerAdaptiveExecution, adaptiveExecutionEnabled, createAdaptiveThinkingController } from './lib/adaptive-execution.ts';
import { selectTaskPipelines, automaticPipelineTools, createPipelineLedger, recordPipelineEvidence, pendingPipelineStages, buildPipelineContext, type PipelineSelection } from './lib/task-pipelines.ts';
import { projectCheckCommand } from './lib/project-tests.ts';

export default function adaptiveWorkflows(pi: any) {
  const execution = createAdaptiveExecutionController();
  const thinking = createAdaptiveThinkingController(pi);
  let dispose: (() => void) | undefined, owner: any, ownerFile = '', ownerCwd = '', ownerId = '', epoch = 0;
  let task = '', scope = 'task', revision = 'initial', selection = selectTaskPipelines({ prompt: '' });
  let ledger = createPipelineLedger(), pendingInput: { text: string; id: string; signal?: AbortSignal } | undefined, acceptedId = '';
  const scopes = new Map<string, { selection: PipelineSelection; revision: string; task: string }>();
  let parentNoDelegation = false;
  type Observation = { sequence: number; revision: number; tree?: string; complete: boolean };
  const changed = new Map<string, string>(), calls = new Map<string, { scope: string; revision: string; key: string; observation?: number }>();
  type OwnedCheck = { scope: string; revision: string; key: string; callId: string; candidate: boolean; failedObserved?: boolean };
  const ownedChecks = new Map<string, OwnedCheck>(), backgroundChecks = new Map<string, OwnedCheck>();
  const pendingTerminals = new Map<string, { task: any; after: number }>();
  const scopeFiles = new Map<string, Set<string>>();
  const discoveredFiles = new Map<string, Set<string>>();
  let sourceRevision = 'initial';
  let sourceSeed = '', nativeIdentity = '', uncertainSource = '', observation: Observation | undefined, observationSequence = 0;
  const enabled = () => adaptiveExecutionEnabled();
  const contentRevision = (text: string) => createHash('sha256').update(`${sourceRevision}:${text}`).digest('hex').slice(0, 20);
  const reset = (_event?: any, ctx?: any) => {
    thinking.reset(ctx);
    dispose?.(); dispose = undefined; execution.reset(); owner = ctx?.sessionManager;
    ownerFile = owner?.getSessionFile?.() ?? ''; task = ''; scope = 'task'; revision = 'initial';
    ownerCwd = ctx?.cwd ?? ''; ownerId = owner?.getSessionId?.() ?? '';
    sourceSeed = ''; nativeIdentity = ''; uncertainSource = ''; observation = undefined; observationSequence = 0;
    selection = selectTaskPipelines({ prompt: '' }); ledger = createPipelineLedger(); scopes.clear(); changed.clear(); scopeFiles.clear(); discoveredFiles.clear(); calls.clear(); ownedChecks.clear(); backgroundChecks.clear(); pendingTerminals.clear(); pendingInput = undefined; acceptedId = ''; parentNoDelegation = false;
    if (owner && enabled()) dispose = registerAdaptiveExecution(ctx, () => execution.profile());
  };
  for (const event of ['session_start', 'session_switch', 'session_tree', 'session_fork']) pi.on(event, reset);
  pi.on('session_shutdown', () => reset());
  pi.on('thinking_level_select', (event: any, ctx: any) => thinking.onSelection(event, ctx));
  pi.on('agent_settled', (_event: any, ctx: any) => thinking.restore(ctx));
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
    return { paths: affected, changed: revision !== before };
  };
  const automaticNames = () => automaticPipelineTools(selection, { prompt: scopes.get(scope)?.task ?? task, profile: execution.profile(), files: [...(scopeFiles.get(scope) ?? []), ...(discoveredFiles.get(scope) ?? [])] });
  const save = (ctx: any, beforeStart = false) => {
    thinking.update(execution.profile(), ctx);
    scopes.set(scope, { selection, revision, task: scopes.get(scope)?.task ?? task });
    try { pi.appendEntry?.('adaptive-execution-v1', { scope, revision, ...execution.profile(), pipelines: selection.ids }); } catch { /* diagnostics */ }
    try { pi.events?.emit?.('adaptive-pipeline-selection', { sessionManager: ctx.sessionManager, beforeStart, names: automaticNames() }); } catch { /* optional discovery host */ }
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
    task = next?.text ?? String(event.prompt ?? ''); acceptedId = next?.id ?? `task-${++epoch}`;
    scope = 'task'; sourceSeed = acceptedId; nativeIdentity = observation ? `${observation.revision}:${observation.tree ?? ''}` : ''; uncertainSource = '';
    changed.clear(); scopeFiles.clear(); discoveredFiles.clear(); scopes.clear(); calls.clear(); ownedChecks.clear(); backgroundChecks.clear(); pendingTerminals.clear(); ledger = createPipelineLedger();
    refreshRevision();
    execution.begin({ task, scope: 'task' }, scope);
    parentNoDelegation = execution.profile().constraints.noDelegation;
    selection = selectTaskPipelines({ prompt: task }); save(ctx, true);
    const content = buildPipelineContext(selection, ledger, coordinate());
    if (content) return { message: { customType: 'task-pipeline', content, display: false } };
  });
  pi.on('tool_call', (event: any, ctx: any) => {
    if (!enabled() || !owns(ctx) || !task || !event.toolCallId) return;
    const key = createHash('sha256').update(JSON.stringify([event.toolName, event.input])).digest('hex');
    calls.set(event.toolCallId, { scope, revision, key, observation: observation?.sequence });
    if (['bash', 'bg_run'].includes(event.toolName) && event.input?.isAgent !== true) {
      ownedChecks.set(event.toolCallId, { scope, revision, key, callId: event.toolCallId, candidate: Boolean(projectCheckCommand(event.input?.command, ctx.cwd)) });
      while (ownedChecks.size > 256) ownedChecks.delete(ownedChecks.keys().next().value!);
    }
    if (calls.size > 256) calls.delete(calls.keys().next().value!);
  });
  pi.on('tool_result', (event: any, ctx: any) => {
    const call = calls.get(event.toolCallId); calls.delete(event.toolCallId);
    if (!enabled() || !owns(ctx) || !call) return;
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
      if (mutation(event, ctx, call).changed) save(ctx);
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
    const resultMutation = mutation(event, ctx, call);
    let nativeTests: any;
    if (event.toolName === 'project_tests' && !failed && ['inspect', 'assess'].includes(event.input?.action)) {
      try {
        const parsed = JSON.parse(text.slice(text.indexOf('{')));
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
    if (['bash', 'bg_run'].includes(event.toolName) && call.revision === revision && projectCheckCommand(command, ctx.cwd)) {
      if (failed) record('validation', 'execution', source, 'failed');
      else if (incomplete || event.toolName === 'bg_run') record('validation', 'execution', source, 'blocked');
    }
    if (!event.isError && ['read', 'context_slice', 'symbol_search', 'project_report'].includes(event.toolName)) {
      const file = typeof event.input?.path === 'string' ? event.input.path : '';
      if (file) {
        const files = discoveredFiles.get(scope) ?? new Set<string>(); files.add(file); discoveredFiles.set(scope, files);
        const discovered = selectTaskPipelines({ prompt: scopes.get(scope)?.task ?? task, files: [...files, ...(scopeFiles.get(scope) ?? [])] });
        if (discovered.fingerprint !== selection.fingerprint) { selection = discovered; save(ctx); }
      }
      record('discovery', 'inspection', source);
    }
    if (resultMutation.paths.length) {
      const files = scopeFiles.get(scope) ?? new Set<string>();
      for (const relative of resultMutation.paths) files.add(relative);
      scopeFiles.set(scope, files);
      selection = selectTaskPipelines({ prompt: scopes.get(scope)?.task ?? task, files: [...files, ...(discoveredFiles.get(scope) ?? [])] });
      execution.update({ changedFiles: [...files] });
      // Inspection remains relevant after the agent's own write; checks
      // and visual evidence must be collected for the new source bytes.
      const inspected = ledger.receipts.findLast(row => row.scope === scope && row.stageId === 'discovery' && row.status === 'passed');
      if (inspected) record('discovery', 'inspection', inspected.source);
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
          selection = !replaced && previous ? previous.selection : selectTaskPipelines({ prompt: title }); scopes.set(key, { selection, revision, task: title }); save(ctx);
        }
      } else if (scope !== 'task') {
        scopes.set(scope, { selection, revision, task: scopes.get(scope)?.task ?? task }); scope = 'task'; execution.select(scope);
        const previous = scopes.get(scope); if (previous) selection = previous.selection; revision = contentRevision(task); save(ctx);
      }
    }
    if (before !== execution.profile().tier || beforeTools !== automaticNames().join('\n')) save(ctx);
    if (event.isError && execution.profile().failures === 2) return { content: [...(event.content ?? []), { type: 'text', text: '[adaptive] Two unresolved failures raised support. Inspect the actual error and current source/state before retrying; preserve completed work. A passing substantive check can lower support again.' }] };
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
      evidenceKind: Type.Optional(Type.Union(['inspection', 'artifact', 'execution', 'assessment', 'pixels', 'interaction', 'evaluation', 'remote', 'live'].map(value => Type.Literal(value)))),
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
        selection = previous?.task === input.task ? previous.selection : selectTaskPipelines({ prompt: input.task }); scopes.set(scope, { selection, revision, task: input.task }); save(ctx);
      }
      if (input.action === 'record') {
        recordPipelineEvidence(ledger, { ...coordinate(), stageId: input.stageId, status: input.status, evidenceKind: input.evidenceKind, source: input.source, summary: input.summary }, selection);
      }
      const details = { scope, revision, execution: execution.profile(), pipelines: selection.ids, pending: pendingPipelineStages(selection, ledger, coordinate()), evidence: ledger.receipts.filter(row => row.scope === scope && row.revision === revision) };
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });
}

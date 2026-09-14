/** The checkpoints owner's project-test lifecycle. Models decide coverage and
 * write tests; the harness owns change revisions, execution receipts, stale
 * evidence and bounded continuation. There is no autonomous script executor. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { projectTestFacts, isProjectTestSource } from '../../scripts/workspace-facts.mjs';
import { tokenizeSimple } from './bash-routing.ts';
import { registerContinuationSource } from './continuation-notice.ts';

const ENTRY = 'project-test-checkpoint-v1';
const MAX_FOLLOWUPS = 2;
type Check = { key: string; label: string; revision: number; outcome: 'passed' | 'failed' | 'unknown' | 'running'; callId: string; handle?: string };
type Assessment = { revision: number; disposition: 'required' | 'not_needed' | 'blocked'; reason: string; checks: { key: string; label: string }[] };
type State = { root: string; revision: number; changed: string[]; assessment?: Assessment; checks: Check[]; followups: number; paused: boolean; optedOut: boolean };
const fresh = (root = ''): State => ({ root, revision: 0, changed: [], checks: [], followups: 0, paused: false, optedOut: false });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const textOf = (content: any) => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text ?? '').join('\n') : '';

/** A check receipt must describe the command that actually ran. Reject shell
 * composition, expansion and status masking; an echo of a runner is not a run.
 * Explicit plans support arbitrary project runners, still as simple commands. */
export function projectCheckCommand(command: unknown, cwd: string, declared = false) {
  if (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[$`\r\n]/.test(command)) return null;
  let directory = path.resolve(cwd), bodyCommand = command.trim();
  const parts = command.split('&&');
  if (parts.length === 2) {
    const prefix = tokenizeSimple(parts[0].trim());
    if (prefix?.length !== 2 || prefix[0] !== 'cd') return null;
    directory = path.resolve(cwd, prefix[1]); bodyCommand = parts[1].trim();
    if (path.relative(cwd, directory).startsWith('..')) return null;
  }
  const tokens = tokenizeSimple(bodyCommand);
  if (!tokens?.length || tokens.some(t => /^(?:--watch(?:All)?(?:=true)?|-w|--help|-h|--version|--listTests|--collect-only|--list(?:-tests)?|-list|--passWithNoTests|--dry-run|--no-run|-DskipTests(?:=true)?|-Dmaven\.test\.skip(?:=true)?)$/.test(t))) return null;
  const executable = path.basename(tokens[0]);
  if (/^(?:echo|printf|true|false|cat|sh|bash|zsh|eval|env|sudo)$/.test(executable)) return null;
  const body = tokens.slice(1).join(' ');
  const phpScript = tokens[tokens[1] === '-f' ? 2 : 1] ?? '';
  const phpTests = /^php(?:\d+(?:\.\d+)*)?$/.test(executable) && !phpScript.startsWith('-')
    && /\.php$/i.test(phpScript) && /(?:^|[/_.-])(?:tests?|spec)(?:[/_.-]|$)/i.test(phpScript);
  const runner = /^(?:pytest|vitest|jest|mocha|ava|phpunit|rspec)$/.test(executable)
    || phpTests
    || /^(?:npm|pnpm|yarn|bun)$/.test(executable) && /^(?:(?:run|exec) )?(?:test(?::[\w.-]+)?|t|vitest|jest)(?: |$)/.test(body)
    || executable === 'npx' && /^(?:--no-install )?(?:vitest|jest|mocha)(?: |$)/.test(body)
    || /^(?:python\d?(?:\.\d+)?)$/.test(executable) && /^-m (?:pytest|unittest)(?: |$)/.test(body)
    || /^(?:cargo|go|dotnet|mvn|gradle|gradlew|swift)$/.test(executable) && /^test(?: |$)/.test(body)
    || /^node(?:js)?$/.test(executable) && (tokens.includes('--test') || tokens.slice(1).some(t => /(?:^|\/)[^/]*(?:test|spec)[^/]*\.[cm]?[jt]s$/.test(t))) && !tokens.some(t => ['-e', '--eval', '-p', '--print', '--check', '-c'].includes(t));
  if (!runner && !declared) return null;
  return { key: digest(JSON.stringify([directory, tokens])), label: `${executable} check` };
}

export function projectTestNeed(state: State): string | null {
  if (!state.changed.length || state.paused || state.optedOut) return null;
  const a = state.assessment;
  if (!a || a.revision !== state.revision) return 'assessment';
  if (a.disposition !== 'required') return null;
  const checks = a.checks.length ? a.checks.map(p => [...state.checks].reverse().find(c => c.key === p.key && c.revision === state.revision))
    : state.checks.filter(c => c.revision === state.revision);
  if (checks.some(c => c?.outcome === 'running')) return 'running';
  if (checks.some(c => c?.outcome === 'failed')) return 'failed';
  if (!checks.length || checks.some(c => !c || c.outcome !== 'passed')) return 'missing';
  return null;
}

export function userSkipsProjectTests(input: string): boolean {
  const prose = input.replace(/```[\s\S]*?```/g, '').split('\n').filter(line => !/^\s*>/.test(line)).join('\n')
    .replace(/\b(?:do not|don't|dont|never)\s+(?:skip|omit)\s+(?:unit\s+)?tests?\b/gi, '');
  const matches = prose.matchAll(/\b(?:do not|don't|dont|never)\s+(?:(?:write|add|create|run|execute|update)\s*(?:,|or|and)?\s*)+(?:any\s+)?(?:unit\s+)?tests?\b|\b(?:skip|omit)\s+(?:all\s+|the\s+|unit\s+)?tests?\b|\bno (?:unit )?tests? (?:please|needed|required)\b/gi);
  // Scoped exclusions remain the model's instruction to apply, not a global
  // opt-out (e.g. "do not run tests in production" or "skip tests for docs").
  return [...matches].some(match => !/^\s+(?:for|in|on|under|inside|against|of|that|which)\b/i.test(prose.slice(match.index! + match[0].length)));
}

export function createProjectTestLifecycle(pi: any, options: { shadow?: boolean; discover?: typeof projectTestFacts; onFacts?: (facts: any, observeChanges: boolean) => void } = {}) {
  let state = fresh(), facts: any, baseline: Record<string, string> | undefined, epoch = 0, active = true;
  let pauseReason: 'error' | 'stop' | 'reload' | undefined;
  let scanTail = Promise.resolve(), notedRevision = -1;
  const starts = new Map<string, { revision: number; check: { key: string; label: string }; epoch: number }>();
  const earlyTerminals = new Map<string, any>();
  const discover = options.discover ?? projectTestFacts;
  const enabled = () => (process.env.PI_PROJECT_TESTS ?? 'on').toLowerCase() !== 'off';
  const capable = () => pi.getActiveTools?.().includes('project_tests') && pi.getActiveTools?.().some((t: string) => ['bash', 'bg_run'].includes(t));
  const save = () => { try { pi.appendEntry?.(ENTRY, { ...state, changed: state.changed.slice(-128), checks: state.checks.slice(-32) }); } catch { /* history persistence is best effort */ } };
  const changed = (files: string[]) => {
    if (!files.length) return;
    state.revision++;
    state.changed = [...new Set([...state.changed, ...files])].slice(-128);
    notedRevision = -1;
    save();
  };
  const scan = async (ctx: any, observeChanges = false) => {
    if ((!enabled() && !options.onFacts) || !active || !ctx?.cwd) return;
    const ticket = epoch;
    const perform = async () => {
      if (ticket !== epoch) return;
      let next: any;
      try { next = await discover(ctx.cwd, ctx.signal); }
      catch {
        if (ticket === epoch) {
          facts = { unavailable: true, tests: [], manifests: [], scripts: [], truncated: true };
          options.onFacts?.({ ...facts, root: state.root || ctx.cwd, reviewSources: {} }, observeChanges);
        }
        return;
      }
      if (ticket !== epoch || !active) return;
      options.onFacts?.(next, observeChanges);
      if (state.root && state.root !== next.root) { state = fresh(next.root); baseline = undefined; starts.clear(); }
      state.root = next.root;
      if (baseline && (observeChanges || state.changed.length)) {
        const paths = new Set([...Object.keys(baseline), ...Object.keys(next.sources)]);
        // A truncated scan does not prove that an omitted source was deleted.
        changed([...paths].filter(file => (observeChanges || state.changed.includes(file)) && next.sources[file] !== baseline![file] && (next.sources[file] !== undefined || !next.truncated)));
      }
      baseline = next.truncated && baseline ? Object.fromEntries(Object.entries({ ...baseline, ...next.sources }).slice(-4000)) : next.sources;
      facts = next;
    };
    const run = scanTail.then(perform, perform); scanTail = run.catch(() => {}); await run;
  };
  const summary = () => ({ ...state, disabled: !enabled(), need: enabled() ? projectTestNeed(state) : null, facts: facts ? { ...facts, sources: undefined, reviewSources: undefined } : { unavailable: true },
    evidenceScope: 'Observed command exits only, not a correctness or coverage verdict. Edits invalidate earlier receipts. Scan limits and unobserved commands remain explicit.' });
  const advice = () => {
    const need = projectTestNeed(state);
    if (!need || need === 'running') return '';
    const message = need === 'assessment'
      ? 'Review the changed behavior and its unit-test coverage with project_tests({action:"inspect"}); extend the existing suite, or create a small meaningful suite when absent. Cover the regression/boundary, update obsolete expectations, and avoid tests that mirror implementation. Record the scoped decision with project_tests({action:"assess",disposition:"required",reason:"...",commands:["..."]}), or not_needed/blocked with a concrete reason when appropriate.'
      : need === 'failed'
        ? 'A planned unit-test check failed. Inspect its actual failure, repair the cause or outdated test, then rerun the focused check. Preserve unrelated/baseline failures in a blocked assessment with a reason; do not suppress tests just to obtain green output.'
        : 'Unit-test evidence is missing, unknown or older than the latest change. Inspect project_tests, run the scoped planned checks using bash/bg_run, and evaluate their actual results. Use a simple command without pipes, trailing echo, or status-masking shell composition so its test exit status is observable; cd into the project with && is supported. Reassess after changing code/tests. A readback, linter or successful echo is not a unit-test pass.';
    return `[project tests] ${state.changed.length} observed source/config change(s), revision ${state.revision}. ${message} Inspect scripts and configuration before running them; respect user scope and permissions, use existing dependencies and avoid unrelated installs. No scripts are automatically executed.`;
  };
  const receipt = (start: { revision: number; check: { key: string; label: string } }, callId: string, outcome: Check['outcome'], handle?: string) => {
    state.checks = state.checks.filter(c => !(c.key === start.check.key && c.revision === start.revision));
    state.checks.push({ ...start.check, revision: start.revision, outcome, callId, ...(handle ? { handle } : {}) });
    state.checks = state.checks.slice(-32); save();
  };
  const terminal = (task: any) => {
    if (!task?.id) return;
    const check = state.checks.find(c => c.handle === task.id && c.outcome === 'running');
    if (/^(?:running|pending|queued|starting)$/.test(task.status ?? task.state ?? '')) return;
    if (!check) {
      if (earlyTerminals.size >= 32) earlyTerminals.delete(earlyTerminals.keys().next().value!);
      earlyTerminals.set(task.id, { id: task.id, status: task.status ?? task.state, exitCode: task.exitCode, signal: task.signal });
      return;
    }
    const status = task.status ?? task.state;
    check.outcome = status === 'completed' && task.exitCode === 0 && !task.signal ? 'passed'
      : ['failed', 'killed', 'timed_out'].includes(status) || typeof task.exitCode === 'number' && task.exitCode !== 0 ? 'failed' : 'unknown';
    save();
  };
  const api = {
    async restore(ctx: any) {
      epoch++; active = true; state = fresh(); pauseReason = undefined; facts = undefined; baseline = undefined; notedRevision = -1; starts.clear(); earlyTerminals.clear();
      // The session branch remains the only durable owner. Restored receipts
      // are stale until checked again; a reload never wakes work on its own.
      const entry = ctx?.sessionManager?.getBranch?.().findLast((e: any) => e.type === 'custom' && e.customType === ENTRY);
      const data = entry?.data;
      if (data?.root === path.resolve(ctx?.cwd ?? '') && Number.isSafeInteger(data.revision) && Array.isArray(data.changed)) {
        state = { ...fresh(data.root), revision: data.revision + 1, changed: data.changed.filter((p: any) => typeof p === 'string').slice(-128),
          optedOut: data.optedOut === true, followups: Math.min(MAX_FOLLOWUPS, Math.max(0, Number(data.followups) || 0)), paused: true };
        pauseReason = 'reload';
      }
      await scan(ctx);
    },
    input(event: any) {
      if (event.source === 'extension') return;
      // A completed scope is retained in branch history, not carried into an
      // unrelated later question as an outstanding test obligation.
      if (!state.paused && !state.optedOut && state.assessment && !projectTestNeed(state)) {
        // Revisions restart in a fresh scope. Retire outstanding receipts so
        // a late old check cannot collide with the new scope's revision.
        epoch++; starts.clear(); earlyTerminals.clear();
        const optedOut = state.optedOut; state = fresh(state.root); state.optedOut = optedOut;
      }
      state.paused = false; pauseReason = undefined; state.followups = 0; notedRevision = -1;
      if (typeof event.text === 'string') {
        if (userSkipsProjectTests(event.text) || /^\s*(?:please )?(?:review only|read[ -]only(?: review)?)(?:,? (?:do not|don't) (?:edit|modify|change)(?: (?:any )?files)?)?[.!]?\s*$/i.test(event.text)) state.optedOut = true;
        else if (/\b(?:write|add|create|run|update|enable|resume)\b.{0,40}\btests?\b/i.test(event.text)) state.optedOut = false;
      }
      save();
    },
    async start(ctx: any) { await scan(ctx); },
    async call(event: any, ctx: any) {
      if (!enabled() || !['bash', 'bg_run'].includes(event.toolName) || event.input?.isAgent === true) return;
      await scan(ctx);
      const candidate = projectCheckCommand(event.input?.command, ctx.cwd, true);
      const check = candidate && (state.assessment?.checks.some(c => c.key === candidate.key) ? candidate : projectCheckCommand(event.input?.command, ctx.cwd));
      if (check) {
        if (starts.size >= 64) starts.delete(starts.keys().next().value!);
        starts.set(event.toolCallId, { revision: state.revision, check, epoch });
      }
    },
    async result(event: any, ctx: any) {
      if ((!enabled() && !options.onFacts) || !active) return;
      const ticket = epoch;
      const start = starts.get(event.toolCallId); starts.delete(event.toolCallId);
      if (['write', 'edit', 'bulk_edit', 'bash', 'bg_run'].includes(event.toolName)) {
        const before = state.revision;
        await scan(ctx, true);
        if (ticket !== epoch || !active) return;
        // Successful native receipts cover paths beyond the bounded scan.
        const raw = event.details?.fileMutation?.resolved ?? event.input?.path;
        if (['write', 'edit'].includes(event.toolName) && (!event.isError || event.details?.fileMutation) && typeof raw === 'string') {
          const relative = path.relative(state.root || ctx.cwd, path.resolve(ctx.cwd, raw));
          if (!relative.startsWith('../') && !path.isAbsolute(relative) && isProjectTestSource(relative) && (before === state.revision || !state.changed.includes(relative))) changed([relative]);
        }
      }
      if (start && start.epoch === epoch) {
        const text = textOf(event.content);
        const task = event.details?.task;
        const detached = /\[managed bash\] Still running[^\n]*\n[^\n]*job\s+([a-f0-9]+)/i.exec(text);
        if (task?.id) { receipt(start, event.toolCallId, 'running', task.id); terminal(earlyTerminals.get(task.id) ?? task); earlyTerminals.delete(task.id); }
        else if (/\[managed bash\] Still running/.test(text)) {
          const handle = detached?.[1] ?? /(?:job|id)[: ]+([a-f0-9]{8})\b/i.exec(text)?.[1];
          receipt(start, event.toolCallId, handle ? 'running' : 'unknown', handle);
        } else {
          const noTests = /\bno tests? (?:found|ran|collected|to run)|\btests? (?:are )?skipped\b|\b(?:tests?|pass|passed|passing)\s*[:=]?\s*0\b|\b(?:Ran 0 tests?|0 passing)\b/i.test(text);
          const exit = event.details?.exitCode ?? event.details?.exit_code;
          const failed = event.isError || typeof exit === 'number' && exit !== 0 || !!event.details?.signal;
          receipt(start, event.toolCallId, failed ? 'failed' : noTests || facts?.unavailable || event.isError !== false ? 'unknown' : 'passed');
        }
      }
      if (event.toolName === 'process') { await scan(ctx); terminal(event.details?.managedJob); }
      if (event.toolName === 'bg_status') { await scan(ctx); for (const task of event.details?.tasks ?? []) terminal(task); }
    },
    async message(event: any, ctx: any) {
      const message = event.message;
      if (message?.role === 'assistant' && ['aborted', 'error'].includes(message.stopReason)) {
        // A provider may recover in the same user turn. Escape/Stop remains
        // authoritative even if a later completion arrives after cancellation.
        if (pauseReason !== 'stop') pauseReason = message.stopReason === 'aborted' ? 'stop' : 'error';
        state.paused = true; starts.clear(); save();
      } else if (message?.role === 'assistant' && ['stop', 'toolUse', 'length'].includes(message.stopReason) && pauseReason === 'error') {
        pauseReason = undefined; state.paused = false; save();
      }
      if (message?.customType === 'background-task-notification') { await scan(ctx); terminal(message.details); }
    },
    notice() {
      if (!enabled() || !active || options.shadow || !capable() || notedRevision === state.revision) return '';
      const content = advice(); if (content) notedRevision = state.revision; return content;
    },
    async settled(_event: any, ctx: any) {
      if (!enabled() || !active || options.shadow || state.paused || state.optedOut || ctx?.signal?.aborted || !capable() || ctx?.isIdle?.() !== true) return;
      const ticket = epoch;
      await scan(ctx);
      if (ticket !== epoch || !active || !enabled() || !capable() || state.paused || state.optedOut || ctx?.signal?.aborted || state.followups >= MAX_FOLLOWUPS || ctx?.hasPendingMessages?.()) return;
      const content = advice(); if (!content) return;
      // Count only successful delivery, and never replenish on extension turns.
      try { pi.sendMessage({ customType: 'project-test-followup', content: `${content} Automatic follow-up ${state.followups + 1}/${MAX_FOLLOWUPS}; if verification cannot be completed, record the concrete blocker and report the remaining gap.`, display: false }, { deliverAs: 'followUp', triggerTurn: true }); state.followups++; save(); }
      catch { /* failed delivery may retry at the next native settled event */ }
    },
    shutdown() { active = false; epoch++; starts.clear(); earlyTerminals.clear(); },
    snapshot: summary,
  };
  registerContinuationSource({ name: 'project tests', pending: () => enabled() && active && !options.shadow && capable() && state.followups < MAX_FOLLOWUPS && advice() ? ['review pending unit-test coverage and current execution evidence'] : [] });
  pi.registerTool({
    name: 'project_tests', label: 'Project Test Checkpoint',
    description: 'Inspect bounded local test setup, observed code changes and actual test execution receipts; assess which meaningful unit tests to add/update and which commands cover the change. No project scripts are executed by this tool. disposition required keeps a bounded verification follow-up pending until planned commands pass after the latest edit; not_needed or blocked requires a concrete reason. Outcomes come only from observed bash/bg_run/process results. Reassess after edits; never report coverage solely from exit zero.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('inspect'), Type.Literal('assess')]),
      disposition: Type.Optional(Type.Union([Type.Literal('required'), Type.Literal('not_needed'), Type.Literal('blocked')])),
      reason: Type.Optional(Type.String({ minLength: 12, maxLength: 1200 })),
      commands: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 8 })) }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const ticket = epoch;
      signal?.throwIfAborted(); await scan(ctx); signal?.throwIfAborted();
      if (ticket !== epoch || !active) throw Error('Project test checkpoint cancelled by session change or shutdown.');
      if (params.action === 'assess') {
        if (!['required', 'not_needed', 'blocked'].includes(params.disposition) || typeof params.reason !== 'string' || params.reason.trim().length < 12) throw Error('Assessment needs a disposition and concrete coverage/exception reason (at least 12 characters).');
        const checks = (params.commands ?? []).map((command: unknown) => {
          const check = projectCheckCommand(command, ctx.cwd, true);
          if (!check) throw Error('Declare a simple test command without shell composition, expansion, watch/list/help modes or status masking. Use the project working directory. No command was executed.');
          return check;
        });
        state.assessment = { revision: state.revision, disposition: params.disposition, reason: params.reason.trim().slice(0, 1200), checks };
        save();
      }
      return { content: [{ type: 'text', text: JSON.stringify(summary()) }], details: { revision: state.revision, need: projectTestNeed(state) } };
    },
  });
  return api;
}

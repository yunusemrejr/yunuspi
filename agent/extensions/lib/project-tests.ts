/** The checkpoints owner's project-test lifecycle. Models decide coverage and
 * write tests; the harness owns change revisions, execution receipts, stale
 * evidence and bounded continuation. There is no autonomous script executor. */
import * as path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { projectTestFacts, isProjectTestSource } from '../../scripts/workspace-facts.mjs';
import { tokenizeSimple } from './bash-routing.ts';
import { registerContinuationSource } from './continuation-notice.ts';
import { attributeWorkspacePath, recordWorkspaceMutation } from './workspace-write-lease.ts';

const ENTRY = 'project-test-checkpoint-v1';
/** pi-background-tasks' terminal publication channel (extension-api.ts). */
const BG_TERMINAL_CHANNEL = 'pi-background-tasks:terminal:v1';
const MAX_FOLLOWUPS = 2;
type Check = { key: string; label: string; revision: number; outcome: 'passed' | 'failed' | 'unknown' | 'running'; callId: string; handle?: string; tree?: string };
type Assessment = { revision: number; disposition: 'required' | 'not_needed' | 'blocked'; reason: string; checks: { key: string; label: string }[] };
type ChangeAttribution = { status: 'current_session' | 'another_session' | 'unattributed'; sessionId?: string; detail?: string };
type State = { root: string; revision: number; changed: string[]; attribution: Record<string, ChangeAttribution>; assessment?: Assessment; checks: Check[]; evidence: Check[]; tree?: string; treeComplete?: boolean; followups: number; paused: boolean; optedOut: boolean };
const fresh = (root = ''): State => ({ root, revision: 0, changed: [], attribution: {}, checks: [], evidence: [], followups: 0, paused: false, optedOut: false });
const NO_GIT_OBSERVED = 'content-hash observed (no Git checkout)';
const nativeAttribution = (sessionId: string, tool: string): ChangeAttribution => ({ status: 'current_session', sessionId, detail: `native ${tool} (content-hash tracked, no Git)` });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Stable identity of the observed sources: sorted path:hash entries hashed.
 * Revision counters reset across scopes and reloads; the tree hash is what
 * makes "the same code" comparable, so passed receipts stay reusable. */
const treeHash = (sources: Record<string, string> | undefined) => {
  if (!sources) return undefined;
  return digest(JSON.stringify(Object.keys(sources).sort().map(k => `${k}:${sources[k]}`)));
};
const textOf = (content: any) => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text ?? '').join('\n') : '';

/** Content identity for reload reconciliation. Scan fingerprints are stat-based
 * (size/mtime/ctime/ino), so a touch or an identical-output rebuild looks like
 * a change; only a byte difference invalidates kept receipts. Files that
 * cannot be hashed (oversized, unreadable, deleted) stay unhashable and force
 * the conservative restore path. */
const PROJECT_HASH_LIMIT = 1 << 20;
const PROJECT_HASH_FILES = 64;
function projectContentHash(root: string, file: string): string | undefined {
  try {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > PROJECT_HASH_LIMIT) return undefined;
    return `${stat.size}:${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`;
  } catch { return undefined; }
}
/** Current bytes must match the bytes the persisted receipts were earned on,
 * for every restored file, before kept state is trusted across a reload. */
function verifyRestoredTree(root: string, changed: string[], persisted: unknown): Record<string, string> | undefined {
  if (!persisted || typeof persisted !== 'object') return undefined;
  const saved = persisted as Record<string, unknown>;
  const verified: Record<string, string> = {};
  for (const file of changed) {
    const old = saved[file];
    if (typeof old !== 'string') return undefined;
    const current = projectContentHash(root, file);
    if (!current || current !== old) return undefined;
    verified[file] = current;
  }
  return verified;
}
function sanitizeRestoredAssessment(assessment: unknown, revision: number): Assessment | undefined {
  if (!assessment || typeof assessment !== 'object') return undefined;
  const candidate = assessment as any;
  if (candidate.revision !== revision || !['required', 'not_needed', 'blocked'].includes(candidate.disposition) || typeof candidate.reason !== 'string') return undefined;
  const checks = Array.isArray(candidate.checks) ? candidate.checks
    .filter((c: any) => c && typeof c.key === 'string' && typeof c.label === 'string')
    .map((c: any) => ({ key: c.key, label: c.label })) : [];
  return { revision, disposition: candidate.disposition, reason: candidate.reason.slice(0, 1200), checks };
}
function sanitizeRestoredChecks(checks: unknown, revision: number): Check[] {
  if (!Array.isArray(checks)) return [];
  const out: Check[] = [];
  for (const raw of checks.slice(-32)) {
    if (!raw || typeof raw !== 'object' || (raw as any).revision !== revision || typeof (raw as any).key !== 'string') continue;
    const candidate = raw as any;
    if (!['passed', 'failed', 'unknown', 'running'].includes(candidate.outcome)) continue;
    // In-flight checks can never be re-observed after a reload: demote
    // running to unknown and drop dead task handles instead of stranding
    // them in a state no event will ever resolve.
    out.push({ key: candidate.key, label: typeof candidate.label === 'string' ? candidate.label : 'check', revision,
      outcome: candidate.outcome === 'running' ? 'unknown' : candidate.outcome,
      callId: typeof candidate.callId === 'string' ? candidate.callId : '',
      ...(typeof candidate.tree === 'string' ? { tree: candidate.tree } : {}) });
  }
  return out;
}

function sanitizeRestoredAttribution(value: unknown, changed: string[]): Record<string, ChangeAttribution> {
	if (!value || typeof value !== 'object') return {};
	const allowed = new Set(changed);
	const result: Record<string, ChangeAttribution> = {};
	for (const [file, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!allowed.has(file) || !raw || typeof raw !== 'object') continue;
		const candidate = raw as Partial<ChangeAttribution>;
		if (!['current_session', 'another_session', 'unattributed'].includes(candidate.status ?? '')) continue;
		result[file] = {
			status: candidate.status as ChangeAttribution['status'],
			...(typeof candidate.sessionId === 'string' ? { sessionId: candidate.sessionId.slice(0, 160) } : {}),
			...(typeof candidate.detail === 'string' ? { detail: candidate.detail.slice(0, 240) } : {}),
		};
	}
	return result;
}

/** A check receipt must describe the command that actually ran. Reject shell
 * composition, expansion and status masking; an echo of a runner is not a run.
 * Explicit plans support arbitrary project runners, still as simple commands.
 * Every rejection carries a specific reason so the caller learns the rule in
 * one round trip instead of guessing across retries. */
type CheckVerdict = { check: { key: string; label: string } } | { reason: string };
function checkCommandInner(command: unknown, cwd: string, declared: boolean): CheckVerdict {
  if (typeof command !== 'string' || !command.trim()) return { reason: 'empty command' };
  if (command.length > 2000) return { reason: 'over 2000 characters' };
  if (/[$`\r\n]/.test(command)) return { reason: 'uses $expansion, backticks or newlines; pass literal values' };
  let directory = path.resolve(cwd), bodyCommand = command.trim();
  const parts = command.split('&&');
  if (parts.length === 2) {
    const prefix = tokenizeSimple(parts[0].trim());
    if (prefix?.length !== 2 || prefix[0] !== 'cd') return { reason: 'only `cd <dir> && <command>` composition is supported (no pipes, ;, || or trailing echo)' };
    directory = path.resolve(cwd, prefix[1]); bodyCommand = parts[1].trim();
    if (path.relative(cwd, directory).startsWith('..')) return { reason: 'cd escapes the project working directory' };
  }
  const commandTokens = tokenizeSimple(bodyCommand);
  if (!commandTokens?.length) {
    // A trailing parenthetical is almost always a natural-language
    // annotation ("cmd (why)"), not shell composition. Name it so the
    // caller drops it instead of guessing across retries.
    const annotation = bodyCommand.match(/\s+\([^()]*\)\s*$/);
    if (annotation) return { reason: `trailing ${JSON.stringify(annotation[0].trim()).slice(0, 80)} looks like an annotation, not part of the command; declare the bare command without it` };
    return { reason: 'shell operators (| ; > < ( ) &) are not allowed; declare one simple command' };
  }
  // Literal leading environment assignments do not mask the runner's exit.
  // Retain them in the receipt key: a pass with different environment values
  // is not evidence for the declared command. Shell expansion stays rejected.
  const firstCommand = commandTokens.findIndex(t => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  if (firstCommand < 0) return { reason: 'only environment assignments, no command' };
  const tokens = commandTokens.slice(firstCommand);
  if (tokens.some(t => /^(?:--watch(?:All)?(?:=true)?|-w|--help|-h|--version|--listTests|--collect-only|--list(?:-tests)?|-list|--passWithNoTests|--dry-run|--no-run|-DskipTests(?:=true)?|-Dmaven\.test\.skip(?:=true)?)$/.test(t))) return { reason: 'watch/list/help/dry-run/skip-test flags do not verify behavior' };
  const executable = path.basename(tokens[0]);
  if (/^(?:sh|bash|zsh|dash|ksh|fish)$/.test(executable)) {
    // A shell argv can hide composition (-c/-s), so shells are banned as
    // general runners — except two honest shapes whose exit IS the check:
    // `bash -n <file>` (syntax) and `bash <script> [args]` (run it; flags
    // after the script name are script arguments, not shell options).
    // dash/ksh/fish ride the same rule: an unbanned shell name must not
    // smuggle -c through.
    const args = tokens.slice(1);
    const syntaxCheck = args[0] === '-n' && args.length > 1 && args.slice(1).every(t => !t.startsWith('-'));
    const runScript = args.length > 0 && !args[0].startsWith('-');
    if (!syntaxCheck && !runScript)
      return { reason: '`bash` only as `bash -n <file>` (syntax check) or `bash <script> [args]`; -c/-s and shell flags can hide the real command' };
  } else if (/^(?:echo|printf|true|false|cat|eval|env|sudo)$/.test(executable)) {
    return { reason: executable === 'sudo'
      ? '`sudo` cannot be a check; declare the underlying command and record privilege limits in a blocked reason'
      : `\`${executable}\` output is not a test run` };
  }
  const body = tokens.slice(1).join(' ');
  const phpScript = tokens[tokens[1] === '-f' ? 2 : 1] ?? '';
  const phpTests = /^php(?:\d+(?:\.\d+)*)?$/.test(executable) && !phpScript.startsWith('-')
    && /\.php$/i.test(phpScript) && /(?:^|[/_.-])(?:tests?|spec)(?:[/_.-]|$)/i.test(phpScript);
  const pythonTests = /^python\d?(?:\.\d+)?$/.test(executable) && !tokens[1]?.startsWith('-')
    && /\.py$/i.test(tokens[1] ?? '') && /(?:^|[/_.-])(?:tests?|spec)(?:[/_.-]|$)/i.test(tokens[1]);
  const runner = /^(?:pytest|vitest|jest|mocha|ava|phpunit|rspec)$/.test(executable)
    || phpTests || pythonTests
    || /^(?:npm|pnpm|yarn|bun)$/.test(executable) && /^(?:(?:run|exec) )?(?:test(?::[\w.-]+)?|t|vitest|jest)(?: |$)/.test(body)
    || executable === 'npx' && /^(?:--no-install )?(?:vitest|jest|mocha)(?: |$)/.test(body)
    || /^(?:python\d?(?:\.\d+)?)$/.test(executable) && /^-m (?:pytest|unittest)(?: |$)/.test(body)
    || /^(?:cargo|go|dotnet|mvn|gradle|gradlew|swift)$/.test(executable) && /^test(?: |$)/.test(body)
    || /^node(?:js)?$/.test(executable) && (tokens.includes('--test') || tokens.slice(1).some(t => /(?:^|\/)[^/]*(?:test|spec)[^/]*\.[cm]?[jt]s$/.test(t))) && !tokens.some(t => ['-e', '--eval', '-p', '--print', '--check', '-c'].includes(t))
    // `php -l <file>` is the PHP analogue of the admitted `bash -n` syntax
    // check: without it, PHP-site sessions can never produce check receipts,
    // the need stays unresolved forever, and automatic reviews stay off.
    || /^php(?:\d+(?:\.\d+)*)?$/.test(executable) && tokens[1] === '-l' && tokens.length > 2 && tokens.slice(2).every(t => !t.startsWith('-'));
  if (!runner && !declared) return { reason: 'not a recognized test runner; declare it explicitly in an assessment plan to use it' };
  return { check: { key: digest(JSON.stringify([directory, commandTokens])), label: command.trim() } };
}

/** Output shaping that leaves the check's exit observable: a trailing
 * `2>&1`, a redirect into a file (such as build/verify/*.txt) and, when run
 * with pipefail, `| tail|head [-n] N`. Returns the bare check plus whether the
 * run needs pipefail to report the check's exit instead of the filter's. */
export function checkInvocation(command: unknown): { body: string; pipefail: boolean } | undefined {
  if (typeof command !== 'string' || /[$`\r\n;]/.test(command)) return undefined;
  let body = command.trim(), pipefail = false;
  const tail = /\s*\|\s*(?:tail|head)(?:\s+-n)?\s+-?\d+\s*$/.exec(body);
  if (tail) { body = body.slice(0, tail.index); pipefail = true; }
  let previous = '';
  while (previous !== body) {
    previous = body;
    body = body.replace(/\s+2>&1\s*$/, '').replace(/\s+(?:1|2|&)?>>?\s*[\w./@-]+\s*$/, '').trim();
  }
  return body && body !== command.trim() ? { body, pipefail } : undefined;
}
/** Read-only reconnaissance proves nothing about behavior: never evidence. */
const RECON = /^(?:ls|ll|cat|head|tail|less|more|find|fd|grep|rg|ag|wc|stat|file|du|df|tree|pwd|which|type|whereis|realpath|readlink|basename|dirname|date|whoami|uname|id|env|printenv|sed|awk|sort|uniq|cut|tr|diff|cmp|md5sum|sha256sum|jq|curl|wget|ps|pgrep|lsof|ss|netstat)$/;
function reconCommand(command: string): boolean {
  const segments = command.split('&&');
  const body = segments.length === 2 && segments[0].trim().startsWith('cd ') ? segments[1] : command;
  const tokens = body.trim().split(/\s+/).filter(t => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  const exe = path.basename(tokens[0] ?? '');
  if (exe === 'git') return /^(?:log|status|diff|show|branch|remote|rev-parse|ls-files|describe|blame)$/.test(tokens[1] ?? '');
  return RECON.test(exe);
}

export function projectCheckCommand(command: unknown, cwd: string, declared = false) {
  const verdict = checkCommandInner(command, cwd, declared);
  return 'check' in verdict ? verdict.check : null;
}

/** Specific rejection reason for a declare attempt, or null when accepted.
 * Used by assess so the error names the rule instead of restating it. */
export function projectCheckCommandReason(command: unknown, cwd: string): string | null {
  const verdict = checkCommandInner(command, cwd, true);
  return 'reason' in verdict ? verdict.reason : null;
}

function currentProjectCheck(state: State, key: string) {
  // Content identity, not the revision counter, decides reuse: a receipt
  // earned on byte-identical sources stays current after edits that were
  // reverted or touched nothing the scan hashes, so no re-run is demanded.
  return state.checks.findLast(c => c.key === key && c.revision === state.revision)
    ?? (state.treeComplete && state.tree ? [...state.checks, ...state.evidence].findLast(c => c.key === key && c.tree === state.tree && c.outcome !== 'running') : undefined);
}

export function projectTestNeed(state: State): string | null {
  if (!state.changed.length || state.paused || state.optedOut) return null;
  const a = state.assessment;
  if (!a || a.revision !== state.revision) return 'assessment';
  if (a.disposition !== 'required') return null;
  const planned = a.checks.length ? a.checks.map(p => p.key)
    : [...new Set(state.checks.filter(c => c.revision === state.revision).map(c => c.key))];
  const resolved = planned.map(key => currentProjectCheck(state, key));
  if (resolved.some(c => c?.outcome === 'running')) return 'running';
  if (resolved.some(c => c?.outcome === 'failed')) return 'failed';
  if (!resolved.length || resolved.some(c => !c || c.outcome !== 'passed')) return 'missing';
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

/** One monotonic revision for the workspace, shared by the project-test and
 * quality-review lifecycles: the same byte change is the same revision in
 * both, and one scan or native write advances it at most once. */
export interface WorkspaceRevision { readonly current: number; advance(token: string): number; seed(value: number): void }
export function createWorkspaceRevision(): WorkspaceRevision {
  let current = 0, lastToken = '';
  return {
    get current() { return current; },
    advance(token: string) { if (token && token === lastToken) return current; lastToken = token; return ++current; },
    seed(value: number) { if (Number.isSafeInteger(value) && value > current) current = value; },
  };
}

export function createProjectTestLifecycle(pi: any, options: { shadow?: boolean; discover?: typeof projectTestFacts; onFacts?: (facts: any, observeChanges: boolean, token: string) => void; revision?: WorkspaceRevision } = {}) {
  const workspaceRevision = options.revision ?? createWorkspaceRevision();
  let scanSequence = 0;
  let disposeContinuationNotice = () => {};
  let state = fresh(), facts: any, baseline: Record<string, string> | undefined, epoch = 0, active = true;
  let pauseReason: 'error' | 'stop' | 'reload' | undefined;
  let scanTail = Promise.resolve(), notedRevision = -1, delivered = '', deliveryInFlight = '', deliveryVersion = 0;
  let hashes: Record<string, string> = {};
  let lastCtx: any;
  const starts = new Map<string, { revision: number; tree?: string; check: { key: string; label: string }; epoch: number; observeOnly?: boolean }>();
  const earlyTerminals = new Map<string, any>();
  // Recent commands that LOOK like a planned check (same executable) but did
  // not match any receipt key: the usual cause is composition (trailing echo,
  // pipes) that changes the key. Surfaced in the missing-need advice so a run
  // is never silently "missing". Bounded: 3 commands × 160 chars, one revision.
  let activity = 0;
  let unmatched = { revision: -1, commands: [] as string[] };
  const firstExe = (command: string) => {
    const segments = command.split('&&');
    const body = segments.length === 2 && segments[0].trim().startsWith('cd ') ? segments[1] : command;
    const first = body.trim().split(/\s+/).find(t => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) ?? '';
    return path.basename(first);
  };
  const discover = options.discover ?? projectTestFacts;
  const enabled = () => (process.env.PI_PROJECT_TESTS ?? 'on').toLowerCase() !== 'off';
  const capable = () => pi.getActiveTools?.().includes('project_tests') && pi.getActiveTools?.().some((t: string) => ['bash', 'bg_run'].includes(t));
  const save = () => { try { pi.appendEntry?.(ENTRY, { ...state, changed: state.changed.slice(-128), attribution: Object.fromEntries(state.changed.slice(-128).map(file => [file, state.attribution[file]]).filter(([, value]) => value)), checks: state.checks.slice(-32),
    hashes: Object.fromEntries(Object.entries(hashes).filter(([file]) => state.changed.includes(file)).slice(-128)) }); } catch { /* history persistence is best effort */ } };
  const changed = (files: string[], ctx?: any, nativeWriter?: string, token = `change:${++scanSequence}`) => {
    if (!files.length) return;
    state.revision = workspaceRevision.advance(token);
    state.changed = [...new Set([...state.changed, ...files])].slice(-128);
    for (const file of files) {
      const sid = ctx?.sessionManager?.getSessionId?.() ?? '';
      const leased = attributeWorkspacePath(ctx?.cwd ?? state.root, sid, file);
      // Without Git there are no writer leases. This session's own native
      // write/edit is still known exactly; other changes are identified by
      // content hash rather than reported as a repeated failure.
      state.attribution[file] = leased.detail !== 'not a Git checkout' ? leased
        : nativeWriter && sid ? nativeAttribution(sid, nativeWriter)
        : { status: 'unattributed', detail: NO_GIT_OBSERVED };
    }
    for (const file of Object.keys(state.attribution)) if (!state.changed.includes(file)) delete state.attribution[file];
    notedRevision = -1;
    // Hash eagerly at change time: after a reload the in-memory map is gone,
    // so only hashes persisted alongside the change can prove the tree is
    // byte-identical later. Files are re-hashed on every change (a change is
    // exactly when the old hash stops being true); unhashable files stay
    // absent and force the conservative restore path.
    for (const file of files) delete hashes[file];
    let budgeted = PROJECT_HASH_FILES;
    for (const file of files) {
      if (budgeted <= 0) break;
      const digest = state.root ? projectContentHash(state.root, file) : undefined;
      if (digest) { hashes[file] = digest; budgeted--; }
    }
    save();
  };
  const scan = async (ctx: any, observeChanges = false) => {
    if ((!enabled() && !options.onFacts) || !active || !ctx?.cwd) return;
    const ticket = epoch;
    const perform = async () => {
      if (ticket !== epoch) return;
      const token = `scan:${++scanSequence}`;
      let next: any;
      try { next = await discover(ctx.cwd, ctx.signal); }
      catch {
        if (ticket === epoch) {
          facts = { unavailable: true, tests: [], manifests: [], scripts: [], truncated: true };
          options.onFacts?.({ ...facts, root: state.root || ctx.cwd, reviewSources: {} }, observeChanges, token);
        }
        return;
      }
      if (ticket !== epoch || !active) return;
      options.onFacts?.(next, observeChanges, token);
      if (state.root && state.root !== next.root) { state = fresh(next.root); baseline = undefined; hashes = {}; starts.clear(); }
      state.root = next.root;
      const nextSources = next.truncated && baseline ? Object.fromEntries(Object.entries({ ...baseline, ...next.sources }).slice(-4000)) : next.sources;
      const currentHashes: Record<string, string> = {}, identities: Record<string, string> = {};
      let remaining = PROJECT_HASH_FILES;
      for (const [file, fingerprint] of Object.entries(nextSources ?? {}) as [string, string][]) {
        const current = remaining-- > 0 ? projectContentHash(state.root, file) : undefined;
        identities[file] = current ?? fingerprint;
        if (current) currentHashes[file] = current;
      }
      if (baseline && (observeChanges || state.changed.length)) {
        const paths = new Set([...Object.keys(baseline), ...Object.keys(next.sources)]);
        // Byte identity rejects touch/identical rewrites, and also detects a
        // same-stat edit. Missing paths in a truncated scan are not deletions.
        changed([...paths].filter(file => (observeChanges || state.changed.includes(file))
          && (next.sources[file] !== undefined || !next.truncated)
          && (next.sources[file] !== baseline![file] || currentHashes[file] && hashes[file] && currentHashes[file] !== hashes[file])
          && (!currentHashes[file] || currentHashes[file] !== hashes[file])), ctx, undefined, token);
      }
      Object.assign(hashes, currentHashes);
      for (const file of Object.keys(hashes)) if (!(file in nextSources)) delete hashes[file];
      baseline = nextSources;
      // Stat identities are retained for files beyond the bounded byte scan.
      state.tree = treeHash(identities);
      state.treeComplete = next.truncated !== true;
      facts = next;
    };
    const run = scanTail.then(perform, perform); scanTail = run.catch(() => {}); await run;
  };
  /** One line per distinct attribution instead of one per changed file. */
  const attributionSummary = () => {
    const groups = new Map<string, { status: string; detail?: string; count: number; files: string[] }>();
    for (const [file, value] of Object.entries(state.attribution)) {
      const key = `${value.status}\u0000${value.detail ?? ''}`;
      const group = groups.get(key) ?? { status: value.status, ...(value.detail ? { detail: value.detail } : {}), count: 0, files: [] };
      group.count++; if (group.files.length < 3) group.files.push(file);
      groups.set(key, group);
    }
    return [...groups.values()];
  };
  const summary = () => ({ ...state, attribution: attributionSummary(), plannedChecks: (state.assessment?.checks ?? []).map(check => {
    const receipt = currentProjectCheck(state, check.key);
    return { command: check.label, outcome: receipt?.outcome ?? ([...state.checks, ...state.evidence].some(c => c.key === check.key) ? 'stale' : 'missing'), ...(receipt ? { callId: receipt.callId } : {}) };
  }), disabled: !enabled(), need: enabled() ? projectTestNeed(state) : null, facts: facts ? { ...facts, sources: undefined, reviewSources: undefined } : { unavailable: true },
    evidenceScope: 'Observed command exits only, not a correctness or coverage verdict. Edits invalidate earlier receipts. Scan limits and unobserved commands remain explicit. Receipts are bound to the observed source tree hash; reuse across scopes requires an identical tree.' });
  const advice = () => {
    const need = projectTestNeed(state);
    if (!need || need === 'running') return '';
    const message = need === 'assessment'
      ? 'Choose verification proportional to the changed behavior with project_tests({action:"inspect"}). Reuse focused existing checks and their current receipts; add or update regression coverage when it tests a changed contract or demonstrated defect. Avoid redundant runs and tests that mirror implementation. Record the scoped decision with project_tests({action:"assess",disposition:"required",reason:"...",commands:["..."]}), or not_needed/blocked with a concrete reason when appropriate.'
      : need === 'failed'
        ? 'A planned check failed. Inspect its actual failure, repair the cause or outdated test, then rerun the focused check. Preserve unrelated/baseline failures in a blocked assessment with a reason; do not suppress tests just to obtain green output.'
        : 'Planned verification evidence is missing, unknown or older than the latest change. Inspect plannedChecks in project_tests; rerun only missing, failed or stale checks using bash/bg_run, and evaluate their actual results. Use a simple command without pipes, trailing echo, or status-masking shell composition so its exit status is observable; literal environment assignments and cd into the project with && are supported. Reassess after changing code/tests. A readback, linter or successful echo does not establish behavioral test coverage.'
          + (unmatched.revision === state.revision && unmatched.commands.length
            ? ` These ran but matched no planned check (composition such as trailing echo or pipes changes the receipt key; run the planned command exactly): ${unmatched.commands.map(c => JSON.stringify(c)).join('; ')}.`
            : '');
    return `[project tests] ${state.changed.length} observed source/config change(s), revision ${state.revision}. ${message} Inspect scripts and configuration before running them; respect user scope and permissions, use existing dependencies and avoid unrelated installs. No scripts are automatically executed.`;
  };
  const receipt = (start: { revision: number; tree?: string; check: { key: string; label: string }; observeOnly?: boolean }, callId: string, outcome: Check['outcome'], handle?: string) => {
    const receipt = { ...start.check, revision: start.revision, outcome, callId, ...(start.tree ? { tree: start.tree } : {}), ...(handle ? { handle } : {}) };
    // A newer failed/running/unknown receipt must retire an older reusable
    // pass before live checks are discarded at a later scope boundary.
    state.evidence = state.evidence.filter(c => c.key !== receipt.key || Boolean(receipt.tree && c.tree !== receipt.tree));
    if (start.observeOnly) {
      // A safe command may precede the plan. Retain its observed exit for an
      // exact later declaration; unrelated commands never become planned tests.
      state.evidence = [...state.evidence, receipt].slice(-32);
    } else {
      state.checks = [...state.checks.filter(c => !(c.key === receipt.key && c.revision === receipt.revision)), receipt].slice(-32);
    }
    save();
  };
  const terminal = (task: any) => {
    if (!task?.id) return;
    const check = [...state.checks, ...state.evidence].find(c => c.handle === task.id && c.outcome === 'running');
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
  const completesOwnedCheck = (task: any) => task?.id
    && !/^(?:running|pending|queued|starting)$/.test(task.status ?? task.state ?? '')
    && [...state.checks, ...state.evidence].some(c => c.handle === task.id && c.outcome === 'running');
  // Terminal state comes from the background-task registry the moment a task
  // settles. The <background-task-notification> message is queued as a
  // follow-up and reaches message hooks only when the agent run ends, which
  // left receipts "running" for minutes while the agent re-verified by hand.
  try {
    pi.events?.on?.(BG_TERMINAL_CHANNEL, (data: any) => {
      const task = data?.task;
      if (!active || !task?.id) return;
      const epochAtArrival = epoch;
      if (completesOwnedCheck(task) && lastCtx) void scan(lastCtx, true).catch(() => {}).then(() => { if (epoch === epochAtArrival) terminal(task); });
      else terminal(task);
    });
  } catch { /* the message path below remains a fallback */ }
  const api = {
    async restore(ctx: any) {
      disposeContinuationNotice();
      disposeContinuationNotice = registerContinuationSource({ session: ctx.sessionManager, name: 'project tests', verification: () => enabled() && active && !options.shadow && capable() && !state.paused && !state.optedOut && state.changed.length && (projectTestNeed(state) || state.assessment?.disposition === 'blocked') ? [state.assessment?.disposition === 'blocked' ? `Blocked: ${state.assessment.reason}` : `Current checks unresolved (${projectTestNeed(state)}); command exits do not establish user-visible behavior.`] : [], pending: () => enabled() && active && !options.shadow && capable() && state.followups < MAX_FOLLOWUPS && advice() ? ['resolve pending verification scope and current execution evidence'] : [] });
      epoch++; deliveryVersion++; active = true; state = fresh(); hashes = {}; pauseReason = undefined; facts = undefined; baseline = undefined; notedRevision = -1; delivered = ''; deliveryInFlight = ''; starts.clear(); earlyTerminals.clear(); unmatched = { revision: -1, commands: [] };
      const ticket = epoch;
      let restoredTree: string | undefined, restoredChecks = false;
      // The session branch remains the only durable owner, and a reload
      // never wakes work on its own. Restored receipts never resume as live
      // checks, but passed tree-bound evidence survives: the next scan
      // recomputes the tree and reuse applies only on an identical hash
      // (stale-marked by mismatch, never silently honored).
      const entry = ctx?.sessionManager?.getBranch?.().findLast((e: any) => e.type === 'custom' && e.customType === ENTRY);
      const data = entry?.data;
      if (data?.root === path.resolve(ctx?.cwd ?? '') && Number.isSafeInteger(data.revision) && Array.isArray(data.changed)) {
        // Restored receipts never resume as live checks, but passed
        // tree-bound evidence survives: the next scan recomputes the tree
        // and reuse applies only on an identical hash (stale-marked by
        // mismatch, never silently honored).
        const evidence = Array.isArray(data.evidence) ? data.evidence.filter((c: any) => c && typeof c.key === 'string' && typeof c.label === 'string' && typeof c.tree === 'string' && c.outcome === 'passed' && !reconCommand(c.label)).slice(-32) : [];
        // Byte-identical tree (content hashes persisted alongside the change
        // match the current bytes for every restored file): the persisted
        // assessment and receipts still describe this exact content, so they
        // are restored at the same revision instead of resurrecting completed
        // work as pending. Any byte difference, or a branch entry from before
        // content hashes were persisted, takes the conservative path below.
        const restoredChanged = data.changed.filter((p: any) => typeof p === 'string').slice(-128);
        const verified = verifyRestoredTree(data.root, restoredChanged, (data as any)?.hashes);
        if (verified) {
          restoredChecks = true;
          restoredTree = data.treeComplete === true && typeof data.tree === 'string' ? data.tree : undefined;
          hashes = verified;
          state = { ...fresh(data.root), revision: data.revision, changed: restoredChanged, attribution: sanitizeRestoredAttribution((data as any)?.attribution, restoredChanged),
            assessment: sanitizeRestoredAssessment((data as any)?.assessment, data.revision),
            checks: sanitizeRestoredChecks((data as any)?.checks, data.revision),
            optedOut: data.optedOut === true, followups: Math.min(MAX_FOLLOWUPS, Math.max(0, Number(data.followups) || 0)), evidence, paused: true };
        } else {
          state = { ...fresh(data.root), revision: data.revision + 1, changed: restoredChanged, attribution: sanitizeRestoredAttribution((data as any)?.attribution, restoredChanged),
            optedOut: data.optedOut === true, followups: Math.min(MAX_FOLLOWUPS, Math.max(0, Number(data.followups) || 0)), evidence, paused: true };
        }
        pauseReason = 'reload';
        workspaceRevision.seed(state.revision);
      }
      await scan(ctx);
      // A dependency outside changed[] may have changed while this session was
      // down. Its old command receipts cannot verify the newly observed tree.
      if (ticket === epoch && restoredChecks && state.root === data.root && (!restoredTree || !state.treeComplete || state.tree !== restoredTree)) {
        state.revision = workspaceRevision.advance(`restore:${ticket}`); state.assessment = undefined; state.checks = []; save();
      }
    },
    input(event: any) {
      if (event.source === 'extension') return;
      // A completed scope is retained in branch history, not carried into an
      // unrelated later question as an outstanding test obligation.
      if (!state.paused && !state.optedOut && state.assessment && !projectTestNeed(state)) {
        // Revisions restart in a fresh scope. Retire live receipts but carry
        // passed tree-bound evidence forward, so the next scope reuses a
        // still-valid pass without re-running when the tree is identical — a
        // late old check still cannot collide with the new scope's revision.
        epoch++; starts.clear(); earlyTerminals.clear();
        const carry = [...state.evidence, ...state.checks.filter(c => c.outcome === 'passed' && typeof c.tree === 'string')].slice(-32);
        const optedOut = state.optedOut; const attribution = state.attribution; state = fresh(state.root); state.optedOut = optedOut; state.evidence = carry; state.attribution = attribution;
        state.revision = workspaceRevision.current;
      }
      deliveryVersion++; state.paused = false; pauseReason = undefined; state.followups = 0; notedRevision = -1; delivered = ''; deliveryInFlight = '';
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
      lastCtx = ctx;
      let candidate = projectCheckCommand(event.input?.command, ctx.cwd, true);
      // `check 2>&1 | tail -60` or `check > build/verify/out.txt 2>&1` is the
      // planned check with its output shaped. Bind it to the plan's receipt;
      // pipefail keeps the check's own exit status observable.
      const shaped = candidate ? undefined : checkInvocation(event.input?.command);
      if (shaped) {
        const bare = projectCheckCommand(shaped.body, ctx.cwd, true);
        if (bare && (state.assessment?.checks.some(c => c.key === bare.key) || projectCheckCommand(shaped.body, ctx.cwd))) {
          candidate = bare;
          if (shaped.pipefail && typeof event.input?.command === 'string' && !/^\s*set -o pipefail;/.test(event.input.command)) event.input.command = `set -o pipefail; ${event.input.command}`;
        }
      }
      const check = candidate && (state.assessment?.checks.some(c => c.key === candidate!.key) ? candidate : projectCheckCommand(shaped && candidate ? shaped.body : event.input?.command, ctx.cwd));
      if (candidate && (check || !reconCommand(candidate.label))) {
        if (starts.size >= 64) starts.delete(starts.keys().next().value!);
        starts.set(event.toolCallId, { revision: state.revision, tree: state.tree, check: candidate, epoch, observeOnly: !check });
      } else if (state.assessment?.revision === state.revision && state.assessment.disposition === 'required' && typeof event.input?.command === 'string') {
        const planned = new Set(state.assessment.checks.map(c => firstExe(c.label)));
        if (planned.has(firstExe(event.input.command))) {
          if (unmatched.revision !== state.revision) unmatched = { revision: state.revision, commands: [] };
          const raw = event.input.command.trim().slice(0, 160);
          if (raw && !unmatched.commands.includes(raw) && unmatched.commands.length < 3) unmatched.commands.push(raw);
        }
      }
    },
    async result(event: any, ctx: any) {
      if ((!enabled() && !options.onFacts) || !active) return;
      lastCtx = ctx;
      const ticket = epoch;
      const start = starts.get(event.toolCallId); starts.delete(event.toolCallId);
      const mutationPath = event.details?.fileMutation?.resolved ?? event.input?.path;
      const previousHash = typeof mutationPath === 'string' ? hashes[path.relative(state.root || ctx.cwd, path.resolve(ctx.cwd, mutationPath))] : undefined;
      if (['write', 'edit', 'bulk_edit', 'bash', 'bg_run'].includes(event.toolName)) {
        const before = state.revision;
        await scan(ctx, true);
        if (ticket !== epoch || !active) return;
        // Successful native receipts cover paths beyond the bounded scan.
        const raw = mutationPath;
        if (['write', 'edit'].includes(event.toolName) && (!event.isError || event.details?.fileMutation) && typeof raw === 'string') {
          const relative = path.relative(state.root || ctx.cwd, path.resolve(ctx.cwd, raw));
          if (!relative.startsWith('../') && !path.isAbsolute(relative) && isProjectTestSource(relative) && (before === state.revision || !state.changed.includes(relative))) {
            const current = projectContentHash(state.root || ctx.cwd, relative);
            if (!current || current !== previousHash) {
              const sid = ctx?.sessionManager?.getSessionId?.() ?? '';
              if (sid) recordWorkspaceMutation(ctx.cwd, sid, relative, event.toolName);
              changed([relative], ctx, event.toolName, `native:${event.toolCallId}`);
            }
          }
          // The scan may have observed this native write first; credit it.
          const sid = ctx?.sessionManager?.getSessionId?.() ?? '';
          if (sid && state.attribution[relative]?.detail === NO_GIT_OBSERVED) state.attribution[relative] = nativeAttribution(sid, event.toolName);
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
      if (event.toolName === 'process') { await scan(ctx, completesOwnedCheck(event.details?.managedJob)); terminal(event.details?.managedJob); }
      if (event.toolName === 'bg_status') { await scan(ctx, (event.details?.tasks ?? []).some(completesOwnedCheck)); for (const task of event.details?.tasks ?? []) terminal(task); }
    },
    async message(event: any, ctx: any) {
      activity++;
      const message = event.message;
      if (message?.role === 'assistant' && ['aborted', 'error'].includes(message.stopReason)) {
        // A provider may recover in the same user turn. Escape/Stop remains
        // authoritative even if a later completion arrives after cancellation.
        if (pauseReason !== 'stop') pauseReason = message.stopReason === 'aborted' ? 'stop' : 'error';
        state.paused = true; starts.clear(); save();
      } else if (message?.role === 'assistant' && ['stop', 'toolUse', 'length'].includes(message.stopReason) && pauseReason === 'error') {
        pauseReason = undefined; state.paused = false; save();
      }
      if (message?.customType === 'background-task-notification') { await scan(ctx, completesOwnedCheck(message.details)); terminal(message.details); }
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
      // Edge-triggered: the same reason at the same revision with no new
      // evidence never wakes the model again. The follow-up budget still
      // bounds genuinely new reasons.
      const revision = state.revision;
      const version = deliveryVersion;
      const key = `${version}:${revision}:${projectTestNeed(state)}`;
      if (delivered === key || deliveryInFlight === key) return;
      deliveryInFlight = key;
      // Idle delivery awaits the complete model turn, which can edit source
      // and re-enter settled. Reserve the budget before dispatch, not afterward.
      const priorFollowups = state.followups, priorDelivered = delivered, priorActivity = activity;
      state.followups++; delivered = key; save();
      try {
        await pi.sendMessage({ customType: 'project-test-followup', content: `${content} Automatic follow-up ${state.followups}/${MAX_FOLLOWUPS}; if verification cannot be completed, record the concrete blocker and report the remaining gap.`, display: false }, { deliverAs: 'followUp', triggerTurn: true });
      } catch {
        if (ticket === epoch && deliveryVersion === version && activity === priorActivity && delivered === key) {
          state.followups = priorFollowups; delivered = priorDelivered; save();
        }
      }
      finally { if (deliveryInFlight === key) deliveryInFlight = ''; }
    },
    shutdown() { disposeContinuationNotice(); active = false; epoch++; starts.clear(); earlyTerminals.clear(); unmatched = { revision: -1, commands: [] }; },
    snapshot: summary,
  };
  pi.registerTool({
    name: 'project_tests', label: 'Project Test Checkpoint',
    description: 'Inspect bounded local test setup, observed code changes and actual execution receipts; choose focused verification proportional to the change, reusing existing checks and current receipts. Add regression tests for changed behavior or demonstrated defects. No project scripts are executed by this tool. disposition required keeps a bounded verification follow-up pending until planned commands pass after the latest edit; not_needed or blocked requires a concrete reason. Outcomes come only from observed bash/bg_run/process results. Reassess after edits; never report coverage solely from exit zero.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('inspect'), Type.Literal('assess')]),
      disposition: Type.Optional(Type.Union([Type.Literal('required'), Type.Literal('not_needed'), Type.Literal('blocked')])),
      reason: Type.Optional(Type.String({ minLength: 12, maxLength: 1200 })),
      commands: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000, description: 'Executable command only, e.g. make test. Put explanations in reason, never append prose or parenthetical notes. Inspect returns the exact planned commands and their receipts.' }), { maxItems: 8 })) }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const ticket = epoch;
      signal?.throwIfAborted(); await scan(ctx); signal?.throwIfAborted();
      if (ticket !== epoch || !active) throw Error('Project test checkpoint cancelled by session change or shutdown.');
      if (params.action === 'assess') {
        if (!['required', 'not_needed', 'blocked'].includes(params.disposition) || typeof params.reason !== 'string' || params.reason.trim().length < 12) throw Error('Assessment needs a disposition and concrete coverage/exception reason (at least 12 characters).');
        // `a && b` of individually valid checks (optionally behind one `cd dir &&`)
        // becomes separate planned checks instead of a rejected round trip;
        // live sessions retried `node --check a && node --check b` by hand.
        const expandChain = (command: unknown): unknown[] => {
          if (typeof command !== 'string' || !command.includes('&&') || projectCheckCommand(command, ctx.cwd, true)) return [command];
          const parts = command.split('&&').map(part => part.trim()).filter(Boolean);
          const cd = tokenizeSimple(parts[0] ?? '');
          const prefix = cd?.length === 2 && cd[0] === 'cd' ? `${parts.shift()} && ` : '';
          const expanded = parts.map(part => prefix + part);
          return expanded.length > 1 && expanded.every(part => projectCheckCommand(part, ctx.cwd, true)) ? expanded : [command];
        };
        const requested = params.commands ?? [];
        const split = requested.flatMap(expandChain);
        const commands = split.length <= 8 ? split : requested;
        const checks = commands.map((command: unknown, index: number) => {
          const check = projectCheckCommand(command, ctx.cwd, true);
          if (!check) throw Error(`Command ${index + 1}/${commands.length} rejected (${projectCheckCommandReason(command, ctx.cwd) ?? 'invalid'}): ${JSON.stringify(String(command)).slice(0, 200)}. Declare a simple test command without shell composition, expansion, watch/list/help modes or status masking. Use the project working directory. No command was executed.`);
          return check;
        });
        for (const check of checks) {
          const observed = currentProjectCheck(state, check.key);
          if (observed && !state.checks.includes(observed)) state.checks = [...state.checks, { ...observed, revision: state.revision }].slice(-32);
        }
        state.assessment = { revision: state.revision, disposition: params.disposition, reason: params.reason.trim().slice(0, 1200), checks };
        save();
      }
      const splitNote = params.action === 'assess' && (params.commands ?? []).length && (params.commands ?? []).length !== (state.assessment?.checks?.length ?? 0)
        ? `Chained commands were split into ${state.assessment?.checks?.length} planned checks; run each exactly as planned: ${JSON.stringify(state.assessment?.checks?.map((check: any) => check.label))}.\n` : '';
      return { content: [{ type: 'text', text: splitNote + JSON.stringify(summary()) }], details: { revision: state.revision, need: projectTestNeed(state) } };
    },
  });
  return api;
}

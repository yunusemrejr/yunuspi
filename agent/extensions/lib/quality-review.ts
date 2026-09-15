import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { isProjectReviewSource } from '../../scripts/workspace-facts.mjs';
import { registerContinuationSource } from './continuation-notice.ts';
import { authoredReviewSnippets, authoredReviewSignals } from './authored-review.ts';
import { REVIEW_LIMITS } from '../pi-subagents/src/runs/shared/automatic-budgets.ts';
import { extractJsonEnvelope } from '../pi-subagents/src/shared/reviewer-envelope.ts';
import { registerSharedQualityReview } from './quality-review-owner.ts';
import { isTrivialChangeRequest } from './review-coordinator.ts';
export { REVIEW_LIMITS };
export { settleSharedQualityReview } from './quality-review-owner.ts';

// Services retain their existing process/graph owners. This checkpoint never
// launches a process, picks a provider, executes project code or owns a database.
export const QUALITY_REVIEW_RUNNER = Symbol.for('yunus-pi.quality-review-runner.v1');
export const QUALITY_PROJECT_CONTEXT = Symbol.for('yunus-pi.quality-project-context.v1');
const ENTRY = 'quality-review-v1';
const brief = (text: string) => text.length <= 6000 ? text : `${text.slice(0,3000)}\n[Middle omitted from bounded review brief; parent retains full instructions.]\n${text.slice(-2800)}`;
const RUBRICS: Record<string, string> = {
  correctness: 'Trace the changed behavior, actual source owner, affected callers and failure/cancellation paths. Check compatibility and meaningful tests. Identify a concrete counterexample; do not request speculative refactors.',
  security: 'Trace input to authorization, escaping, secret handling and data/storage boundaries. Check denied cases and migration compatibility when applicable. A filename or pattern alone is not a vulnerability.',
  interface: 'Check real task completion, native controls, keyboard/focus, responsive layout, contrast and loading/empty/error/disabled states. Review blinking live-status pills, competing font roles, tiny tracked labels, effect clusters, redundant cards and fixed-coordinate content against the project design system and user preferences. Default to quiet truthful status text. Source cues and learned similarity only select inspection targets: require rendered/browser evidence for appearance and actual interaction evidence for behavior. Block demonstrated broken behavior or unmet explicit requirements; label taste suggestions as improvements. Do not certify appearance from source or repeat redesign rounds for optional polish.',
  content: 'Check audience, clarity, specific supported claims, tone, links and calls to action. For public web content also check titles, headings, canonical/indexing, structured data and crawlability where relevant. Do not invent marketing facts or demand SEO for internal documentation.',
  runtime: 'Check language/runtime contracts (JavaScript, PHP, Python or other touched stack), browser compatibility, resource lifetimes and WebAssembly memory/ABI/fallback behavior where relevant. Require measurements for performance claims.',
  delivery: 'Check the actual target and release configuration, backwards compatibility, environment boundaries and rollback. Distinguish local, staged and observed production behavior; never deploy or access production just to review.',
};
export function reviewAspects(files: string[], task = '', history: any[] = []) {
  const names = files.join('\n'), prose = task.slice(0, 6000);
  const selected = new Set<string>();
  if (files.some(f => /\.(?:[cm]?[jt]sx?|py|php|go|rs|java|c|cc|cpp|cs|sh|sql|ya?ml|toml|json|vue|svelte)$/i.test(f))) selected.add('correctness');
  if (/auth|permission|security|migration|schema|\.sql\b/i.test(names) || /\b(?:security|authentication|authorization)\b/i.test(prose)) selected.add('security');
  if (/\.(?:html?|css|scss|sass|less|tsx|jsx|vue|svelte)\b/i.test(names) || /\b(?:UI|interface|accessibility|responsive)\b/i.test(prose)) selected.add('interface');
  if (/\.(?:mdx?|rst|txt|html?)\b/i.test(names) || /\b(?:SEO|marketing|copywriting|landing page)\b/i.test(prose)) selected.add('content');
  if (/\.(?:wasm|wat|c|cc|cpp|rs|py|php)\b/i.test(names) || /\b(?:performance|WebAssembly|memory leak)\b/i.test(prose)) selected.add('runtime');
  if (/deploy|docker|containerfile|procfile|makefile|jenkinsfile|justfile|(?:^|\/)compose\.ya?ml\b|pipeline|terraform|\.tf\b|release/i.test(names) || /\b(?:deploy|deployment|production|release)\b/i.test(prose)) selected.add('delivery');
  if (!selected.size && files.length) selected.add('correctness');
  // History sets attention order, never correctness standards or an extra round.
  const recent = history.slice(-20);
  const priority = (id: string) => (id === 'security' ? 100 : 0) + (id === 'correctness' ? 20 : 0) +
    recent.filter(s => s.aspect === id && (s.outcome === 'changes' || s.hadChanges === true)).length * 3;
  return [...selected].sort((a,b) => priority(b)-priority(a)).map(id => ({ id, rubric: RUBRICS[id] }));
}

export type ReviewReport = { aspect: string; outcome: 'pass' | 'changes' | 'unknown'; evidence: string[]; findings: { id: string; severity: 'blocking' | 'improvement'; file: string; detail: string }[]; gap: string };
/** Model text is untrusted advisory evidence. Empty/prose/malformed responses
 * never become a pass; actionable findings need a changed/related source path. */
export function parseReviewReport(text: string, aspect: string): ReviewReport {
  const unknown = (): ReviewReport => ({ aspect, outcome: 'unknown', evidence: [], findings: [], gap: 'Reviewer did not return a valid, evidence-backed assessment.' });
  try {
    if (text.length > 10000) return unknown();
    const value: any = extractJsonEnvelope(text);
    if (!value || typeof value !== 'object') return unknown();
    if (!['pass','changes','unknown'].includes(value.outcome) || !Array.isArray(value.evidence) || !value.evidence.length ||
      value.evidence.length > 6 || !value.evidence.every((s: any) => typeof s === 'string' && s.trim().length >= 12 && s.length <= 700) ||
      !Array.isArray(value.findings) || value.findings.length > 5) return unknown();
    const findings = value.findings.map((f: any, i: number) => {
      if (!['blocking','improvement'].includes(f.severity) || typeof f.file !== 'string' || !f.file || f.file.length > 256 || path.isAbsolute(f.file) || f.file.split(/[\\/]/).includes('..') ||
        typeof f.detail !== 'string' || f.detail.trim().length < 20 || f.detail.length > 900) throw Error('Invalid finding');
      return { id: `${aspect}-${i+1}`, severity: f.severity, file: f.file, detail: f.detail };
    });
    if (value.outcome === 'pass' && findings.some((f: any) => f.severity === 'blocking') || value.outcome === 'changes' && !findings.some((f: any) => f.severity === 'blocking')) return unknown();
    const gap = typeof value.gap === 'string' ? value.gap.slice(0,900) : '';
    if (value.outcome === 'unknown' && gap.trim().length < 12) return unknown();
    return { aspect, outcome: value.outcome, evidence: value.evidence, findings, gap };
  } catch { return unknown(); }
}

/** Bound even a faulty service that fails to honor AbortSignal. Its late result
 * has no path back into checkpoint state; the native executor still owns kill. */
async function withinDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); signal.throwIfAborted(); }
  let abort: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_resolve,reject) => {
      abort = () => reject(signal.reason ?? Error('Review cancelled'));
      signal.addEventListener('abort',abort,{once:true});
    })]);
  } finally { signal.removeEventListener('abort',abort); }
}

/** Stat fingerprints change without any byte changing when a build rewrites
 * identical output, a tool touches a file, or an atomic replace keeps content.
 * Confirm a real content change before charging a review revision; oversized or
 * unreadable files stay stat-only and are treated as changed (conservative). */
const REVIEW_HASH_LIMIT = 1 << 20;
function reviewContentHash(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > REVIEW_HASH_LIMIT) return undefined;
    return `${stat.size}:${createHash('sha1').update(fs.readFileSync(file)).digest('hex')}`;
  } catch { return undefined; }
}

/** Reload reconciliation: every restored file must still hold the exact bytes
 * the persisted disposition and reports were earned on. Unhashable files
 * (oversized, unreadable, deleted) or entries from before hashes were
 * persisted fail closed to the conservative bump-and-drop path. */
function verifyReviewTree(root: string, changed: string[], persisted: unknown): Record<string, string> | undefined {
  if (!persisted || typeof persisted !== 'object') return undefined;
  const saved = persisted as Record<string, unknown>;
  const verified: Record<string, string> = {};
  for (const file of changed) {
    const old = saved[file];
    if (typeof old !== 'string') return undefined;
    const current = reviewContentHash(path.join(root, file));
    if (!current || current !== old) return undefined;
    verified[file] = current;
  }
  return verified;
}

export function createQualityReviewLifecycle(pi: any, options: { shadow?: boolean; refresh(ctx: any): Promise<void>; tests(): any; runner?: any; context?: any } ) {
  let releaseShared = () => {};
  let root = '', baseline: Record<string,string> | undefined, revision = 0, changed: string[] = [], task = '', rounds = 0, followups = 0;
  let reports: ReviewReport[] = [], reviewed = -1, disposition = '', reason = '', paused = true, active = true, generation = 0, busy: Promise<any> | undefined, controller: AbortController | undefined;
  let truncated = false, delivered = '', noted = '', pauseReason = '', history: any[] = [], graph = 'Project graph unavailable; inspect source and label missing context.';
  let scopeOverflow = false;
  let scanning: Promise<void> | undefined;
  const patterns = new Map<string, ReturnType<typeof authoredReviewSignals>>();
  // File -> last confirmed content hash. Shared by the discovery pass and the
  // native receipt path so one real edit is charged exactly one revision.
  let hashes: Record<string, string> = {};
  const enabled = () => !options.shadow && process.env.PI_SUBAGENT_CHILD !== '1' && !['off','0'].includes(process.env.PI_QUALITY_REVIEWS ?? 'on');
  const capable = () => pi.getActiveTools?.().includes('quality_review');
  const testsPending = () => { const tests = options.tests(); return !tests?.disabled && !!tests?.need; };
  const save = () => { try { pi.appendEntry?.(ENTRY, { root, revision, changed, task, rounds, followups, reports, reviewed, disposition, reason, scopeOverflow,
    hashes: Object.fromEntries(Object.entries(hashes).filter(([file]) => changed.includes(file)).slice(-128)) }); } catch {} };
  const invalidate = (files: string[]) => {
    if (!files.length) return;
    for (const file of files) patterns.delete(file);
    const all = [...new Set([...changed,...files])]; scopeOverflow ||= all.length > 128;
    revision++; changed = all.slice(-128); disposition = ''; reason = ''; delivered = ''; save();
  };
  const status = () => !changed.length ? 'not_needed' : disposition || (reviewed !== revision ? rounds >= REVIEW_LIMITS.rounds ? 'budget_exhausted' : 'pending' : 'awaiting_assessment');
  const patternReport = () => [...patterns].flatMap(([file,signals])=>signals.map(s=>({...s,file}))).slice(0,12);
  const summary = (includePrevious = false) => ({ root, revision, changed, status: status(), rounds, limits: REVIEW_LIMITS, reports: reviewed === revision ? reports : [], staleReports: reviewed !== revision && reports.length > 0,
    ...(includePrevious && reviewed !== revision && reports.length ? { previousReview: { revision: reviewed, reports } } : {}),
    reason: reason || (status() === 'budget_exhausted' ? `Review rounds exhausted. Changed source was not reviewed at the current revision; ${reports.length ? 'inspect previousReview for earlier evidence' : 'no earlier report is available'} and report the remaining gap.` : ''), truncated: truncated || scopeOverflow,
    aspects: reviewAspects(changed,task,history), historicalSamples: history.length,
    patterns: patternReport(),
    scope: 'Independent advisory source reviews plus parent assessment; not certification. Tests, visual evidence and deployed behavior require their own observations.' });
  const advice = () => !changed.length || disposition ? '' : `[quality review] Revision ${revision}: ${status()}. ${reviewed === revision ? 'Review results are available; assess them without rerunning this revision.' : rounds >= REVIEW_LIMITS.rounds ? 'Review rounds are exhausted; assess remaining gaps without another attempt.' : 'Before declaring completion, use quality_review({action:"review"}) for bounded independent aspect reviews, then assess the evidence.'} Repair concrete blocking findings and re-review changed files; defer optional polish. Use quality_review({action:"assess",disposition:"accepted"|"blocked",reason:"..."}) with a concrete rationale. Report unavailable independent review separately from observed defects and task completion. Never claim missing evidence was verified. Maximum two review rounds; report unresolved gaps when exhausted.`;
  const automaticAdvice = () => testsPending() ? '' : advice();
  const cancel = () => { generation++; controller?.abort(); controller = undefined; busy = undefined; };
  const refresh = async (ctx: any) => {
    // Every caller must await discovery; skipping an active scan can approve
    // evidence for source that the scan is about to invalidate.
    if (scanning) return scanning;
    const operation = Promise.resolve().then(() => options.refresh(ctx));
    scanning = operation;
    try { await operation; } finally { if (scanning === operation) scanning = undefined; }
  };
  const run = async (ctx: any, signal?: AbortSignal, automatic = false) => {
    const entryGeneration = generation;
    await refresh(ctx);
    if (entryGeneration !== generation || signal?.aborted || ctx.signal?.aborted) return summary();
    // Test assessment/execution owns the next automatic step while unresolved.
    // An explicit source review still works, but parallel automatic reviews
    // would spend their bounded rounds on source/tests that are still changing.
    if (automatic && testsPending()) return summary();
    // Trivial formatting/lint/cleanup work never earns an automatic review.
    // Deliberate quality_review({action:"review"}) always stays available.
    if (automatic && isTrivialChangeRequest(task, changed)) return summary();
    if (!enabled() || !active || paused || !changed.length || disposition || reviewed === revision || rounds >= REVIEW_LIMITS.rounds) return summary();
    if (busy) return busy;
    const ticket = generation, rev = revision;
    const own = new AbortController(); controller = own;
    const combined = AbortSignal.any([own.signal, AbortSignal.timeout(REVIEW_LIMITS.deadlineMs), ...(signal ? [signal] : []), ...(ctx.signal ? [ctx.signal] : [])]);
    rounds++; save();
    const operation = (async () => {
      const context = options.context ?? (globalThis as any)[QUALITY_PROJECT_CONTEXT];
      try {
        const info = await withinDeadline(Promise.resolve(context?.({ action:'read', files:changed, task }, ctx, combined)),combined);
        if (ticket !== generation || combined.aborted) return summary();
        graph = typeof info?.graph === 'string' ? info.graph.slice(0,5000) : graph;
        history = Array.isArray(info?.history) ? info.history.slice(-20) : [];
      } catch {}
      const aspects = reviewAspects(changed,task,history);
      const runner = options.runner ?? (globalThis as any)[QUALITY_REVIEW_RUNNER];
      // Admit each completed aspect before the shared deadline. A slow peer
      // must not erase valid evidence, and late callbacks must not revive it.
      const completed = new Map<string, ReviewReport>();
      const failures = new Map<string, string>();
      const onResult = (item: any) => {
        if (ticket !== generation || !active || paused || combined.aborted ||
          !aspects.some(a => a.id === item?.aspect) || completed.has(item.aspect)) return;
        if (!item.ok || typeof item.text !== 'string') {
          if (typeof item.gap === 'string') failures.set(item.aspect,item.gap.slice(0,900));
          return;
        }
        completed.set(item.aspect, parseReviewReport(item.text, item.aspect));
      };
      let failure = typeof runner !== 'function' ? 'The native quality review runner is unavailable.' : '';
      try {
        combined.throwIfAborted();
        const result = await withinDeadline(Promise.resolve(runner?.({ revision:rev, files:[...changed], task, aspects, graph, history, patterns:patternReport(), tests:options.tests(), limits:REVIEW_LIMITS, onResult }, ctx, combined)),combined);
        if (Array.isArray(result)) result.forEach(onResult);
      } catch { failure = combined.aborted ? 'The review deadline expired before this aspect completed.' : 'The native quality review runner failed before returning this aspect.'; }
      if (ticket !== generation || !active || paused || own.signal.aborted || signal?.aborted || ctx.signal?.aborted) return summary();
      await refresh(ctx);
      if (ticket !== generation || own.signal.aborted || signal?.aborted || ctx.signal?.aborted) return summary();
      const received: ReviewReport[] = aspects.map(a => completed.get(a.id) ?? { aspect:a.id, outcome:'unknown', evidence:[], findings:[], gap:failures.get(a.id) || failure || 'No permitted reviewer returned an assessment for this aspect.' });
      if (rev !== revision) {
        reports = received.map(report => ({...report,outcome:'unknown',gap:`Source changed during this review; evidence may span revisions and cannot approve current source. ${report.gap}`.slice(0,900)}));
        reviewed = rev; save(); return summary();
      }
      reports = received; reviewed = rev;
      if (received.every(r => r.outcome === 'unknown' && !r.evidence.length && !r.findings.length)) {
        disposition = 'blocked';
        reason = 'Independent review unavailable: ' + [...new Set(received.map(r => r.gap))].join(' ').slice(0,1000);
      }
      save();
      // Only bounded numeric/category outcomes cross sessions, not review prose.
      try { await withinDeadline(Promise.resolve(context?.({ action:'record', samples:received.map(r => ({aspect:r.aspect,outcome:r.outcome})) },ctx,combined)),combined); } catch {}
      return summary();
    })();
    busy = operation;
    try { return await operation; } finally { own.abort(); if (busy === operation) busy = undefined; if (controller === own) controller = undefined; }
  };
  const api = {
    observe(facts: any, observeChanges: boolean) {
      if (!active || !enabled()) return;
      if (root && root !== facts.root) { cancel(); baseline = undefined; revision = 0; changed = []; reports = []; reviewed = -1; disposition = ''; rounds = 0; history = []; scopeOverflow = false; patterns.clear(); hashes = {}; }
      root = facts.root; truncated = facts.truncated === true;
      if (truncated && disposition === 'accepted') { disposition = ''; reviewed = -1; reason = 'Current source discovery is incomplete; earlier acceptance cannot establish the current scope.'; }
      const next = facts.reviewSources ?? {};
      if (baseline && (observeChanges || changed.length)) {
        // A stat-only change (build rewrite, touch, chmod, atomic replace) must
        // not invalidate an otherwise-current review. Confirm content first; the
        // stored hash also lets a later native write/edit receipt see that this
        // exact content was already accounted for instead of double-counting it.
        const candidates = [...new Set([...Object.keys(baseline),...Object.keys(next)])].filter(f =>
          (observeChanges || changed.includes(f)) && next[f] !== baseline![f] && (next[f] !== undefined || !truncated));
        invalidate(candidates.filter(f => {
          if (next[f] === undefined) { delete hashes[f]; return true; }
          const current = reviewContentHash(path.join(root,f));
          if (current && hashes[f] === current) return false;
          if (current) hashes[f] = current;
          return true;
        }));
      }
      for (const f of Object.keys(next)) if (hashes[f] === undefined && next[f] !== undefined) {
        const current = reviewContentHash(path.join(root,f));
        if (current) hashes[f] = current;
      }
      baseline = truncated && baseline ? Object.fromEntries(Object.entries({...baseline,...next}).slice(-4000)) : next;
    },
    restore(ctx: any) {
      releaseShared();
      hashes = {};
      releaseShared = registerSharedQualityReview(ctx,{owner:api,available:()=>enabled() && capable() && active,settle:(context,signal)=>api.settled({},context,signal),snapshot:summary});
      cancel(); active = true; paused = true; pauseReason = 'reload'; root = path.resolve(ctx.cwd); baseline = undefined; revision = 0; changed = []; reports = []; reviewed = -1; disposition = ''; reason = ''; rounds = 0; followups = 0; task = ''; delivered = ''; noted = ''; history = []; graph = 'Project graph unavailable; inspect source and label missing context.';
      patterns.clear();
      scopeOverflow = false;
      const data = ctx.sessionManager?.getBranch?.().findLast((e:any) => e.type === 'custom' && e.customType === ENTRY)?.data;
      if (data?.root === root && Number.isSafeInteger(data.revision) && Array.isArray(data.changed)) {
        const restoredChanged = data.changed.filter((f:any) => typeof f === 'string' && isProjectReviewSource(f)).slice(-128);
        // Byte-identical tree: the persisted disposition and reports still
        // describe this exact content, so resume keeps the revision instead of
        // invalidating approval and re-spending review rounds on already
        // reviewed work. Any byte difference, or an entry from before hashes
        // were persisted, takes the conservative bump-and-drop path below.
        const verified = verifyReviewTree(root, restoredChanged, (data as any)?.hashes);
        revision = verified ? data.revision : data.revision + 1;
        changed = restoredChanged;
        if (verified) hashes = verified;
        rounds = Math.min(2, Math.max(0,Number(data.rounds)||0)); followups = Math.min(3,Math.max(0,Number(data.followups)||0)); task = String(data.task??'').slice(0,6000);
        scopeOverflow = data.scopeOverflow === true;
        if (verified && (data.disposition === 'accepted' || data.disposition === 'blocked')) {
          // An acceptance replays only alongside its own reports; a recorded
          // evidence gap stays a gap, never a pass.
          if (data.disposition === 'blocked' || Array.isArray(data.reports) && data.reports.length > 0) {
            disposition = data.disposition; reason = String(data.reason ?? '').slice(0, 1200);
          }
        }
        // Resume invalidates approval, not evidence. Keep a bounded, validated
        // previous report available on explicit inspection; never replay it as
        // current evidence or inflate automatic continuation messages with it.
        if (Number.isSafeInteger(data.reviewed) && data.reviewed >= 0 && data.reviewed <= data.revision && Array.isArray(data.reports)) {
          const seen = new Set<string>();
          for (const item of data.reports.slice(0,Object.keys(RUBRICS).length)) {
            if (!item || !Object.hasOwn(RUBRICS,item.aspect) || seen.has(item.aspect)) continue;
            const parsed = parseReviewReport(JSON.stringify(item),item.aspect);
            if (!parsed.evidence.length && !parsed.findings.length) {
              if (item.outcome !== 'unknown' || typeof item.gap !== 'string' || item.gap.trim().length < 12) continue;
              parsed.gap = item.gap.slice(0,900);
            }
            seen.add(item.aspect); reports.push(parsed);
          }
          if (reports.length) reviewed = data.reviewed;
        }
      }
    },
    input(event: any) {
      if (event.source === 'extension') return;
      cancel(); paused = false; pauseReason = ''; rounds = 0; followups = 0; delivered = ''; noted = '';
      const resume = /\b(?:continue|resume|retry|recheck|review)\b/i.test(String(event.text??''));
      if (disposition && !(disposition === 'blocked' && resume)) { changed = []; scopeOverflow = false; patterns.clear(); }
      // Explicit input grants a fresh bounded attempt, including recovery from
      // missing capacity. Automatic extension turns must never do this.
      reviewed = -1; reports = []; disposition = ''; reason = '';
      task = brief(changed.length && task ? `${task}\nUser follow-up: ${String(event.text??'')}` : String(event.text??'')); save();
    },
    result(event: any, ctx: any) {
      if (!enabled() || !active || !['write','edit'].includes(event.toolName) || event.isError && !event.details?.fileMutation) return;
      const raw = event.details?.fileMutation?.resolved ?? event.input?.path;
      if (typeof raw !== 'string') return;
      const file = path.relative(root || ctx.cwd,path.resolve(ctx.cwd,raw));
      // Native mutation receipts cover paths outside the bounded scan. Each
      // successful edit invalidates a review, even a same-size/same-stat write.
      if (!file.startsWith('../') && !path.isAbsolute(file) && isProjectReviewSource(file)) {
        const earlier = patterns.get(file) ?? [];
        // The discovery pass that runs with every native write/edit already owns
        // scanned paths. Charge the receipt only for content it has not accounted
        // for, so a single edit cannot bump the review revision twice.
        const current = reviewContentHash(path.resolve(root || ctx.cwd,file));
        if (!(current && hashes[file] === current)) {
          invalidate([file]);
          if (current) hashes[file] = current;
        }
        if (patterns.size >= 128) patterns.delete(patterns.keys().next().value!);
        const snippets = authoredReviewSnippets(event.toolName,event.input);
        const fresh = authoredReviewSignals(file,snippets);
        // An unrelated partial edit cannot clear an earlier cue. A complete
        // bounded write can; scan-driven changes discard stale snippet evidence.
        const whole = event.toolName === 'write' && typeof event.input?.content === 'string' && event.input.content.length <= 24000;
        patterns.set(file,[...new Map([...(whole?[]:earlier),...fresh].map(s=>[s.key,s])).values()].slice(0,12));
      }
    },
    message(event: any) {
      if (event.message?.role !== 'assistant') return;
      const stop = event.message.stopReason;
      if (['aborted','error'].includes(stop)) { cancel(); paused = true; if (pauseReason !== 'stop') pauseReason = stop === 'aborted' ? 'stop' : 'error'; }
      else if (pauseReason === 'error' && ['stop','toolUse','length'].includes(stop)) { paused = false; pauseReason = ''; noted = ''; }
    },
    notice() {
      if (!enabled() || !capable() || !active || paused) return '';
      const key = `${root}:${revision}:${reviewed}:${status()}`;
      if (noted === key) return '';
      const content = automaticAdvice(); if (content) noted = key; return content;
    },
    async settled(_event: any, ctx: any, signal?: AbortSignal) {
      if (!enabled() || !capable() || !active || paused || signal?.aborted || ctx.signal?.aborted || ctx.isIdle?.() !== true || ctx.hasPendingMessages?.()) return;
      const ticket = generation;
      await run(ctx,signal,true);
      if (ticket !== generation || !active || paused || signal?.aborted || ctx.signal?.aborted || ctx.isIdle?.() !== true || ctx.hasPendingMessages?.() || followups >= 3) return;
      if (testsPending()) return;
      if (disposition === 'blocked' && reason.startsWith('Independent review unavailable:')) {
        // Show an automatic failure receipt without asking a model to repeat it
        // or re-open completed project work merely to acknowledge capacity loss.
        const blockedKey = `blocked:${revision}`;
        if (delivered === blockedKey) return;
        try {
          pi.sendMessage({customType:'quality-review-status',content:`[quality review] ${reason}`,display:true},{deliverAs:'followUp',triggerTurn:false});
          // Two settled hooks can await the same in-flight review. Mark the
          // receipt only after delivery so a failed queue remains retryable.
          delivered = blockedKey; save();
        } catch {}
        return;
      }
      const content = advice(), key = `${revision}:${reviewed}:${status()}`;
      if (!content || delivered === key) return;
      try { pi.sendMessage({customType:'quality-review-followup',content:`${content}\n${JSON.stringify(summary())}`,display:false},{deliverAs:'followUp',triggerTurn:true}); followups++; delivered = key; save(); } catch {}
    },
    shutdown() { releaseShared(); cancel(); active = false; paused = true; }, snapshot: summary, run,
  };
  pi.on?.('session_compact', () => { noted = ''; });
  registerContinuationSource({name:'quality review',pending:() => enabled() && capable() && active && !paused && followups < 3 && automaticAdvice() ? ['complete bounded quality review and assess remaining evidence gaps'] : []});
  pi.registerTool({name:'quality_review',label:'Quality Review',description:'Run or inspect automatic, bounded, read-only aspect reviews of observed changes; assess evidence before declaring completion. Reviewer receipts come from the native economy-gated executor, never a parent-supplied pass. Two rounds per user turn. Missing evidence is blocked, not accepted; optional improvements do not require endless polishing.',
    parameters:Type.Object({action:Type.Union(['inspect','review','assess'].map(x=>Type.Literal(x))),disposition:Type.Optional(Type.Union([Type.Literal('accepted'),Type.Literal('blocked')])),reason:Type.Optional(Type.String({minLength:20,maxLength:1200,description:"Concise evidence-based assessment, 20–1200 characters; reference retained reports rather than repeat them."})),dismissals:Type.Optional(Type.Array(Type.Object({id:Type.String(),reason:Type.String({minLength:20,maxLength:600})}),{maxItems:30}))}),
    async execute(_id: string, params: any, signal: any, _update: any, ctx: any) {
      const ticket = generation;
      const checkCurrent = () => {
        signal?.throwIfAborted();
        if (ticket !== generation || !active) throw Error('Quality review cancelled by user input, session change or shutdown.');
      };
      checkCurrent(); await refresh(ctx); checkCurrent();
      if (params.action === 'review') { await run(ctx,signal); checkCurrent(); }
      if (params.action === 'assess') {
        if (!['accepted','blocked'].includes(params.disposition) || typeof params.reason !== 'string' || params.reason.trim().length < 20) throw Error('Assessment requires a concrete rationale of at least 20 characters.');
        if (params.disposition === 'accepted') {
          if (reviewed !== revision || !reports.length || reports.some(r=>r.outcome === 'unknown' || r.gap.trim())) throw Error('Current independent reviews and their missing evidence must be resolved; record blocked when unavailable.');
          if (truncated || scopeOverflow) throw Error('Change discovery is incomplete; narrow the workspace or record the uncovered scope as blocked.');
          const test = options.tests();
          if (!test?.disabled && (test?.need || test?.assessment?.disposition === 'blocked')) throw Error('Current project test evidence is unresolved.');
          const blockers = reports.flatMap(r=>r.findings).filter(f=>f.severity === 'blocking');
          for (const finding of blockers) if (!(params.dismissals??[]).some((d:any)=>d.id===finding.id && typeof d.reason==='string' && d.reason.trim().length>=20)) throw Error(`Resolve ${finding.id} through a repair/review or supply an evidence-based dismissal.`);
        }
        disposition = params.disposition; reason = params.reason.trim().slice(0,1200); save();
        if (params.dismissals?.length) pi.appendEntry?.('quality-review-adjudication-v1',{revision,dismissals:params.dismissals});
      }
      signal?.throwIfAborted(); const data=summary(true);return {content:[{type:'text',text:JSON.stringify(data)}],details:data};
    }
  });
  return api;
}

import { sessionObservability } from './session-observability.ts';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { isProjectReviewSource } from '../../scripts/workspace-facts.mjs';
import { registerContinuationSource } from './continuation-notice.ts';
import { authoredReviewSnippets, authoredReviewSignals } from './authored-review.ts';
import { REVIEW_LIMITS } from '../pi-subagents/src/runs/shared/automatic-budgets.ts';
import { normalizeReviewPath, parseReviewReport, type ReviewReport } from '../pi-subagents/src/shared/quality-review-report.ts';
export { parseReviewReport } from '../pi-subagents/src/shared/quality-review-report.ts';
export type { ReviewReport } from '../pi-subagents/src/shared/quality-review-report.ts';
import { noteQualityReviewCompleted, registerSharedQualityReview } from './quality-review-owner.ts';
import { isTrivialChangeRequest } from './review-coordinator.ts';
import { createInterventionSession } from './intervention-session.ts';
import { reviewRoundIntent } from './intervention-intents.ts';
import { registerShadowSource } from './intervention-registry.ts';
export { REVIEW_LIMITS };
export { settleSharedQualityReview } from './quality-review-owner.ts';

// Services retain their existing process/graph owners. This checkpoint never
// launches a process, picks a provider, executes project code or owns a database.
export const QUALITY_REVIEW_RUNNER = Symbol.for('yunus-pi.quality-review-runner.v1');
export const QUALITY_PROJECT_CONTEXT = Symbol.for('yunus-pi.quality-project-context.v1');
const ENTRY = 'quality-review-v1';
const EVIDENCE_CHANGED = 'Outcome evidence changed after review began; the retained report cannot approve the current artifacts.';
const brief = (text: string) => text.length <= 6000 ? text : `${text.slice(0,3000)}\n[Middle omitted from bounded review brief; parent retains full instructions.]\n${text.slice(-2800)}`;
const RUBRICS: Record<string, string> = {
  correctness: 'Trace the changed behavior, actual source owner, affected callers and failure/cancellation paths. Check compatibility and meaningful tests. Identify a concrete counterexample; do not request speculative refactors.',
  security: 'Trace input to authorization, escaping, secret handling and data/storage boundaries. Check denied cases and migration compatibility when applicable. A filename or pattern alone is not a vulnerability.',
  interface: 'Check real task completion, native controls, keyboard/focus, responsive layout, contrast and loading/empty/error/disabled states. Review blinking live-status pills, competing font roles, tiny tracked labels, effect clusters, redundant cards and fixed-coordinate content against the project design system and user preferences. Default to quiet truthful status text. Source cues and learned similarity only select inspection targets: require captured pixels from the actual application for appearance and actual interaction evidence for behavior, including native desktop/game windows. Offscreen renders, internal autoplay assertions, image headers and process exit zero do not prove the displayed application works. Check the normal launch path, displayed content and real input through a representative task. A failed capture is an unresolved gap; do not blame the display server without an independent probe. When outcome evidence paths are supplied, inspect them before judging; appearance and behavior claims require that evidence, never source inference. Block demonstrated broken behavior or unmet explicit requirements; label taste suggestions as improvements. Do not certify appearance from source or repeat redesign rounds for optional polish.',
  content: 'Check audience, clarity, specific supported claims, tone, links and calls to action. For public web content also check titles, headings, canonical/indexing, structured data and crawlability where relevant. Do not invent marketing facts or demand SEO for internal documentation.',
  runtime: 'Check language/runtime contracts (JavaScript, PHP, Python or other touched stack), browser compatibility, resource lifetimes and WebAssembly memory/ABI/fallback behavior where relevant. Require measurements for performance claims.',
  delivery: 'Check the actual target and release configuration, backwards compatibility, environment boundaries and rollback. Distinguish local, staged and observed production behavior; never deploy or access production just to review.',
};
export function reviewAspects(files: string[], task = '', history: any[] = []) {
  const names = files.join('\n'), prose = task.slice(0, 6000);
  const selected = new Set<string>();
  if (files.some(f => /\.(?:[cm]?[jt]sx?|py|php|go|rs|java|c|cc|cpp|cs|sh|sql|ya?ml|toml|json|vue|svelte)$/i.test(f))) selected.add('correctness');
  if (/auth|permission|security|migration|schema|\.sql\b/i.test(names) || /\b(?:security|authentication|authorization)\b/i.test(prose)) selected.add('security');
  if (/\.(?:html?|css|scss|sass|less|tsx|jsx|vue|svelte)\b/i.test(names) || /\b(?:UI|GUI|interface|accessibility|responsive|desktop app|game|gameplay|windowed|pixel art)\b/i.test(prose)) selected.add('interface');
  if (/\.(?:mdx?|rst|txt|html?)\b/i.test(names) || /\b(?:SEO|marketing|copywriting|landing page)\b/i.test(prose)) selected.add('content');
  if (/\.(?:wasm|wat|c|cc|cpp|rs|py|php)\b/i.test(names) || /\b(?:performance|WebAssembly|memory leak)\b/i.test(prose)) selected.add('runtime');
  if (/deploy|docker|containerfile|procfile|makefile|jenkinsfile|justfile|(?:^|\/)compose\.ya?ml\b|pipeline|terraform|\.tf\b|release/i.test(names) || /\b(?:deploy|deployment|production|release)\b/i.test(prose)) selected.add('delivery');
  if (!selected.size && files.length) selected.add('correctness');
  // History sets attention order, never correctness standards or an extra round.
  const recent = history.slice(-20);
  const priority = (id: string) => (id === 'security' ? 100 : 0) + (id === 'correctness' ? 20 : id === 'interface' ? 15 : 0) +
    recent.filter(s => s.aspect === id && (s.outcome === 'changes' || s.hadChanges === true)).length * 3;
  return [...selected].sort((a,b) => priority(b)-priority(a)).map(id => ({ id, rubric: RUBRICS[id] }));
}

/** Best-effort review telemetry. Failures here never affect the lifecycle. */
function noteHealth(kind: string, data: Record<string, unknown>): void {
  try { sessionObservability()[Symbol.for('yunus-pi.health.v1')]?.(kind, data); } catch { /* telemetry is optional */ }
}

/** Parent-supplied outcome evidence (renders, logs, test output) so reviewers
 * judge behavior instead of inferring it from source. Validation is explicit:
 * a path must be a regular file inside the project, not merely a normalized
 * string. The legacy helper remains available for callers that only need the
 * syntax filter; the tool path uses validateReviewEvidence and reports every
 * rejected entry to the model. */
export function validReviewEvidence(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value.slice(0, 8)) {
		const file = normalizeReviewPath(entry);
		if (!file) continue;
		if (!out.includes(file)) out.push(file);
	}
	return out;
}

export function validateReviewEvidence(root: string, value: unknown): { paths: string[]; rejected: string[] } {
	const paths: string[] = [], rejected: string[] = [];
	if (value === undefined) return { paths, rejected };
	if (!Array.isArray(value)) return { paths, rejected: ["evidence must be an array"] };
	for (const entry of value.slice(0, 8)) {
		const display = typeof entry === "string" ? entry.slice(0, 256) : String(entry).slice(0, 256);
		const file = normalizeReviewPath(entry);
		if (!file) { rejected.push(`${display}: invalid relative path`); continue; }
		const absolute = path.resolve(root, file);
		const relative = path.relative(root, absolute);
		if (relative.startsWith("..") || path.isAbsolute(relative)) { rejected.push(`${display}: outside project root`); continue; }
		try {
			const stat = fs.lstatSync(absolute);
			if (!stat.isFile() || stat.isSymbolicLink()) { rejected.push(`${file}: not a regular project file`); continue; }
		} catch {
			rejected.push(`${file}: file does not exist`);
			continue;
		}
		try {
			const real = fs.realpathSync(absolute);
			if (!insideRoot(root, real)) { rejected.push(`${file}: resolves outside project root`); continue; }
		} catch {
			rejected.push(`${file}: could not resolve file`);
			continue;
		}
		if (!paths.includes(file)) paths.push(file);
	}
	return { paths, rejected };
}

function insideRoot(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

function outcomeEvidenceKey(root: string, files: string[]): string {
  return createHash('sha256').update(JSON.stringify(files.slice().sort().map(file => {
    const full = path.join(root, file), hash = reviewContentHash(full);
    if (hash) return [file, hash];
    try { const stat = fs.statSync(full); return [file, stat.size, stat.mtimeMs, stat.ctimeMs]; }
    catch { return [file, 'unavailable']; }
  }))).digest('hex');
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
  let releaseShared = () => {}, disposeContinuationNotice = () => {};
  let root = '', baseline: Record<string,string> | undefined, revision = 0, changed: string[] = [], task = '', rounds = 0, followups = 0, refunded = 0;
  let reports: ReviewReport[] = [], reviewed = -1, disposition = '', reason = '', paused = true, active = true, generation = 0, busy: Promise<any> | undefined, controller: AbortController | undefined;
  let truncated = false, delivered = '', deliveryInFlight = '', noted = '', pauseReason = '', history: any[] = [], graph = 'Project graph unavailable; inspect source and label missing context.';
	let scopeOverflow = false, dispatchGap = '', reviewedEvidence = '', reviewedEvidencePaths: string[] = [], evidenceRejected: string[] = [];
  let scanning: Promise<void> | undefined, activity = 0, reviewUnavailable = false;
  const patterns = new Map<string, ReturnType<typeof authoredReviewSignals>>();
  // File -> last confirmed content hash. Shared by the discovery pass and the
  // native receipt path so one real edit is charged exactly one revision.
  let hashes: Record<string, string> = {};
  let reviewedHashes: Record<string, string> = {};
  const progressListeners = new Set<(value: any) => void>();
  let progress: { round: number; startedAt: number; startedClock: number; deadlineMs: number; aspects: Record<string, string> } | undefined;
  const emitProgress = () => {
    if (!progress) return;
    const elapsedMs = Math.max(0, Math.floor(performance.now() - progress.startedClock));
    const data = { round:progress.round, startedAt:progress.startedAt, deadlineMs:progress.deadlineMs, aspects:{...progress.aspects}, elapsedMs, remainingMs:Math.max(0, progress.deadlineMs - elapsedMs) };
    const text = `Quality review ${progress.round}/${REVIEW_LIMITS.rounds}: ${Object.entries(progress.aspects).map(([aspect, state]) => `${aspect} ${state}`).join('; ') || 'preparing source context'}. ${Math.floor(elapsedMs / 1000)}s elapsed; deadline ${Math.ceil(data.remainingMs / 1000)}s remaining.`;
    for (const listener of progressListeners) try { listener({ content: [{type:'text', text}], details: {reviewProgress:data} }); } catch { /* UI observers do not own the review */ }
  };
  const enabled = () => !options.shadow && process.env.PI_SUBAGENT_CHILD !== '1' && !['off','0'].includes(process.env.PI_QUALITY_REVIEWS ?? 'on');
  const capable = () => pi.getActiveTools?.().includes('quality_review');
  // Control session (per-subsystem envelope per D-011).
  const shadowPlane = createInterventionSession();
  try { registerShadowSource("review", () => shadowPlane.audit()); } catch { /* diagnostics only */ }
  const testsPending = () => { const tests = options.tests(); return !tests?.disabled && !!tests?.need; };
  const save = () => { try { pi.appendEntry?.(ENTRY, { root, revision, changed, task, rounds, refunded, followups, reports, reviewed, disposition, reason, scopeOverflow, dispatchGap, reviewedEvidence, reviewedEvidencePaths, evidenceRejected, reviewUnavailable,
    hashes: Object.fromEntries(Object.entries(hashes).filter(([file]) => changed.includes(file)).slice(-128)) }); } catch {} };
  const invalidate = (files: string[]) => {
    if (!files.length) return;
    for (const file of files) patterns.delete(file);
    const all = [...new Set([...changed,...files])]; scopeOverflow ||= all.length > 128;
    revision++; changed = all.slice(-128); disposition = ''; reason = ''; delivered = ''; save();
  };
  const unavailableReason = () => dispatchGap || reason || (reviewUnavailable ? 'Independent review unavailable: ' + [...new Set(reports.map(r => r.gap))].join(' ').slice(0, 1000) : '');
  const status = () => !changed.length ? 'not_needed' : disposition || (dispatchGap || reviewUnavailable ? 'unavailable' : reviewed !== revision ? rounds >= REVIEW_LIMITS.rounds ? 'budget_exhausted' : 'pending' : 'awaiting_assessment');
  const patternReport = () => [...patterns].flatMap(([file,signals])=>signals.map(s=>({...s,file}))).slice(0,12);
  const summary = (includePrevious = false) => ({ root, revision, changed, status: status(), rounds, refunded, limits: REVIEW_LIMITS, reports: reviewed === revision ? reports : [], staleReports: reviewed !== revision && reports.length > 0,
    ...(includePrevious && reviewed !== revision && reports.length ? { previousReview: { revision: reviewed, reports } } : {}),
    reason: unavailableReason() || (evidenceRejected.length ? `Outcome evidence rejected: ${evidenceRejected.join(' ').slice(0, 1000)}` : '') || (status() === 'budget_exhausted' ? `Review rounds exhausted. Changed source was not reviewed at the current revision; ${reports.length ? 'inspect previousReview for earlier evidence' : 'no earlier report is available'} and report the remaining gap.` : ''),
    ...(evidenceRejected.length ? { evidenceRejected } : {}), truncated: truncated || scopeOverflow,
    aspects: reviewAspects(changed,task,history).map(({id}) => ({id})), historicalSamples: history.length,
    patterns: patternReport(),
    ...(reviewUnavailable || dispatchGap ? { nextAction: rounds >= REVIEW_LIMITS.rounds ? 'Independent review returned no usable assessment and review rounds are exhausted. Preserve completed local checks and report this verification limit; do not retry or reopen completed requested work.' : 'Independent review returned no usable assessment. Preserve completed local checks and report this verification limit. Retry only after correcting the launch/capacity cause, supplying retryReason; changing source or evidence alone does not repair the reviewer.' } : !disposition && rounds >= REVIEW_LIMITS.rounds ? { nextAction: 'Review rounds are exhausted. Assess the retained evidence now: accepted only when current reports and required checks support it, otherwise blocked with the precise verification gap. Do not add optional polish or repeat completed checks to compensate for unavailable independent review. A blocked review receipt records a verification limit; it does not require reopening completed requested work.' } : !disposition && reviewed === revision ? { nextAction: 'Assess the retained reports. Fix concrete blocking findings; defer improvement-only suggestions unless the user requested them. A second round is for a concrete repair or newly supplied missing evidence, not a fresh polish audit.' } : {}),
    scope: 'Independent advisory source reviews plus parent assessment; not certification. Retry a missing-evidence review with new outcome evidence; retry a launch failure only after correcting its cause. Tests, visual evidence and deployed behavior require their own observations.' });
  const advice = () => !changed.length || disposition ? '' : `[quality review] Revision ${revision}: ${status()}. ${reviewed === revision ? 'Review results are available; assess the retained findings. If necessary outcome evidence was missing, attach new or updated evidence paths to an explicit review call while a round remains.' : rounds >= REVIEW_LIMITS.rounds ? 'Review rounds are exhausted; assess remaining gaps without another attempt.' : 'Before declaring completion, use quality_review({action:"review"}) for bounded independent aspect reviews, then assess the evidence. For UI/behavior work attach outcome evidence (renders, test output) via evidence paths so reviewers judge the outcome, not the diff shape.'} Repair concrete blocking findings and re-review changed files; defer optional polish. Use quality_review({action:"assess",disposition:"accepted"|"blocked",reason:"..."}) with a concrete rationale. Report unavailable independent review separately from observed defects and task completion. Never claim missing evidence was verified. Use a remaining round only to verify a concrete repair or newly supplied missing evidence, never merely because budget remains. Preserve current checks and captures; report unavailable review without reopening completed work. Maximum two review rounds.`;
  const automaticAdvice = () => testsPending() || dispatchGap || reviewUnavailable ? '' : advice();
  const cancel = () => { generation++; controller?.abort(); controller = undefined; busy = undefined; };
  const refresh = async (ctx: any) => {
    // Every caller must await discovery; skipping an active scan can approve
    // evidence for source that the scan is about to invalidate.
    if (scanning) return scanning;
    const ticket = generation;
    const operation = Promise.resolve().then(async () => {
      await options.refresh(ctx);
      if (ticket === generation && active && reviewed === revision && reviewedEvidencePaths.length && outcomeEvidenceKey(root, reviewedEvidencePaths) !== reviewedEvidence && reports.some(r => !r.gap.startsWith(EVIDENCE_CHANGED))) {
        reports = reports.map(r => ({...r, outcome:'unknown', gap:`${EVIDENCE_CHANGED} ${r.gap}`.slice(0,900)}));
        disposition = ''; reason = ''; delivered = ''; save();
      }
    });
    scanning = operation;
    try { await operation; } finally { if (scanning === operation) scanning = undefined; }
  };
  const noteDisposition = () => {
    noteHealth('review.disposition', { decision: disposition, count: reports.flatMap(r => r.findings).filter(f => f.severity === 'blocking').length });
  };
  const run = async (ctx: any, signal?: AbortSignal, automatic = false, evidence: string[] = [], rejectedEvidence: string[] = [], retryReason = '') => {
    const entryGeneration = generation;
    await refresh(ctx);
    if (entryGeneration !== generation || signal?.aborted || ctx.signal?.aborted) return summary();
    // Test assessment/execution owns the next automatic step while unresolved.
    // An explicit source review still works, but parallel automatic reviews
    // would spend their bounded rounds on source/tests that are still changing.
    if (automatic && (testsPending() || dispatchGap || reviewUnavailable)) return summary();
    // Trivial formatting/lint/cleanup work never earns an automatic review.
    // Deliberate quality_review({action:"review"}) always stays available.
    if (automatic && isTrivialChangeRequest(task, changed)) return summary();
    // Changing artifacts cannot repair a failed reviewer launch. A deliberate
    // retry documents its corrected cause; a new user request resets the gate.
    const infraBlocked = reviewUnavailable || Boolean(dispatchGap);
    const infrastructureRetry = !automatic && infraBlocked && retryReason.trim().length >= 20;
    if (infraBlocked && !infrastructureRetry) return summary();
    const evidenceKey = outcomeEvidenceKey(root, evidence);
    // A missing screenshot/log can be supplied after source review without a
    // fake code edit. Only a deliberate call with new evidence reopens an
    // incomplete report; repeated receipts and settled hooks spend no round.
    const evidenceRetry = !infraBlocked && !automatic && evidence.length > 0 && reviewed === revision && evidenceKey !== reviewedEvidence && reports.some(r => r.outcome === 'unknown' || r.gap.trim());
    if (!enabled() || !active || paused || !changed.length || (disposition && !infraBlocked && !dispatchGap && !evidenceRetry) || (reviewed === revision && !infrastructureRetry && !evidenceRetry) || rounds >= REVIEW_LIMITS.rounds) return summary();
    if (busy) return busy;
    const ticket = generation, rev = revision;
    const own = new AbortController(); controller = own;
    const combined = AbortSignal.any([own.signal, AbortSignal.timeout(REVIEW_LIMITS.deadlineMs), ...(signal ? [signal] : []), ...(ctx.signal ? [ctx.signal] : [])]);
    // Go-live (step 19): the escalation budget gates AUTOMATIC rounds only.
    // Explicit quality_review tool calls shadow-observe and are never
    // refused. A refused automatic round is skipped: summary returned,
    // round NOT spent. Fail-open on control error.
    if (automatic) {
      let admitted = true;
      try {
        admitted = shadowPlane.enforce(reviewRoundIntent({ revision: rev, round: rounds + 1, automatic, files: changed.length, task })).outcome === "admitted";
      } catch { admitted = true; }
      if (!admitted) return summary();
    } else {
      try { shadowPlane.shadow(reviewRoundIntent({ revision: rev, round: rounds + 1, automatic, files: changed.length, task })); } catch { /* observation never affects review */ }
    }
		dispatchGap = ''; reviewUnavailable = false; disposition = ''; reason = ''; evidenceRejected = rejectedEvidence.slice(0, 8);
    const reviewScopeHashes = Object.fromEntries(changed.map(file => [file, reviewContentHash(path.join(root, file))]).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const previousReview = reviewed >= 0 && reports.length ? {
      revision: reviewed,
      changedFiles: changed.filter(file => !reviewScopeHashes[file] || reviewScopeHashes[file] !== reviewedHashes[file]),
      reports: reports.map(report => ({aspect:report.aspect, outcome:report.outcome, gap:report.gap.slice(0,300), findings:report.findings.filter(f => f.severity === 'blocking').map(f => ({id:f.id,file:f.file,detail:f.detail.slice(0,600)}))})),
    } : undefined;
    rounds++; reviewedEvidence = evidenceKey; reviewedEvidencePaths = [...evidence]; save();
    const roundProgress = { round: rounds, startedAt: Date.now(), startedClock: performance.now(), deadlineMs: REVIEW_LIMITS.deadlineMs, aspects: {} as Record<string,string> };
    progress = roundProgress; emitProgress();
    // Progress is transient tool UI only: no new prompt, ledger entry or model
    // turn is created while a slow reviewer uses its existing bounded deadline.
    const progressTimer = setInterval(emitProgress, 10000); progressTimer.unref?.();
    const operation = (async () => {
      const context = options.context ?? (globalThis as any)[QUALITY_PROJECT_CONTEXT];
      try {
		const info = await withinDeadline(Promise.resolve(context?.({ action:'read', files:changed, task }, ctx, combined)),combined);
		if (ticket !== generation) return summary();
		graph = typeof info?.graph === 'string' ? info.graph.slice(0,5000) : graph;
		history = Array.isArray(info?.history) ? info.history.slice(-20) : [];
	  } catch {}
      const aspects = reviewAspects(changed,task,history);
      roundProgress.aspects = Object.fromEntries(aspects.map(aspect => [aspect.id, 'pending'])); emitProgress();
      const runner = options.runner ?? (globalThis as any)[QUALITY_REVIEW_RUNNER];
      // Admit each completed aspect before the shared deadline. A slow peer
      // must not erase valid evidence, and late callbacks must not revive it.
      const completed = new Map<string, ReviewReport>();
      const failures = new Map<string, string>();
      const unattempted = new Set<string>();
      const onResult = (item: any) => {
        if (ticket !== generation || !active || paused || combined.aborted ||
          !aspects.some(a => a.id === item?.aspect) || completed.has(item.aspect)) return;
        if (item?.unattempted === true) unattempted.add(item.aspect);
        if (!item.ok || typeof item.text !== 'string') {
          if (typeof item.gap === 'string') failures.set(item.aspect,item.gap.slice(0,900));
          roundProgress.aspects[item.aspect] = 'unavailable'; emitProgress();
          return;
        }
        completed.set(item.aspect, parseReviewReport(item.text, item.aspect));
        roundProgress.aspects[item.aspect] = 'received'; emitProgress();
      };
      let failure = typeof runner !== 'function' ? 'The native quality review runner is unavailable.' : '';
      try {
        combined.throwIfAborted();
        const result = await withinDeadline(Promise.resolve(runner?.({ revision:rev, files:[...changed], task, aspects, graph, history, patterns:patternReport(), tests:options.tests(), limits:REVIEW_LIMITS, onResult, automatic, evidence, previousReview }, ctx, combined)),combined);
        if (Array.isArray(result)) result.forEach(onResult);
      } catch { failure = combined.aborted ? 'The review deadline expired before this aspect completed.' : 'The native quality review runner failed before returning this aspect.'; }
		// A user/session cancellation discards the in-flight turn. The local
		// deadline is different: it must settle as an explicit unknown gap so a
		// spent round cannot disappear as if it never ran.
		if (ticket !== generation || !active || paused || own.signal.aborted || signal?.aborted || ctx.signal?.aborted) return summary();
		await refresh(ctx);
      if (ticket !== generation || own.signal.aborted || signal?.aborted || ctx.signal?.aborted) return summary();
      const evidenceChanged = evidence.length > 0 && evidenceKey !== outcomeEvidenceKey(root, evidence);
      const received: ReviewReport[] = aspects.map(a => {
        const report = completed.get(a.id) ?? { aspect:a.id, outcome:'unknown' as const, evidence:[], findings:[], gap:failures.get(a.id) || failure || 'No permitted reviewer returned an assessment for this aspect.' };
        return evidenceChanged ? {...report, outcome:'unknown', gap:`${EVIDENCE_CHANGED} ${report.gap}`.slice(0,900)} : report;
      });
      // Reviewer availability is independent of the source revision. A source
      // edit during failed startup cannot repair the launch or authorize retry.
      reviewUnavailable = completed.size === 0;
      if (aspects.length > 0 && aspects.every(a => unattempted.has(a.id))) {
        // No reviewer was dispatched (no capacity, disabled assistance,
        // delegation block): refund the round so the 2-round budget is spent
        // on real attempts. Keep the reason and stop automatic retry loops.
        rounds--; refunded++; reports = received; reviewed = rev; reviewUnavailable = true;
        dispatchGap = 'Independent review unavailable: ' + [...new Set(received.map(r => r.gap))].join(' ').slice(0, 900) + ' No reviewer was dispatched; the round was not spent. Retry quality_review action review only after capacity or restrictions change.';
        save(); return summary();
      }
      if (rev !== revision) {
        reports = received.map(report => ({...report,outcome:'unknown',gap:`Source changed during this review; evidence may span revisions and cannot approve current source. ${report.gap}`.slice(0,900)}));
        reviewed = rev; save(); return summary();
      }
      reports = received; reviewed = rev; reviewedHashes = reviewScopeHashes; reviewUnavailable = completed.size === 0;
      // A decisive round suppresses near-term stuck-signal review suggestions;
      // an all-unknown round stays suggestible since no review evidence exists.
      if (received.some(r => r.outcome !== 'unknown')) { try { noteQualityReviewCompleted(ctx); } catch {} }
      if (received.every(r => r.outcome === 'unknown' && !r.evidence.length && !r.findings.length)) {
        disposition = 'blocked';
        reason = 'Independent review unavailable: ' + [...new Set(received.map(r => r.gap))].join(' ').slice(0,1000);
        noteDisposition();
      }
      save();
      // Only bounded numeric/category outcomes cross sessions, not review prose.
      try { await withinDeadline(Promise.resolve(context?.({ action:'record', samples:received.map(r => ({aspect:r.aspect,outcome:r.outcome})) },ctx,combined)),combined); } catch {}
      return summary();
    })();
    busy = operation;
    try { return await operation; } finally { clearInterval(progressTimer); if (progress === roundProgress) progress = undefined; own.abort(); if (busy === operation) busy = undefined; if (controller === own) controller = undefined; }
  };
  const api = {
    observe(facts: any, observeChanges: boolean) {
      if (!active || !enabled()) return;
    if (root && root !== facts.root) { cancel(); baseline = undefined; revision = 0; changed = []; reports = []; reviewed = -1; disposition = ''; rounds = 0; refunded = 0; history = []; scopeOverflow = false; dispatchGap = ''; reviewUnavailable = false; reviewedEvidence = ''; reviewedEvidencePaths = []; evidenceRejected = []; patterns.clear(); hashes = {}; }
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
      disposeContinuationNotice();
      disposeContinuationNotice = registerContinuationSource({session:ctx.sessionManager,name:'quality review',verification:() => enabled() && capable() && active && !paused && changed.length && disposition !== 'accepted' ? [`Independent review ${status()}: ${unavailableReason() || 'current changes have not been accepted; inspect the review evidence and remaining gaps.'}`] : [],pending:() => enabled() && capable() && active && !paused && followups < 3 && automaticAdvice() ? ['complete bounded quality review and assess remaining evidence gaps'] : []});
      releaseShared();
      hashes = {}; reviewedHashes = {};
      releaseShared = registerSharedQualityReview(ctx,{owner:api,available:()=>enabled() && capable() && active,settle:(context,signal)=>api.settled({},context,signal),snapshot:summary});
      cancel(); active = true; paused = true; pauseReason = 'reload'; root = path.resolve(ctx.cwd); baseline = undefined; revision = 0; changed = []; reports = []; reviewed = -1; disposition = ''; reason = ''; rounds = 0; refunded = 0; followups = 0; task = ''; delivered = ''; noted = ''; history = []; graph = 'Project graph unavailable; inspect source and label missing context.';
      patterns.clear();
      scopeOverflow = false; dispatchGap = ''; reviewUnavailable = false; reviewedEvidence = ''; reviewedEvidencePaths = []; evidenceRejected = [];
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
        if (verified) { hashes = verified; if (data.reviewed === data.revision) reviewedHashes = {...verified}; }
        rounds = Math.min(2, Math.max(0,Number(data.rounds)||0)); refunded = Math.max(0,Math.min(99,Number(data.refunded)||0)); followups = Math.min(3,Math.max(0,Number(data.followups)||0)); task = String(data.task??'').slice(0,6000);
        scopeOverflow = data.scopeOverflow === true;
        reviewUnavailable = data.reviewUnavailable === true;
        dispatchGap = typeof data.dispatchGap === 'string' ? data.dispatchGap.slice(0, 1200) : '';
        reviewedEvidence = typeof data.reviewedEvidence === 'string' ? data.reviewedEvidence.slice(0, 64) : '';
        reviewedEvidencePaths = validReviewEvidence(data.reviewedEvidencePaths);
        evidenceRejected = Array.isArray(data.evidenceRejected) ? data.evidenceRejected.filter((entry:any) => typeof entry === 'string').slice(-8).map((entry:string) => entry.slice(0, 320)) : [];
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
      try { shadowPlane.beginRequest('review-input'); } catch { /* shadow only */ }
      cancel(); paused = false; pauseReason = ''; rounds = 0; refunded = 0; dispatchGap = ''; reviewUnavailable = false; reviewedEvidence = ''; reviewedEvidencePaths = []; evidenceRejected = []; followups = 0; delivered = ''; noted = '';
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
      activity++;
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
      if (dispatchGap || reviewUnavailable || disposition === 'blocked' && reason.startsWith('Independent review unavailable:')) {
        // Show an automatic failure receipt without asking a model to repeat it
        // or re-open completed project work merely to acknowledge capacity loss.
        const blockedKey = `blocked:${revision}`;
        if (delivered === blockedKey || deliveryInFlight === blockedKey) return;
        deliveryInFlight = blockedKey;
        const deliveryGeneration = generation;
        const deliveryRevision = revision;
        try {
          await pi.sendMessage({customType:'quality-review-status',content:`[quality review] ${unavailableReason()} Completed local checks remain valid; report the independent-review limit. Retry only after correcting its launch/capacity cause.`,display:true},{deliverAs:'followUp',triggerTurn:false});
          if (deliveryGeneration !== generation || !active || paused || deliveryRevision !== revision) return;
          // Two settled hooks can await the same in-flight review. Mark the
          // receipt only after delivery so a failed queue remains retryable.
          delivered = blockedKey; save();
        } catch {} finally { if (deliveryInFlight === blockedKey) deliveryInFlight = ''; }
        return;
      }
      const content = advice(), key = `${revision}:${reviewed}:${status()}`;
      if (!content || delivered === key || deliveryInFlight === key) return;
      deliveryInFlight = key;
      const deliveryGeneration = generation;
      const priorFollowups = followups, priorDelivered = delivered, priorActivity = activity;
      followups++; delivered = key; save();
      try {
        await pi.sendMessage({customType:'quality-review-followup',content:`${content}\n${JSON.stringify(summary())}`,display:false},{deliverAs:'followUp',triggerTurn:true});
      } catch {
        if (deliveryGeneration === generation && activity === priorActivity && delivered === key) {
          followups = priorFollowups; delivered = priorDelivered; save();
        }
      }
      finally { if (deliveryInFlight === key) deliveryInFlight = ''; }
    },
    shutdown() { disposeContinuationNotice(); releaseShared(); cancel(); active = false; paused = true; }, snapshot: summary, run,
  };
  pi.on?.('session_compact', () => { noted = ''; });
  pi.registerTool({name:'quality_review',label:'Quality Review',description:'Run or inspect automatic, bounded, read-only aspect reviews of observed changes; assess evidence before declaring completion. Reviewer receipts come from the native economy-gated executor, never a parent-supplied pass. Two rounds per user turn. Missing evidence is blocked, not accepted; optional improvements do not require endless polishing.',
    parameters:Type.Object({action:Type.Union(['inspect','review','assess'].map(x=>Type.Literal(x))),disposition:Type.Optional(Type.Union([Type.Literal('accepted'),Type.Literal('blocked')])),reason:Type.Optional(Type.String({minLength:20,maxLength:1200,description:"Concise evidence-based assessment, 20–1200 characters; reference retained reports rather than repeat them."})),dismissals:Type.Optional(Type.Array(Type.Object({id:Type.String(),reason:Type.String({minLength:20,maxLength:600})}),{maxItems:30})),retryReason:Type.Optional(Type.String({minLength:20,maxLength:600,description:'Concrete launch or capacity correction since an unavailable review. Required to retry when no independent reviewer returned; new code or screenshots alone are not a correction.'})),evidence:Type.Optional(Type.Array(Type.String({maxLength:256}),{maxItems:8,description:"Outcome evidence for reviewers to judge (renders, logs, test output): existing regular files inside the project, given as relative paths with no parent traversal. Rejected or missing paths are reported explicitly. New or updated evidence can reopen an incomplete review within the two-round budget."}))}),
    async execute(_id: string, params: any, signal: any, update: any, ctx: any) {
      const ticket = generation;
      const checkCurrent = () => {
        signal?.throwIfAborted();
        if (ticket !== generation || !active) throw Error('Quality review cancelled by user input, session change or shutdown.');
      };
      checkCurrent(); await refresh(ctx); checkCurrent();
      if (params.action === 'review') {
        const validation = validateReviewEvidence(ctx.cwd, params.evidence);
        if (validation.rejected.length && validation.paths.length === 0) throw Error(`No usable outcome evidence was accepted. ${validation.rejected.join(' ')}`);
        if (typeof update === 'function') { progressListeners.add(update); emitProgress(); }
        try { await run(ctx,signal,false,validation.paths,validation.rejected,params.retryReason ?? ''); }
        finally { if (typeof update === 'function') progressListeners.delete(update); }
        checkCurrent();
      }
      if (params.action === 'assess') {
        if (!['accepted','blocked'].includes(params.disposition) || typeof params.reason !== 'string' || params.reason.trim().length < 20) throw Error('Assessment requires a concrete rationale of at least 20 characters.');
        if (params.disposition === 'accepted') {
          if (reviewed !== revision || !reports.length || reports.some(r=>r.outcome === 'unknown' || r.gap.trim())) {
            // Name the open items so the caller can resolve them (repair and
            // re-review within the round budget) instead of repeating an
            // accepted assessment blind. The leading sentence is pinned: the
            // diagnostics classifier matches it for the verification category.
            const flat = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
            const open = reports.map(r => r.outcome === 'unknown' ? `${r.aspect} (unknown outcome${r.gap.trim() ? `: ${flat(r.gap).slice(0, 180)}` : ''})` : r.gap.trim() ? `${r.aspect} (gap: ${flat(r.gap).slice(0, 180)})` : '').filter(Boolean);
            if (reviewed !== revision || !reports.length) open.unshift(!reports.length ? 'no independent report retained' : `review is stale (reviewed r${reviewed}, current r${revision})`);
            const detail = open.join('; ').slice(0, 600);
            throw Error(`Current independent reviews and their missing evidence must be resolved; record blocked when unavailable.${detail ? ` Open: ${detail}.` : ''}`);
          }
          if (truncated || scopeOverflow) throw Error('Change discovery is incomplete; narrow the workspace or record the uncovered scope as blocked.');
          const test = options.tests();
          if (!test?.disabled && (test?.need || test?.assessment?.disposition === 'blocked')) throw Error('Current project test evidence is unresolved.');
          const blockers = reports.flatMap(r=>r.findings).filter(f=>f.severity === 'blocking');
          for (const finding of blockers) if (!(params.dismissals??[]).some((d:any)=>d.id===finding.id && typeof d.reason==='string' && d.reason.trim().length>=20)) throw Error(`Resolve ${finding.id} through a repair/review or supply an evidence-based dismissal.`);
        } else {
          // A blocked disposition is still an assessment of the current
          // revision. Do not let a caller turn an unreviewed or stale state
          // into a truthful-looking current review receipt. An explicit
          // project-test blocker is a deliberate exception: it is already
          // current, session-owned evidence that the shared verification
          // boundary cannot be completed, and quality must be able to retain
          // the same blocked disposition alongside it.
          const test = options.tests();
          const verificationBlocked = Boolean(!test?.disabled && test?.changed?.length
            && test.assessment?.revision === test.revision
            && test.assessment.disposition === 'blocked');
          if (!changed.length && !verificationBlocked) throw Error('There is no current changed scope to assess as blocked.');
          if (disposition === 'accepted') throw Error('The current revision was accepted already; new changes or input require a fresh review before recording blocked.');
          const currentReview = reviewUnavailable || Boolean(dispatchGap) || reviewed === revision && reports.length > 0;
          if (!currentReview && !verificationBlocked && rounds < REVIEW_LIMITS.rounds) throw Error('Current independent review is still pending; run or complete the current review before recording blocked.');
        }
        disposition = params.disposition; reason = params.reason.trim().slice(0,1200); save(); noteDisposition();
        if (params.dismissals?.length) pi.appendEntry?.('quality-review-adjudication-v1',{revision,dismissals:params.dismissals});
      }
      signal?.throwIfAborted(); const data=summary(true);return {content:[{type:'text',text:JSON.stringify(data)}],details:data};
    }
  });
  return api;
}

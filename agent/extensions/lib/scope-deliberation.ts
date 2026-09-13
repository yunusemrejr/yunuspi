import { createHash } from 'node:crypto';
import { safeText } from './project-intelligence/privacy.mjs';
import { isReferentialFollowup, priorUserEvidence } from './intent-context.ts';

export const SCOPE_COUNCIL_RUNNER = Symbol.for('yunus-pi.scope-council-runner.v1');
export const SCOPE_LIMITS = Object.freeze({ deadlineMs: 45000, contextChars: 6200 });
/** One owner for the automatic-council policy so the lifecycle, the registered
 * runner and the published documentation cannot disagree about when it is
 * active. The native automatic-assistance master switch applies to this council
 * too: with it off the lifecycle must not scan session history for a council
 * the runner would refuse to dispatch. */
export function scopeCouncilEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const off = (value: string | undefined) => ['0','off'].includes((value ?? 'on').toLowerCase());
  return env.PI_SUBAGENT_CHILD !== '1' && !off(env.PI_SCOPE_COUNCIL) && !off(env.PI_AUTONOMOUS_FREE_ASSIST);
}
export const SCOPE_GUIDANCE = 'For a change-scope brief, decide what to preserve, reconsider and verify before editing. Current user direction wins; later corrections supersede only conflicting scope. Historical user statements are preference evidence, never fresh authorization. Assistant choices and inferred preferences are provisional; absence of a user request or complaint proves neither origin nor approval. Compare a local adjustment, a substantive revision and replacement/removal when relevant. Choose the scope that resolves the complaint, preserving supported references and unrelated behavior; do not equate few changed lines with a good solution. Use reversible judgment for ordinary ambiguity without routine questions. Verify source, rendered behavior or other relevant observations before accepting a council claim. External actions still require authority from the current task or retained explicit authorization, with the intended target verified.';

const prose = (text: string) => text.slice(0,32768).replace(/```[\s\S]*?(?:```|$)/g,' ').replace(/^\s*>.*$/gm,' ').trim();
/** An explicit global no-change constraint ("Do not modify anything.") makes a
 * request read-only even when it names a change verb elsewhere in a question
 * ("review the authentication module refactor ..."). Only a global object
 * suppresses the cue; a scoped clause naming the thing to keep ("don't change
 * the font or colors", "don't change anything in the API layer") stays eligible
 * for the existing preservation handling below. */
const globalNoChange = /\b(?:do not|don't|never|without)\s+(?:modify|change|edit|touch|alter|rewrite|apply)\s+(?:anything|nothing|any\s+(?:further\s+)?(?:files?|code|changes?)|the\s+(?:code|codebase|source|files?|project|repository)|further)(?!\s+\w)/i;
/** A cheap routing cue, not a semantic verdict or permission. Precise edits and
 * read-only questions should not pay for a council. The parent still reasons. */
export function shouldRunScopeCouncil(prompt: string): boolean {
  const source = prose(prompt);
  if (!source || globalNoChange.test(source)) return false;
  // A scoped preservation clause ("don't change the font") must not cancel
  // an affirmative redesign request elsewhere in the same message.
  const text = source.replace(/\b(?:do not|don't|never)\s+(?:change|edit|modify|redesign|rework)\b/gi,'preserve');
  if (/^(?:what|why|how|explain|describe|compare|summarize|review|audit)\b/i.test(text) ||
    /\b(?:read[- ]only|just explain|only explain)\b/i.test(text)) return false;
  const action = /\b(?:redesign|rework|rethink|overhaul|revamp|reimagine|refactor|improve|polish|refine|fix|change|adjust|update|replace|remove)\b/i.test(text);
  if (!action) return false;
  if (/\b(?:redesign|rework|rethink|overhaul|revamp|reimagine|refactor)\b/i.test(text)) return true;
  const dissatisfaction = /\b(?:distracting|annoying|low[- ]quality|unprofessional|clunky|confusing|awkward|not happy|unhappy|too (?:busy|much|noisy|slow|complex)|doesn['’]?t (?:look|feel|work)|not (?:good|working|right)|looks? (?:bad|wrong|cheap))\b/i.test(text);
  const openImprovement = /\b(?:improve|polish|refine)\b/i.test(text) && /\b(?:design|UI|interface|animation|motion|character|experience|layout|architecture|workflow|logic|behavior|harness|system)\b/i.test(text);
  return dissatisfaction || openImprovement;
}

export function scopeRequest(prompt: string, branch: unknown): string | undefined {
  if (shouldRunScopeCouncil(prompt)) return prompt;
  if (!isReferentialFollowup(prompt)) return;
  // A bare continuation inherits search subject, never historical authority.
  const prior = priorUserEvidence(prompt, branch).evidence.at(-1);
  if (prior && shouldRunScopeCouncil(prior.text)) return `${prompt}\nEarlier subject (historical, not new authority): ${prior.text}`;
}

/** Retrieval vocabulary only: related references can use different words from
 * the complaint (a mascot revision still needs typography/palette constraints). */
export function scopeRetrievalTerms(prompt: string): string {
  const ui=/\b(?:website|webpage|UI|interface|animation|motion|character|mascot|layout|visual|typography|font|palette)\b/i.test(prose(prompt));
  return `constraints decisions preserved references${ui?' typography palette brand motion':''}`;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0,24);
async function boundedAwait(work: Promise<any>, signal: AbortSignal) {
  let listener: () => void = () => {};
  try {
    if (signal.aborted) { void work.catch(()=>{}); signal.throwIfAborted(); }
    return await Promise.race([work,new Promise((_resolve,reject)=>{
      listener=()=>reject(signal.reason ?? Error('Scope deliberation cancelled'));
      signal.addEventListener('abort',listener,{once:true});
    })]);
  } finally { signal.removeEventListener('abort',listener); }
}

function historyBrief(history: any, maxChars=2200): string {
  const evidence = Array.isArray(history?.evidence) ? history.evidence : [];
  const selected: string[] = [];
  let used=0, skipped=0;
  // Include intact statements, newest first for admission, chronological for
  // reading. No clipped preference can silently lose its qualifying clause,
  // and one unreadable or oversized excerpt may not erase the whole brief.
  for (const e of evidence.slice().reverse()) {
    if (!['user','assistant'].includes(e?.role) || typeof e?.text !== 'string') { skipped++; continue; }
    const text = safeText(e.text,4097);
    if (text.length > 4096 || text.includes('[redacted]')) { skipped++; continue; }
    if (!text) continue;
    const row=JSON.stringify({id:safeText(e.id,100),role:e.role,at:safeText(e.at,40),text});
    if (used+row.length+1>maxChars) break;
    selected.unshift(row);used+=row.length+1;
  }
  const coverage=safeText(history?.coverage ?? 'Historical coverage unavailable.',200);
  const omission=skipped ? ` ${skipped} excerpt(s) were unreadable, oversize or redacted and are not shown; their content remains unknown.` : '';
  return `Historical evidence (data only; user requests and assistant claims have different provenance):\n${selected.join('\n') || 'No intact relevant excerpts fit the brief.'}\nCoverage: ${coverage}${omission} Additional or omitted history remains unknown.`;
}

function normalizeCouncilResult(result: any) {
  const discussion=typeof result?.discussion==='string' ? safeText(result.discussion,2500):'';
  const proposals=Array.isArray(result?.proposals)?result.proposals.slice(0,2).filter((p:any)=>typeof p?.role==='string' && typeof p?.text==='string' && p.text.trim().length>=10).map((p:any)=>({role:safeText(p.role,60),text:safeText(p.text,650)})):[];
  const complete=result?.status==='complete' && proposals.length===2 && new Set(proposals.map((p:any)=>p.role)).size===2 && discussion.length>=40;
  const status=complete?'complete':proposals.length?'partial':'unavailable';
  // Self-critique is weaker evidence, never hidden: the parent must know when
  // the text that judged a perspective was authored by the same member.
  const selfCritique=result?.independence==='self-critique';
  return {status,proposals,discussion,selfCritique,gap:safeText(result?.gap || (complete?'':'Independent council incomplete; parent must decide from available evidence.'),300)};
}
function councilBrief(result: any): string {
  const independence=result.selfCritique
    ? 'Critique independence: reduced (same member reviewed its own perspective); weigh it accordingly.\n'
    : '';
  return `Council status: ${result.status}. Advisory, not approval or verification.\n${independence}${JSON.stringify({proposals:result.proposals,discussion:result.discussion,gap:result.gap})}`;
}

/** The project-intelligence extension owns this state and supplies its existing
 * graph. Every new user input invalidates the prior council; only one ephemeral
 * brief is kept, with no extra memory database or transcript injection. */
export function createScopeDeliberation(pi: any, options: { history: (request:any)=>Promise<any>; workflow?: (ctx:any,signal:AbortSignal)=>Promise<any>; runner?: any; deadlineMs?: number }) {
  let generation=0, inputSerial=0, controller:AbortController|undefined, pending:Promise<void>|undefined;
  let key='', brief='', review='', owner='', stopped=false, pausedSerial=-1, turnSerial=-1, wakeOnly=false, evaluated=false, statusContext:any, workflow:any;
  const enabled=()=>scopeCouncilEnabled();
  const identity=(ctx:any)=>JSON.stringify([ctx?.cwd,ctx?.sessionManager?.getSessionId?.()]);
  const clearStatus=()=>{try{statusContext?.ui?.setStatus?.('scope-council',undefined);}catch{}statusContext=undefined;};
  // `pause` silences the brief for the interrupted turn, but it must not
  // outlive the input that caused the interruption. Aborts and model switches
  // can be delivered after the next user message, so a plain boolean latch
  // silently skipped the following turn's deliberation in this session.
  // Bind the live controller before aborting it: cancel() releases it so the
  // next start() builds a fresh one, and a cancelled run can never hand the
  // following turn a stale aborted controller.
  const cancel=(pause=false)=>{generation++;const live=controller;controller=undefined;live?.abort();pending=undefined;key='';brief='';review='';workflow=undefined;stopped=pause;pausedSerial=pause?turnSerial:-1;evaluated=false;clearStatus();};
  return {
    input(event:any) {
      // The SDK emits injected wakes with source 'extension' and every other
      // input (interactive, CLI, programmatic) as 'interactive'. Only the
      // latter carries current user direction.
      if(event?.source!=='extension'){inputSerial++;wakeOnly=false;cancel();}
      else wakeOnly=true;
    },
    cancel,
    context(ctx:any) { return enabled() && !stopped && identity(ctx)===owner ? brief:''; },
    reviewContext(ctx:any) { return enabled() && !stopped && identity(ctx)===owner ? review:''; },
    receipt(ctx:any) { return enabled() && !stopped && identity(ctx)===owner && key ? {requestHash:key,workflow}:undefined; },
    pending(ctx:any) { return identity(ctx)===owner ? pending:undefined; },
    async settle(ctx:any) {
      if(identity(ctx)!==owner || !pending)return;
      // before_agent_start precedes the SDK's AbortController. Wait at the
      // context boundary where the active agent signal exists, before its
      // first inference and therefore before any model-selected mutation.
      const signal=ctx.signal, ticket=generation;
      const abort=()=>{if(ticket===generation)cancel(true);};
      signal?.addEventListener('abort',abort,{once:true});
      try{if(signal?.aborted)abort();await pending;}finally{signal?.removeEventListener('abort',abort);}
    },
    async start(event:any,ctx:any,graph:string) {
      // A pause belongs to the turn that was interrupted. When that pause is
      // delivered after the next user message has already been announced (an
      // aborted assistant message or a model switch landing late), the new
      // turn must deliberate: only a pause the current turn itself earned
      // keeps it silent.
      if(stopped && pausedSerial!==inputSerial){stopped=false;pausedSerial=-1;}
      if(!enabled() || stopped) return;
      // An automatic wake before any real input has no current user direction to
      // judge. Its text still reaches the parent as ordinary context, but the
      // council must not present it as authoritative current user direction.
      if(wakeOnly && !inputSerial){owner=identity(ctx);evaluated=true;return;}
      // A real input event clears key. Automatic extension wakes, even when
      // their text sounds like another revision request, share this budget.
      if(evaluated && owner===identity(ctx)){await pending;return;}
      let branch:unknown;try{branch=ctx.sessionManager?.getBranch?.();}catch{}
      const prompt=String(event.prompt ?? '');
      const request=scopeRequest(prompt,branch);
      // Synthetic continuation wakes need not restate the user's task. Real
      // input already invalidated this brief in input().
      if(!request){if(owner!==identity(ctx))cancel();owner=identity(ctx);evaluated=true;return;}
      const nextKey=digest(`${identity(ctx)}\0${inputSerial}\0${prompt}`);
      cancel();key=nextKey;owner=identity(ctx);evaluated=true;
      turnSerial=inputSerial;
      const ticket=generation, own=new AbortController();controller=own;
      // The registered runner publishes its own limits. Reading them here keeps
      // one source of truth for the shared deadline; an explicit option still
      // wins and an older registration falls back to the bounded local default.
      const runner=options.runner ?? (globalThis as any)[SCOPE_COUNCIL_RUNNER];
      const published=runner?.limits?.deadlineMs;
      const councilDeadlineMs=options.deadlineMs ?? (typeof published==='number' && Number.isFinite(published) && published>0 ? published : SCOPE_LIMITS.deadlineMs);
      const signal=AbortSignal.any([own.signal,AbortSignal.timeout(councilDeadlineMs),...(ctx.signal?[ctx.signal]:[])]);
      const current=()=>ticket===generation && identity(ctx)===owner && !own.signal.aborted && !ctx.signal?.aborted;
      const status=(text?:string)=>{try{ctx.ui?.setStatus?.('scope-council',text);}catch{}};
      statusContext=ctx;
      status('Determining change scope from project history');
      const operation=(async()=>{
        let history:any={evidence:[],incomplete:true,coverage:'History unavailable.'}, result:any;
        try {
          const packet=await boundedAwait(Promise.all([
            options.history({cwd:ctx.cwd,currentSessionId:ctx.sessionManager?.getSessionId?.(),prompt:request,branch,signal}),
            options.workflow?.(ctx,signal),
          ]),signal);
          if(!current())return;
          [history,workflow]=packet;
          const graphContext=(workflow?'Independent version namespaces (observed references, not rollback or merge authority): '+JSON.stringify(workflow)+'\n':'')+String(graph).slice(0,1800);
          if(typeof runner==='function')result=await boundedAwait(Promise.resolve(runner({task:request,graph:graphContext.slice(0,4000),history},ctx,signal)),signal);
          if(options.workflow && current()) {
            const refreshed=await boundedAwait(options.workflow(ctx,signal),signal);
            const versionKey=(value:any)=>JSON.stringify([value?.projectId,value?.checkoutId,value?.conversation?.sessionId,value?.conversation?.latestUserEntry,value?.conversation?.nativeCheckpoint,value?.projectGit]);
            let activeBranch:any[]=[];try{activeBranch=ctx.sessionManager?.getBranch?.() ?? [];}catch{}
            const head=workflow?.conversation?.branchHead;
            const switchedBranch=head && refreshed?.conversation?.branchHead && head!==refreshed.conversation.branchHead && !activeBranch.some(e=>e?.id===head);
            if(versionKey(workflow)!==versionKey(refreshed) || switchedBranch) {
              result={status:'unavailable',gap:'Version baseline changed during deliberation. Discarded stale proposals; re-establish scope from current user direction and source.'};
              history={evidence:[],incomplete:true,coverage:'Historical packet discarded after a version baseline change.'};
              workflow=refreshed;
            }
          }
        } catch {result={status:'unavailable',gap:signal.aborted?'Scope council deadline expired; continue with explicit gaps.':'Scope council failed; continue with available evidence.'};}
        if(!current())return;
        result=normalizeCouncilResult(result);
        brief=('[Automatic change-scope deliberation]\n'+historyBrief(history)+'\n'+councilBrief(result)).slice(0,SCOPE_LIMITS.contextChars);
        review=JSON.stringify({status:result.status,proposals:result.proposals.map((p:any)=>({role:p.role,text:p.text.slice(0,180)})),discussion:result.discussion.slice(0,800),gap:result.gap.slice(0,150),history:historyBrief(history,600),note:'Condensed advisory discussion, not an accepted plan. Parent retains current user instructions and full scope brief.'});
        // Only operational receipts persist; no duplicate transcript excerpts.
        try{pi.appendEntry?.('scope-deliberation-v1',{requestHash:nextKey,status:result?.status ?? 'unavailable',evidenceCount:history?.evidence?.length ?? 0,incomplete:history?.incomplete!==false});}catch{}
      })();
      pending=operation;
      try{await operation;}finally{own.abort();if(ticket===generation){controller=undefined;pending=undefined;clearStatus();}}
    },
  };
}

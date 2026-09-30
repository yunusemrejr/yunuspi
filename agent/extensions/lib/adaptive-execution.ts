/** Shared admission policy for automatic coordination. The current scope owns
 * its evidence; a difficult parent does not make a mechanical todo difficult.
 * This policy never removes tool access, checks, user constraints or authority.
 * Deliberate tool invocations stay available. No inference or I/O is needed. */
export type ExecutionScope = 'task' | 'subtask' | 'todo';
export type ExecutionTier = 'direct' | 'standard' | 'complex' | 'critical';
export type AutomaticCapability = 'assistance' | 'council' | 'qualityReview' | 'observer' | 'watchmaker' | 'localLm' | 'jev';
export interface ExecutionInput {
  task: string;
  scope?: ExecutionScope;
  changedFiles?: number | readonly string[];
  /** Concrete separable work, rather than the number of nouns in a prompt. */
  independentWorkItems?: number;
  uncertainty?: number;
  failures?: number;
  repeatedFailures?: number;
  risk?: 'low' | 'medium' | 'high' | 'critical';
  verified?: boolean;
  /** Inherited constraints can only suppress automation, never grant authority. */
  noDelegation?: boolean;
}
export interface ExecutionProfile {
  scope: ExecutionScope;
  tier: ExecutionTier;
  reasoning: 'minimal' | 'low' | 'high';
  contextChars: number;
  reasons: string[];
  failures: number;
  constraints: { noDelegation: boolean };
  assistance: { mode: 'none' | 'subagent' | 'swarm' | 'fusion'; maxAgents: number };
  features: Record<AutomaticCapability, boolean>;
  cadence: { observerMs: number; watchmakerMs: number };
  review: { rounds: number; reviewers: number };
}

const count = (value: unknown, max = 1000) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0;
const prose = (value: unknown) => typeof value === 'string' ? value.slice(0, 32768).replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/^\s*>.*$/gm, ' ').trim() : '';
const noDelegationCue = /\b(?:do not|don't|never)\s+(?:delegate|spawn\s+(?:sub[- ]?agents?|agents?|helpers?)|use\s+(?:sub[- ]?agents?|swarms?|fusion|helpers?))\b|\bno\s+(?:sub[- ]?agents?|agents?|helpers?|delegation|swarms?|fusion|tools)\b|\bwithout tools\b/i;
// Exclusive technology choices ("only use HTML, CSS and PHP") are not model
// pins. Keep cost-only free restrictions eligible for permitted free helpers.
const restrictedRouteCue = /\b(?:only use|use only|stick to|stay on)\s+(?!(?:the\s+)?free\b)[^.!?\n;]{0,100}\b(?:models?|providers?|routes?|llms?|openrouter|anthropic|claude|openai|gpt[\w.-]*|gemini|deepseek|qwen[\w.-]*|ollama)\b/i;
const broadCue = /\b(?:multiple|cross[- ](?:service|file)|end[- ]to[- ]end|subsystems|frontend and backend)\b/i;
const alternativesCue = /\b(?:compare|alternatives|trade[- ]?offs|competing|choose between|architectural? alternatives|design decision)\b/i;
const diagnosticCue = /\b(?:debug|investigate|audit|root cause|intermittent|deadlock|race condition)\b/i;
const deliberationCue = /\b(?:architect(?:ure|ural)?|redesign|rearchitect|overhaul|rethink|migration|migrate|concurrency|finetun(?:e|ing)|fine[- ]tun(?:e|ing))\b/i;
const criticalCue = /\b(?:authentication|authorization|credentials|security|billing|payment|production deploy|deploy.{0,32}production|data loss|delete.{0,20}(?:database|production)|schema migration)\b/i;
const mechanicalCue = /\b(?:typo|spelling|whitespace|indentation|format(?:ting)?|prettier|eslint|gofmt|rustfmt|comment typo|one[- ]line)\b/i;
const behavioralCue = /\b(?:refactor|redesign|logic|behavior|behaviour|contract|api change|breaking|regression|migration|performance|security|auth|production)\b/i;
const explicitSimpleCue = /\b(?:single[- ]file|one file|one[- ]line|small|simple|just|only)\b/i;
const openWorkCue = /\b(?:create|build|design|produce|compose|make)\b[^.!?\n]{0,80}\b(?:website|webpage|landing page|music|soundtrack|animation|video|game)\b|\b(?:improve|polish|refine)\b[^.!?\n]{0,50}\b(?:design|UI|interface|animation|motion|character|experience|layout|architecture|workflow|harness|system)\b|\b(?:fix|change)\b[^.!?\n]{0,60}\b(?:clunky|distracting|annoying|unprofessional|looks? (?:bad|cheap|wrong))\b/i;

export function classifyExecution(input: ExecutionInput): ExecutionProfile {
  const text = prose(input?.task);
  const files = Array.isArray(input?.changedFiles) ? new Set(input.changedFiles.filter(value => typeof value === 'string')).size : count(input?.changedFiles);
  const failures = input?.verified ? 0 : count(input?.failures);
  const repeats = input?.verified ? 0 : count(input?.repeatedFailures);
  const uncertainty = typeof input?.uncertainty === 'number' && Number.isFinite(input.uncertainty) ? Math.max(0, Math.min(1, input.uncertainty)) : 0;
  const independent = count(input?.independentWorkItems, 8);
  const references = new Set(text.match(/\b[\w/-]+\.(?:ts|js|py|go|rs|tsx|java|php|cpp|c|sh)\b/g) ?? []).size;
  const broad = broadCue.test(text) || references >= 2 || files >= 5 || independent >= 2;
  const alternatives = alternativesCue.test(text);
  const diagnostic = diagnosticCue.test(text);
  const deliberation = deliberationCue.test(text) || openWorkCue.test(text) && !explicitSimpleCue.test(text);
  const critical = input?.risk === 'critical' || input?.risk === 'high' || criticalCue.test(text);
  const stuck = failures >= 2 || repeats >= 2;
  const mechanical = mechanicalCue.test(text) && !behavioralCue.test(text);
  const bounded = explicitSimpleCue.test(text) && !diagnostic && !deliberation && !broad;
  const reasons: string[] = [];
  let tier: ExecutionTier = 'direct';
  if (critical) { tier = 'critical'; reasons.push('high consequence scope'); }
  else if (broad || alternatives || deliberation || failures >= 3 || repeats >= 3 || uncertainty >= .8) {
    tier = 'complex';
    if (broad) reasons.push('separable or broad work');
    if (alternatives || deliberation) reasons.push('competing approaches or consequential design');
    if (failures >= 3 || repeats >= 3) reasons.push('repeated unresolved failures');
    if (uncertainty >= .8) reasons.push('high observed uncertainty');
  } else if (diagnostic || stuck || uncertainty >= .5 || files >= 3 || input?.risk === 'medium') {
    tier = 'standard'; reasons.push(diagnostic ? 'diagnosis requires evidence' : 'observed scope needs verification');
  } else reasons.push(mechanical || bounded ? 'bounded mechanical work' : 'direct work has no coordination signal');
  // Negative user constraints are fail-safe across the whole request. A long
  // task's tail must never disappear merely because routing uses a prefix.
  const constraintsText = typeof input?.task === 'string' ? input.task : '';
  const constrained = Boolean(input?.noDelegation || noDelegationCue.test(constraintsText) || restrictedRouteCue.test(constraintsText));
  const help = !constrained && (tier === 'complex' || tier === 'critical' || diagnostic || stuck || uncertainty >= .6);
  let mode: ExecutionProfile['assistance']['mode'] = help ? 'subagent' : 'none';
  let maxAgents = help ? 1 : 0;
  if (help && alternatives) { mode = 'fusion'; maxAgents = 2; }
  else if (help && broad) { mode = 'swarm'; maxAgents = Math.min(3, Math.max(2, independent || 3)); }
  if (constrained) reasons.push('automatic delegation constrained');
  const substantial = tier === 'complex' || tier === 'critical';
  return {
    scope: input?.scope ?? 'task', tier, reasons, failures, constraints: {noDelegation:constrained},
    reasoning: substantial ? 'high' : tier === 'standard' ? 'low' : 'minimal',
    contextChars: tier === 'critical' ? 16000 : tier === 'complex' ? 12000 : tier === 'standard' ? 6000 : 2400,
    assistance: { mode, maxAgents },
    features: {
      assistance: help, council: !constrained && substantial && (alternatives || deliberation),
      qualityReview: tier !== 'direct', observer: tier !== 'direct', watchmaker: substantial || stuck,
      // Cheap stages are useful only for a genuine choice. Deterministic
      // routing goes first; failing helpers never suppress mandatory guards.
      localLm: substantial || diagnostic || uncertainty >= .5,
      jev: substantial || uncertainty >= .6 || stuck,
    },
    cadence: { observerMs: tier === 'critical' ? 30000 : tier === 'complex' ? 60000 : 120000, watchmakerMs: substantial || stuck ? 120000 : 0 },
    review: { rounds: tier === 'direct' ? 0 : 2, reviewers: substantial ? 3 : 1 },
  };
}

export interface AutomaticEvidence {
  explicit?: boolean;
  required?: boolean;
  /** Stable revision + scope + capability key owned by the caller. */
  alreadySatisfied?: boolean;
  running?: boolean;
}
export function automaticCapabilityDecision(profile: ExecutionProfile, capability: AutomaticCapability, evidence: AutomaticEvidence = {}) {
  if (evidence.running) return { run: false, reason: 'equivalent work is in flight' };
  if (evidence.alreadySatisfied && !evidence.explicit) return { run: false, reason: 'current scope and revision already satisfied' };
  if (evidence.explicit || evidence.required) return { run: true, reason: 'deliberate or required capability' };
  return { run: profile.features[capability], reason: profile.features[capability] ? `${profile.tier} scope qualifies` : `${profile.tier} scope does not need automatic ${capability}` };
}

/** Delivery assurance cannot inherit only the final todo's cheap profile.
 * Whole-task source/risk and any stronger live failure evidence both remain. */
export function completionExecutionProfile(task: string, changedFiles: number | readonly string[] = [], live?: ExecutionProfile): ExecutionProfile {
  const retained = classifyExecution({task,changedFiles,failures:live?.failures,noDelegation:live?.constraints.noDelegation});
  const tiers: ExecutionTier[] = ['direct','standard','complex','critical'];
  const stronger = live && tiers.indexOf(live.tier) > tiers.indexOf(retained.tier) ? live : retained;
  return {...stronger,scope:'task'};
}

export interface ExecutionOutcome {
  ok: boolean;
  /** A passing substantive check resolves failure evidence; unrelated reads do not. */
  verified?: boolean;
  failureKey?: string;
  transient?: boolean;
  changedFiles?: number | readonly string[];
  uncertainty?: number;
}
/** Small in-memory state owned by the invoking extension. Explicit scope keys
 * isolate todos/subtasks; selecting one never inherits the parent's difficulty. */
export function createAdaptiveExecutionController(maxScopes = 64) {
  const scopes = new Map<string, { input: ExecutionInput; failures: number; repeats: number; lastFailure: string }>();
  let selected = 'task';
  const current = () => scopes.get(selected);
  const profile = () => {
    const state = current();
    return classifyExecution(state ? { ...state.input, failures: state.failures, repeatedFailures: state.repeats } : { task: '' });
  };
  return {
    begin(input: ExecutionInput, key: string = input.scope ?? 'task') {
      selected = String(key).slice(0, 160);
      const state = { input: { ...input }, failures: count(input.failures), repeats: count(input.repeatedFailures), lastFailure: '' };
      scopes.delete(selected); scopes.set(selected, state);
      const limit = Math.max(1, Math.min(256, count(maxScopes, 256) || 64));
      while (scopes.size > limit) scopes.delete(scopes.keys().next().value!);
      return profile();
    },
    select(key: string) { if (!scopes.has(key)) return undefined; selected = key; return profile(); },
    update(input: Partial<ExecutionInput>) {
      const state = current();
      if (state) {
        state.input = { ...state.input, ...input };
        if (input.failures !== undefined) state.failures = count(input.failures);
        if (input.repeatedFailures !== undefined) state.repeats = count(input.repeatedFailures);
        if (input.verified) { state.failures = 0; state.repeats = 0; state.lastFailure = ''; }
      }
      return profile();
    },
    observe(outcome: ExecutionOutcome) {
      const state = current();
      if (!state) return profile();
      if (outcome.changedFiles !== undefined) state.input.changedFiles = outcome.changedFiles;
      if (outcome.uncertainty !== undefined) state.input.uncertainty = outcome.uncertainty;
      if (outcome.verified && outcome.ok) { state.failures = 0; state.repeats = 0; state.lastFailure = ''; state.input.verified = true; }
      else if (!outcome.ok && !outcome.transient) {
        state.input.verified = false; state.failures = Math.min(1000, state.failures + 1);
        const key = String(outcome.failureKey ?? '').slice(0, 200);
        state.repeats = key && key === state.lastFailure ? state.repeats + 1 : 1; state.lastFailure = key;
      }
      return profile();
    },
    profile,
    reset() { scopes.clear(); selected = 'task'; },
  };
}

/** Share a live getter, rather than a second copy of task state. Existing
 * session owners register and dispose their getter on lifecycle changes. */
const OWNER = Symbol.for('yunus-pi.adaptive-execution.v1');
const owners = (): WeakMap<object, Map<string, () => ExecutionProfile>> => (globalThis as any)[OWNER] ??= new WeakMap();
const sessionKey = (ctx: any) => { try {
  const manager = ctx?.sessionManager;
  if (!manager || !['object','function'].includes(typeof manager)) return;
  return { manager, key: JSON.stringify([ctx.cwd ?? '', manager.getSessionId?.() ?? '', manager.getSessionFile?.() ?? '']) };
} catch { return; } };
export function registerAdaptiveExecution(ctx: any, get: () => ExecutionProfile): () => void {
  const owner = sessionKey(ctx); if (!owner) return () => {};
  let entries = owners().get(owner.manager);
  if (!entries) { entries = new Map(); owners().set(owner.manager, entries); }
  entries.set(owner.key, get);
  return () => { if (entries.get(owner.key) === get) entries.delete(owner.key); };
}
export function currentExecutionProfile(ctx: any): ExecutionProfile | undefined {
  if (!adaptiveExecutionEnabled()) return;
  const owner = sessionKey(ctx); if (!owner) return;
  try { return owners().get(owner.manager)?.get(owner.key)?.(); } catch { return; }
}
export function adaptiveExecutionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !['off','0'].includes((env.PI_ADAPTIVE_EXECUTION ?? 'on').toLowerCase());
}

/** Only native automatic helpers consume this default. Explicit configured
 * routes (including their thinking suffix) retain the user's exact setting. */
export function automaticChildThinking(profile: ExecutionProfile, route: string, configured = false): ExecutionProfile['reasoning'] | undefined {
  return !adaptiveExecutionEnabled() || configured || /:(?:off|minimal|low|medium|high|xhigh|max)$/.test(route) ? undefined : profile.reasoning;
}

const THINKING_LEVELS = ['off','minimal','low','medium','high','xhigh','max'] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];
/** Session-local thinking actuator. The configured current level is a ceiling;
 * CLI pins and later manual selections stay exact. Own setter events are
 * reconciled by transition, including asynchronous native event delivery. */
export function createAdaptiveThinkingController(pi: any, options: {argv?: readonly string[]; env?: Record<string,string|undefined>} = {}) {
  const argv = options.argv ?? process.argv;
  const cliPinned = argv.some((arg,index) => /^--thinking(?:=|$)/.test(arg)
    || /^(?:--model|-m)$/.test(arg) && /:(?:off|minimal|low|medium|high|xhigh|max)$/.test(argv[index+1] ?? '')
    || /^--model=.*:(?:off|minimal|low|medium|high|xhigh|max)$/.test(arg));
  let owner: ReturnType<typeof sessionKey>, ceiling: ThinkingLevel | undefined, lastAuto: ThinkingLevel | undefined, manual = cliPinned;
  const pending: Array<{level:ThinkingLevel;previousLevel:ThinkingLevel}> = [];
  const read = (): ThinkingLevel | undefined => { try { const level = pi.getThinkingLevel?.(); return THINKING_LEVELS.includes(level) ? level : undefined; } catch { return; } };
  const sameOwner = (ctx: any) => { const next=sessionKey(ctx);return !!owner && !!next && owner.manager===next.manager && owner.key===next.key; };
  const set = (level: ThinkingLevel, current: ThinkingLevel) => {
    if (level===current) return current;
    const transition={level,previousLevel:current}; pending.push(transition); if(pending.length>32)pending.shift();
    try { pi.setThinkingLevel(level); return read() ?? current; }
    catch { const index=pending.indexOf(transition);if(index>=0)pending.splice(index,1);return current; }
  };
  const restore = (ctx: any) => {
    const current=read();
    if(!sameOwner(ctx) || !current || manual || !ceiling || lastAuto===undefined)return current;
    if(current!==lastAuto){manual=true;ceiling=current;lastAuto=undefined;return current;}
    const restored=set(ceiling,current);lastAuto=undefined;return restored;
  };
  const begin = (ctx: any) => {
    const same=sameOwner(ctx);if(same)restore(ctx);else manual=cliPinned;
    owner=sessionKey(ctx);ceiling=read();lastAuto=undefined;
  };
  return {
    begin,
    update(profile: ExecutionProfile, ctx: any) {
      if(!sameOwner(ctx))begin(ctx);
      const current=read();if(!current || !ceiling || typeof pi.setThinkingLevel!=='function')return current;
      if(!adaptiveExecutionEnabled(options.env ?? process.env)){restore(ctx);return read();}
      if(manual || cliPinned || ceiling==='off')return current;
      if(lastAuto!==undefined && current!==lastAuto){manual=true;ceiling=current;lastAuto=undefined;return current;}
      const limit=THINKING_LEVELS.indexOf(ceiling),desired=Math.min(limit,THINKING_LEVELS.indexOf(profile.reasoning));
      const map=ctx?.model?.thinkingLevelMap;
      const available=THINKING_LEVELS.filter((level,index)=>index<=limit && (ctx?.model?.reasoning!==false || level==='off')
        && map?.[level]!==null && (!(level==='xhigh'||level==='max') || map?.[level]!==undefined));
      const below=available.filter(level=>THINKING_LEVELS.indexOf(level)<=desired);
      const target=below.at(-1) ?? available[0] ?? current;
      const applied=set(target,current);lastAuto=applied;return applied;
    },
    onSelection(event: {level?:string;previousLevel?:string}, ctx: any) {
      const index=pending.findIndex(row=>row.level===event.level && row.previousLevel===event.previousLevel);
      if(index>=0){pending.splice(index,1);return;}
      if(!sameOwner(ctx))begin(ctx);
      if(THINKING_LEVELS.includes(event.level as ThinkingLevel)){manual=true;ceiling=event.level as ThinkingLevel;lastAuto=undefined;}
    },
    restore,
    reset(ctx?: any) { if(ctx)restore(ctx);owner=undefined;ceiling=undefined;lastAuto=undefined;manual=cliPinned; },
    state:()=>({ceiling,lastAuto,manual,cliPinned}),
  };
}

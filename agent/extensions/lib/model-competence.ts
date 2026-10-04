/** Online competence estimate for the route that is executing a session.
 *
 * Oversight (observers, reviewers, helpers, reasoning effort) is a cost paid to
 * lower the expected cost of mistakes, so it should follow the measured rate of
 * wasted work, never a model name. Measured on 20k recorded tool steps, model
 * mistakes have two structures and the estimator treats each on its own scale:
 *
 *   burst      A slip makes the next ones 3x likelier for about five steps
 *              (self-excitation): two slips among three steps predict another
 *              within five steps 31% of the time against a 10.7% base rate.
 *              A burst is a short transient with a targeted response.
 *   baseline   Between sessions and routes the long-run slip rate differs only
 *              by about 2x, so telling 4% from 8% needs roughly 200 weighted
 *              observations: long memory plus aged history from earlier
 *              sessions of the same route. The confidence interval of the
 *              weighted slip rate is compared with the fleet's own rate, so the
 *              thresholds follow this installation, and maps to a level with
 *              hysteresis:
 *                earned    the whole interval is below the freedom threshold
 *                standard  not enough evidence, or evidence in between
 *                guarded   the whole interval is above the tightening threshold
 *
 * Evidence decides in both directions: freedom needs the UPPER bound to be low
 * (trust is earned, not assumed), tightening needs the LOWER bound to be high
 * (a noisy streak is not unreliability). Pure and synchronous: no I/O, no
 * inference, no clock. The extension owns persistence and delivery. */
import { createHash } from 'node:crypto';

export type OutcomeClass = 'clean' | 'slip' | 'check' | 'stall' | 'reversal' | 'gate' | 'neutral';
export type ControlLevel = 'earned' | 'standard' | 'guarded';

export interface StepOutcome {
  cls: OutcomeClass;
  /** Share of a full model-attributable slip this outcome counts as (clean outcomes: evidence weight). */
  weight: number;
  /** Family of the step: a later clean outcome of the same family closes an open slip. */
  family: string;
}

const WASTE_CLASSES = new Set<OutcomeClass>(['slip', 'check', 'stall', 'reversal', 'gate']);
/** Classes that leave an open slip until the family succeeds again; a failing check is resolved by the project-test owner, a gate by its own call. */
const OPEN_CLASSES = new Set<OutcomeClass>(['slip', 'stall', 'reversal']);
/** A strong slip is a clear model-attributable mistake; weaker evidence never starts a burst. */
const isStrongSlip = (outcome: StepOutcome) => OPEN_CLASSES.has(outcome.cls) && outcome.weight >= 0.5;

export interface ToolOutcomeInput {
  toolName: string;
  isError: boolean;
  /** Result text; only the first 800 characters are read. */
  text?: string;
  /** True when the command is a recognised project check (test, build, lint). */
  check?: boolean;
  /** Identical call and result with no workspace change in between. */
  repeated?: boolean;
  /** An edit whose new text restores text an earlier edit removed from the same file. */
  reversed?: boolean;
}

// Calls that wait or poll are not decisions: their results say nothing about the model.
const PASSIVE_TOOLS = new Set(['wait', 'wait_agent', 'sleep', 'clock', 'process', 'bg_status', 'bg_logs', 'bg_kill', 'subagent_wait']);
const MUTATING_TOOLS = new Set(['edit', 'write', 'bulk_edit']);

const ENVIRONMENT = /\b(?:ECONN\w*|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|rate[- ]?limit|overloaded|too many requests|service unavailable|bad gateway|gateway time-?out|Provider stream idle|timed? ?out|deadline exceeded|Command aborted|operation was aborted|cancelled by user|session change or shutdown|connection (?:refused|reset)|unreachable|net::ERR_|\b(?:429|502|503|504)\b)/i;
const SCHEMA = /Validation failed for tool|must have required propert|must not have more than|must be (?:object|array|string|number|integer|equal to constant)|must match a schema|additionalProperties|unknown (?:option|parameter|field|agent)|(?:is|are) not supported\b|Tool \S+ not found|Unknown agent|requires? (?:an? )?(?:HTTP|action|path|url)/i;
const EDIT_MISS = /Could not find (?:the exact text|edits?\[)|did not match|must match exactly|\boverlap in\b|No match for|oldText/i;
const READ_FIRST = /No verified read-tool coverage|Read the current file with read before editing|Before edit on|must read (?:the )?file/i;
const MISSING_PATH = /\bENOENT\b|no such file or directory|does not exist|source not found|not found:?\s*["'`/~.]/i;
const GUARD = /\bBlocked:|protected path|not allowed|\brefus(?:ed|al)\b|permission denied|\bdenied\b|requires? (?:a )?new human-started session|outside the harness maintenance/i;
const GATE = /refused: verification is unresolved|must be resolved|unresolved|Resolve these first|run or complete the current review|not accepted|Independent review (?:unavailable|pending)|Complete dependencies before|Reopen the parent before/i;
const SHELL_SLIP = /command not found|syntax error|unexpected (?:token|EOF)|unrecognized (?:option|arguments?)|invalid option|unknown option|usage:|bad substitution|No such file or directory/i;

/** Classify one finished tool call. Heuristic on purpose: weights are small for
 * ambiguous causes so the estimate is driven by clear, repeated evidence. */
export function classifyToolOutcome(input: ToolOutcomeInput): StepOutcome {
  const tool = String(input?.toolName ?? '');
  const family = tool || 'unknown';
  if (!input.isError) {
    if (PASSIVE_TOOLS.has(tool)) return { cls: 'neutral', weight: 0, family };
    if (input.reversed) return { cls: 'reversal', weight: 0.8, family };
    if (input.repeated) return { cls: 'stall', weight: tool === 'bash' || tool === 'bg_run' ? 0.4 : 0.8, family };
    // A passing check closes every open slip: the work verifiably recovered.
    return { cls: 'clean', weight: 1, family: input.check ? 'check' : family };
  }
  const text = String(input.text ?? '').slice(0, 800);
  if (ENVIRONMENT.test(text)) return { cls: 'neutral', weight: 0, family };
  if (SCHEMA.test(text)) return { cls: 'slip', weight: 1, family };
  if (MUTATING_TOOLS.has(tool)) {
    if (EDIT_MISS.test(text)) return { cls: 'slip', weight: 1, family };
    if (READ_FIRST.test(text)) return { cls: 'slip', weight: 0.6, family };
    if (MISSING_PATH.test(text)) return { cls: 'slip', weight: 0.7, family };
  }
  if ((tool === 'read' || tool === 'ls' || tool === 'find') && MISSING_PATH.test(text)) return { cls: 'slip', weight: 0.7, family };
  if (GATE.test(text)) return { cls: 'gate', weight: 0.5, family };
  if (tool === 'bash' || tool === 'bg_run') {
    // `grep` finding nothing exits 1 with no output; that is an answer, not a mistake.
    if (/^\s*\(no output\)\s*Command exited with code 1\s*$/i.test(text)) return { cls: 'neutral', weight: 0, family };
    if (SHELL_SLIP.test(text) && !input.check) return { cls: 'slip', weight: 0.8, family };
    if (GUARD.test(text)) return { cls: 'slip', weight: 0.5, family };
    // A failing build or test after the model's change is expected iteration.
    return { cls: 'check', weight: input.check ? 0.35 : 0.3, family: input.check ? 'check' : family };
  }
  if (GUARD.test(text)) return { cls: 'slip', weight: 0.5, family };
  if (tool === 'project_tests') return { cls: 'check', weight: 0.35, family: 'check' };
  return { cls: 'slip', weight: 0.3, family };
}

const digest = (value: string) => createHash('sha1').update(value).digest('hex').slice(0, 16);
const stable = (value: unknown, budget = { chars: 6000 }): string => {
  if (value === null || typeof value !== 'object') { const text = JSON.stringify(value) ?? 'undefined'; budget.chars -= text.length; return budget.chars < 0 ? '' : text; }
  if (Array.isArray(value)) return `[${value.map(item => stable(item, budget)).join(',')}]`;
  return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${stable((value as any)[key], budget)}`).join(',')}}`;
};

/** Detects waste that needs memory across calls: an identical call returning an
 * identical result while the workspace did not change, and an edit that undoes
 * an earlier edit of the same file. The caller supplies workspace-change truth. */
export function createStepTracker(maxEntries = 256) {
  const seen = new Map<string, { result: string; epoch: number }>();
  const removed = new Map<string, Set<string>>();
  let epoch = 0;
  const editPairs = (args: any): Array<{ oldText: string; newText: string }> => {
    const rows = Array.isArray(args?.edits) ? args.edits : args && typeof args === 'object' ? [args] : [];
    return rows.flatMap((row: any) => typeof row?.oldText === 'string' && typeof row?.newText === 'string' ? [{ oldText: row.oldText, newText: row.newText }] : []);
  };
  return {
    /** `mutated`: this call changed the workspace (a successful edit, or a command that wrote files). */
    track(input: { toolName: string; args: unknown; text: string; isError: boolean; mutated: boolean }): { repeated: boolean; reversed: boolean } {
      const tool = input.toolName;
      let reversed = false;
      if (!input.isError && tool === 'edit') {
        const path = typeof (input.args as any)?.path === 'string' ? (input.args as any).path : '';
        if (path) {
          const known = removed.get(path) ?? new Set<string>();
          for (const pair of editPairs(input.args)) {
            if (pair.newText.length >= 12 && known.has(digest(pair.newText))) reversed = true;
            if (pair.oldText.length >= 12) known.add(digest(pair.oldText));
          }
          removed.set(path, known);
          if (removed.size > 64) removed.delete(removed.keys().next().value!);
        }
      }
      if (input.mutated || MUTATING_TOOLS.has(tool) && !input.isError) epoch++;
      const key = `${tool}:${digest(stable(input.args))}`;
      const result = digest(input.text.slice(0, 4000));
      const previous = seen.get(key);
      const repeated = !input.isError && !input.mutated && !MUTATING_TOOLS.has(tool) && previous !== undefined && previous.result === result && previous.epoch === epoch;
      seen.delete(key); seen.set(key, { result, epoch });
      while (seen.size > maxEntries) seen.delete(seen.keys().next().value!);
      return { repeated, reversed };
    },
  };
}

export interface CompetencePrior {
  /** Weighted slip rate carried over from earlier sessions of this route. */
  rate: number;
  /** Pseudo-observations the prior is worth; it decays like any observation as evidence accumulates. */
  strength: number;
}

/** Calibrated on 20,581 recorded tool steps from 162 sessions (fleet weighted
 * slip rate 3.8%, strong slips 2.4%, bursts on about 1.8% of steps). The
 * thresholds are multiples of the fleet's own rate. See docs/COMPETENCE-CONTROL.md. */
export const COMPETENCE_PARAMS = Object.freeze({
  /** Baseline forgetting per observation: half-life of about 138 steps, at most 200 effective observations. */
  decay: 0.995,
  /** Fleet rate used until the store has enough history to know the installation's own. */
  neutralRate: 0.038,
  neutralStrength: 8,
  maxPriorStrength: 60,
  /** One-sided confidence for the bounds: freedom is granted at 85%, tightening needs 90%. */
  zEarned: 1.04,
  zGuarded: 1.28,
  /** Level thresholds as multiples of the fleet rate, with absolute clamps. */
  enterEarned: 1.2,
  exitEarned: 1.6,
  enterGuarded: 1.4,
  exitGuarded: 1.0,
  minRate: 0.015,
  maxRate: 0.12,
  /** Freedom needs this many effective observations (session plus decayed history). */
  minMassEarned: 60,
  minStepsGuarded: 10,
  /** Steps a level is kept before it may change again. */
  dwell: 12,
  /** An unrepaired slip counts as abandoned (the approach changed) after this many steps. */
  openTtl: 12,
  /** Burst: this many strong slips among the last `burstSpan` steps, held for `burstHold` steps. */
  burstSlips: 2,
  burstSpan: 3,
  burstHold: 5,
});

/** Wilson score interval for a proportion measured over `n` effective observations. */
export function wilsonBounds(p: number, n: number, z: number): { lo: number; hi: number } {
  if (!(n > 0)) return { lo: 0, hi: 1 };
  const clamped = Math.min(1, Math.max(0, p)), z2 = z * z;
  const denominator = 1 + z2 / n, center = clamped + z2 / (2 * n);
  const margin = z * Math.sqrt(clamped * (1 - clamped) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, (center - margin) / denominator), hi: Math.min(1, (center + margin) / denominator) };
}

export interface ControlSnapshot {
  level: ControlLevel;
  /** Weighted share of steps lost to model-attributable mistakes, with the interval used for the current decision. */
  slip: { rate: number; low: number; high: number };
  /** The fleet rate the thresholds were derived from. */
  fleet: number;
  /** Observations this session (not decayed). */
  steps: number;
  /** Families with a slip that has not been followed by a clean step of the same family. */
  open: number;
  /** A burst of slips is in progress: the family that keeps failing, while it lasts. */
  burst?: { family: string; slips: number };
  /** Why the level is what it is, in a sentence suitable for a status line. */
  reason: string;
}

export interface CompetenceDelta {
  /** Additive contribution for persistence: undecayed weighted slips and observations since the last take. */
  slip: number;
  mass: number;
}

const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** One estimator per (session, route). `fleetRate` is the installation's own weighted slip rate. */
export function createCompetenceEstimator(prior?: CompetencePrior, options: { fleetRate?: number } = {}) {
  const P = COMPETENCE_PARAMS;
  const fleet = clamp(Number.isFinite(options.fleetRate) ? options.fleetRate! : P.neutralRate, P.minRate, P.maxRate);
  const earnedEnter = clamp(P.enterEarned * fleet, P.minRate, P.maxRate), earnedExit = clamp(P.exitEarned * fleet, P.minRate, P.maxRate);
  const guardedEnter = clamp(P.enterGuarded * fleet, P.minRate, P.maxRate), guardedExit = clamp(P.exitGuarded * fleet, P.minRate, P.maxRate);
  const hasPrior = Boolean(prior) && Number.isFinite(prior!.strength) && prior!.strength > 0 && Number.isFinite(prior!.rate);
  let priorMass = hasPrior ? Math.min(P.maxPriorStrength, prior!.strength) : P.neutralStrength;
  const rate0 = hasPrior ? clamp(prior!.rate, 0.005, 0.5) : fleet;
  let slip = 0, mass = 0, steps = 0;
  const open = new Map<string, number>();
  let level: ControlLevel = 'standard', levelSince = 0, reason = 'no evidence yet';
  const strongSlips: Array<{ step: number; family: string }> = [];
  let burstUntil = 0, burstFamily = '', burstSlips = 0;
  const pending = { slip: 0, mass: 0 };

  const estimate = () => {
    // The prior decays like any observation, so history fades as evidence accumulates.
    const n = mass + priorMass, rate = (slip + rate0 * priorMass) / n;
    const up = wilsonBounds(rate, n, P.zEarned).hi, down = wilsonBounds(rate, n, P.zGuarded).lo;
    return { n, rate, low: down, high: up };
  };
  const decide = (): void => {
    for (const [family, started] of open) if (steps - started >= P.openTtl) open.delete(family);
    const e = estimate();
    let next = level;
    if (steps - levelSince >= P.dwell) {
      if (level === 'earned') {
        if (e.low > guardedEnter && steps >= P.minStepsGuarded) { next = 'guarded'; reason = `slip rate ${pct(e.rate)} (at least ${pct(e.low)}) against a ${pct(fleet)} fleet rate`; }
        else if (e.high > earnedExit || open.size > 1) { next = 'standard'; reason = open.size > 1 ? 'unrepaired slips' : `slip rate up to ${pct(e.high)}`; }
      } else if (level === 'guarded') {
        if (e.low < guardedExit) { next = e.high < earnedEnter && e.n >= P.minMassEarned ? 'earned' : 'standard'; reason = `slip rate back to ${pct(e.rate)}`; }
      } else if (e.low > guardedEnter && steps >= P.minStepsGuarded) { next = 'guarded'; reason = `slip rate ${pct(e.rate)} (at least ${pct(e.low)}) against a ${pct(fleet)} fleet rate`; }
      else if (e.high < earnedEnter && e.n >= P.minMassEarned && open.size === 0) { next = 'earned'; reason = `slip rate ${pct(e.rate)} (at most ${pct(e.high)}) over ${Math.round(e.n)} weighted observations, fleet ${pct(fleet)}`; }
    }
    if (next !== level) { level = next; levelSince = steps; }
    else if (level === 'standard') reason = e.n < P.minMassEarned ? `${Math.round(e.n)} weighted observations; trust needs ${P.minMassEarned}` : `slip rate ${pct(e.rate)} (${pct(e.low)}-${pct(e.high)}) is between the thresholds, fleet ${pct(fleet)}`;
  };

  return {
    observe(outcome: StepOutcome): ControlSnapshot {
      if (!outcome || outcome.cls === 'neutral' || !(outcome.weight > 0)) return this.snapshot();
      steps++;
      const waste = WASTE_CLASSES.has(outcome.cls), w = Math.min(1, outcome.weight);
      slip = slip * P.decay + (waste ? w : 0);
      mass = mass * P.decay + 1;
      priorMass *= P.decay;
      pending.slip += waste ? w : 0;
      pending.mass += 1;
      if (isStrongSlip(outcome)) {
        strongSlips.push({ step: steps, family: outcome.family }); if (strongSlips.length > 4) strongSlips.shift();
        const within = strongSlips.filter(row => steps - row.step < P.burstSpan);
        if (within.length >= P.burstSlips) {
          burstUntil = steps + P.burstHold; burstSlips = within.length;
          // The family that keeps failing: the most common one among the burst's slips.
          const counts = new Map<string, number>(); for (const row of within) counts.set(row.family, (counts.get(row.family) ?? 0) + 1);
          burstFamily = [...counts].sort((a, b) => b[1] - a[1])[0][0];
        }
      }
      if (waste) { if (OPEN_CLASSES.has(outcome.cls) && !open.has(outcome.family)) open.set(outcome.family, steps); }
      else {
        // A clean outcome of the same family, or any passing check, closes the open slip.
        if (outcome.family === 'check') open.clear(); else open.delete(outcome.family);
        // A clean step of the failing family ends the burst early: the repair worked.
        if (steps <= burstUntil && outcome.family === burstFamily) burstUntil = 0;
      }
      decide();
      return this.snapshot();
    },
    snapshot(): ControlSnapshot {
      const e = estimate();
      return { level, slip: { rate: e.rate, low: e.low, high: e.high }, fleet, steps, open: open.size, ...(steps <= burstUntil ? { burst: { family: burstFamily, slips: burstSlips } } : {}), reason };
    },
    /** Contribution since the last take, for the persisted route aggregate (which ages it by days, not steps). */
    takeDelta(): CompetenceDelta { const out = { slip: pending.slip, mass: pending.mass }; pending.slip = 0; pending.mass = 0; return out; },
  };
}

/** Stored per-route aggregate: exponentially aged sums, so recent sessions dominate. */
export interface CompetenceAggregate { slip: number; mass: number; updatedAt: number }
export const COMPETENCE_HALF_LIFE_DAYS = 14;
const aged = (stored: CompetenceAggregate | undefined, now: number) => stored
  ? Math.pow(0.5, Math.max(0, now - stored.updatedAt) / 86_400_000 / COMPETENCE_HALF_LIFE_DAYS) : 0;
export function mergeCompetence(stored: CompetenceAggregate | undefined, delta: CompetenceDelta, now: number): CompetenceAggregate {
  const keep = aged(stored, now);
  const finite = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;
  return {
    slip: (stored?.slip ?? 0) * keep + finite(delta.slip),
    mass: (stored?.mass ?? 0) * keep + finite(delta.mass),
    updatedAt: now,
  };
}

/** Prior for a new session of a route: its aged history, worth up to the cap. */
export function priorFromAggregate(stored: CompetenceAggregate | undefined, now: number): CompetencePrior | undefined {
  if (!stored || !(stored.mass > 1)) return undefined;
  const mass = stored.mass * aged(stored, now);
  if (!(mass > 1)) return undefined;
  return { rate: stored.slip / stored.mass, strength: Math.min(COMPETENCE_PARAMS.maxPriorStrength, mass) };
}

/** Fleet rate from the all-routes aggregate; the neutral rate until it has enough mass to be trusted. */
export function fleetRateFromAggregate(stored: CompetenceAggregate | undefined, now: number): number {
  const prior = priorFromAggregate(stored, now);
  return prior && stored && stored.mass * aged(stored, now) >= 150 ? prior.rate : COMPETENCE_PARAMS.neutralRate;
}

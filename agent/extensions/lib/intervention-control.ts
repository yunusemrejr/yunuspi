// intervention-control — one arbitration owner for automatic interventions.
//
// Every subsystem that wants to inject model context, recommend a skill,
// launch automatic assistance, request a review, or issue a checkpoint
// submits an InterventionIntent HERE instead of acting directly. Safety
// blocking stays separate: actual enforcement remains authoritative and
// never routes through this layer.
//
// Pure and additive: no pi imports, no I/O, no behavior change on its own.
// Wiring (session binding, shadow mode, live arbitration) lands with the
// rollout phases; this file owns only the schema, the request-cycle
// identity, budget envelopes, dedup semantics, and the decision audit log.
//
// Budgets are PER REQUEST CYCLE: each user input begins a cycle, and all
// continuations, tool results, helpers, reviews, checkpoints and guidance
// triggered by that input share it. A continuation is never a fresh
// opportunity to spend again.
//
// Two-phase API separates observation from enforcement:
//   evaluate(intent) — what WOULD happen (shadow-safe, spends nothing)
//   commit(intent)   — evaluate + spend (idempotent per intent id)

export type InterventionCategory =
  | "context"
  | "guidance"
  | "assistance"
  | "review"
  | "checkpoint";

export interface InterventionEvidenceRef {
  kind: string;
  id: string;
  hash?: string;
}

export interface InterventionIntent {
  id?: string;
  /** Owning subsystem, e.g. "project-intelligence.ts". Never a model tool. */
  source: string;
  /** Canonical request/cycle id from beginCycle(). */
  requestId: string;
  category: InterventionCategory;
  /** 0-100, higher matters more. Recorded and reported; no preemption yet. */
  priority: number;
  /** Human-readable why, 1-500 chars. Over-long is rejected, never cut. */
  reason: string;
  /** Dedup identity within (category, stabilityKey, contentHash). */
  stabilityKey: string;
  /** Semantic content hash; same key + same hash reuses, never re-spends. */
  contentHash?: string;
  /** Intent lifetime in ms, 0..24h. */
  ttlMs: number;
  /** Declared context cost in chars (charged for context/guidance/checkpoint). */
  estimatedChars: number;
  /** Declared USD cost (charged for assistance; envelope for review follow-ons). */
  estimatedCost: number;
  /** Sync-critical (blocking) vs deferrable. Recorded; same budget rules. */
  blocking: boolean;
  /** Target stable context slot (slots land with composition ownership). */
  slot?: string;
  evidence: InterventionEvidenceRef[];
  /** Epoch ms; defaults to the control clock at evaluate/commit time. */
  createdAt?: number;
}

export interface InterventionBudgets {
  /** Shared automatic context-addition envelope per cycle, in chars. */
  contextChars: number;
  /** Automatic helper launches per cycle. Conservative: one by default. */
  helperChildren: number;
  /** Automatic helper spend per cycle, in USD. */
  helperCost: number;
  /** Review escalations per cycle. */
  reviewEscalations: number;
  /** Synchronous hook-processing envelope per cycle, in ms. */
  hookLatencyMs: number;
}

/** Conservative starting envelopes. Tune only after the architecture is
 *  stable — and there is exactly one place where each threshold matters. */
export const DEFAULT_BUDGETS: InterventionBudgets = {
  contextChars: 12000,
  helperChildren: 1,
  helperCost: 0.05,
  reviewEscalations: 1,
  hookLatencyMs: 500,
};

export type DecisionOutcome =
  | "admitted"
  | "suppressed-duplicate"
  | "suppressed-budget"
  | "suppressed-stale"
  | "suppressed-expired"
  | "rejected-invalid";

export interface InterventionDecision {
  outcome: DecisionOutcome;
  intentId: string;
  requestId: string;
  category: InterventionCategory;
  priority: number;
  /** Stable machine-readable explanation, e.g. "budget:contextChars". */
  reason: string;
  at: number;
}

interface CycleRecord {
  id: string;
  seq: number;
  label: string;
  beganAt: number;
  endedAt: number | null;
}

interface DedupEntry {
  expiresAt: number;
  intentId: string;
}

const CATEGORIES: InterventionCategory[] = ["context", "guidance", "assistance", "review", "checkpoint"];
const MAX_LOG = 512;
const MAX_DEDUP = 1024;
const MAX_CYCLES = 32;
const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max;
const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function validateIntent(intent: any): string | null {
  if (!intent || typeof intent !== "object") return "intent-not-object";
  if (!boundedString(intent.source, 160)) return "source";
  if (!boundedString(intent.requestId, 64)) return "requestId";
  if (!CATEGORIES.includes(intent.category)) return "category";
  if (!finiteNumber(intent.priority) || intent.priority < 0 || intent.priority > 100) return "priority";
  if (!boundedString(intent.reason, 500)) return "reason";
  if (!boundedString(intent.stabilityKey, 160)) return "stabilityKey";
  if (intent.contentHash !== undefined && !(typeof intent.contentHash === "string" && intent.contentHash.length <= 128))
    return "contentHash";
  if (!finiteNumber(intent.ttlMs) || intent.ttlMs < 0 || intent.ttlMs > 86400000) return "ttlMs";
  if (!finiteNumber(intent.estimatedChars) || intent.estimatedChars < 0 || intent.estimatedChars > 1e9)
    return "estimatedChars";
  if (!finiteNumber(intent.estimatedCost) || intent.estimatedCost < 0 || intent.estimatedCost > 1e6)
    return "estimatedCost";
  if (typeof intent.blocking !== "boolean") return "blocking";
  if (intent.slot !== undefined && !(typeof intent.slot === "string" && intent.slot.length <= 64)) return "slot";
  if (!Array.isArray(intent.evidence)) return "evidence";
  for (const ref of intent.evidence) {
    if (!ref || typeof ref !== "object") return "evidence-entry";
    if (!boundedString(ref.kind, 64) || !boundedString(ref.id, 160)) return "evidence-entry";
    if (ref.hash !== undefined && !(typeof ref.hash === "string" && ref.hash.length <= 128)) return "evidence-entry";
  }
  if (intent.createdAt !== undefined && !finiteNumber(intent.createdAt)) return "createdAt";
  return null;
}

export interface InterventionControlOptions {
  budgets?: Partial<InterventionBudgets>;
  clock?: () => number;
  idSource?: () => string;
}

export class InterventionControl {
  private budgets: InterventionBudgets;
  private clock: () => number;
  private idSource: () => string;
  private seq = 0;
  private idSeq = 0;
  private cycles = new Map<string, CycleRecord>();
  private current: string | null = null;
  private spent = { contextChars: 0, helperChildren: 0, helperCost: 0, reviewEscalations: 0, hookLatencyMs: 0 };
  private dedup = new Map<string, DedupEntry>();
  private committed = new Map<string, InterventionDecision>();
  private log: { at: number; outcome: DecisionOutcome; intentId: string; category: InterventionCategory; source: string; requestId: string; shadow: boolean }[] = [];
  private admittedCount = 0;
  private suppressedCount = 0;

  constructor(options: InterventionControlOptions = {}) {
    this.budgets = { ...DEFAULT_BUDGETS, ...(options.budgets ?? {}) };
    this.clock = options.clock ?? (() => Date.now());
    this.idSource = options.idSource ?? (() => `in-${++this.idSeq}`);
  }

  /** Begin one canonical request cycle. Resets per-cycle spend. */
  beginCycle(label = ""): string {
    const id = `c${++this.seq}`;
    const now = this.clock();
    if (this.current) {
      const prev = this.cycles.get(this.current);
      if (prev && prev.endedAt === null) prev.endedAt = now;
    }
    this.cycles.set(id, { id, seq: this.seq, label: label.slice(0, 120), beganAt: now, endedAt: null });
    while (this.cycles.size > MAX_CYCLES) this.cycles.delete(this.cycles.keys().next().value!);
    this.current = id;
    this.spent = { contextChars: 0, helperChildren: 0, helperCost: 0, reviewEscalations: 0, hookLatencyMs: 0 };
    return id;
  }

  currentCycle(): string | null {
    return this.current;
  }

  endCycle(id: string): boolean {
    const record = this.cycles.get(id);
    if (!record || record.endedAt !== null) return false;
    record.endedAt = this.clock();
    if (this.current === id) this.current = null;
    return true;
  }

  /** Shadow-safe: computes the decision without spending or recording dedup. */
  evaluate(raw: InterventionIntent): InterventionDecision {
    return this.decide(raw, true);
  }

  /** Evaluate + spend. Idempotent per intent id: re-commits replay the stored decision. */
  commit(raw: InterventionIntent): InterventionDecision {
    if (raw && typeof raw.id === "string" && this.committed.has(raw.id)) return this.committed.get(raw.id)!;
    const decision = this.decide(raw, false);
    this.committed.set(decision.intentId, decision);
    while (this.committed.size > MAX_DEDUP) this.committed.delete(this.committed.keys().next().value!);
    return decision;
  }

  /** Out-of-band hook-latency observation against the per-cycle envelope. */
  noteHookLatency(ms: number): void {
    if (finiteNumber(ms) && ms > 0) this.spent.hookLatencyMs += ms;
  }

  latencyExceeded(): boolean {
    return this.spent.hookLatencyMs > this.budgets.hookLatencyMs;
  }

  spentBudget(): InterventionBudgets {
    return { ...this.spent };
  }

  remainingBudget(): InterventionBudgets {
    return {
      contextChars: this.budgets.contextChars - this.spent.contextChars,
      helperChildren: this.budgets.helperChildren - this.spent.helperChildren,
      helperCost: this.budgets.helperCost - this.spent.helperCost,
      reviewEscalations: this.budgets.reviewEscalations - this.spent.reviewEscalations,
      hookLatencyMs: this.budgets.hookLatencyMs - this.spent.hookLatencyMs,
    };
  }

  /** Compact state for diagnostics surfaces (never model-visible). */
  snapshot(): {
    cycle: string | null; cycles: number; budgets: InterventionBudgets; spent: InterventionBudgets;
    remaining: InterventionBudgets; latencyExceeded: boolean; admitted: number; suppressed: number;
    recent: { at: number; outcome: DecisionOutcome; intentId: string; category: InterventionCategory; source: string; requestId: string; shadow: boolean }[];
  } {
    return {
      cycle: this.current,
      cycles: this.seq,
      budgets: { ...this.budgets },
      spent: this.spentBudget(),
      remaining: this.remainingBudget(),
      latencyExceeded: this.latencyExceeded(),
      admitted: this.admittedCount,
      suppressed: this.suppressedCount,
      recent: this.log.slice(-20),
    };
  }

  private decide(raw: InterventionIntent, shadow: boolean): InterventionDecision {
    const now = this.clock();
    const invalid = validateIntent(raw);
    if (!raw || typeof raw !== "object" || invalid) {
      return this.record({
        outcome: "rejected-invalid", intentId: "none", requestId: "none",
        category: "context", priority: 0, reason: `invalid:${invalid ?? "not-object"}`, at: now,
      }, "unknown", shadow);
    }
    if (!raw.id) raw.id = this.idSource();
    if (!finiteNumber(raw.createdAt)) raw.createdAt = now;
    const intent = raw as Required<Pick<InterventionIntent, "id" | "createdAt">> & InterventionIntent;
    const cycle = this.cycles.get(intent.requestId);
    if (!cycle) {
      return this.record({
        outcome: "rejected-invalid", intentId: intent.id, requestId: intent.requestId,
        category: intent.category, priority: intent.priority, reason: "invalid:unknown-cycle", at: now,
      }, intent.source, shadow);
    }
    if (cycle.endedAt !== null || intent.requestId !== this.current) {
      return this.record({
        outcome: "suppressed-stale", intentId: intent.id, requestId: intent.requestId,
        category: intent.category, priority: intent.priority, reason: "stale:cycle-ended", at: now,
      }, intent.source, shadow);
    }
    if (now > intent.createdAt! + intent.ttlMs) {
      return this.record({
        outcome: "suppressed-expired", intentId: intent.id, requestId: intent.requestId,
        category: intent.category, priority: intent.priority, reason: "expired:ttl", at: now,
      }, intent.source, shadow);
    }
    this.pruneDedup(now);
    const key = `${intent.category}|${intent.stabilityKey}|${intent.contentHash ?? ""}`;
    const dup = this.dedup.get(key);
    if (dup && now < dup.expiresAt) {
      return this.record({
        outcome: "suppressed-duplicate", intentId: intent.id, requestId: intent.requestId,
        category: intent.category, priority: intent.priority, reason: `duplicate-of:${dup.intentId}`, at: now,
      }, intent.source, shadow);
    }
    const over = this.overBudget(intent);
    if (over) {
      return this.record({
        outcome: "suppressed-budget", intentId: intent.id, requestId: intent.requestId,
        category: intent.category, priority: intent.priority, reason: `budget:${over}`, at: now,
      }, intent.source, shadow);
    }
    if (!shadow) {
      this.spend(intent);
      this.dedup.set(key, { expiresAt: now + Math.max(intent.ttlMs, 1000), intentId: intent.id! });
      while (this.dedup.size > MAX_DEDUP) this.dedup.delete(this.dedup.keys().next().value!);
    }
    return this.record({
      outcome: "admitted", intentId: intent.id!, requestId: intent.requestId,
      category: intent.category, priority: intent.priority, reason: "admitted", at: now,
    }, intent.source, shadow);
  }

  private overBudget(intent: InterventionIntent): string | null {
    if (intent.category === "context" || intent.category === "guidance" || intent.category === "checkpoint") {
      if (this.spent.contextChars + intent.estimatedChars > this.budgets.contextChars) return "contextChars";
      return null;
    }
    if (intent.category === "assistance") {
      if (this.spent.helperChildren + 1 > this.budgets.helperChildren) return "helperChildren";
      if (this.spent.helperCost + intent.estimatedCost > this.budgets.helperCost) return "helperCost";
      return null;
    }
    if (this.spent.reviewEscalations + 1 > this.budgets.reviewEscalations) return "reviewEscalations";
    return null;
  }

  private spend(intent: InterventionIntent): void {
    if (intent.category === "context" || intent.category === "guidance" || intent.category === "checkpoint") {
      this.spent.contextChars += intent.estimatedChars;
    } else if (intent.category === "assistance") {
      this.spent.helperChildren += 1;
      this.spent.helperCost += intent.estimatedCost;
    } else {
      this.spent.reviewEscalations += 1;
    }
  }

  private pruneDedup(now: number): void {
    for (const [key, entry] of this.dedup) {
      if (now >= entry.expiresAt) this.dedup.delete(key);
      else break; // insertion-ordered; entries expire roughly in order
    }
  }

  private record(decision: InterventionDecision, source: string, shadow: boolean): InterventionDecision {
    // Shadow evaluations are observation only: they leave counters, spend and
    // dedup untouched and appear solely in the audit log with shadow:true.
    if (!shadow) {
      if (decision.outcome === "admitted") this.admittedCount++;
      else this.suppressedCount++;
    }
    this.log.push({
      at: decision.at, outcome: decision.outcome, intentId: decision.intentId,
      category: decision.category, source, requestId: decision.requestId, shadow,
    });
    while (this.log.length > MAX_LOG) this.log.shift();
    return decision;
  }
}

export type InterventionCategory = "context" | "guidance" | "assistance" | "review" | "checkpoint";
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
    /** Target stable composition slot. One admitted owner per slot per cycle;
     *  further commits to a claimed slot are suppressed (first wins, no
     *  preemption). Unset (or empty) means unslotted: no arbitration. */
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
export declare const DEFAULT_BUDGETS: InterventionBudgets;
export type DecisionOutcome = "admitted" | "suppressed-duplicate" | "suppressed-budget" | "suppressed-slot" | "suppressed-stale" | "suppressed-expired" | "rejected-invalid";
/** Zero-effect declaration: context-family intent injecting zero chars.
 *  Assistance always launches a child and review always escalates, so those
 *  categories are never no-ops regardless of declared cost. */
export declare function isNoOpIntent(intent: Pick<InterventionIntent, "category" | "estimatedChars">): boolean;
/** Only admitted decisions authorize downstream effect. */
export declare function isActionable(decision: Pick<InterventionDecision, "outcome">): boolean;
/** Canonical no-op receipt for any non-admitted decision, so downstream
 *  composition handles every decision uniformly: admitted injects, anything
 *  else carries this receipt into the audit trail. Returns null for admitted
 *  decisions (nothing to excuse). */
export declare function noopReceipt(decision: InterventionDecision): {
    intentId: string;
    outcome: DecisionOutcome;
    reason: string;
    at: number;
} | null;
/** One claimed composition slot: the winning intent's render identity. */
export interface SlotClaim {
    slot: string;
    intentId: string;
    category: InterventionCategory;
    priority: number;
    source: string;
    /** Declared chars (0 for no-op owners: seat held, nothing renders). */
    chars: number;
    at: number;
}
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
export interface InterventionControlOptions {
    budgets?: Partial<InterventionBudgets>;
    clock?: () => number;
    idSource?: () => string;
}
export declare class InterventionControl {
    private budgets;
    private clock;
    private idSource;
    private seq;
    private idSeq;
    private cycles;
    private current;
    private spent;
    private dedup;
    private committed;
    private claims;
    private log;
    private admittedCount;
    private suppressedCount;
    constructor(options?: InterventionControlOptions);
    /** Begin one canonical request cycle. Resets per-cycle spend, slots,
     *  and dedup: a new request is a new arbitration window (cross-request
     *  spacing is the subsystem's own cooldown logic, not the control's).
     *  Within-cycle repeats still dedup; TTL still bounds within-cycle memory. */
    beginCycle(label?: string): string;
    /** Forget dedup memory for one stability key (any content hash) so a
     *  retracted/expired/evicted — never delivered — item may be re-queued
     *  mid-cycle. Never refunds spend: re-delivery re-spends honestly.
     *  Idempotent; returns entries forgotten. */
    release(stabilityKey: string, category?: InterventionCategory): number;
    /** Forget all dedup memory (pending-set clears). Spend/slots untouched. */
    releaseAll(): number;
    currentCycle(): string | null;
    endCycle(id: string): boolean;
    /** Shadow-safe: computes the decision without spending or recording dedup. */
    evaluate(raw: InterventionIntent): InterventionDecision;
    /** Evaluate + spend. Idempotent per intent id: re-commits replay the stored decision. */
    commit(raw: InterventionIntent): InterventionDecision;
    /** Out-of-band hook-latency observation against the per-cycle envelope. */
    noteHookLatency(ms: number): void;
    latencyExceeded(): boolean;
    spentBudget(): InterventionBudgets;
    remainingBudget(): InterventionBudgets;
    /** Claimed composition slots for a cycle: admitted slotted owners in
     *  deterministic (slot-name) order. Live-cycle view only: ended or unknown
     *  cycles compose to []. */
    composition(cycleId?: string): SlotClaim[];
    /** Compact state for diagnostics surfaces (never model-visible). */
    snapshot(): {
        cycle: string | null;
        cycles: number;
        budgets: InterventionBudgets;
        spent: InterventionBudgets;
        remaining: InterventionBudgets;
        latencyExceeded: boolean;
        admitted: number;
        suppressed: number;
        slots: string[];
        recent: {
            at: number;
            outcome: DecisionOutcome;
            intentId: string;
            category: InterventionCategory;
            source: string;
            requestId: string;
            shadow: boolean;
            slot?: string;
        }[];
    };
    private decide;
    private overBudget;
    private spend;
    private pruneDedup;
    private record;
}

import { InterventionControl, type DecisionOutcome, type InterventionBudgets, type InterventionDecision, type InterventionIntent } from "./intervention-control.js";
export interface ShadowRecord {
    at: number;
    cycle: string;
    outcome: DecisionOutcome;
    intentId: string;
    category: InterventionDecision["category"];
    source: string;
    reason: string;
    /** How the decision was produced: observed (shadow) or binding (go-live). */
    mode: "shadow" | "enforced";
}
export interface ShadowAudit {
    cycle: string | null;
    evaluated: number;
    admitted: number;
    suppressed: Record<string, number>;
    sources: Record<string, number>;
    /** Records produced by binding enforcement (vs shadow observation). */
    enforced: number;
}
export interface InterventionSessionOptions {
    budgets?: Partial<InterventionBudgets>;
    clock?: () => number;
    idSource?: () => string;
    journalLimit?: number;
}
export interface InterventionSession {
    /** Begin one canonical request cycle. Resets per-cycle spend and slots. */
    beginRequest(label?: string): string;
    /** Shadow-submit one intent: evaluate against the live cycle, journal the
     *  would-be decision. Auto-begins an implicit cycle when none is open so
     *  pre-input activity is observed rather than dropped. */
    shadow(intent: Omit<InterventionIntent, "requestId"> & {
        requestId?: string;
    }): InterventionDecision;
    /** Binding submit: commit against the live cycle (spends, claims, dedups)
     *  and journal the enforced decision. Callers act on the outcome. */
    enforce(intent: Omit<InterventionIntent, "requestId"> & {
        requestId?: string;
    }): InterventionDecision;
    /** Forget dedup memory for one stability key (retract/expire/evict paths).
     *  Never refunds spend. Idempotent; returns entries forgotten. */
    release(stabilityKey: string, category?: InterventionDecision["category"]): number;
    /** Forget all dedup memory (pending-set clears). Spend/slots untouched. */
    releaseAll(): number;
    /** Chronological journal of shadow records, oldest dropped past the limit. */
    journal(): ShadowRecord[];
    /** Current-cycle rollup: would-admit vs would-suppress by outcome/source. */
    audit(): ShadowAudit;
    /** Underlying control (diagnostics snapshot; commit path for go-live). */
    control(): InterventionControl;
}
export declare function createInterventionSession(options?: InterventionSessionOptions): InterventionSession;

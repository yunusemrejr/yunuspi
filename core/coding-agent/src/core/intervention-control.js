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
// identity, budget envelopes, dedup semantics, named-slot arbitration,
// no-op semantics, the composition reader, and the decision audit log.
//
// Budgets are PER REQUEST CYCLE: each user input begins a cycle, and all
// continuations, tool results, helpers, reviews, checkpoints and guidance
// triggered by that input share it. A continuation is never a fresh
// opportunity to spend again.
//
// Two-phase API separates observation from enforcement:
//   evaluate(intent) — what WOULD happen (shadow-safe, spends nothing)
//   commit(intent)   — evaluate + spend (idempotent per intent id)
/** Conservative starting envelopes. Tune only after the architecture is
 *  stable — and there is exactly one place where each threshold matters. */
export const DEFAULT_BUDGETS = {
    contextChars: 12000,
    helperChildren: 1,
    helperCost: 0.05,
    reviewEscalations: 1,
    hookLatencyMs: 500,
};
/** Zero-effect declaration: context-family intent injecting zero chars.
 *  Assistance always launches a child and review always escalates, so those
 *  categories are never no-ops regardless of declared cost. */
export function isNoOpIntent(intent) {
    return (intent.category === "context" || intent.category === "guidance" || intent.category === "checkpoint") &&
        intent.estimatedChars === 0;
}
/** Only admitted decisions authorize downstream effect. */
export function isActionable(decision) {
    return decision.outcome === "admitted";
}
/** Canonical no-op receipt for any non-admitted decision, so downstream
 *  composition handles every decision uniformly: admitted injects, anything
 *  else carries this receipt into the audit trail. Returns null for admitted
 *  decisions (nothing to excuse). */
export function noopReceipt(decision) {
    if (decision.outcome === "admitted")
        return null;
    return { intentId: decision.intentId, outcome: decision.outcome, reason: decision.reason, at: decision.at };
}
const CATEGORIES = ["context", "guidance", "assistance", "review", "checkpoint"];
const MAX_LOG = 512;
const MAX_DEDUP = 1024;
const MAX_CYCLES = 32;
const MAX_SLOTS = 256;
const boundedString = (value, max) => typeof value === "string" && value.length >= 1 && value.length <= max;
const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value);
function validateIntent(intent) {
    if (!intent || typeof intent !== "object")
        return "intent-not-object";
    if (!boundedString(intent.source, 160))
        return "source";
    if (!boundedString(intent.requestId, 64))
        return "requestId";
    if (!CATEGORIES.includes(intent.category))
        return "category";
    if (!finiteNumber(intent.priority) || intent.priority < 0 || intent.priority > 100)
        return "priority";
    if (!boundedString(intent.reason, 500))
        return "reason";
    if (!boundedString(intent.stabilityKey, 160))
        return "stabilityKey";
    if (intent.contentHash !== undefined && !(typeof intent.contentHash === "string" && intent.contentHash.length <= 128))
        return "contentHash";
    if (!finiteNumber(intent.ttlMs) || intent.ttlMs < 0 || intent.ttlMs > 86400000)
        return "ttlMs";
    if (!finiteNumber(intent.estimatedChars) || intent.estimatedChars < 0 || intent.estimatedChars > 1e9)
        return "estimatedChars";
    if (!finiteNumber(intent.estimatedCost) || intent.estimatedCost < 0 || intent.estimatedCost > 1e6)
        return "estimatedCost";
    if (typeof intent.blocking !== "boolean")
        return "blocking";
    if (intent.slot !== undefined && !(typeof intent.slot === "string" && intent.slot.length <= 64))
        return "slot";
    if (!Array.isArray(intent.evidence))
        return "evidence";
    for (const ref of intent.evidence) {
        if (!ref || typeof ref !== "object")
            return "evidence-entry";
        if (!boundedString(ref.kind, 64) || !boundedString(ref.id, 160))
            return "evidence-entry";
        if (ref.hash !== undefined && !(typeof ref.hash === "string" && ref.hash.length <= 128))
            return "evidence-entry";
    }
    if (intent.createdAt !== undefined && !finiteNumber(intent.createdAt))
        return "createdAt";
    return null;
}
export class InterventionControl {
    budgets;
    clock;
    idSource;
    seq = 0;
    idSeq = 0;
    cycles = new Map();
    current = null;
    spent = { contextChars: 0, helperChildren: 0, helperCost: 0, reviewEscalations: 0, hookLatencyMs: 0 };
    dedup = new Map();
    committed = new Map();
    claims = new Map();
    log = [];
    admittedCount = 0;
    suppressedCount = 0;
    constructor(options = {}) {
        this.budgets = { ...DEFAULT_BUDGETS, ...(options.budgets ?? {}) };
        this.clock = options.clock ?? (() => Date.now());
        this.idSource = options.idSource ?? (() => `in-${++this.idSeq}`);
    }
    /** Begin one canonical request cycle. Resets per-cycle spend, slots,
     *  and dedup: a new request is a new arbitration window (cross-request
     *  spacing is the subsystem's own cooldown logic, not the control's).
     *  Within-cycle repeats still dedup; TTL still bounds within-cycle memory. */
    beginCycle(label = "") {
        const id = `c${++this.seq}`;
        const now = this.clock();
        if (this.current) {
            const prev = this.cycles.get(this.current);
            if (prev && prev.endedAt === null)
                prev.endedAt = now;
        }
        this.cycles.set(id, { id, seq: this.seq, label: label.slice(0, 120), beganAt: now, endedAt: null });
        while (this.cycles.size > MAX_CYCLES)
            this.cycles.delete(this.cycles.keys().next().value);
        this.current = id;
        this.spent = { contextChars: 0, helperChildren: 0, helperCost: 0, reviewEscalations: 0, hookLatencyMs: 0 };
        this.claims.clear();
        this.dedup.clear();
        return id;
    }
    /** Forget dedup memory for one stability key (any content hash) so a
     *  retracted/expired/evicted — never delivered — item may be re-queued
     *  mid-cycle. Never refunds spend: re-delivery re-spends honestly.
     *  Idempotent; returns entries forgotten. */
    release(stabilityKey, category) {
        // Stored keys are always sliced to 160 chars by intent validation;
        // normalize here so hygiene callers passing full keys still match.
        const want = stabilityKey.slice(0, 160);
        let forgotten = 0;
        for (const [key, entry] of this.dedup) {
            if (entry.stabilityKey !== want)
                continue;
            if (category !== undefined && entry.category !== category)
                continue;
            this.dedup.delete(key);
            forgotten++;
        }
        return forgotten;
    }
    /** Forget all dedup memory (pending-set clears). Spend/slots untouched. */
    releaseAll() {
        const forgotten = this.dedup.size;
        this.dedup.clear();
        return forgotten;
    }
    currentCycle() {
        return this.current;
    }
    endCycle(id) {
        const record = this.cycles.get(id);
        if (!record || record.endedAt !== null)
            return false;
        record.endedAt = this.clock();
        if (this.current === id)
            this.current = null;
        return true;
    }
    /** Shadow-safe: computes the decision without spending or recording dedup. */
    evaluate(raw) {
        return this.decide(raw, true);
    }
    /** Evaluate + spend. Idempotent per intent id: re-commits replay the stored decision. */
    commit(raw) {
        if (raw && typeof raw.id === "string" && this.committed.has(raw.id))
            return this.committed.get(raw.id);
        const decision = this.decide(raw, false);
        this.committed.set(decision.intentId, decision);
        while (this.committed.size > MAX_DEDUP)
            this.committed.delete(this.committed.keys().next().value);
        return decision;
    }
    /** Out-of-band hook-latency observation against the per-cycle envelope. */
    noteHookLatency(ms) {
        if (finiteNumber(ms) && ms > 0)
            this.spent.hookLatencyMs += ms;
    }
    latencyExceeded() {
        return this.spent.hookLatencyMs > this.budgets.hookLatencyMs;
    }
    spentBudget() {
        return { ...this.spent };
    }
    remainingBudget() {
        return {
            contextChars: this.budgets.contextChars - this.spent.contextChars,
            helperChildren: this.budgets.helperChildren - this.spent.helperChildren,
            helperCost: this.budgets.helperCost - this.spent.helperCost,
            reviewEscalations: this.budgets.reviewEscalations - this.spent.reviewEscalations,
            hookLatencyMs: this.budgets.hookLatencyMs - this.spent.hookLatencyMs,
        };
    }
    /** Claimed composition slots for a cycle: admitted slotted owners in
     *  deterministic (slot-name) order. Live-cycle view only: ended or unknown
     *  cycles compose to []. */
    composition(cycleId) {
        const id = cycleId ?? this.current;
        if (!id || id !== this.current)
            return [];
        return [...this.claims.values()].sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
    }
    /** Compact state for diagnostics surfaces (never model-visible). */
    snapshot() {
        return {
            cycle: this.current,
            cycles: this.seq,
            budgets: { ...this.budgets },
            spent: this.spentBudget(),
            remaining: this.remainingBudget(),
            latencyExceeded: this.latencyExceeded(),
            admitted: this.admittedCount,
            suppressed: this.suppressedCount,
            slots: this.composition().map((claim) => claim.slot),
            recent: this.log.slice(-20),
        };
    }
    decide(raw, shadow) {
        const now = this.clock();
        const invalid = validateIntent(raw);
        if (!raw || typeof raw !== "object" || invalid) {
            return this.record({
                outcome: "rejected-invalid", intentId: "none", requestId: "none",
                category: "context", priority: 0, reason: `invalid:${invalid ?? "not-object"}`, at: now,
            }, "unknown", shadow);
        }
        if (!raw.id)
            raw.id = this.idSource();
        if (!finiteNumber(raw.createdAt))
            raw.createdAt = now;
        const intent = raw;
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
        if (now > intent.createdAt + intent.ttlMs) {
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
        const slot = intent.slot || undefined;
        if (slot && this.claims.has(slot)) {
            return this.record({
                outcome: "suppressed-slot", intentId: intent.id, requestId: intent.requestId,
                category: intent.category, priority: intent.priority, reason: `slot:taken:${slot}`, at: now,
            }, intent.source, shadow, slot);
        }
        if (!shadow) {
            this.spend(intent);
            this.dedup.set(key, { expiresAt: now + Math.max(intent.ttlMs, 1000), intentId: intent.id, category: intent.category, stabilityKey: intent.stabilityKey });
            while (this.dedup.size > MAX_DEDUP)
                this.dedup.delete(this.dedup.keys().next().value);
            if (slot) {
                this.claims.set(slot, {
                    slot, intentId: intent.id, category: intent.category, priority: intent.priority,
                    source: intent.source, chars: intent.estimatedChars, at: now,
                });
                while (this.claims.size > MAX_SLOTS)
                    this.claims.delete(this.claims.keys().next().value);
            }
        }
        return this.record({
            outcome: "admitted", intentId: intent.id, requestId: intent.requestId,
            category: intent.category, priority: intent.priority, reason: "admitted", at: now,
        }, intent.source, shadow, slot);
    }
    overBudget(intent) {
        if (intent.category === "context" || intent.category === "guidance" || intent.category === "checkpoint") {
            if (this.spent.contextChars + intent.estimatedChars > this.budgets.contextChars)
                return "contextChars";
            return null;
        }
        if (intent.category === "assistance") {
            if (this.spent.helperChildren + 1 > this.budgets.helperChildren)
                return "helperChildren";
            if (this.spent.helperCost + intent.estimatedCost > this.budgets.helperCost)
                return "helperCost";
            return null;
        }
        if (this.spent.reviewEscalations + 1 > this.budgets.reviewEscalations)
            return "reviewEscalations";
        return null;
    }
    spend(intent) {
        if (intent.category === "context" || intent.category === "guidance" || intent.category === "checkpoint") {
            // No-op intents declare zero effect: admitted and tracked (dedup, slot)
            // but spend nothing. Assistance/review always spend (launch/escalation
            // are effects even at zero declared cost).
            if (!isNoOpIntent(intent))
                this.spent.contextChars += intent.estimatedChars;
        }
        else if (intent.category === "assistance") {
            this.spent.helperChildren += 1;
            this.spent.helperCost += intent.estimatedCost;
        }
        else {
            this.spent.reviewEscalations += 1;
        }
    }
    pruneDedup(now) {
        for (const [key, entry] of this.dedup) {
            if (now >= entry.expiresAt)
                this.dedup.delete(key);
            else
                break; // insertion-ordered; entries expire roughly in order
        }
    }
    record(decision, source, shadow, slot) {
        // Shadow evaluations are observation only: they leave counters, spend,
        // dedup and slot claims untouched and appear solely in the audit log
        // with shadow:true.
        if (!shadow) {
            if (decision.outcome === "admitted")
                this.admittedCount++;
            else
                this.suppressedCount++;
        }
        this.log.push({
            at: decision.at, outcome: decision.outcome, intentId: decision.intentId,
            category: decision.category, source, requestId: decision.requestId, shadow,
            ...(slot ? { slot } : {}),
        });
        while (this.log.length > MAX_LOG)
            this.log.shift();
        return decision;
    }
}

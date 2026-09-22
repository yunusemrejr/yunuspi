// intervention-session — session binding for the control plane.
//
// One session owns one InterventionControl. Each user request begins a
// request cycle; subsystems shadow intents (evaluate-only) for observation
// or enforce them (binding commit: spends, claims, dedups) at flipped
// callsites, and the journal records every decision with its mode.
// Per D-011 each subsystem owns its session and input-driven cycles.
//
// Pure and additive: no pi imports, no I/O. Callers in live paths wrap
// calls in try/catch and fail open so the control can never break delivery.
import { InterventionControl, } from "./intervention-control.js";
const DEFAULT_JOURNAL_LIMIT = 200;
export function createInterventionSession(options = {}) {
    const control = new InterventionControl({
        ...(options.budgets ? { budgets: options.budgets } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.idSource ? { idSource: options.idSource } : {}),
    });
    const limit = options.journalLimit ?? DEFAULT_JOURNAL_LIMIT;
    const records = [];
    const submit = (intent, mode) => {
        const requestId = intent.requestId ?? control.currentCycle() ?? control.beginCycle("implicit");
        const decision = mode === "shadow"
            ? control.evaluate({ ...intent, requestId })
            : control.commit({ ...intent, requestId });
        records.push({
            at: decision.at,
            // Submission cycle, not the echoed id: rejected-invalid decisions
            // carry requestId "none", but the attempt still belongs to this cycle.
            cycle: requestId,
            outcome: decision.outcome,
            intentId: decision.intentId,
            category: decision.category,
            source: (intent.source ?? "unknown").slice(0, 160),
            reason: decision.reason,
            mode,
        });
        while (records.length > limit)
            records.shift();
        return decision;
    };
    return {
        beginRequest(label = "") {
            return control.beginCycle(label);
        },
        shadow(intent) {
            return submit(intent, "shadow");
        },
        enforce(intent) {
            return submit(intent, "enforced");
        },
        release(stabilityKey, category) {
            return control.release(stabilityKey, category);
        },
        releaseAll() {
            return control.releaseAll();
        },
        journal() {
            return records.slice();
        },
        audit() {
            const cycle = control.currentCycle();
            const suppressed = {};
            const sources = {};
            let evaluated = 0;
            let admitted = 0;
            let enforced = 0;
            for (const record of records) {
                if (record.cycle !== cycle)
                    continue;
                evaluated++;
                if (record.outcome === "admitted")
                    admitted++;
                else
                    suppressed[record.outcome] = (suppressed[record.outcome] ?? 0) + 1;
                sources[record.source] = (sources[record.source] ?? 0) + 1;
                if (record.mode === "enforced")
                    enforced++;
            }
            return { cycle, evaluated, admitted, suppressed, sources, enforced };
        },
        control() {
            return control;
        },
    };
}

// intervention-session — shadow-mode session binding for the control plane.
//
// One session owns one InterventionControl. Each user request begins a
// request cycle; subsystems submit shadow intents (evaluate-only) as they
// act, so the journal records what the control plane WOULD have decided
// without changing any live behavior. Go-live (commit-based enforcement)
// is a later phase; nothing here spends, claims, or blocks.
//
// Pure and additive: no pi imports, no I/O. Callers in live paths wrap
// calls in try/catch so observation can never break delivery.
import {
  InterventionControl,
  type DecisionOutcome,
  type InterventionBudgets,
  type InterventionDecision,
  type InterventionIntent,
} from "./intervention-control.ts";

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

const DEFAULT_JOURNAL_LIMIT = 200;

export interface InterventionSession {
  /** Begin one canonical request cycle. Resets per-cycle spend and slots. */
  beginRequest(label?: string): string;
  /** Shadow-submit one intent: evaluate against the live cycle, journal the
   *  would-be decision. Auto-begins an implicit cycle when none is open so
   *  pre-input activity is observed rather than dropped. */
  shadow(intent: Omit<InterventionIntent, "requestId"> & { requestId?: string }): InterventionDecision;
  /** Binding submit: commit against the live cycle (spends, claims, dedups)
   *  and journal the enforced decision. Callers act on the outcome. */
  enforce(intent: Omit<InterventionIntent, "requestId"> & { requestId?: string }): InterventionDecision;
  /** Chronological journal of shadow records, oldest dropped past the limit. */
  journal(): ShadowRecord[];
  /** Current-cycle rollup: would-admit vs would-suppress by outcome/source. */
  audit(): ShadowAudit;
  /** Underlying control (diagnostics snapshot; commit path for go-live). */
  control(): InterventionControl;
}

export function createInterventionSession(options: InterventionSessionOptions = {}): InterventionSession {
  const control = new InterventionControl({
    ...(options.budgets ? { budgets: options.budgets } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.idSource ? { idSource: options.idSource } : {}),
  });
  const limit = options.journalLimit ?? DEFAULT_JOURNAL_LIMIT;
  const records: ShadowRecord[] = [];

  const submit = (
    intent: Omit<InterventionIntent, "requestId"> & { requestId?: string },
    mode: "shadow" | "enforced",
  ): InterventionDecision => {
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
    while (records.length > limit) records.shift();
    return decision;
  };

  return {
    beginRequest(label = ""): string {
      return control.beginCycle(label);
    },

    shadow(intent): InterventionDecision {
      return submit(intent, "shadow");
    },

    enforce(intent): InterventionDecision {
      return submit(intent, "enforced");
    },

    journal(): ShadowRecord[] {
      return records.slice();
    },

    audit(): ShadowAudit {
      const cycle = control.currentCycle();
      const suppressed: Record<string, number> = {};
      const sources: Record<string, number> = {};
      let evaluated = 0;
      let admitted = 0;
      let enforced = 0;
      for (const record of records) {
        if (record.cycle !== cycle) continue;
        evaluated++;
        if (record.outcome === "admitted") admitted++;
        else suppressed[record.outcome] = (suppressed[record.outcome] ?? 0) + 1;
        sources[record.source] = (sources[record.source] ?? 0) + 1;
        if (record.mode === "enforced") enforced++;
      }
      return { cycle, evaluated, admitted, suppressed, sources, enforced };
    },

    control(): InterventionControl {
      return control;
    },
  };
}

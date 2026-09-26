/**
 * Expert convergence policy — explicit stop conditions for the improvement
 * loop. Pure module: no I/O, no inference.
 *
 * WHY: "review until good" without a convergence condition becomes either
 * an endless polish loop or a premature "tests passed" claim. Convergence
 * holds only when every clause below is evidenced: requirements closed,
 * invariants preserved, deterministic checks green, no substantive critic
 * finding open, recent passes yielding only low-value polish, and the
 * domain evidence current. Anything else names its next action instead of
 * blocking silently.
 */

export interface ExpertPassEvidence {
  /** Open requirement ids (R#) without evidence. */
  openRequirements: readonly string[];
  /** Invariant violations observed on the current artifacts. */
  invariantViolations: readonly string[];
  /** Failing deterministic checks (tool/op + reason). */
  failingChecks: readonly string[];
  /** Open critic findings by severity. */
  openBlocking: number;
  openImprovements: number;
  openPolish: number;
  /** Findings the latest repair pass fixed, by severity. */
  fixedBlocking: number;
  fixedImprovements: number;
  /** New substantive findings the latest pass introduced or uncovered. */
  newSubstantive: number;
  /** Latest repair pass number (1-based) and the pass budget. */
  pass: number;
  maxPasses: number;
  /** Domain evidence (captures, receipts, transcripts) matches current bytes. */
  evidenceCurrent: boolean;
  /** Layers that could not run, for honest reporting (never silent). */
  unavailable: readonly string[];
}

export interface ExpertVerdict {
  converged: boolean;
  /** Stable machine-readable reason code. */
  reason:
    | "converged" | "requirements-open" | "invariants-violated" | "checks-failing"
    | "blocking-open" | "improvements-open" | "evidence-stale" | "pass-budget-spent" | "regressing";
  /** Human-readable one-paragraph explanation with the next action. */
  detail: string;
  /** Ordered next actions (most impactful first). */
  nextActions: string[];
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export function evaluateExpertConvergence(input: ExpertPassEvidence): ExpertVerdict {
  const openRequirements = input.openRequirements.filter((s) => typeof s === "string" && s);
  const invariantViolations = input.invariantViolations.filter((s) => typeof s === "string" && s);
  const failingChecks = input.failingChecks.filter((s) => typeof s === "string" && s);
  const unavailable = input.unavailable.filter((s) => typeof s === "string" && s);
  const openBlocking = count(input.openBlocking);
  const openImprovements = count(input.openImprovements);
  const fixedBlocking = count(input.fixedBlocking);
  const fixedImprovements = count(input.fixedImprovements);
  const newSubstantive = count(input.newSubstantive);
  const pass = Math.max(1, count(input.pass) || 1);
  const maxPasses = Math.max(1, Math.min(8, count(input.maxPasses) || 3));
  const limited = unavailable.length ? ` Unavailable layers (disclosed, not passed): ${unavailable.slice(0, 6).join("; ")}.` : "";

  if (openRequirements.length) return {
    converged: false, reason: "requirements-open",
    detail: `Not converged: ${openRequirements.length} requirement(s) without evidence (${openRequirements.slice(0, 6).join(", ")}). Close requirements with receipts before judging excellence.${limited}`,
    nextActions: ["Evidence every open requirement, then re-run critics on the changed scope."],
  };
  if (invariantViolations.length) return {
    converged: false, reason: "invariants-violated",
    detail: `Not converged: ${invariantViolations.length} invariant violation(s): ${invariantViolations.slice(0, 4).join("; ")}. Invariants outrank polish; repair them first.${limited}`,
    nextActions: ["Repair invariant violations and re-verify with the owning deterministic check."],
  };
  if (failingChecks.length) return {
    converged: false, reason: "checks-failing",
    detail: `Not converged: ${failingChecks.length} deterministic check(s) failing: ${failingChecks.slice(0, 4).join("; ")}. Cheap checks gate model judgment.${limited}`,
    nextActions: ["Fix failing deterministic checks; do not spend model review on red checks."],
  };
  if (openBlocking) return {
    converged: false, reason: "blocking-open",
    detail: `Not converged: ${openBlocking} blocking critic finding(s) open. Blocking findings name concrete defects, not taste.${limited}`,
    nextActions: ["Repair blocking findings in impact order, then re-run the owning lenses."],
  };
  if (!input.evidenceCurrent) return {
    converged: false, reason: "evidence-stale",
    detail: `Not converged: domain evidence is stale relative to current artifacts. Re-capture or re-run the domain checks before claiming excellence.${limited}`,
    nextActions: ["Refresh domain evidence (captures, receipts, transcripts) on current bytes."],
  };
  if (openImprovements) {
    if (pass >= maxPasses) return {
      converged: false, reason: "pass-budget-spent",
      detail: `Pass budget spent (${pass}/${maxPasses}) with ${openImprovements} improvement(s) still open. Report them as known gaps rather than polishing silently or looping.${limited}`,
      nextActions: ["Report open improvements as known gaps with their evidence; stop the loop."],
    };
    // A pass that fixes nothing substantive while surfacing new substantive
    // findings is regressing, not converging; say so after the first pass.
    if (pass > 1 && fixedBlocking + fixedImprovements === 0 && newSubstantive > 0) return {
      converged: false, reason: "regressing",
      detail: `Not converging: pass ${pass} fixed no substantive finding and surfaced ${newSubstantive} new one(s). Change strategy (narrow scope, revisit direction) instead of repeating the pass.${limited}`,
      nextActions: ["Change strategy: narrow scope or revisit the chosen direction before another pass."],
    };
    return {
      converged: false, reason: "improvements-open",
      detail: `Pass ${pass}/${maxPasses}: ${openImprovements} improvement(s) open. Repair in impact order; fixes ${fixedBlocking + fixedImprovements} so far this loop.${limited}`,
      nextActions: [`Repair the highest-impact improvements (pass ${Math.min(pass + 1, maxPasses)} of ${maxPasses}), then re-run critics.`],
    };
  }
  if (pass >= maxPasses && (fixedBlocking + fixedImprovements > 0)) {
    // Budget spent exactly as the last substantive fix landed: converged,
    // with remaining polish explicitly out of scope.
  }
  return {
    converged: true, reason: "converged",
    detail: `Converged: requirements evidenced, invariants preserved, deterministic checks green, no substantive finding open, evidence current.${input.openPolish ? ` ${count(input.openPolish)} polish suggestion(s) intentionally deferred.` : ""}${limited}`,
    nextActions: [],
  };
}

/** Minimal pass ledger folded by the wiring owner. Settled passes are
 * retained as counts only; the verdict history stays bounded. */
export interface ExpertPassLedger {
  pass: number;
  maxPasses: number;
  fixedBlocking: number;
  fixedImprovements: number;
  /** Last three verdict reason codes, oldest first. */
  recentReasons: string[];
}

export const emptyExpertPassLedger = (maxPasses = 3): ExpertPassLedger =>
  ({ pass: 0, maxPasses: Math.max(1, Math.min(8, maxPasses)), fixedBlocking: 0, fixedImprovements: 0, recentReasons: [] });

export function foldExpertPass(ledger: ExpertPassLedger, verdict: ExpertVerdict, evidence: ExpertPassEvidence): ExpertPassLedger {
  return {
    pass: Math.max(ledger.pass, count(evidence.pass)),
    maxPasses: ledger.maxPasses,
    fixedBlocking: ledger.fixedBlocking + count(evidence.fixedBlocking),
    fixedImprovements: ledger.fixedImprovements + count(evidence.fixedImprovements),
    recentReasons: [...ledger.recentReasons, verdict.reason].slice(-3),
  };
}

/** One TUI line describing the verdict. */
export function expertVerdictSummary(verdict: ExpertVerdict): string {
  return verdict.converged ? "Expert pass: converged." : `Expert pass: ${verdict.reason.replaceAll("-", " ")}.`;
}

/** Reviewer evidence rows shared by Observer and Watchmaker. Pure: reads
 * only the supplied branch entries. Observer receives domain focus and
 * doctrine so it judges against the excellence bar; Watchmaker receives
 * pass/yield rows so it can spot low-value perfectionism. Guardian needs
 * no new row: it already fingerprints expert_director tool evidence and
 * completion claims through its existing signals. */
export interface ExpertReviewerRow {
  id: string;
  kind: string;
  text: string;
}

export function expertReviewerRows(branch: unknown): ExpertReviewerRow[] {
  const list = Array.isArray(branch) ? branch : [];
  const runs = list
    .filter((entry) => (entry as any)?.type === "custom" && (entry as any)?.customType === "expert-director-v1")
    .map((entry) => (entry as any)?.data)
    .filter((data) => data && typeof data === "object");
  if (!runs.length) return [];
  const rows: ExpertReviewerRow[] = [];
  const briefs = runs.filter((d) => d.action === "brief");
  const verdicts = runs.filter((d) => d.action === "assess");
  const last = briefs[briefs.length - 1];
  const verdict = verdicts[verdicts.length - 1];
  if (last && Array.isArray(last.domains) && last.domains.length) {
    const lenses = Array.isArray(last.detail?.lenses) ? last.detail.lenses.slice(0, 6).join(", ") : "";
    rows.push({
      id: "expert-focus",
      kind: "expert quality focus",
      text: `Expert Director brief: ${last.domains.join("+")} · ${last.taskType ?? "unknown task"}${last.openEnded ? " · open brief" : ""}${lenses ? `; critic lenses ${lenses}` : ""}${last.detail?.tasteApplied ? `; ${last.detail.tasteApplied} quality prior(s)` : ""}. Judge this work against that domain's excellence bar and its doctrine, not generic correctness.`,
    });
  }
  if (verdict) {
    const ledger = verdict.ledger && typeof verdict.ledger === "object" ? verdict.ledger : {};
    const pass = typeof ledger.pass === "number" ? ledger.pass : 0;
    const max = typeof ledger.maxPasses === "number" ? ledger.maxPasses : 0;
    const recent = Array.isArray(ledger.recentReasons) ? ledger.recentReasons.join(" → ") : "";
    rows.push({
      id: "expert-verdict",
      kind: "expert convergence",
      text: verdict.converged
        ? `Expert convergence: converged${pass ? ` after pass ${pass}` : ""}. Do not ask for more polish without new evidence.`
        : `Expert convergence: ${String(verdict.reason ?? "open").replaceAll("-", " ")}${pass && max ? ` (pass ${pass}/${max})` : ""}${recent ? `; recent: ${recent}` : ""}. Only substantive findings keep this loop open; repeated polish-only passes are low-value perfectionism.`,
    });
  }
  return rows.map((row) => ({ ...row, text: row.text.slice(0, 500) }));
}

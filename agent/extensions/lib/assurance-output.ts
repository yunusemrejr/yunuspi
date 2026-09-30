import { redactSecrets } from './memory-redaction.ts';
/** Model-facing projections only. Full native state and hash gates stay owned
 * by their lifecycles; diagnostics are observations, never a coverage verdict. */
export function projectTestOutput(data: any, detailed = false) {
  if (detailed) return data;
  return {
    revision: data.revision, changed: data.changed, need: data.need,
    disabled: data.disabled, paused: data.paused, optedOut: data.optedOut,
    ...(data.assessment ? { assessment: { disposition: data.assessment.disposition, reason: data.assessment.reason } } : {}),
    plannedChecks: data.plannedChecks, facts: data.facts,
    ...(data.attribution?.length ? { attribution: data.attribution } : {}),
    treeComplete: data.treeComplete,
    scope: 'Observed exits, not coverage. Current source-bound receipts are retained natively; view=detailed retrieves them.',
  };
}
export function qualityReviewOutput(data: any, detailed = false, assessed = false) {
  if (detailed) return data;
  return {
    revision: data.revision, changed: data.changed, status: data.status,
    rounds: data.rounds, maxRounds: data.limits?.rounds, staleReports: data.staleReports,
    truncated: data.truncated, ...(data.reason ? { reason: data.reason } : {}),
    ...(data.automaticReview ? { automaticReview: data.automaticReview } : {}),
    reports: assessed && ['accepted', 'blocked'].includes(data.status)
      ? data.reports.map((r: any) => ({ aspect: r.aspect, outcome: r.outcome, gap: r.gap,
          findings: r.findings, ...(r.unavailable ? { unavailable: true } : {}) })) : data.reports,
    ...(data.previousReview ? { previousRevision: data.previousReview.revision, previousReports: 'Historical; view=detailed retrieves them. Current assessment remains required.' } : {}),
    ...(data.policyFindings?.length ? { policyFindings: data.policyFindings } : {}),
    ...(data.evidenceRejected?.length ? { evidenceRejected: data.evidenceRejected } : {}),
    ...(data.retryRationale ? { retryRationale: data.retryRationale } : {}),
    ...(!['accepted','blocked','not_needed'].includes(data.status) ? { nextAction: data.status === 'awaiting_assessment'
      ? 'Assess these reports once. Repair blocking findings; defer optional polish.'
      : data.status === 'unavailable' ? 'Preserve local checks and report unavailable independent review; retry only after repairing its launch cause.'
      : data.status === 'budget_exhausted' ? 'Assess retained evidence and disclose the remaining gap; no review rounds remain.'
      : 'Complete current checks, review, then assess. Native test diagnostics need no temporary log; visual/behavior captures remain required where relevant.' } : {}),
    scope: 'Advisory review plus parent assessment. Full state: view=detailed.',
  };
}
/** Refuse to spread credential-bearing test output into an independent model.
 * Retain the source command receipt; loss of diagnostics is explicit. */
export function testDiagnostics(text: string) {
  if (!text.trim()) return undefined;
  if (redactSecrets(text) !== text || /\[\[(?:private|protected|secret)|<\/?(?:private|secret|protected)\b|\b(?:confidential|private[- ]input|do not (?:send|share|upload)|not for distribution)\b/i.test(text))
    return { text: '[Diagnostic output withheld: possible protected material.]', chars: text.length, omitted: true };
  const limit = 1400;
  return { text: text.length > limit ? `${text.slice(0,500)}\n[Diagnostic middle omitted]\n${text.slice(-850)}` : text, chars: text.length, omitted: text.length > limit };
}
export function reviewTestContext(data: any) {
  const safe = (value: unknown) => typeof value === 'string' ? redactSecrets(value) : value;
  const plannedChecks = data?.plannedChecks?.map((row: any) => ({ ...row, command: safe(row.command) }));
  return { disabled: data?.disabled, revision: data?.revision, need: data?.need,
    assessment: data?.assessment ? { revision: data.assessment.revision, disposition: data.assessment.disposition, reason: safe(data.assessment.reason) } : undefined,
    treeComplete: data?.treeComplete, plannedChecks,
    scope: 'Native observed receipts and bounded diagnostics; protected command/reason values redacted. No correctness or coverage certification.' };
}

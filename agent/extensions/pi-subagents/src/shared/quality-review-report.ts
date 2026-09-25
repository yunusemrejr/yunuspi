import path from 'node:path';
import { extractJsonEnvelope } from './reviewer-envelope.ts';

/** `unavailable` marks an aspect whose reviewer never returned (deadline,
 * launch or capacity failure): a verification limit, not a verdict. */
export type ReviewReport = { aspect: string; outcome: 'pass' | 'changes' | 'unknown'; evidence: string[]; findings: { id: string; severity: 'blocking' | 'improvement'; file: string; detail: string }[]; gap: string; unavailable?: true };

// The dispatcher and checkpoint share the contract. Extra citations are bounded
// output, not grounds to discard the findings from an otherwise valid review.
export const REVIEW_REPORT_INSTRUCTIONS = 'Per aspect: at most 6 evidence strings (12–700 characters each), 3 findings (detail 20–900 characters), and a gap up to 900 characters. Finding paths must be project-relative without parent traversal. An unknown assessment may have no evidence, but must explain its gap.';

export function normalizeReviewPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const file = value.trim();
  return file && file.length <= 256 && !/[\x00-\x1f\x7f]/.test(file) && !path.isAbsolute(file) && !path.win32.isAbsolute(file) && !/^[A-Za-z]:/.test(file) && !file.split(/[\\/]/).includes('..') ? file : undefined;
}

export function parseReviewReport(text: string, aspect: string): ReviewReport {
  const unknown = (gap: string): ReviewReport => ({ aspect, outcome: 'unknown', evidence: [], findings: [], gap });
  if (typeof text !== 'string' || text.length > 30000) return unknown('Reviewer report exceeded the 30000-character envelope.');
  const value: any = extractJsonEnvelope(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown('Reviewer report is not a complete JSON object.');
  const problems: string[] = [];
  if (!['pass', 'changes', 'unknown'].includes(value.outcome)) problems.push('invalid outcome');
  if (!Array.isArray(value.evidence)) problems.push('missing evidence array');
  if (!Array.isArray(value.findings)) problems.push('missing findings array');
  const rawEvidence = Array.isArray(value.evidence) ? value.evidence : [];
  const evidence = rawEvidence.map((s: unknown) => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '').filter((s: string) => s.length >= 12);
  if (evidence.length !== rawEvidence.length) problems.push('invalid evidence entries');
  const findings: ReviewReport['findings'] = [];
  for (const f of Array.isArray(value.findings) ? value.findings : []) {
    const file = normalizeReviewPath(f?.file);
    const detail = typeof f?.detail === 'string' ? f.detail.replace(/\s+/g, ' ').trim() : '';
    if (!f || !['blocking', 'improvement'].includes(f.severity) || !file ||
      detail.length < 20) {
      problems.push('invalid finding'); continue;
    }
    if (detail.length > 900) problems.push('finding detail truncated; inspect the reviewer output');
    findings.push({ id: '', severity: f.severity, file, detail: detail.slice(0, 900).trim() });
  }
  if (findings.length > 5) problems.push('additional findings omitted; inspect the reviewer output');
  if (value.outcome !== 'unknown' && !evidence.length) problems.push('no source evidence');
  if (value.outcome === 'pass' && findings.some(f => f.severity === 'blocking') || value.outcome === 'changes' && !findings.some(f => f.severity === 'blocking')) problems.push('outcome contradicts blocking findings');
  const gap = typeof value.gap === 'string' ? value.gap.trim() : '';
  if (value.outcome === 'unknown' && gap.length < 12) problems.push('unknown outcome without an explained gap');
  return { aspect, outcome: problems.length ? 'unknown' : value.outcome,
    evidence: evidence.slice(0, 6).map((s: string) => s.trim().slice(0, 700).trim()),
    // Retain concrete blockers before optional improvements when over budget.
    findings: (findings.length > 5 ? findings.filter(f => f.severity === 'blocking').concat(findings.filter(f => f.severity !== 'blocking')).slice(0, 5) : findings).map((f, i) => ({...f, id: `${aspect}-${i + 1}`})),
    gap: [problems.length ? `Invalid reviewer report: ${[...new Set(problems)].join('; ')}.` : '', gap].filter(Boolean).join(' ').slice(0, 900) };
}

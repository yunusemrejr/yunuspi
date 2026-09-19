import path from 'node:path';
import { extractJsonEnvelope } from './reviewer-envelope.ts';

export type ReviewReport = { aspect: string; outcome: 'pass' | 'changes' | 'unknown'; evidence: string[]; findings: { id: string; severity: 'blocking' | 'improvement'; file: string; detail: string }[]; gap: string };

// The dispatcher and checkpoint share the contract. Extra citations are bounded
// output, not grounds to discard the findings from an otherwise valid review.
export const REVIEW_REPORT_INSTRUCTIONS = 'Per aspect: at most 6 evidence strings (12–700 characters each), 3 findings (detail 20–900 characters), and a gap up to 900 characters. Finding paths must be project-relative without parent traversal. An unknown assessment may have no evidence, but must explain its gap.';

export function parseReviewReport(text: string, aspect: string): ReviewReport {
  const unknown = (gap: string): ReviewReport => ({ aspect, outcome: 'unknown', evidence: [], findings: [], gap });
  if (typeof text !== 'string' || text.length > 30000) return unknown('Reviewer report exceeded the 30000-character envelope.');
  const value: any = extractJsonEnvelope(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown('Reviewer report is not a complete JSON object.');
  if (!['pass', 'changes', 'unknown'].includes(value.outcome) || !Array.isArray(value.evidence) || !Array.isArray(value.findings))
    return unknown('Reviewer report requires outcome, evidence and findings fields.');
  const problems: string[] = [];
  const evidence = value.evidence.filter((s: unknown) => typeof s === 'string' && s.trim().length >= 12);
  if (evidence.length !== value.evidence.length) problems.push('invalid evidence entries');
  const findings: ReviewReport['findings'] = [];
  for (const [i, f] of value.findings.entries()) {
    if (!f || !['blocking', 'improvement'].includes(f.severity) || typeof f.file !== 'string' || !f.file.trim() || f.file.length > 256 || path.isAbsolute(f.file) || /^[A-Za-z]:/.test(f.file) || f.file.split(/[\\/]/).includes('..') ||
      typeof f.detail !== 'string' || f.detail.trim().length < 20 || f.detail.length > 900) {
      problems.push('invalid finding'); continue;
    }
    findings.push({ id: `${aspect}-${i + 1}`, severity: f.severity, file: f.file, detail: f.detail });
  }
  if (findings.length > 5) problems.push('additional findings omitted; inspect the reviewer output');
  if (value.outcome !== 'unknown' && !evidence.length) problems.push('no source evidence');
  if (value.outcome === 'pass' && findings.some(f => f.severity === 'blocking') || value.outcome === 'changes' && !findings.some(f => f.severity === 'blocking')) problems.push('outcome contradicts blocking findings');
  const gap = typeof value.gap === 'string' ? value.gap.trim() : '';
  if (value.outcome === 'unknown' && gap.length < 12) problems.push('unknown outcome without an explained gap');
  return { aspect, outcome: problems.length ? 'unknown' : value.outcome,
    evidence: evidence.slice(0, 6).map((s: string) => s.slice(0, 700)),
    // Retain concrete blockers before optional improvements when over budget.
    findings: findings.length > 5 ? findings.filter(f => f.severity === 'blocking').concat(findings.filter(f => f.severity !== 'blocking')).slice(0, 5) : findings,
    gap: [problems.length ? `Invalid reviewer report: ${[...new Set(problems)].join('; ')}.` : '', gap].filter(Boolean).join(' ').slice(0, 900) };
}

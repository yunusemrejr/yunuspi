import type {CodeSignal} from './code-guidance-signals.ts';
import {codeLexicalMask} from './code-lexical-mask.ts';

/** Cheap change-local review routing. Paths select checks, never establish defects. */
export function qualityReviewSignals(file: string, value: unknown): CodeSignal[] {
  if (typeof value !== 'string' || !value.trim() || value.length > 24000) return [];
  const p=file.replace(/\\/g,'/');
  if (/(?:^|\/)(?:node_modules|vendor|dist|build|fixtures?|__fixtures__|skills|references)\/|\.(?:min|generated)\./i.test(p)) return [];
  if (!/\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cpp|cc|h|hpp|cs|rb|php|sql|sh|ya?ml|tf|vue|svelte)$/i.test(p)) return [];
  const out: CodeSignal[]=[];
  const add=(key:string,skill:string,check:string)=>out.push({key,skill,check});
  if (/(?:^|\/)(?:auth(?:entication|orization)?|permissions?|sessions?|security)(?:[./_-]|$)/i.test(p))
    add('quality-trust-boundary','systems-security','An authentication or permission-related file changed. Trace untrusted input to the actual authorization owner; verify a denied case, identity/session expiry and secret handling as applicable. A filename is a routing cue, not evidence of a vulnerability.');
  if (/\.sql$|(?:^|\/)(?:migrations?|schema)(?:[./_-]|$)/i.test(p))
    add('quality-data-change','databases','A schema or database change was observed. Check existing rows, null/duplicate behavior, transaction boundaries and compatibility with old callers. Verify migration recovery on disposable representative data when applicable; do not run against production just to verify.');
  if (/(?:^|\/)(?:queues?|workers?|scheduler|retry|cache|pool)(?:[./_-]|$)/i.test(p))
    add('quality-lifecycle','behavioral-contracts','A lifecycle-related file changed. Trace completion, failure, cancellation and repeated delivery through the existing state owner. Test the relevant ordering or invalidation counterexample, rather than adding another state store or generic retry.');
  if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(p))
    add('quality-test-evidence','property-based-testing','Test code changed. Check whether it would fail for the original defect or a plausible wrong implementation. Assert observable behavior and meaningful boundaries; avoid mocking the behavior under test or treating snapshots as correctness proof.');
  if (/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(p)) {
    const code=codeLexicalMask(value).code;
    if (/\b(?:innerHTML|outerHTML)\s*=|\binsertAdjacentHTML\s*\(/.test(code))
      add('quality-html-boundary','web-security','HTML insertion was observed. Trace the value to its source; if untrusted content can reach this boundary, use the existing sanitization contract or a text-only DOM API. Do not assume every intentional HTML insertion is unsafe.');
    if (/\bPromise\.all\s*\([\s\S]{0,200}\.map\s*\(/.test(code))
      add('quality-fanout','behavioral-contracts','Concurrent map fanout was observed. Check collection bounds, downstream capacity and failure/cancellation behavior; use bounded concurrency only when the workload needs it.');
    if (/\b(?:verify|check|hash|compare)Password\b|jsonwebtoken|\bjwt\s*\.\s*(?:sign|verify)\b|\bbcrypt\b|\bargon2\b|\bscrypt\b|createSession|destroySession|requireAuth|requirePermission|checkPermission|\.authorize\s*\(|\bprocess\.env\.[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PRIVATE_KEY)\b|createHmac|createCipheriv|publicEncrypt|privateDecrypt/.test(code))
      add('quality-auth-content','systems-security','Authentication, session, permission-enforcement or secret-handling mechanics were observed in changed code. Trace untrusted input to the actual authorization owner; verify a denied case, identity/session expiry and secret handling as applicable. An API mention is a routing cue, not evidence of a vulnerability.');
  }
  return out.slice(0,3);
}

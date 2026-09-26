/** Continuation notice: bounded, pure composition plus the registration seam
 * through which each subsystem reports the work it will resume. No I/O, no
 * inference: sources describe only their own pending continuation. */
import type { GateReceipt } from "./completion-gate.ts";

/** Stable machine identity for one unresolved verification item, separate
 * from its human-readable rendering. The completion gate keys refusals and
 * waivers on (source, id, revision, state, count): rewording `line` never
 * resets a refusal, while a new revision, state or count refuses afresh.
 * Sources own their id namespace; collisions across sources are impossible
 * because `source` is part of the key. The gate module owns the shape. */
export type VerificationReceipt = GateReceipt;
export type ContinuationSource = { name: string; session?: object; pending(): string[]; verification?(): string[]; verificationReceipts?(): VerificationReceipt[] };
export const CONTINUATION_SOURCES = Symbol.for("yunus-pi.continuation-sources.v1");
const MAX_LINES = 3, MAX_LINE = 160;

export function registerContinuationSource(source: ContinuationSource): () => void {
  const list: ContinuationSource[] = ((globalThis as any)[CONTINUATION_SOURCES] ??= []);
  const at = list.findIndex(entry => entry.name === source.name && entry.session === source.session);
  if (at >= 0) list[at] = source; else list.push(source);
  return () => { const current = list.indexOf(source); if (current >= 0) list.splice(current, 1); };
}

/** Bounded lines from every registered source; one failing source is skipped. */
function collectLines(field: 'pending' | 'verification', limit: number, session?: object): string[] {
  const list: ContinuationSource[] = (globalThis as any)[CONTINUATION_SOURCES] ?? [];
  const out: string[] = [];
  for (const source of list) {
    if (source.session && source.session !== session) continue;
    let items: unknown = [];
    try { items = source[field]?.(); } catch { items = []; }
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const text = String(item ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LINE);
      if (!text) continue;
      out.push(`${source.name}: ${text}`);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export const collectContinuationLines = (limit = MAX_LINES, session?: object) => collectLines('pending', limit, session);
export const collectVerificationLines = (limit = MAX_LINES, session?: object) => collectLines('verification', limit, session);

const cleanId = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim().slice(0, max);
  return text ? text : undefined;
};

/** Structured receipts from every registered source. Sources without
 * verificationReceipts fall back to their legacy lines, keyed whole: an
 * unconverted producer resets on any reword (fail-closed) instead of
 * risking a collapsed identity. Malformed receipts are dropped. */
export function collectVerificationReceipts(limit = MAX_LINES, session?: object): VerificationReceipt[] {
  const list: ContinuationSource[] = (globalThis as any)[CONTINUATION_SOURCES] ?? [];
  const out: VerificationReceipt[] = [];
  for (const source of list) {
    if (source.session && source.session !== session) continue;
    if (typeof source.verificationReceipts === "function") {
      let items: unknown = [];
      try { items = source.verificationReceipts() ?? []; } catch { items = []; }
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const receipt = item as Partial<VerificationReceipt>;
        const id = cleanId(receipt?.id, 160);
        const state = cleanId(receipt?.state, 80);
        const line = cleanId(receipt?.line, MAX_LINE);
        if (!id || !state || !line) continue;
        const revision = receipt?.revision === undefined ? undefined : cleanId(receipt.revision, 80);
        const count = typeof receipt?.count === "number" && Number.isSafeInteger(receipt.count) && receipt.count >= 0 ? receipt.count : undefined;
        out.push({ source: cleanId(receipt?.source, 80) ?? source.name, id, ...(revision === undefined ? {} : { revision }), state, ...(count === undefined ? {} : { count }), line });
        if (out.length >= limit) return out;
      }
      continue;
    }
    let lines: unknown = [];
    try { lines = source.verification?.() ?? []; } catch { lines = []; }
    if (!Array.isArray(lines)) continue;
    for (const item of lines) {
      const text = String(item ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LINE);
      if (!text) continue;
      out.push({ source: source.name, id: `${source.name}: ${text}`, state: "unresolved", line: `${source.name}: ${text}` });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Settled/blocked is a lifecycle decision, never a successful verification. */
export function verificationWarning(lines: readonly string[]): string {
  return lines.length ? `\n\n---\n⚠️ Verification incomplete (harness receipts):\n${lines.map(line => `- ${line}`).join('\n')}\nThese are verification limits, not evidence of a product defect. Preserve completed checks and report any remaining blocker.` : '';
}

/** Warning appended to a finished answer. Empty lines + no queued follow-up = "". */
export function continuationWarning(lines: readonly string[], pendingMessages = false): string {
  const parts = [...lines.map(line => `- ${line}`)];
  if (pendingMessages) parts.push("- queued follow-up messages will continue this session automatically");
  if (!parts.length) return "";
  return `\n\n---\n⚠️ Continuation pending — this session will keep running after this answer:\n${parts.join("\n")}\nThis notice is automatic; user instructions still govern what runs.`;
}

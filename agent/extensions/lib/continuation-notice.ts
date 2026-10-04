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
const MAX_LINES = 3, MAX_LINE = 160, MAX_BRIEF = 110;

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
        const brief = receipt?.brief === undefined ? undefined : cleanId(receipt.brief, MAX_BRIEF);
        const count = typeof receipt?.count === "number" && Number.isSafeInteger(receipt.count) && receipt.count >= 0 ? receipt.count : undefined;
        out.push({ source: cleanId(receipt?.source, 80) ?? source.name, id, ...(revision === undefined ? {} : { revision }), state, ...(count === undefined ? {} : { count }), line, ...(brief === undefined ? {} : { brief }) });
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

// ── Transcript footer ───────────────────────────────────────────────────
// A footer is written for the person reading the transcript, never for the
// agent: the agent already receives its own guidance through follow-ups and
// notices. It is edge-triggered on what is shown, so a long session never
// repeats an unchanged footer, and it is stripped from every model request so
// the agent cannot echo it into later answers (measured: 9 of 95 warned
// finals carried a copied block, streaks ran up to 8 finals).

export interface NoticeMemory { continuation?: string; verification?: string }
export interface NoticeInput {
  /** Pending-work lines from the sources that will resume this session. */
  continuation: readonly string[];
  /** A queued follow-up message will start another turn on its own. */
  pendingMessages: boolean;
  /** Unresolved verification items, already bounded. */
  receipts: readonly VerificationReceipt[];
  memory: NoticeMemory;
}

const receiptKey = (receipt: VerificationReceipt): string => `${receipt.source}\0${receipt.id}\0${receipt.revision ?? ""}\0${receipt.state}\0${receipt.count ?? ""}`;
const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

/** Footer for a finished answer, plus the memory that keeps the next one quiet.
 * A turn that hands off to resumed work announces that once and says nothing
 * about verification (it is expected to be open while work continues); a turn
 * that really ends reports each distinct set of open verification once. */
export function composeNotice(input: NoticeInput): { text: string; memory: NoticeMemory } {
  const handoff = input.continuation.length > 0 || input.pendingMessages;
  const memory: NoticeMemory = { ...input.memory };
  if (handoff) {
    const rows = input.continuation.map(line => `- ${line}`);
    if (input.pendingMessages) rows.push("- queued follow-up messages will continue this session automatically");
    const key = JSON.stringify({ lines: input.continuation, pendingMessages: input.pendingMessages });
    if (key === memory.continuation) return { text: "", memory };
    memory.continuation = key;
    return { text: `\n\n---\n⏳ Session continues after this answer:\n${rows.join("\n")}`, memory };
  }
  memory.continuation = undefined;
  if (!input.receipts.length) { memory.verification = undefined; return { text: "", memory }; }
  const key = input.receipts.map(receiptKey).join("\n");
  if (key === memory.verification) return { text: "", memory };
  memory.verification = key;
  const rows = input.receipts.map(receipt => `- ${clip(receipt.brief ?? receipt.line, MAX_BRIEF)}`);
  return { text: `\n\n---\n⚠️ Verification open:\n${rows.join("\n")}`, memory };
}

// Matches the footers composeNotice writes and the earlier wording, so a
// resumed transcript is cleaned as well. Anchored on the separator and a known
// header, then only footer-shaped rows: agent prose around an echo survives.
const FOOTER = /\n\n---\n(?:⚠️ Verification (?:open|incomplete)|⚠️ Continuation pending|⏳ Session continues)[^\n]*(?:\n(?:- [^\n]*|These are verification limits[^\n]*|This notice is automatic[^\n]*))*/g;

/** Message with harness footers removed from assistant text; never mutates the input. */
export function stripNoticeFooters<T>(message: T): T {
  const content = (message as any)?.content;
  if ((message as any)?.role !== "assistant") return message;
  if (typeof content === "string") {
    const clean = content.replace(FOOTER, "");
    return clean === content || !clean.trim() ? message : { ...(message as any), content: clean };
  }
  if (!Array.isArray(content)) return message;
  let changed = false;
  const parts: unknown[] = [];
  for (const part of content) {
    if (part?.type !== "text" || typeof part.text !== "string") { parts.push(part); continue; }
    const clean = part.text.replace(FOOTER, "");
    if (clean === part.text) { parts.push(part); continue; }
    changed = true;
    if (clean.trim()) parts.push({ ...part, text: clean });
  }
  // A message that was nothing but footer stays as written: providers reject empty assistant content.
  return changed && parts.length ? { ...(message as any), content: parts } : message;
}

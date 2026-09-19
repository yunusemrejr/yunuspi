/** Continuation notice: bounded, pure composition plus the registration seam
 * through which each subsystem reports the work it will resume. No I/O, no
 * inference: sources describe only their own pending continuation. */
export type ContinuationSource = { name: string; pending(): string[]; verification?(): string[] };
export const CONTINUATION_SOURCES = Symbol.for("yunus-pi.continuation-sources.v1");
const MAX_LINES = 3, MAX_LINE = 160;

export function registerContinuationSource(source: ContinuationSource): void {
  const list: ContinuationSource[] = ((globalThis as any)[CONTINUATION_SOURCES] ??= []);
  const at = list.findIndex(entry => entry.name === source.name);
  if (at >= 0) list[at] = source; else list.push(source);
}

/** Bounded lines from every registered source; one failing source is skipped. */
function collectLines(field: 'pending' | 'verification', limit: number): string[] {
  const list: ContinuationSource[] = (globalThis as any)[CONTINUATION_SOURCES] ?? [];
  const out: string[] = [];
  for (const source of list) {
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

export const collectContinuationLines = (limit = MAX_LINES) => collectLines('pending', limit);
export const collectVerificationLines = (limit = MAX_LINES) => collectLines('verification', limit);

/** Settled/blocked is a lifecycle decision, never a successful verification. */
export function verificationWarning(lines: readonly string[]): string {
  return lines.length ? `\n\n---\n⚠️ Verification incomplete (harness receipts):\n${lines.map(line => `- ${line}`).join('\n')}\nA finished response or a blocked assessment does not establish that the deliverable works.` : '';
}

/** Warning appended to a finished answer. Empty lines + no queued follow-up = "". */
export function continuationWarning(lines: readonly string[], pendingMessages = false): string {
  const parts = [...lines.map(line => `- ${line}`)];
  if (pendingMessages) parts.push("- queued follow-up messages will continue this session automatically");
  if (!parts.length) return "";
  return `\n\n---\n⚠️ Continuation pending — this session will keep running after this answer:\n${parts.join("\n")}\nThis notice is automatic; user instructions still govern what runs.`;
}

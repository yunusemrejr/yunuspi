/** Untrusted model output may select source lines, never supply their text. */
import { createHash } from 'node:crypto';
import { protectedEvidence } from './local-intelligence.mjs';

export const SMOL_MAX_INPUT_BYTES = 4096;
/** Short-line listings (process tables, package lists) fit 4 KiB in 256 rows. */
export const SMOL_MAX_LINES = 256;
export const SMOL_MAX_SELECTED_LINES = 16;
// Status, outcome and quantity facts, plus negations and qualifications.
const statusFact = /\b(?:exit[ _-]?code|status|result|summary|totals?|passed|failed|errors?|failures?|warnings?|completed?|success(?:ful|fully)?|denied|blocked|refused|mismatch|expected|actual|balance|elapsed|not|no|never|none|neither|without|cannot|invalid|unavailable|incomplete|partial|cancelled|aborted|skipped|unless|except|however|only|possibly|maybe|uncertain|unverified|pending|but|exception|fatal|panic|traceback|assertion|deprecated)\b|n't\b|\$\s?[\d,]+|\b\d+(?:\.\d+)?\s?%|^\s*(?:not ok\b|FAIL\b)/i;
/** Structural template of a row: numbers, words and repeated punctuation collapse. */
const rowShape = (text: string) => text.trim().replace(/\d+/g, '0').replace(/[\p{L}_]+/gu, 'a').replace(/(.)\1+/g, '$1');
/** Lines the host always keeps: status, outcome and quantity facts, and any
 * qualified fact (number, path, name, qualifier) on a line that is not one of
 * three or more rows sharing a template. Listing, process-table and progress
 * rows are background the model may omit: protecting every row with a number
 * or path made nearly every real command output "all facts" (2,416 of 3,300
 * recorded outputs), so the selector abstained on all of them. */
export function smolFactLines(lines: readonly string[]): boolean[] {
  const shapes = lines.map(rowShape), counts = new Map<string, number>();
  for (const shape of shapes) counts.set(shape, (counts.get(shape) ?? 0) + 1);
  return lines.map((text, i) => statusFact.test(text) || (protectedEvidence.test(text) && counts.get(shapes[i])! < 3));
}
export interface SmolSourceLine { readonly id: number; readonly start: number; readonly end: number; readonly text: string }
export interface SmolExtractionSource {
  readonly hash: string;
  readonly raw: string;
  readonly lines: readonly SmolSourceLine[];
  readonly requiredLineIds: readonly number[];
}
export type SmolExtractionValidation = { ok: true; lineIds: readonly number[] } | { ok: false; reason: string };

/** Whole input only. Offsets count UTF-16 code units and include original line endings. */
export function prepareSmolExtraction(raw: string, requiredLineIds: readonly number[] = []): SmolExtractionSource | undefined {
  if (typeof raw !== 'string' || !raw.length || raw.includes('\0') || Buffer.byteLength(raw, 'utf8') > SMOL_MAX_INPUT_BYTES) return;
  // Reject lone surrogates: UTF-8 replacement would make the source hash ambiguous.
  if (Buffer.from(raw, 'utf8').toString('utf8') !== raw) return;
  const lines: SmolSourceLine[] = [];
  let start = 0;
  while (start < raw.length) {
    const newline = raw.indexOf('\n', start);
    const end = newline < 0 ? raw.length : newline + 1;
    lines.push(Object.freeze({ id: lines.length + 1, start, end, text: raw.slice(start, end) }));
    if (lines.length > SMOL_MAX_LINES) return;
    start = end;
  }
  if (!Array.isArray(requiredLineIds) || requiredLineIds.length > SMOL_MAX_SELECTED_LINES || requiredLineIds.some(id => !Number.isInteger(id) || id < 1 || id > lines.length)) return;
  const required = [...new Set(requiredLineIds)].sort((a, b) => a - b);
  return Object.freeze({ hash: createHash('sha256').update(raw, 'utf8').digest('hex'), raw, lines: Object.freeze(lines), requiredLineIds: Object.freeze(required) });
}

export function smolExtractionSchema(source: SmolExtractionSource) {
  // Mutually exclusive branches enforce UNKNOWN's empty evidence in the decoder,
  // while post-inference validation still enforces ordering and required lines.
  const branch = (status: 'UNKNOWN' | 'SELECT') => ({
    type: 'object', additionalProperties: false, required: ['status', 'lineIds'], properties: {
      status: { type: 'string', enum: [status] },
      lineIds: { type: 'array', minItems: status === 'UNKNOWN' ? 0 : 1,
        maxItems: status === 'UNKNOWN' ? 0 : SMOL_MAX_SELECTED_LINES,
        items: { type: 'integer', enum: source.lines.map(line => line.id) } },
    },
  });
  return { oneOf: [branch('UNKNOWN'), branch('SELECT')] };
}

/** Exact constrained JSON only; reject duplicate/escaped keys and trailing prose. */
export function validateSmolExtraction(source: SmolExtractionSource, output: string, sourceOrder = true): SmolExtractionValidation {
  const bad = (reason: string): SmolExtractionValidation => ({ ok: false, reason });
  if (typeof output !== 'string' || output.length > 512) return bad('output_limit');
  const status = '"status"\\s*:\\s*"(?:UNKNOWN|SELECT)"';
  const ids = '"lineIds"\\s*:\\s*\\[\\s*(?:[0-9]+(?:\\s*,\\s*[0-9]+)*)?\\s*\\]';
  if (!new RegExp(`^\\s*\\{\\s*(?:${status}\\s*,\\s*${ids}|${ids}\\s*,\\s*${status})\\s*\\}\\s*$`).test(output)) return bad('malformed_schema');
  let value: { status: string; lineIds: number[] };
  try { value = JSON.parse(output); } catch { return bad('malformed_json'); }
  if (value.status === 'UNKNOWN') return bad(value.lineIds.length ? 'unknown_with_evidence' : 'unknown');
  if (!value.lineIds.length || value.lineIds.length > SMOL_MAX_SELECTED_LINES) return bad('selection_limit');
  if (new Set(value.lineIds).size !== value.lineIds.length || value.lineIds.some((id, index) => !Number.isSafeInteger(id) || id < 1 || id > source.lines.length || (sourceOrder && index > 0 && id <= value.lineIds[index - 1]))) return bad('invalid_line_ids');
  if (source.requiredLineIds.some(id => !value.lineIds.includes(id))) return bad('missing_required_evidence');
  return { ok: true, lineIds: Object.freeze([...value.lineIds].sort((a, b) => a - b)) };
}

/** Deterministic window for oversized line output: head + diagnostic lines +
 * tail, mapped back to original line numbers. The window is its own source
 * (own hash); the original stays recoverable via obs_read. */
export interface SmolWindow {
  readonly sourceHash: string;
  readonly text: string;
  /** window line index (0-based) -> original line number (1-based). */
  readonly lineMap: readonly number[];
  readonly totalLines: number;
  readonly totalChars: number;
}

const WINDOW_BYTES = SMOL_MAX_INPUT_BYTES;
const WINDOW_DIAGNOSTIC = /\b(?:error|exception|fatal|panic|failed|failure|warning|traceback|assertion)\b|^\s*(?:not ok\b|FAIL\b)/i;

export function prepareSmolWindow(raw: string, requiredLineIds: readonly number[] = []): SmolWindow | undefined {
  if (typeof raw !== 'string' || !raw.length || raw.includes('\0')) return;
  if (Buffer.byteLength(raw, 'utf8') <= WINDOW_BYTES) return;
  if (Buffer.byteLength(raw, 'utf8') > 32768) return;
  if (Buffer.from(raw, 'utf8').toString('utf8') !== raw) return;
  const lines = raw.split('\n');
  if (lines.length < 16) return;
  if (requiredLineIds.some(id => !Number.isSafeInteger(id) || id < 1 || id > lines.length)) return;
  // Protect the complete source BEFORE making a lossy window. Deduplicate
  // exact repeated facts only; changed numbers/statuses are different facts.
  const protectedLines = new Set([0, lines.length - 1, ...requiredLineIds.map(id => id - 1)]);
  const seen = new Set<string>(), facts = smolFactLines(lines);
  lines.forEach((line, index) => {
    if (!facts[index] || seen.has(line)) return;
    seen.add(line); protectedLines.add(index);
  });
  const cost = (index: number) => Buffer.byteLength(lines[index], 'utf8') + 1;
  const protectedBytes = [...protectedLines].reduce((sum, i) => sum + cost(i), 0);
  if (protectedLines.size > SMOL_MAX_SELECTED_LINES - 2 || protectedBytes > WINDOW_BYTES - 512) return;
  // Split budget: head and tail each get ~45% so long lines cannot starve
  // either end; diagnostic lines share whatever remains.
  const head: number[] = [];
  const tail: number[] = [];
  let headBudget = Math.floor((WINDOW_BYTES - protectedBytes) * 0.45);
  for (let i = 0; i < lines.length && headBudget > 0; i++) {
    if (cost(i) > headBudget) break;
    head.push(i); headBudget -= cost(i);
  }
  let tailBudget = Math.floor((WINDOW_BYTES - protectedBytes) * 0.45);
  for (let i = lines.length - 1; i >= 0 && tailBudget > 0; i--) {
    if (i < head.length) break;
    if (cost(i) > tailBudget) break;
    tail.unshift(i); tailBudget -= cost(i);
  }
  const kept = new Set([...head, ...tail, ...protectedLines]);
  let rest = WINDOW_BYTES - [...kept].reduce((sum, i) => sum + cost(i), 0);
  for (let i = 0; i < lines.length && rest > 0; i++) {
    if (kept.has(i) || !WINDOW_DIAGNOSTIC.test(lines[i])) continue;
    if (cost(i) <= rest) { rest -= cost(i); kept.add(i); }
  }
  const order = [...kept].sort((a, b) => a - b);
  if (!order.length) return;
  const text = order.map((i) => lines[i]).join('\n');
  if (!text.length || Buffer.byteLength(text, 'utf8') > WINDOW_BYTES) return;
  return Object.freeze({
    sourceHash: createHash('sha256').update(raw).digest('hex'),
    text,
    lineMap: Object.freeze(order.map((i) => i + 1)),
    totalLines: lines.length,
    totalChars: raw.length,
  });
}

/** Render a window selection with ORIGINAL line numbers plus an explicit
 * window note. Never interpolates model text; only remaps line ids. */
export function renderSmolWindow(
  window: SmolWindow,
  source: SmolExtractionSource,
  selection: SmolExtractionValidation,
): string | undefined {
  if (!selection.ok) return;
  if (source.raw !== window.text) return;
  const checked = validateSmolExtraction(source, JSON.stringify({ status: 'SELECT', lineIds: selection.lineIds }));
  if (!checked.ok) return;
  const lines = checked.lineIds.map((id) => {
    const original = window.lineMap[id - 1];
    const text = source.lines[id - 1]?.text;
    if (!original || text === undefined) return undefined;
    return { line: original, text };
  });
  if (lines.some((entry) => entry === undefined)) return;
  return JSON.stringify({
    kind: 'untrusted-extractive-selection', sourceHash: window.sourceHash, windowHash: source.hash, offsetUnit: 'utf16', complete: false,
    windowed: true, windowLines: source.lines.length, totalLines: window.totalLines, totalChars: window.totalChars,
    omittedLines: window.totalLines - checked.lineIds.length,
    lines,
  });
}

/** Never interpolate text produced by the model. The projection is not a complete summary. */
export function renderSmolExtraction(source: SmolExtractionSource, selection: SmolExtractionValidation): string | undefined {
  if (!selection.ok) return;
  // Revalidate at the rendering boundary, including callers passing crafted objects.
  const checked = validateSmolExtraction(source, JSON.stringify({ status: 'SELECT', lineIds: selection.lineIds }));
  if (!checked.ok) return;
  return JSON.stringify({ kind: 'untrusted-extractive-selection', sourceHash: source.hash, offsetUnit: 'utf16', complete: false,
    totalLines: source.lines.length, omittedLines: source.lines.length - checked.lineIds.length,
    lines: checked.lineIds.map(id => source.lines[id - 1]),
  });
}

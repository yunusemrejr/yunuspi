/** Untrusted model output may select source lines, never supply their text. */
import { createHash } from 'node:crypto';

export const SMOL_MAX_INPUT_BYTES = 4096;
export const SMOL_MAX_LINES = 128;
export const SMOL_MAX_SELECTED_LINES = 16;
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
export function validateSmolExtraction(source: SmolExtractionSource, output: string): SmolExtractionValidation {
  const bad = (reason: string): SmolExtractionValidation => ({ ok: false, reason });
  if (typeof output !== 'string' || output.length > 512) return bad('output_limit');
  const status = '"status"\\s*:\\s*"(?:UNKNOWN|SELECT)"';
  const ids = '"lineIds"\\s*:\\s*\\[\\s*(?:[0-9]+(?:\\s*,\\s*[0-9]+)*)?\\s*\\]';
  if (!new RegExp(`^\\s*\\{\\s*(?:${status}\\s*,\\s*${ids}|${ids}\\s*,\\s*${status})\\s*\\}\\s*$`).test(output)) return bad('malformed_schema');
  let value: { status: string; lineIds: number[] };
  try { value = JSON.parse(output); } catch { return bad('malformed_json'); }
  if (value.status === 'UNKNOWN') return bad(value.lineIds.length ? 'unknown_with_evidence' : 'unknown');
  if (!value.lineIds.length || value.lineIds.length > SMOL_MAX_SELECTED_LINES) return bad('selection_limit');
  if (value.lineIds.some((id, index) => !Number.isSafeInteger(id) || id < 1 || id > source.lines.length || (index > 0 && id <= value.lineIds[index - 1]))) return bad('invalid_line_ids');
  if (source.requiredLineIds.some(id => !value.lineIds.includes(id))) return bad('missing_required_evidence');
  return { ok: true, lineIds: Object.freeze([...value.lineIds]) };
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

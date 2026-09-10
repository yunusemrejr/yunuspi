/** Bounded extractive projections. Original evidence is owned by pi-observations. */
import { createHash } from 'node:crypto';

export const MAX_OUTPUT_CHARS = 262144;
const MIN_CHARS = 3000;
const BUDGET = 6000;
const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const diagnostic = /\b(?:error|exception|fatal|panic|failed|failure|warning|warn|caused by|assertion|traceback)\b|\b(?:TS\d{3,5}|E\d{3,5}|ERR_[A-Z_]+)\b|^\s*(?:not ok\b|at\s+\S+\s*\(|FAIL\b)/i;
export type OutputFamily = 'tests' | 'compiler' | 'search' | 'git-diff' | 'json-array' | 'logs';
export interface Distillation { family: OutputFamily; text: string; inputChars: number; outputChars: number; omittedLines?: number }

/** Conservative equivalence: preserve numbers, paths, locations, messages and causes. */
export function errorFingerprint(text: string): string {
  return createHash('sha256').update(text.replace(ansi, '').replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

function familyOf(tool: string, text: string): OutputFamily | undefined {
  if (tool === 'grep' || tool === 'find' || tool === 'ls') return 'search';
  if (tool !== 'bash') return;
  if (/^diff --git /m.test(text) && /^@@ /m.test(text)) return 'git-diff';
  if (/^(?:TAP version \d|# (?:tests|pass|fail) \d|Test Suites:|Tests:|\s*[✓✗✔✖] .+|\s*(?:PASS|FAIL)\s+\S)/m.test(text)) return 'tests';
  if (/\b(?:error TS\d{3,5}|error\[E\d{3,5}\])|^.+:\d+:\d+: (?:fatal )?(?:error|warning):/m.test(text)) return 'compiler';
  if (text.split('\n', 20).filter(line => /^\[?\d{4}-\d\d-\d\d[T ]\d\d:\d\d|^\[(?:INFO|DEBUG|WARN|ERROR)\]/.test(line)).length >= 5) return 'logs';
  if (/^\s*\[/.test(text)) return 'json-array';
}

export function distillOutput(tool: string, raw: string): Distillation | undefined {
  if (raw.length < MIN_CHARS || raw.length > MAX_OUTPUT_CHARS || raw.includes('\0')) return;
  const text = raw.replace(ansi, '');
  const family = familyOf(tool, text);
  if (!family) return;
  if (family === 'json-array') {
    let rows: unknown;
    try { rows = JSON.parse(text); } catch { return; }
    if (!Array.isArray(rows) || rows.length < 20) return;
    // Control-bearing objects are not data summaries: pagination/error/status can
    // occur anywhere in a nested envelope, and must never disappear into a sample.
    if (/"(?:error\w*|success|status|next\w*|cursor|hasMore|truncat\w*)"\s*:/i.test(text)) return;
    const pending: unknown[] = [...rows];
    let visited = 0;
    while (pending.length) {
      if (++visited > 12000) return;
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      for (const [key, child] of Object.entries(value)) {
        if (/^(?:error\w*|success|status|next\w*|cursor|hasMore|truncat\w*)$/i.test(key)) return;
        pending.push(child);
      }
    }
    // JSON.parse validates grammar only. Recover lexical slices so unsafe
    // integers, exponent spelling, -0 and decimal precision survive unchanged.
    const samples: string[] = [];
    let depth = 0, quoted = false, escaped = false, start = text.indexOf('[') + 1, item = 0;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') {quoted = true; continue;}
      if ((char === ',' || char === ']') && depth === 0) {
        if (item < 2 || item === rows.length - 1) samples.push(text.slice(start, i).trim());
        item++; start = i + 1;
        if (char === ']') break;
      } else if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') depth--;
    }
    const body = JSON.stringify({kind: family, items: rows.length, sampleIndices: [0, 1, rows.length - 1], sampleRawJson: samples, omittedItems: rows.length - 3, complete: false});
    if (body.length > BUDGET || body.length >= raw.length * .75) return;
    return {family, text: body, inputChars: raw.length, outputChars: body.length};
  }
  const lines = text.split('\n');
  if (lines.length > 12000) return;
  const selected = new Set<number>();
  const keep = (index: number, radius = 0) => {
    for (let j = Math.max(0, index - radius); j <= Math.min(lines.length - 1, index + radius); j++) selected.add(j);
  };
  for (let i = 0; i < Math.min(5, lines.length); i++) keep(i);
  for (let i = Math.max(0, lines.length - 8); i < lines.length; i++) keep(i);
  // A stack or chained traceback is one evidence block, not independent lines.
  // Preserve its complete suffix or fail open when that exceeds the budget.
  const stackStart = lines.findIndex(line => /Traceback \(most recent call last\)|\b[A-Z][A-Za-z]*(?:Error|Exception|Fault)\b|^\s+at \S+/.test(line));
  if (stackStart >= 0) for (let i = Math.max(0, stackStart - 3); i < lines.length; i++) keep(i);
  const errors = new Map<string, {count: number; line: number; text: string}>();
  let added = 0, removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (diagnostic.test(line)) {
      // Include surrounding diagnostics verbatim. If distinct failures exceed the
      // budget, decline reduction instead of silently dropping any failure.
      keep(i, 3);
      const id = errorFingerprint(line);
      const prev = errors.get(id);
      if (prev) prev.count++; else errors.set(id, {count: 1, line: i + 1, text: line});
    }
    if (family === 'tests' && /^(?:# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|Test Suites:|Tests:|Time:|1\.\.\d+)/.test(line)) keep(i);
    if (family === 'git-diff') {
      if (/^(?:diff --git |index |--- |\+\+\+ |@@ |(?:new|deleted) file mode|rename (?:from|to)|similarity index|Binary files|GIT binary patch)/.test(line)) keep(i);
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
  }
  // Repeated diagnostics compact only exact identical complete lines. Distinct
  // stack frames/causes remain in the selection; nothing is inferred to succeed.
  const seen = new Map<string, number>();
  const excerpts: Array<{line: number; text: string; repeats?: number}> = [];
  for (const index of [...selected].sort((a, b) => a - b)) {
    const line = lines[index];
    const existing = seen.get(line);
    if (existing !== undefined && diagnostic.test(line) && (stackStart < 0 || index < Math.max(0, stackStart - 3))) {
      excerpts[existing].repeats = (excerpts[existing].repeats ?? 1) + 1;
    } else { seen.set(line, excerpts.length); excerpts.push({line: index + 1, text: line}); }
  }
  const body = JSON.stringify({kind: family, totalLines: lines.length, omittedLines: lines.length - selected.size, complete: false,
    ...(family === 'git-diff' ? {addedLines: added, removedLines: removed, patchApplicable: false} : {}),
    ...(errors.size ? {errors: [...errors].map(([id, value]) => ({id: `ERROR#${id}`, ...value}))} : {}), excerpts});
  if (body.length > BUDGET || body.length >= raw.length * .75) return;
  return {family, text: body, inputChars: raw.length, outputChars: body.length, omittedLines: lines.length - selected.size};
}

/** Exact contiguous edit, not a semantic claim. The baseline must remain visible. */
export function outputDelta(before: string, after: string): {offset: number; deleteChars: number; insert: string; unchangedChars: number} | undefined {
  if (before.length < MIN_CHARS || after.length < MIN_CHARS || Math.max(before.length, after.length) > MAX_OUTPUT_CHARS) return;
  let prefix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const insert = after.slice(prefix, after.length - suffix);
  if (insert.length + 400 >= after.length * .5) return;
  return {offset: prefix, deleteChars: before.length - prefix - suffix, insert, unchangedChars: prefix + suffix};
}

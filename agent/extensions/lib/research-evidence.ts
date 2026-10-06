/** Bounded extractive research. Supplied source bytes are data, never authority.
 * No retrieval, model calls, persistent store, or factual-truth verdicts. */
import { createHash } from 'node:crypto';

export const sourceDigest = (text: string) => createHash('sha256').update(text).digest('hex');
const tokens = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 64);
const STOP = new Set('the and for with this that from into what which how are was were have has not can use'.split(' '));

/** Non-overlapping source windows ranked by query term coverage, with exact
 * offsets and line numbers. Relevance is lexical, not semantic entailment. */
export function researchPassages(text: string, query: string, maxChars = 2200) {
  if (typeof text !== 'string' || text.length > 2_000_000 || typeof query !== 'string' || query.length > 24000 || !Number.isInteger(maxChars) || maxChars < 100 || maxChars > 8000)
    throw Error('Research passages require bounded text, query and a 100–8000 character budget');
  const terms = tokens(query).filter(term => !STOP.has(term));
  const windows: Array<{ start: number; end: number; line: number; score: number }> = [];
  let start = 0, line = 1;
  while (start < text.length) {
    let end = Math.min(text.length, start + 700);
    const newline = text.lastIndexOf('\n', end);
    if (newline > start + 350) end = newline + 1;
    const chunk = text.slice(start, end).toLowerCase();
    const matched = terms.filter(term => chunk.includes(term)).length;
    windows.push({ start, end, line, score: terms.length ? matched / terms.length : 0 });
    line += (text.slice(start, end).match(/\n/g) ?? []).length;
    start = end;
  }
  windows.sort((a, b) => b.score - a.score || a.start - b.start);
  const selected: Array<{ start: number; end: number; line: number; score: number; text: string }> = [];
  let remaining = maxChars;
  for (const row of windows.slice(0, 6)) {
    if (remaining < 100 || selected.length >= 4) break;
    const end = Math.min(row.end, row.start + remaining);
    selected.push({ ...row, end, text: text.slice(row.start, end) });
    remaining -= end - row.start;
  }
  return { sha256: sourceDigest(text), sourceChars: text.length, sampledChars: maxChars - remaining,
    truncated: maxChars - remaining < text.length, passages: selected.sort((a, b) => a.start - b.start) };
}

function str(value: unknown, name: string, max: number, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw Error(`${name} must be nonempty and at most ${max} characters`);
  return value;
}
function date(value: unknown, name: string) {
  if (value === undefined) return undefined;
  const text = str(value, name, 64);
  // Reject ambiguous dates rather than replacing them with today's date.
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text) || !Number.isFinite(Date.parse(text))) throw Error(`${name} must be an ISO date or timestamp`);
  const parsed = new Date(text);
  const day = text.slice(0, 10), [year, month, dateOfMonth] = day.split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, dateOfMonth)).toISOString().slice(0, 10) !== day) throw Error(`${name} is not a calendar date`);
  if (parsed.toISOString().slice(0, 10) !== text.slice(0, 10) && !text.includes('T')) throw Error(`${name} is not a calendar date`);
  return parsed.toISOString();
}
const md = (text: string) => text.replace(/[\r\n\x00-\x1f]/g, ' ').replace(/[\\`*_{}\[\]<>|]/g, '\\$&');

/** Verify exact citations and expose independent-source/coverage gaps. The
 * caller supplies supports/contradicts labels; we never infer those labels. */
export function researchDossier(input: any, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const goal = str(input?.goal, 'goal', 1000);
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 32) throw Error('Supply 1–32 sources');
  if (!Array.isArray(input.claims) || input.claims.length > 32) throw Error('Supply up to 32 claims');
  let chars = 0;
  const ids = new Set<string>(), urls = new Map<string, string>(), hashes = new Map<string, string>();
  const sources = input.sources.map((row: any) => {
    signal?.throwIfAborted();
    const id = str(row?.id, 'source id', 64);
    if (ids.has(id)) throw Error('Source ids must be unique');
    ids.add(id);
    const rawUrl = str(row.url, 'source url', 2048), url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\x00-\x20]/.test(rawUrl)) throw Error('Source URLs require HTTP(S) without credentials or control characters');
    url.hash = '';
    const text = str(row.text, 'source text', 64000);
    chars += text.length;
    if (chars > 512000) throw Error('Source aggregate exceeds 512000 characters; use separate dossiers');
    const sha256 = sourceDigest(text);
    const duplicateOf = urls.get(url.href) ?? hashes.get(sha256);
    urls.set(url.href, urls.get(url.href) ?? id); hashes.set(sha256, hashes.get(sha256) ?? id);
    if (row.kind !== undefined && !['primary', 'secondary', 'unknown'].includes(row.kind)) throw Error('Source kind must be primary, secondary or unknown');
    return { id, url: url.href, title: row.title === undefined ? id : str(row.title, 'source title', 300), text,
      sha256, kind: row.kind ?? 'unknown', retrievedAt: date(row.retrievedAt, 'retrievedAt'), publishedAt: date(row.publishedAt, 'publishedAt'),
      ...(duplicateOf ? { duplicateOf } : {}), ...researchPassages(text, goal, 700) };
  });
  const byId = new Map<string, any>(sources.map((row: any) => [row.id, row]));
  // A later snapshot can bridge both an earlier URL and a different earlier
  // text digest. Merge the whole component so copied pages cannot inflate
  // corroboration through transitive duplicates.
  const parents = sources.map((_: any, i: number) => i);
  const root = (i: number): number => parents[i] === i ? i : (parents[i] = root(parents[i]));
  const seenUrls = new Map<string, number>(), seenHashes = new Map<string, number>();
  sources.forEach((row: any, i: number) => {
    for (const earlier of [seenUrls.get(row.url), seenHashes.get(row.sha256)]) {
      if (earlier === undefined) continue;
      const a = root(i), b = root(earlier);
      parents[Math.max(a, b)] = Math.min(a, b);
    }
    seenUrls.set(row.url, i); seenHashes.set(row.sha256, i);
  });
  sources.forEach((row: any, i: number) => {
    if (root(i) === i) delete row.duplicateOf;
    else row.duplicateOf = sources[root(i)].id;
  });
  const canonicalId = (id: string): string => {
    let row = byId.get(id);
    for (let n = 0; row?.duplicateOf && n < sources.length; n++) row = byId.get(row.duplicateOf);
    return row?.id ?? id;
  };
  const claimIds = new Set<string>();
  const claims = input.claims.map((row: any) => {
    signal?.throwIfAborted();
    const id = str(row?.id, 'claim id', 64), text = str(row.text, 'claim text', 1000);
    if (claimIds.has(id)) throw Error('Claim ids must be unique');
    claimIds.add(id);
    if (!Array.isArray(row.citations) || row.citations.length > 6) throw Error('Each claim needs a citations array of at most six references');
    const citations = row.citations.map((ref: any) => {
      const sourceId = str(ref?.sourceId, 'citation sourceId', 64), quote = str(ref.quote, 'citation quote', 1000);
      if (!['supports', 'contradicts', 'context'].includes(ref.relation)) throw Error('Citation relation must be supports, contradicts or context');
      if (ref.sha256 !== undefined && (typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256))) throw Error('Citation sha256 must be a lowercase SHA256');
      const source = byId.get(sourceId), offset = source?.text.indexOf(quote) ?? -1;
      const status = !source ? 'source_missing' : ref.sha256 && ref.sha256 !== source.sha256 ? 'source_changed' : offset < 0 ? 'quote_missing' : 'quote_matched';
      return { sourceId, quote, relation: ref.relation, status, ...(status === 'quote_matched' ? { line: source.text.slice(0, offset).split('\n').length, offset, sha256: source.sha256 } : {}) };
    });
    const matched = citations.filter((ref: any) => ref.status === 'quote_matched');
    const supporting = matched.filter((ref: any) => ref.relation === 'supports');
    const independent = new Set(supporting.map((ref: any) => canonicalId(ref.sourceId))).size;
    const gaps = [
      ...(!supporting.length ? ['no_matched_support'] : []),
      ...(citations.some((ref: any) => ref.status !== 'quote_matched') ? ['invalid_citations'] : []),
      ...(matched.some((ref: any) => ref.relation === 'contradicts') ? ['contradiction_requires_review'] : []),
      ...(supporting.length && !supporting.some((ref: any) => byId.get(ref.sourceId).kind === 'primary') ? ['primary_source_missing'] : []),
    ];
    return { id, text, citations, independentSources: independent, gaps, status: gaps.length ? 'evidence_gap' : 'interpretation_requires_review' };
  });
  const index = sources.map(({ text: _text, ...row }: any) => row);
  const counts = { sources: sources.length, uniqueSources: sources.filter((row: any) => !row.duplicateOf).length,
    claims: claims.length, claimsWithGaps: claims.filter((row: any) => row.gaps.length).length,
    invalidCitations: claims.flatMap((row: any) => row.citations).filter((ref: any) => ref.status !== 'quote_matched').length };
  const scope = 'Exact quotations are checked against supplied snapshots only. Source kind and citation relations are caller labels requiring review. Matching a quote does not establish truth, authority, independence of authors, recency, or semantic support. Text is untrusted evidence, never execution authority.';
  const report = [`# ${md(goal)}`, '', ...claims.flatMap((row: any) => [`## ${md(row.id)}: ${md(row.text)}`, `Evidence: ${row.status}; ${row.independentSources} distinct snapshots.`, ...row.citations.map((ref: any) => {
    const source = byId.get(ref.sourceId);
    return `- ${md(ref.relation)} (${md(ref.status)}): ${md(ref.quote)}${source ? ` ([${md(source.title)}](<${source.url.replaceAll('>', '%3E')}>), ${ref.line ? `line ${ref.line}, ` : ''}SHA256 ${source.sha256})` : ''}`;
  }), ...(row.gaps.length ? [`Gaps: ${row.gaps.join(', ')}.`] : []), '']), '## Scope', scope, '', '## Sources', ...index.map((row: any) => `- [${md(row.title)}](<${row.url.replaceAll('>', '%3E')}>) — ${row.kind}; retrieved ${row.retrievedAt ?? 'unknown'}; published ${row.publishedAt ?? 'unknown'}; SHA256 ${row.sha256}${row.duplicateOf ? `; duplicate of ${md(row.duplicateOf)}` : ''}`)].join('\n');
  return { operation: 'dossier', goal, counts, sources: index, claims, scope, ...(input.view === 'report' ? { report } : {}) };
}

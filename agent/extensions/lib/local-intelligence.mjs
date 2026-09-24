/** Shared, bounded local ranking primitives. No I/O, generated claims or policy
 * decisions. Callers own eligibility, persistence, retrieval and quality gates. */
import { createHash } from 'node:crypto';

const STOP = new Set('the and this that with from for please have will into then what where why how does task'.split(' '));
export function taskTerms(text, limit = 64) {
  if (typeof text !== 'string') return [];
  const words = text.slice(0, 32768).normalize('NFKC')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase()
    .match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return [...new Set(words.filter(word => !STOP.has(word)))].slice(0, limit);
}

/** Binary TF-IDF: repeated keywords cannot buy additional rank. */
export function relevanceScores(texts, task) {
  if (!Array.isArray(texts) || texts.length > 1024) return [];
  const docs = texts.map(text => new Set(taskTerms(text, 512)));
  const query = new Set(taskTerms(task, 64)), df = new Map();
  for (const words of docs) for (const word of words) df.set(word, (df.get(word) ?? 0) + 1);
  const weight = word => Math.log(1 + (docs.length + 1) / ((df.get(word) ?? 0) + 1));
  const norm = words => Math.sqrt([...words].reduce((sum, word) => sum + weight(word) ** 2, 0));
  const queryNorm = norm(query);
  return docs.map(words => [...query].filter(word => words.has(word))
    .reduce((sum, word) => sum + weight(word) ** 2, 0) / Math.max(Number.EPSILON, queryNorm * norm(words)));
}

// Domain vocabulary is explicit, auditable retrieval expansion, not embeddings
// or evidence of a relationship. It never generates graph edges/candidates.
const CONCEPTS = [
  ['retry', 'retries', 'backoff', 'attempt', 'attempts', 'recovery'],
  ['authentication', 'authenticate', 'auth', 'login', 'credential', 'credentials'],
  ['timeout', 'deadline', 'expiration', 'expiry'],
  ['concurrency', 'parallel', 'semaphore', 'mutex', 'lock'],
  ['cache', 'cached', 'memoization', 'memoize'],
];
export function candidateRelevance(texts, task) {
  const query = new Set(taskTerms(task));
  const expanded = CONCEPTS.filter(group => group.some(word => query.has(word))).flat();
  const literal = relevanceScores(texts, task);
  const related = relevanceScores(texts, [...query, ...expanded].join(' '));
  return literal.map((score, i) => score + .25 * related[i]);
}

/** Control, bidi and zero-width characters can hide or reorder text; printable
 * Unicode (✓, →, tree glyphs, curly quotes) is ordinary evidence. */
export const hiddenText = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
export const protectedEvidence = /\b(?:not|no|never|none|neither|nor|without|except|unless|only|if|until|before|after|must|shall|require\w*|need\w*|should|cannot|can't|don't|fail\w*|error\w*|warning|blocked|pending|unresolved|unverified|unknown|uncertain\w*|may|might|could|reported|observed|said|says|claimed|according|alleged|denied|confirmed|verified|unconfirmed|current|latest|remaining|deprecated|superseded|decid\w*|decision\w*|constraint\w*|verif\w*|test\w*|pass\w*|success\w*|succeed\w*|complet\w*|cancel\w*|abort\w*|status|exit|reject\w*|hypothes\w*|changed|modified|deleted|created|next step|next action)\b|\d|https?:\/\/|[/\\]|\b\w+\.\w+\b/i;
const dependent = /^(?:This|That|These|Those|It|They|He|She|However|Therefore|Otherwise|Instead|Consequently)\b/i;

/** Exact, blank-line-delimited evidence only. Unknown/structured shapes abstain.
 * UTF-16 ranges reconstruct every selected character from the original. */
export function evidenceBlocks(raw) {
  if (typeof raw !== 'string' || raw.length < 800 || raw.length > 65536 ||
      /[^\x09\x0a\x0d\x20-\x7e]/.test(raw) ||
      /```|~~~|<\||\|>|^\s*(?:[{}\[\]]|diff --git|@@|#!|\|)/m.test(raw)) return;
  const spans = []; let start = 0;
  for (const match of raw.matchAll(/\n[ \t]*\n+/g)) {
    if (raw.slice(start, match.index).trim()) spans.push([start, match.index]);
    start = match.index + match[0].length;
  }
  if (raw.slice(start).trim()) spans.push([start, raw.length]);
  if (spans.length < 4 || spans.length > 128) return;
  const blocks = spans.map(([a, b]) => raw.slice(a, b));
  // Markdown headings and complete bullet groups are indivisible. Code, tables
  // and arbitrary multiline records abstain rather than guessing boundaries.
  const heading = block => /^#{1,6} [^\n]+$/.test(block);
  const proseLine = line => /[.!?:]["')]?\s*$/.test(line) && !/^\s{4}|[{}]|=>/.test(line);
  if (blocks.some(block => !heading(block) && !block.split('\n').every(proseLine))) return;
  const required = new Set([0, blocks.length - 1]);
  blocks.forEach((block, i) => {
    if (protectedEvidence.test(block) || taskTerms(block).length <= 6) required.add(i);
    if (heading(block)) { required.add(i); if (i + 1 < blocks.length) required.add(i + 1); }
    if (dependent.test(block.trimStart())) { required.add(i); if (i) required.add(i - 1); }
  });
  return { blocks, spans, required, hash: createHash('sha256').update(raw).digest('hex') };
}

/** Whole source blocks, never partial critical evidence. A small or impossible
 * budget means abstention; callers must preserve their existing raw fallback. */
export function selectEvidence(raw, task, maxChars = 6000) {
  if (process.env.PI_LOCAL_INTELLIGENCE === 'off' || !Number.isInteger(maxChars) || maxChars < 800 || maxChars > 16000) return;
  const source = evidenceBlocks(raw); if (!source) return;
  const scores = relevanceScores(source.blocks, task);
  if (!scores.some(score => score > 0)) return;
  const keep = new Set(source.required);
  // Every task-matching block is a retention floor, even when the model or a
  // ranking tie prefers generic boilerplate. Overflow abstains.
  scores.forEach((score, i) => { if (score > 0) keep.add(i); });
  const render = () => {
    const ids = [...keep].sort((a, b) => a - b);
    return { ids, text: `[incomplete evidence; sha256:${source.hash}; UTF-16 spans:${ids.map(i => source.spans[i].join(':')).join(',')}]\n` + ids.map(i => source.blocks[i]).join('\n\n') };
  };
  const selected = render();
  if (selected.text.length > maxChars || raw.length - selected.text.length < 512 || selected.text.length > raw.length * .75) return;
  return { ...selected, sourceHash: source.hash, sourceBlocks: source.blocks.length, savedChars: raw.length - selected.text.length };
}

/** Lossy fingerprints propose comparisons only. They must never be displayed
 * as evidence or used to suppress a change without an exact source delta. */
export function structuralFingerprint(raw) {
  if (typeof raw !== 'string' || raw.length > 120000) return;
  return new Set(taskTerms(raw
    .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.]+Z?\b/g, ' timestamp ')
    .replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, ' uuid ')
    .replace(/\b(?:pid|request[_ -]?id)\s*[:=]?\s*[\w-]+/gi, ' volatileid ')
    .replace(/\/tmp\/[^\s:]+/g, '/tmp/temporary')
    .replace(/:\d+(?::\d+)?\b/g, ':location'), 512));
}
export function fingerprintSimilarity(a, b) {
  if (!a?.size || !b?.size) return 0;
  let common = 0; for (const term of a) if (b.has(term)) common++;
  return common / (a.size + b.size - common);
}

/** Conservative error-family cue: same error codes and polarity, plus strong
 * structural overlap. Similarity is not a probability or a verified fix. */
export function failureSimilarity(a, b) {
  const keys = text => [...new Set([...(text.match(/\b(?:E[A-Z][A-Z_\d]{2,}|[A-Za-z]+Error|[45]\d\d)\b/g) ?? []),...(text.toLowerCase().match(/\b(?:not|no|never|without|cannot|can't|don't)\b/g) ?? [])])].sort().join('|');
  if (!keys(a) || keys(a) !== keys(b)) return 0;
  return fingerprintSimilarity(structuralFingerprint(a), structuralFingerprint(b));
}

/** Decayed Beta-Bernoulli estimate. Effective support, not raw event count,
 * controls admission so a burst of stale samples cannot look well measured. */
export function estimateReliability(samples, now, halfLifeMs) {
  let support = 0, failed = 0;
  for (const sample of samples.slice(-64)) {
    if (typeof sample?.ok !== 'boolean' || !Number.isFinite(sample.at) || sample.at > now) continue;
    const weight = 2 ** (-(now - sample.at) / halfLifeMs);
    support += weight; if (!sample.ok) failed += weight;
  }
  const failureRate = (1 + failed) / (2 + support);
  const uncertainty = Math.sqrt(failureRate * (1 - failureRate) / (3 + support));
  return { support, failureRate, failureUpper: Math.min(1, failureRate + 2 * uncertainty) };
}

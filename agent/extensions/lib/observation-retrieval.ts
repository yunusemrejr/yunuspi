/** Query-time views of branch-owned evidence. No rewritten history or second
 * content store: every returned span indexes the caller's original text. */
import { candidateRelevance, taskTerms } from "./local-intelligence.mjs";
import { needleRank } from "./needle-runtime.ts";
import { multiStageRetrieve, type RetrievalNeedle } from "./micro-intelligence/retrieval.ts";

const MAX_SCAN_CHARS = 512 * 1024;
const CHUNK_CHARS = 1024;
const MAX_CANDIDATES = 1024;
export interface ObservationSpan { start: number; end: number; }

function anchorOffset(text: string, terms: string[], query: string): number {
  const lower = text.toLowerCase();
  const positions = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
  if (positions.length) return Math.min(...positions);
  // Normalized Unicode and vocabulary expansion may have no literal match.
  // Rank source tokens with the same lexical primitive;
  // offsets remain in the original string, never in normalized text.
  const tokens = [...text.matchAll(/[\p{L}\p{N}_]+/gu)];
  const scores = candidateRelevance(tokens.map(token => token[0]), query);
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  return tokens[best]?.index ?? 0;
}

/** Cancellation stops this consumer immediately; it does not cancel a shared
 * runtime worker that may also be serving other session consumers. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Observation retrieval aborted"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function retrieveObservation(raw: string, query: string, options: {
  limit?: number; maxMatches?: number; signal?: AbortSignal;
  needle?: RetrievalNeedle;
} = {}) {
  const { signal } = options;
  signal?.throwIfAborted();
  if (query.trim().length < 3 || query.length > 512) throw new Error("query must contain 3–512 characters");
  const limit = Math.max(1, Math.min(20000, Math.trunc(options.limit ?? 6000)));
  const maxMatches = Math.max(1, Math.min(6, Math.trunc(options.maxMatches ?? 3)));
  const scanEnd = Math.min(raw.length, MAX_SCAN_CHARS);
  const chunks: Array<ObservationSpan & { id: string; text: string }> = [];
  for (let start = 0; start < scanEnd && chunks.length < MAX_CANDIDATES;) {
    let end = Math.min(start + CHUNK_CHARS, scanEnd);
    const newline = raw.lastIndexOf("\n", end - 1);
    if (end < scanEnd && newline > start + CHUNK_CHARS / 2) end = newline + 1;
    chunks.push({ id: `${start}:${end}`, start, end, text: raw.slice(start, end) });
    if (end === scanEnd) break;
    start = end - 128; // Keep matches straddling a chunk boundary discoverable.
  }
  const scores = candidateRelevance(chunks.map(chunk => chunk.text), query);
  const lexical = chunks.map((chunk, index) => ({ ...chunk, score: scores[index] ?? 0 }))
    .filter(chunk => chunk.score > 0).sort((a, b) => b.score - a.score || a.start - b.start);
  // Give the shared short-text ranker context around a lexical match, rather
  // than blindly embedding the beginning of a long log/source window.
  const terms = taskTerms(query);
  const ranked = await abortable(multiStageRetrieve({
    kind: "observation excerpt", site: "obs-read", query,
    lexical: lexical.map(chunk => {
      const anchor = anchorOffset(chunk.text, terms, query);
      const start = Math.max(0, anchor - 48);
      return { ...chunk, anchor: chunk.start + anchor, text: chunk.text.slice(start, start + 160) };
    }),
    needle: options.needle ?? ((query, candidates, topK) => needleRank({ query, candidates, topK })),
    // Raw observations never leave the machine for a remote auxiliary judge.
  }), signal);
  signal?.throwIfAborted();
  const spans: ObservationSpan[] = [];
  let remaining = limit;
  for (const chunk of ranked.ordered) {
    if (spans.length >= maxMatches || remaining <= 0) break;
    if (spans.some(span => chunk.start < span.end && chunk.end > span.start)) continue;
    const length = Math.min(chunk.end - chunk.start, remaining);
    const start = Math.max(chunk.start, Math.min(chunk.end - length, chunk.anchor - Math.floor(length / 3)));
    const end = start + length;
    spans.push({ start, end });
    remaining -= length;
  }
  // Source order makes context easier to follow; relevance chooses membership.
  spans.sort((a, b) => a.start - b.start);
  return { spans, ranking: ranked.applied, scannedChars: chunks.at(-1)?.end ?? 0,
    totalChars: raw.length, candidateCount: lexical.length, returnedChars: limit - remaining };
}

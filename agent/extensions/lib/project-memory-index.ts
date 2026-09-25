/** Project memory indexer: chunking, enrichment, dedup, event ingestion.
 *
 * The vector store is an index over project history, never the authority:
 * every chunk carries provenance (source type/path/range, session, commit,
 * time bounds) so retrieval can cite it and callers can verify against the
 * JSONL/Markdown originals. Indexing is event-driven and incremental —
 * content hashes skip unchanged chunks, so only new material is embedded.
 *
 * Deterministic throughout: no model calls. Embeddings arrive through the
 * injected MemoryEmbedder (Needle by default); a null embedding stores the
 * chunk unembedded and retrieval degrades to lexical.
 */

import { createHash, randomUUID } from "node:crypto";
import { redactSecrets, sensitiveMemoryPath } from "./memory-redaction.ts";
export { redactSecrets } from "./memory-redaction.ts";
import { embedMemory, MEMORY_EMBED_BATCH, MEMORY_EMBED_CHARS, type MemoryEmbedder, type MemoryEmbedding } from "./project-memory-embedder.ts";
export { needleMemoryEmbedder, openRouterMemoryEmbedder, configuredMemoryEmbedder, type MemoryEmbedder } from "./project-memory-embedder.ts";
import { type ChunkType, type ProjectVectorStore, isChunkType } from "./project-vector-store.ts";
import { sessionObservability } from './session-observability.ts';

/** Retrieval weight per source type. Curated knowledge outranks raw exhaust. */
export const TYPE_WEIGHTS: Record<ChunkType, number> = {
  decision: 1.0,
  architecture: 0.95,
  concept: 0.9,
  session_summary: 0.9,
  convention: 0.85,
  observation: 0.8,
  bug: 0.8,
  commit: 0.7,
  error: 0.7,
  user_request: 0.6,
  code: 0.6,
  todo: 0.5,
  tool_result: 0.35,
};

export const TYPE_DEFAULT_IMPORTANCE: Record<ChunkType, number> = {
  decision: 0.95,
  architecture: 0.85,
  concept: 0.85,
  session_summary: 0.9,
  convention: 0.8,
  observation: 0.8,
  bug: 0.8,
  commit: 0.6,
  error: 0.65,
  user_request: 0.5,
  code: 0.5,
  todo: 0.5,
  tool_result: 0.3,
};

/** Fake embedder for tests: hashed bag-of-trigrams, L2-normalized. */
export function testEmbedder(dim = 64): MemoryEmbedder {
  return {
    id: "test-hash",
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const vec = new Array<number>(dim).fill(0);
        const lower = text.toLowerCase();
        for (let i = 0; i + 3 <= lower.length; i++) {
          const h = createHash("sha256").update(lower.slice(i, i + 3)).digest();
          vec[h[0] % dim] += 1;
          vec[h[1] % dim] += 0.5;
        }
        const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
        return vec.map((v) => v / norm);
      });
    },
  };
}

/** Same minimal text for first indexing and subsequent backfill. */
export function memoryEmbeddingText(title: string, text: string): string {
  return redactSecrets(`${title.slice(0, 160)}\n${text}`).slice(0, MEMORY_EMBED_CHARS);
}

export function normalizeForHash(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function contentHash(sourceType: string, text: string): string {
  return createHash("sha256").update(`${sourceType}\0${normalizeForHash(text)}`).digest("hex");
}

export function newChunkId(): string {
  return `mem_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export interface TextChunk {
  title: string;
  text: string;
  /** 1-based line span in the source (0 when unknown). */
  start: number;
  end: number;
}

const MAX_CHUNK_CHARS = 2000;

/** Markdown-aware split: headings, list items, paragraphs keep their context. */
export function chunkMarkdown(text: string, maxChars = MAX_CHUNK_CHARS): TextChunk[] {
  const chunks: TextChunk[] = [];
  let heading = "";
  let lines: string[] = [];
  let first = 1;
  const flush = (lastLine: number) => {
    const body = lines.join("\n").trim();
    lines = [];
    if (body.length < 12) return;
    if (body.length <= maxChars) {
      chunks.push({ title: heading, text: body, start: first, end: lastLine });
      return;
    }
    // Long section: hard-split on paragraph boundaries, keep heading.
    let part: string[] = [];
    let partChars = 0;
    for (const paragraph of body.split(/\n{2,}/)) {
      if (partChars + paragraph.length > maxChars && part.length) {
        chunks.push({ title: heading, text: part.join("\n\n"), start: first, end: lastLine });
        part = [];
        partChars = 0;
      }
      part.push(paragraph);
      partChars += paragraph.length + 2;
    }
    if (part.length) chunks.push({ title: heading, text: part.join("\n\n"), start: first, end: lastLine });
  };
  const rawLines = text.split("\n");
  rawLines.forEach((line, index) => {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush(index);
      heading = h[2].replace(/<!--.*?-->/g, "").trim().slice(0, 120);
      first = index + 2;
      return;
    }
    if (!line.trim() || /^\s{0,1}[-*+]\s|^\s{0,1}\d+[.)]\s/.test(line)) {
      if (lines.length) {
        flush(index);
        first = index + 1;
      }
      if (!line.trim()) return;
    }
    if (!lines.length) first = index + 1;
    lines.push(line);
  });
  flush(rawLines.length);
  return chunks;
}

/** Code split: overlapping line windows that never break a line. */
export function chunkCode(text: string, opts: { windowLines?: number; overlapLines?: number; maxChars?: number } = {}): TextChunk[] {
  const window = opts.windowLines ?? 80;
  const overlap = Math.min(opts.overlapLines ?? 12, Math.floor(window / 2));
  const maxChars = opts.maxChars ?? 4000;
  const lines = text.split("\n");
  const chunks: TextChunk[] = [];
  for (let start = 0; start < lines.length;) {
    let end = Math.min(start + window, lines.length);
    let body = lines.slice(start, end).join("\n");
    while (body.length > maxChars && end - start > 8) {
      end -= 8;
      body = lines.slice(start, end).join("\n");
    }
    if (body.trim().length >= 12) chunks.push({ title: "", text: body, start: start + 1, end });
    if (end >= lines.length) break;
    start = end - overlap;
  }
  return chunks;
}

/** Plain-text split: paragraphs packed to maxChars. */
export function chunkText(text: string, maxChars = MAX_CHUNK_CHARS): TextChunk[] {
  const chunks: TextChunk[] = [];
  let part: string[] = [];
  let partChars = 0;
  for (const paragraph of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (partChars + paragraph.length > maxChars && part.length) {
      chunks.push({ title: "", text: part.join("\n\n"), start: 0, end: 0 });
      part = [];
      partChars = 0;
    }
    part.push(paragraph.length > maxChars ? paragraph.slice(0, maxChars) : paragraph);
    partChars += Math.min(paragraph.length, maxChars) + 2;
  }
  if (part.length) chunks.push({ title: "", text: part.join("\n\n"), start: 0, end: 0 });
  return chunks;
}

const CODE_EXTENSIONS = new Set(("ts tsx js jsx mjs cjs mts cts py rb java kt kts go rs c h hpp cc cpp cs swift php scala lua r jl sh bash zsh ps1 sql html css scss vue svelte json yaml yml toml xml proto graphqljava ex exs erl hs ml Dockerfile Makefile cmake gradle").split(" "));

export function chunkerForPath(filePath: string): "markdown" | "code" | "text" {
  const base = filePath.split("/").pop() ?? "";
  const ext = base.includes(".") ? base.split(".").pop()?.toLowerCase() ?? "" : "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (CODE_EXTENSIONS.has(ext) || /^(Dockerfile|Makefile|Gemfile|Rakefile)/.test(base)) return "code";
  return "text";
}

/** Deterministic concept enrichment: tags, links, identifiers, file names. */
export function extractConcepts(text: string, filePath = ""): string[] {
  const concepts = new Set<string>();
  for (const match of text.matchAll(/(?:#([\p{L}\p{N}][\p{L}\p{N}_/-]{1,40})|\[\[([^\][\n]{1,60})\]\])/gu)) {
    concepts.add((match[1] ?? match[2]).trim().slice(0, 60));
  }
  for (const match of text.matchAll(/`([^`\n]{2,80})`/g)) {
    const inner = match[1].trim();
    if (/^[\w.+-]+(\/[\w.+-]+)+$/.test(inner) || /^[\w$.]+\.\w+$/.test(inner)) concepts.add(inner.slice(0, 80));
  }
  for (const match of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) {
    concepts.add(match[1].slice(0, 60));
  }
  if (filePath) {
    const base = filePath.split("/").pop() ?? "";
    if (base) concepts.add(base.slice(0, 80));
  }
  return [...concepts].slice(0, 24);
}

export type IndexEventKind =
  | "user_prompt"
  | "agent_outcome"
  | "tool_result"
  | "error"
  | "file_edit"
  | "git_commit"
  | "session_summary"
  | "observation"
  | "decision";

const EVENT_TYPE: Record<IndexEventKind, ChunkType> = {
  user_prompt: "user_request",
  agent_outcome: "tool_result",
  tool_result: "tool_result",
  error: "error",
  file_edit: "code",
  git_commit: "commit",
  session_summary: "session_summary",
  observation: "observation",
  decision: "decision",
};

export interface IndexEvent {
  kind: IndexEventKind;
  /** Override the default source type for this event kind. */
  sourceType?: ChunkType;
  sessionId?: string;
  title?: string;
  text: string;
  path?: string;
  commit?: string;
  concepts?: string[];
  importance?: number;
  confidence?: number;
  timestamp?: string;
}

export interface IndexResult {
  inserted: number;
  replaced: number;
  skippedDup: number;
  embedded: number;
  ids: string[];
}

const EVENT_MAX_CHARS: Record<IndexEventKind, number> = {
  user_prompt: 2000,
  agent_outcome: 1500,
  tool_result: 1200,
  error: 2000,
  file_edit: 800,
  git_commit: 1500,
  session_summary: 4000,
  observation: 2000,
  decision: 2000,
};

/** Index one event as a single chunk (callers pre-trim; long texts chunk). */
export async function indexEvent(
  store: ProjectVectorStore,
  projectId: string,
  event: IndexEvent,
  opts: { embedder?: MemoryEmbedder; now?: () => string; signal?: AbortSignal } = {},
): Promise<IndexResult> {
  const result: IndexResult = { inserted: 0, replaced: 0, skippedDup: 0, embedded: 0, ids: [] };
  const text = redactSecrets(event.text).trim();
  if (text.length < 12) return result;
  const type = event.sourceType && isChunkType(event.sourceType) ? event.sourceType : EVENT_TYPE[event.kind];
  const cap = EVENT_MAX_CHARS[event.kind];
  const chunks = text.length > cap ? chunkText(text, cap) : [{ title: "", text, start: 0, end: 0 }];
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const embedTexts: string[] = [];
  const pending: Array<{ id: string; chunk: TextChunk; hash: string }> = [];
  const backfillIds: string[] = [];
  for (const chunk of chunks.slice(0, 4)) {
    const hash = contentHash(type, chunk.text);
    const duplicate = store.hasHash(hash);
    if (duplicate) {
      result.skippedDup++;
      const stored = store.getChunk(duplicate);
      if (opts.embedder && (!stored?.has_embedding || stored.embedder !== opts.embedder.id)) backfillIds.push(duplicate);
      continue;
    }
    const id = newChunkId();
    pending.push({ id, chunk, hash });
    embedTexts.push(memoryEmbeddingText(event.title ?? chunk.title, chunk.text));
  }
  let batch: MemoryEmbedding | null = null;
  if (pending.length && opts.embedder && type !== 'tool_result' && event.kind !== 'file_edit' && !sensitiveMemoryPath(event.path ?? '')) batch = await embedMemory(opts.embedder, embedTexts, { signal: opts.signal });
  const vectors = batch?.vectors;
  for (let i = 0; i < pending.length; i++) {
    const { id, chunk, hash } = pending[i];
    const outcome = store.upsertChunk({
      id,
      project_id: projectId,
      session_id: event.sessionId ?? "",
      source_type: type,
      source_path: redactSecrets(event.path ?? ""),
      source_start: chunk.start,
      source_end: chunk.end,
      title: redactSecrets(event.title ?? chunk.title).slice(0, 160),
      text: chunk.text,
      timestamp: event.timestamp ?? now,
      valid_from: now,
      commit_sha: event.commit ?? "",
      concepts: event.concepts ?? extractConcepts(chunk.text, event.path ?? ""),
      importance: event.importance ?? TYPE_DEFAULT_IMPORTANCE[type],
      authority: 0.5,
      content_hash: hash,
      embedder: batch?.space.id ?? "",
      embeddingSpace: batch?.space,
      embedding: vectors?.[i] ?? null,
    }, now);
    if (outcome === "duplicate") {
      result.skippedDup++;
      continue;
    }
    if (outcome === "inserted") result.inserted++;
    else result.replaced++;
    if (vectors?.[i] && store.getChunk(id)?.has_embedding) result.embedded++;
    result.ids.push(id);
  }
  if (backfillIds.length && opts.embedder && type !== 'tool_result' && event.kind !== 'file_edit') {
    const report = await reindexEmbeddings(store, opts.embedder, { ids: backfillIds, fallback: true, signal: opts.signal, now: opts.now });
    result.embedded += report.embedded + report.fallbackEmbedded;
  }
  return result;
}

export interface IndexFileInput {
  path: string;
  content: string;
  sessionId?: string;
  commit?: string;
  sourceType?: ChunkType;
  timestamp?: string;
}

/** Index a repository file: only hash-changed chunks are (re-)embedded. */
export async function indexFile(
  store: ProjectVectorStore,
  projectId: string,
  input: IndexFileInput,
  opts: { embedder?: MemoryEmbedder; now?: () => string; signal?: AbortSignal } = {},
): Promise<IndexResult> {
  const result: IndexResult = { inserted: 0, replaced: 0, skippedDup: 0, embedded: 0, ids: [] };
  if (sensitiveMemoryPath(input.path)) return result;
  const content = redactSecrets(input.content);
  if (content.trim().length < 24 || content.length > 500_000) return result;
  const kind = chunkerForPath(input.path);
  const chunks = (kind === "markdown" ? chunkMarkdown(content) : kind === "code" ? chunkCode(content) : chunkText(content)).slice(0, 64);
  const type = input.sourceType ?? (kind === "markdown" ? "architecture" : "code");
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const pending: Array<{ id: string; chunk: TextChunk; hash: string }> = [];
  const backfillIds: string[] = [];
  for (const chunk of chunks) {
    const hash = contentHash(`${type}:${input.path}`, chunk.text);
    const duplicate = store.hasHash(hash);
    if (duplicate) {
      result.skippedDup++;
      const stored = store.getChunk(duplicate);
      if (opts.embedder && (!stored?.has_embedding || stored.embedder !== opts.embedder.id)) backfillIds.push(duplicate);
      continue;
    }
    pending.push({ id: newChunkId(), chunk, hash });
  }
  const batch = pending.length && opts.embedder ? await embedMemory(opts.embedder, pending.map(p => memoryEmbeddingText(p.chunk.title || `${input.path}:${p.chunk.start || 0}`, p.chunk.text)), { signal: opts.signal }) : null;
  const vectors = batch?.vectors;
  for (let i = 0; i < pending.length; i++) {
    const { id, chunk, hash } = pending[i];
    const outcome = store.upsertChunk({
      id,
      project_id: projectId,
      session_id: input.sessionId ?? "",
      source_type: type,
      source_path: input.path,
      source_start: chunk.start,
      source_end: chunk.end,
      title: (chunk.title || `${input.path}:${chunk.start || 0}`).slice(0, 160),
      text: chunk.text,
      timestamp: input.timestamp ?? now,
      valid_from: now,
      commit_sha: input.commit ?? "",
      concepts: extractConcepts(chunk.text, input.path),
      importance: TYPE_DEFAULT_IMPORTANCE[type],
      authority: 0.5,
      content_hash: hash,
      embedder: batch?.space.id ?? "",
      embeddingSpace: batch?.space,
      embedding: vectors?.[i] ?? null,
    }, now);
    if (outcome === "duplicate") {
      result.skippedDup++;
      continue;
    }
    if (outcome === "inserted") result.inserted++;
    else result.replaced++;
    if (vectors?.[i] && store.getChunk(id)?.has_embedding) result.embedded++;
    result.ids.push(id);
  }
  if (backfillIds.length && opts.embedder) {
    const report = await reindexEmbeddings(store, opts.embedder, { ids: backfillIds, fallback: true, signal: opts.signal, now: opts.now });
    result.embedded += report.embedded + report.fallbackEmbedded;
  }
  return result;
}

/** Backfill embeddings for chunks stored while the embedder was unavailable. */
export async function reindexEmbeddings(
  store: ProjectVectorStore,
  embedder: MemoryEmbedder,
  opts: { limit?: number; ids?: string[]; now?: () => string; signal?: AbortSignal; fallback?: boolean } = {},
): Promise<{ embedded: number; fallbackEmbedded: number; failed: number; remaining: number; cancelled: boolean }> {
  const limit = Math.max(1, Math.min(256, opts.limit ?? 32));
  const ids = (opts.ids ?? store.unembeddedIds(limit, embedder.id)).slice(0, opts.ids ? 64 : limit);
  let embedded = 0, fallbackEmbedded = 0, failed = 0;
  const now = opts.now ?? (() => new Date().toISOString());
  for (let i = 0; i < ids.length && !opts.signal?.aborted; i += MEMORY_EMBED_BATCH) {
    const chunks = store.getChunks(ids.slice(i, i + MEMORY_EMBED_BATCH)).filter(c => c.valid_until === null && c.source_type !== 'tool_result'
      && !(c.source_type === 'code' && c.text.startsWith('File edited via '))
      && !sensitiveMemoryPath(c.source_path) && (!c.has_embedding || c.embedder !== embedder.id));
    if (!chunks.length) continue;
    const batch = await embedMemory(embedder, chunks.map(c => memoryEmbeddingText(c.title, c.text)), { signal: opts.signal });
    if (!batch || opts.signal?.aborted) {
      failed += chunks.length;
      // Automatic ingestion may retain new history in the local space while
      // the selected remote space is unavailable. Explicit migrations remain
      // exact-backend operations. Never overwrite a compatible existing vector
      // or count a local fallback as successful remote backfill.
      const fallback = opts.fallback ? embedder.fallback : undefined;
      if (!fallback || fallback.id === embedder.id || opts.signal?.aborted) break;
      const pending = chunks.filter(c => !c.has_embedding || c.embedder !== fallback.id);
      const local = pending.length ? await embedMemory(fallback, pending.map(c => memoryEmbeddingText(c.title, c.text)), { signal: opts.signal }) : null;
      if (local && !opts.signal?.aborted) for (let j = 0; j < pending.length; j++) {
        if (store.setEmbedding(pending[j].id, local.space, local.vectors[j], now(), pending[j].content_hash)) fallbackEmbedded++;
      }
      continue;
    }
    for (let j = 0; j < chunks.length; j++) {
      // An edit in another session during the request invalidates this vector.
      if (store.setEmbedding(chunks[j].id, batch.space, batch.vectors[j], now(), chunks[j].content_hash)) embedded++;
      else failed++;
    }
  }
  const remaining = store.unembeddedIds(5000, embedder.id).length;
  const report = { embedded, fallbackEmbedded, failed, remaining, cancelled: opts.signal?.aborted === true };
  store.setMeta(`backfill:${embedder.id}`, JSON.stringify({ ...report, at: now() }));
  if (fallbackEmbedded) try {
    sessionObservability()[Symbol.for('yunus-pi.health.v1')]?.('ml.project-memory.embedding', { decision: 'local-fallback', helper: 'needle', count: fallbackEmbedded });
  } catch { /* Optional telemetry cannot interrupt indexing. */ }
  return report;
}

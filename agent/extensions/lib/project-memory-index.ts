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
import { needleEmbed, needleWarmup } from "./needle-runtime.ts";
import { type ChunkType, type ProjectVectorStore, isChunkType } from "./project-vector-store.ts";

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

export interface MemoryEmbedder {
  readonly id: string;
  /** Embed texts in order; null when the backend is unavailable. Never throws. */
  embed(texts: string[]): Promise<number[][] | null>;
}

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

const NEEDLE_TEXT_CHARS = 2000;
const NEEDLE_BATCH = 16;

/**
 * Local Needle3 embeddings. Offline-safe: skips cleanly when unavailable.
 * No health pre-check: the runtime cold-starts on first use and queues the
 * op behind init, so gating on "healthy" would strand every cold caller
 * in lexical-only mode. Disabled/cooling states still skip immediately.
 */
export function needleMemoryEmbedder(): MemoryEmbedder {
  return {
    id: "needle3",
    async embed(texts: string[]): Promise<number[][] | null> {
      try {
        needleWarmup();
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i += NEEDLE_BATCH) {
          const batch = texts.slice(i, i + NEEDLE_BATCH).map((t) => t.slice(0, NEEDLE_TEXT_CHARS));
          const result = await needleEmbed(batch);
          if (!result.ok) return out.length ? out : null;
          out.push(...result.value.vectors);
        }
        return out;
      } catch {
        return null;
      }
    },
  };
}

/** Secret patterns must never be indexed raw (mirrors memory search redaction). */
const REDACT = /(?:sk-(?:ant-|proj-)?|ghp_|gho_|github_pat_|glpat-|xox[abprs]-|AKIA)[A-Za-z0-9_-]{12,}|-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----|\b[A-Za-z0-9+/_-]{48,}={0,2}/g;

export function redactSecrets(text: string): string {
  return text.replace(REDACT, "[redacted]");
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
  opts: { embedder?: MemoryEmbedder; now?: () => string } = {},
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
  for (const chunk of chunks.slice(0, 4)) {
    const hash = contentHash(type, chunk.text);
    if (store.hasHash(hash)) {
      result.skippedDup++;
      continue;
    }
    const id = newChunkId();
    pending.push({ id, chunk, hash });
    embedTexts.push(`${event.title ?? ""}\n${chunk.text}`.slice(0, NEEDLE_TEXT_CHARS));
  }
  let vectors: number[][] | null = null;
  if (pending.length && opts.embedder) {
    try {
      vectors = await opts.embedder.embed(embedTexts);
    } catch {
      vectors = null;
    }
  }
  for (let i = 0; i < pending.length; i++) {
    const { id, chunk, hash } = pending[i];
    const outcome = store.upsertChunk({
      id,
      project_id: projectId,
      session_id: event.sessionId ?? "",
      source_type: type,
      source_path: event.path ?? "",
      source_start: chunk.start,
      source_end: chunk.end,
      title: (event.title ?? chunk.title).slice(0, 160),
      text: chunk.text,
      timestamp: event.timestamp ?? now,
      valid_from: now,
      commit_sha: event.commit ?? "",
      concepts: event.concepts ?? extractConcepts(chunk.text, event.path ?? ""),
      importance: event.importance ?? TYPE_DEFAULT_IMPORTANCE[type],
      authority: 0.5,
      content_hash: hash,
      embedder: vectors?.[i] ? (opts.embedder?.id ?? "") : "",
      embedding: vectors?.[i] ?? null,
    }, now);
    if (outcome === "duplicate") {
      result.skippedDup++;
      continue;
    }
    if (outcome === "inserted") result.inserted++;
    else result.replaced++;
    if (vectors?.[i]) result.embedded++;
    result.ids.push(id);
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
  opts: { embedder?: MemoryEmbedder; now?: () => string } = {},
): Promise<IndexResult> {
  const result: IndexResult = { inserted: 0, replaced: 0, skippedDup: 0, embedded: 0, ids: [] };
  const content = redactSecrets(input.content);
  if (content.trim().length < 24 || content.length > 500_000) return result;
  const kind = chunkerForPath(input.path);
  const chunks = (kind === "markdown" ? chunkMarkdown(content) : kind === "code" ? chunkCode(content) : chunkText(content)).slice(0, 64);
  const type = input.sourceType ?? (kind === "markdown" ? "architecture" : "code");
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const pending: Array<{ id: string; chunk: TextChunk; hash: string }> = [];
  for (const chunk of chunks) {
    const hash = contentHash(`${type}:${input.path}`, chunk.text);
    if (store.hasHash(hash)) {
      result.skippedDup++;
      continue;
    }
    pending.push({ id: newChunkId(), chunk, hash });
  }
  let vectors: number[][] | null = null;
  if (pending.length && opts.embedder) {
    try {
      vectors = await opts.embedder.embed(pending.map((p) => `${input.path}\n${p.chunk.text}`.slice(0, NEEDLE_TEXT_CHARS)));
    } catch {
      vectors = null;
    }
  }
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
      embedder: vectors?.[i] ? (opts.embedder?.id ?? "") : "",
      embedding: vectors?.[i] ?? null,
    }, now);
    if (outcome === "duplicate") {
      result.skippedDup++;
      continue;
    }
    if (outcome === "inserted") result.inserted++;
    else result.replaced++;
    if (vectors?.[i]) result.embedded++;
    result.ids.push(id);
  }
  return result;
}

/** Backfill embeddings for chunks stored while the embedder was unavailable. */
export async function reindexEmbeddings(
  store: ProjectVectorStore,
  embedder: MemoryEmbedder,
  opts: { limit?: number; now?: () => string } = {},
): Promise<{ embedded: number; failed: number }> {
  const ids = store.unembeddedIds(opts.limit ?? 500);
  let embedded = 0;
  let failed = 0;
  const now = (opts.now ?? (() => new Date().toISOString()))();
  for (let i = 0; i < ids.length; i += NEEDLE_BATCH) {
    const batchIds = ids.slice(i, i + NEEDLE_BATCH);
    const chunks = store.getChunks(batchIds);
    let vectors: number[][] | null = null;
    try {
      vectors = await embedder.embed(chunks.map((c) => `${c.title}\n${c.text}`.slice(0, NEEDLE_TEXT_CHARS)));
    } catch {
      vectors = null;
    }
    if (!vectors || vectors.length !== chunks.length) {
      failed += chunks.length;
      continue;
    }
    for (let j = 0; j < chunks.length; j++) {
      if (store.setEmbedding(chunks[j].id, embedder.id, vectors[j], now)) embedded++;
      else failed++;
    }
  }
  return { embedded, failed };
}

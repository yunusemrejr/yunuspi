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
import { embedMemory, MEMORY_EMBED_BATCH, MEMORY_EMBED_CHARS, MEMORY_EMBED_MAX_TEXTS, type MemoryEmbedder, type MemoryEmbedding } from "./project-memory-embedder.ts";
export { needleMemoryEmbedder, openRouterMemoryEmbedder, configuredMemoryEmbedder, type MemoryEmbedder } from "./project-memory-embedder.ts";
import { type ChunkType, type ProjectVectorStore, type StoredAtom, type StoredChunk, type UpsertAtomInput, isChunkType } from "./project-vector-store.ts";
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

/** Target atom size. Atoms are retrieval units: small enough to embed whole,
 * so no atom text is ever semantically invisible the way oversized chunks were. */
export const ATOM_TARGET_CHARS = 800;
/** Blocks above this size are hard-split on line boundaries; oversized
 * blocks below it stay whole (a whole function beats a split one). */
export const ATOM_HARD_SPLIT_CHARS = 1600;
/** Max atom texts embedded per index call; the remainder backfills later. */
export const ATOM_EMBED_BUDGET = 96;

export interface MemoryAtom {
  title: string;
  text: string;
  /** 1-based line span within the parent chunk. */
  start: number;
  end: number;
  /** Char span within the parent chunk text (exclusive end). */
  charStart: number;
  charEnd: number;
}

interface TextBlock {
  text: string;
  startLine: number;
  endLine: number;
  charStart: number;
  charEnd: number;
}

// Definition starts force atom boundaries in code. Strong keywords (types,
// functions) match at any indent; weak keywords only at indent 0 so a
// mid-function `const x = ...` never splits its own function.
const CODE_HARD_DEF = /^\s*(?:export\s+|async\s+|declare\s+|abstract\s+|public\s+|private\s+|protected\s+|static\s+|override\s+)*(?:class|interface|enum|function|def|fn|func|struct|impl|trait|mixin|extension)\b|^\s*@/;
const CODE_SOFT_DEF = /^(?:export\s+|declare\s+|pub\s+|static\s+)*(?:const|let|var|type|pub|static|void|int|long|short|char|string|bool(?:ean)?|float|double|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH)\b/;

function splitBlocks(text: string, hardDef: RegExp | null, softDef: RegExp | null): TextBlock[] {
  const lines = text.split("\n");
  const blocks: TextBlock[] = [];
  let cur: string[] = [];
  let startLine = 1;
  let charStart = 0;
  let offset = 0;
  const flush = (endLine: number, endChar: number) => {
    const body = cur.join("\n");
    cur = [];
    if (body.trim().length) blocks.push({ text: body, startLine, endLine, charStart, charEnd: Math.min(endChar, text.length) });
  };
  lines.forEach((line, index) => {
    const lineStart = offset;
    offset += line.length + 1;
    const blank = !line.trim();
    const boundary = !blank && ((hardDef !== null && hardDef.test(line)) || (softDef !== null && softDef.test(line)));
    if ((blank || boundary) && cur.length) flush(index, lineStart > 0 ? lineStart - 1 : 0);
    if (blank) return;
    if (!cur.length) {
      startLine = index + 1;
      charStart = lineStart;
    }
    cur.push(line);
  });
  if (cur.length) flush(lines.length, text.length);
  return blocks;
}

function hardSplitBlock(block: TextBlock, maxChars: number): TextBlock[] {
  if (block.text.length <= ATOM_HARD_SPLIT_CHARS) return [block];
  const out: TextBlock[] = [];
  let acc: string[] = [];
  let accChars = 0;
  let accStart = block.startLine;
  let accCharStart = block.charStart;
  let offset = block.charStart;
  const flush = (endLine: number) => {
    if (!acc.length) return;
    out.push({ text: acc.join("\n"), startLine: accStart, endLine, charStart: accCharStart, charEnd: Math.min(offset - 1, block.charEnd) });
    acc = [];
    accChars = 0;
  };
  for (const line of block.text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (accChars + line.length + 1 > maxChars && acc.length) {
      const flushedLines = acc.length;
      flush(accStart + flushedLines - 1);
      accStart += flushedLines;
      accCharStart = lineStart;
    }
    if (line.length > maxChars && !acc.length) {
      // One pathological line: slice it rather than emitting a giant atom.
      for (let at = 0; at < line.length; at += maxChars) {
        out.push({ text: line.slice(at, at + maxChars), startLine: accStart, endLine: accStart, charStart: lineStart + at, charEnd: Math.min(lineStart + at + maxChars, block.charEnd) });
      }
      accStart += 1;
      accCharStart = offset;
      continue;
    }
    if (!acc.length) accCharStart = lineStart;
    acc.push(line);
    accChars += line.length + 1;
  }
  if (acc.length) flush(accStart + acc.length - 1);
  return out.length ? out : [block];
}

function packBlocks(blocks: TextBlock[], source: string, maxChars: number): TextBlock[] {
  const out: TextBlock[] = [];
  let acc: TextBlock | null = null;
  const flush = () => {
    if (acc) out.push(acc);
    acc = null;
  };
  for (const block of blocks.flatMap((b) => hardSplitBlock(b, maxChars))) {
    if (!acc) {
      acc = block;
      continue;
    }
    if (acc.text.length + 2 + block.text.length <= maxChars) {
      // Rejoin with the original separator so the char span stays exact.
      const gap = source.slice(acc.charEnd, block.charStart);
      acc = { text: acc.text + gap + block.text, startLine: acc.startLine, endLine: block.endLine, charStart: acc.charStart, charEnd: block.charEnd };
      continue;
    }
    flush();
    acc = block;
  }
  flush();
  return out;
}

/** Split one parent chunk into retrieval atoms. Short parents stay a single
 * atom with byte-identical text, so their vectors match the legacy whole-chunk
 * embedding input exactly. */
export function atomizeParent(text: string, kind: "prose" | "code", maxChars = ATOM_TARGET_CHARS): MemoryAtom[] {
  if (text.length <= maxChars) {
    return [{ title: "", text, start: 1, end: text.split("\n").length, charStart: 0, charEnd: text.length }];
  }
  const blocks = splitBlocks(text, kind === "code" ? CODE_HARD_DEF : null, kind === "code" ? CODE_SOFT_DEF : null);
  const packed = packBlocks(blocks.length ? blocks : [{ text, startLine: 1, endLine: text.split("\n").length, charStart: 0, charEnd: text.length }], text, maxChars);
  return packed.map((block) => ({ title: "", text: block.text, start: block.startLine, end: block.endLine, charStart: block.charStart, charEnd: block.charEnd }));
}

/** Prose atoms: paragraphs, list items and headings packed to target size. */
export function atomizeProse(text: string, maxChars = ATOM_TARGET_CHARS): MemoryAtom[] {
  return atomizeParent(text, "prose", maxChars);
}

/** Code atoms: definition-aware blocks packed to target size. */
export function atomizeCode(text: string, maxChars = ATOM_TARGET_CHARS): MemoryAtom[] {
  return atomizeParent(text, "code", maxChars);
}

export function newAtomId(chunkId: string, ordinal: number): string {
  return `${chunkId}:a${ordinal}`;
}

export function atomContentHash(text: string): string {
  return contentHash("atom", text);
}

export interface AtomizeParentInput {
  title: string;
  text: string;
  /** 1-based file line where the parent starts (0 when unknown). */
  start: number;
}

/** Build the atom rows for one parent chunk. The first atom inherits the
 * parent title so single-atom parents embed exactly the legacy input. */
export function buildAtomInputs(
  chunkId: string,
  parent: AtomizeParentInput,
  opts: { kind: "prose" | "code"; path?: string },
): UpsertAtomInput[] {
  return atomizeParent(parent.text, opts.kind).map((atom, ordinal) => ({
    id: newAtomId(chunkId, ordinal),
    chunk_id: chunkId,
    ordinal,
    title: ordinal === 0 ? parent.title : "",
    text: atom.text,
    source_start: parent.start > 0 ? parent.start + atom.start - 1 : 0,
    source_end: parent.start > 0 ? parent.start + atom.end - 1 : 0,
    char_start: atom.charStart,
    char_end: atom.charEnd,
    concepts: extractConcepts(atom.text, opts.path ?? ""),
    content_hash: atomContentHash(atom.text),
  }));
}

/** True when the chunk still needs embedding work in the space: no covering
 * legacy vector and (no atoms yet, or an atom missing the space). Mirrors
 * the store's unembeddedIds filter so callers and SQL agree. */
export function chunkNeedsSpace(store: ProjectVectorStore, chunk: StoredChunk, spaceId: string): boolean {
  if (chunk.has_embedding && chunk.embedder === spaceId) return false;
  const atoms = store.getAtoms(chunk.id);
  if (!atoms.length) return true;
  return atoms.some((atom) => !atom.has_embedding || atom.embedder !== spaceId);
}

/** True when every atom of the chunk carries a vector in the space. */
export function atomsCoveredInSpace(store: ProjectVectorStore, chunkId: string, spaceId: string): boolean {
  const atoms = store.getAtoms(chunkId);
  return atoms.length > 0 && atoms.every((atom) => atom.has_embedding && atom.embedder === spaceId);
}

export interface AtomEmbedJob {
  chunkId: string;
  atomId: string;
  hash: string;
  text: string;
}

/** Embed atom texts in bounded sub-batches and attach the vectors. Stops at
 * the first failed sub-batch; reports the resolved space plus the chunks
 * that gained at least one vector. */
export async function embedAtomJobs(
  store: ProjectVectorStore,
  embedder: MemoryEmbedder,
  jobs: AtomEmbedJob[],
  opts: { signal?: AbortSignal; now: () => string },
): Promise<{ space: MemoryEmbedding["space"] | null; gained: Set<string> }> {
  const gained = new Set<string>();
  let space: MemoryEmbedding["space"] | null = null;
  for (let i = 0; i < jobs.length && !opts.signal?.aborted; i += MEMORY_EMBED_MAX_TEXTS) {
    const slice = jobs.slice(i, i + MEMORY_EMBED_MAX_TEXTS);
    const batch = await embedMemory(embedder, slice.map((job) => job.text), { signal: opts.signal });
    if (!batch || opts.signal?.aborted) break;
    space = batch.space;
    const at = opts.now();
    slice.forEach((job, k) => {
      if (store.setAtomEmbedding(job.atomId, batch.space, batch.vectors[k], at, job.hash)) gained.add(job.chunkId);
    });
  }
  return { space, gained };
}

/** Atomize a parent that predates atoms (legacy backfill path). */
export function ensureChunkAtoms(store: ProjectVectorStore, chunk: StoredChunk, now: string): StoredAtom[] {
  const existing = store.getAtoms(chunk.id);
  if (existing.length) return existing;
  const detected = chunk.source_path ? chunkerForPath(chunk.source_path) : chunk.source_type === "code" ? "code" : "text";
  store.setAtoms(chunk.id, buildAtomInputs(chunk.id,
    { title: chunk.title, text: chunk.text, start: chunk.source_start },
    { kind: detected === "code" ? "code" : "prose", path: chunk.source_path }), now);
  return store.getAtoms(chunk.id);
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

/** Index one event as parent chunks plus retrieval atoms (callers pre-trim;
 * long texts chunk). Parents upsert first so atoms always have a home;
 * vectors attach to atoms when the embedder is available. */
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
  const pending: Array<{ id: string; chunk: TextChunk; hash: string }> = [];
  const backfillIds: string[] = [];
  for (const chunk of chunks.slice(0, 4)) {
    const hash = contentHash(type, chunk.text);
    const duplicate = store.hasHash(hash);
    if (duplicate) {
      result.skippedDup++;
      const stored = store.getChunk(duplicate);
      if (opts.embedder && stored && chunkNeedsSpace(store, stored, opts.embedder.id)) backfillIds.push(duplicate);
      continue;
    }
    pending.push({ id: newChunkId(), chunk, hash });
  }
  const jobs: AtomEmbedJob[] = [];
  for (const { id, chunk, hash } of pending) {
    const title = redactSecrets(event.title ?? chunk.title).slice(0, 160);
    const outcome = store.upsertChunk({
      id,
      project_id: projectId,
      session_id: event.sessionId ?? "",
      source_type: type,
      source_path: redactSecrets(event.path ?? ""),
      source_start: chunk.start,
      source_end: chunk.end,
      title,
      text: chunk.text,
      timestamp: event.timestamp ?? now,
      valid_from: now,
      commit_sha: event.commit ?? "",
      concepts: event.concepts ?? extractConcepts(chunk.text, event.path ?? ""),
      importance: event.importance ?? TYPE_DEFAULT_IMPORTANCE[type],
      authority: 0.5,
      content_hash: hash,
    }, now);
    if (outcome === "duplicate") {
      result.skippedDup++;
      continue;
    }
    if (outcome === "inserted") result.inserted++;
    else result.replaced++;
    result.ids.push(id);
    const inputs = buildAtomInputs(id, { title, text: chunk.text, start: chunk.start }, { kind: "prose", path: event.path ?? "" });
    store.setAtoms(id, inputs, now);
    for (const atom of inputs) {
      jobs.push({ chunkId: id, atomId: atom.id, hash: atom.content_hash, text: memoryEmbeddingText(atom.title, atom.text) });
    }
  }
  if (jobs.length && opts.embedder && type !== 'tool_result' && event.kind !== 'file_edit' && !sensitiveMemoryPath(event.path ?? '')) {
    result.embedded += (await embedAtomJobs(store, opts.embedder, jobs.slice(0, ATOM_EMBED_BUDGET), { signal: opts.signal, now: () => now })).gained.size;
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

/** Index a repository file: only hash-changed chunks are stored, and only a
 * bounded atom budget is embedded per call; the rest backfills later. */
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
  const atomKind = kind === "code" ? "code" : "prose";
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const pending: Array<{ id: string; chunk: TextChunk; hash: string }> = [];
  const backfillIds: string[] = [];
  for (const chunk of chunks) {
    const hash = contentHash(`${type}:${input.path}`, chunk.text);
    const duplicate = store.hasHash(hash);
    if (duplicate) {
      result.skippedDup++;
      const stored = store.getChunk(duplicate);
      if (opts.embedder && stored && chunkNeedsSpace(store, stored, opts.embedder.id)) backfillIds.push(duplicate);
      continue;
    }
    pending.push({ id: newChunkId(), chunk, hash });
  }
  const jobs: AtomEmbedJob[] = [];
  for (const { id, chunk, hash } of pending) {
    const title = (chunk.title || `${input.path}:${chunk.start || 0}`).slice(0, 160);
    const outcome = store.upsertChunk({
      id,
      project_id: projectId,
      session_id: input.sessionId ?? "",
      source_type: type,
      source_path: input.path,
      source_start: chunk.start,
      source_end: chunk.end,
      title,
      text: chunk.text,
      timestamp: input.timestamp ?? now,
      valid_from: now,
      commit_sha: input.commit ?? "",
      concepts: extractConcepts(chunk.text, input.path),
      importance: TYPE_DEFAULT_IMPORTANCE[type],
      authority: 0.5,
      content_hash: hash,
    }, now);
    if (outcome === "duplicate") {
      result.skippedDup++;
      continue;
    }
    if (outcome === "inserted") result.inserted++;
    else result.replaced++;
    result.ids.push(id);
    const inputs = buildAtomInputs(id, { title, text: chunk.text, start: chunk.start }, { kind: atomKind, path: input.path });
    store.setAtoms(id, inputs, now);
    for (const atom of inputs) {
      jobs.push({ chunkId: id, atomId: atom.id, hash: atom.content_hash, text: memoryEmbeddingText(atom.title, atom.text) });
    }
  }
  if (jobs.length && opts.embedder) {
    result.embedded += (await embedAtomJobs(store, opts.embedder, jobs.slice(0, ATOM_EMBED_BUDGET), { signal: opts.signal, now: () => now })).gained.size;
  }
  if (backfillIds.length && opts.embedder) {
    const report = await reindexEmbeddings(store, opts.embedder, { ids: backfillIds, fallback: true, signal: opts.signal, now: opts.now });
    result.embedded += report.embedded + report.fallbackEmbedded;
  }
  return result;
}

/** Backfill embeddings for chunks stored while the embedder was unavailable.
 * Legacy parents without atoms are atomized first; once atoms cover a chunk
 * in the requested space its legacy chunk vector (if any) retires. */
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
      && !sensitiveMemoryPath(c.source_path) && chunkNeedsSpace(store, c, embedder.id));
    if (!chunks.length) continue;
    const jobs: AtomEmbedJob[] = [];
    for (const chunk of chunks) {
      const atoms = ensureChunkAtoms(store, chunk, now());
      for (const atom of atoms) {
        if (!atom.has_embedding || atom.embedder !== embedder.id) {
          jobs.push({ chunkId: chunk.id, atomId: atom.id, hash: atom.content_hash, text: memoryEmbeddingText(atom.ordinal === 0 ? chunk.title : atom.title, atom.text) });
        }
      }
    }
    if (!jobs.length) continue;
    const primary = await embedAtomJobs(store, embedder, jobs, { signal: opts.signal, now });
    if (!primary.space || opts.signal?.aborted) {
      failed += chunks.length;
      // Automatic ingestion may retain new history in the local space while
      // the selected remote space is unavailable. Explicit migrations remain
      // exact-backend operations. Never overwrite a compatible existing vector
      // or count a local fallback as successful remote backfill.
      const fallback = opts.fallback ? embedder.fallback : undefined;
      if (!fallback || fallback.id === embedder.id || opts.signal?.aborted) break;
      const pending: AtomEmbedJob[] = [];
      for (const chunk of chunks) {
        for (const atom of store.getAtoms(chunk.id)) {
          if (!atom.has_embedding || atom.embedder !== fallback.id) {
            pending.push({ chunkId: chunk.id, atomId: atom.id, hash: atom.content_hash, text: memoryEmbeddingText(atom.ordinal === 0 ? chunk.title : atom.title, atom.text) });
          }
        }
      }
      const local = pending.length ? await embedAtomJobs(store, fallback, pending, { signal: opts.signal, now }) : null;
      if (local?.space && !opts.signal?.aborted) for (const chunk of chunks) {
        if (local.gained.has(chunk.id) && atomsCoveredInSpace(store, chunk.id, local.space.id)) fallbackEmbedded++;
      }
      continue;
    }
    for (const chunk of chunks) {
      if (opts.signal?.aborted) break;
      // An edit in another session during the request invalidates this vector.
      if (atomsCoveredInSpace(store, chunk.id, primary.space.id)) {
        if (primary.gained.has(chunk.id)) embedded++;
        store.clearChunkVector(chunk.id, now());
      } else if (!primary.gained.has(chunk.id)) {
        failed++;
      }
      // Partially covered chunks made progress and resume on the next call.
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

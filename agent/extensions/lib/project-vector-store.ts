/** Project vector store: one SQLite file per project.
 *
 * Layout: `<projectsDir>/<project-id>/memory.sqlite`
 *
 *   - `chunks` table: chunk text + rich metadata (type, provenance, time
 *     bounds, authority, supersession links, content hash, embedding BLOB).
 *   - `chunks_fts` (FTS5, porter stemming): lexical search over title, text,
 *     concepts. Managed manually in the same transaction as `chunks`.
 *   - Vectors: L2-normalized float32 BLOBs, cosine via brute-force dot
 *     product over a bounded scan. No sqlite-vec dependency; project-scale
 *     corpora (thousands of chunks) scan in milliseconds.
 *
 * The store is synchronous (node:sqlite) and never calls a model: callers
 * embed query/chunk text and pass vectors in. JSONL/Markdown remain the
 * authoritative history; this file is a lossy, rebuildable index.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const PROJECT_STORE_SCHEMA_VERSION = 1;

/** Chunk source types. Weights live in project-memory-index.ts. */
export const CHUNK_TYPES = [
  "user_request",
  "decision",
  "code",
  "tool_result",
  "error",
  "observation",
  "architecture",
  "commit",
  "session_summary",
  "concept",
  "convention",
  "bug",
  "todo",
] as const;
export type ChunkType = (typeof CHUNK_TYPES)[number];

export function isChunkType(value: string): value is ChunkType {
  return (CHUNK_TYPES as readonly string[]).includes(value);
}

export interface StoredChunk {
  id: string;
  project_id: string;
  session_id: string;
  source_type: ChunkType;
  source_path: string;
  source_start: number;
  source_end: number;
  title: string;
  text: string;
  timestamp: string;
  valid_from: string;
  valid_until: string | null;
  commit_sha: string;
  concepts: string[];
  importance: number;
  confidence: number;
  authority: number;
  supersedes: string[];
  superseded_by: string;
  content_hash: string;
  embedder: string;
  dim: number;
  has_embedding: boolean;
  created_at: string;
  updated_at: string;
}

export interface UpsertChunkInput {
  id: string;
  project_id: string;
  session_id?: string;
  source_type: ChunkType;
  source_path?: string;
  source_start?: number;
  source_end?: number;
  title?: string;
  text: string;
  timestamp?: string;
  valid_from?: string;
  valid_until?: string | null;
  commit_sha?: string;
  concepts?: string[];
  importance?: number;
  confidence?: number;
  authority?: number;
  supersedes?: string[];
  superseded_by?: string;
  content_hash: string;
  embedder?: string;
  /** L2-normalized by the store; null/empty clears the embedding. */
  embedding?: number[] | Float32Array | null;
}

export interface VectorHit {
  id: string;
  /** Cosine similarity in [-1, 1] (dot product of normalized vectors). */
  score: number;
}

export interface LexicalHit {
  id: string;
  /** FTS5 bm25() rank (lower is better; negative). */
  rank: number;
}

export interface StoreCounts {
  chunks: number;
  embedded: number;
  tombstoned: number;
  types: Record<string, number>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  source_start INTEGER NOT NULL DEFAULT 0,
  source_end INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  commit_sha TEXT NOT NULL DEFAULT '',
  concepts TEXT NOT NULL DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.8,
  authority REAL NOT NULL DEFAULT 0.5,
  supersedes TEXT NOT NULL DEFAULT '[]',
  superseded_by TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  embedder TEXT NOT NULL DEFAULT '',
  dim INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS chunks_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS chunks_type ON chunks(source_type);
CREATE INDEX IF NOT EXISTS chunks_time ON chunks(timestamp);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(title, text, concepts, tokenize='porter unicode61');
`;

function toBuffer(vec: number[] | Float32Array): { buffer: Buffer; dim: number } | null {
  const arr = Array.isArray(vec) ? Float32Array.from(vec) : vec;
  if (arr.length === 0) return null;
  let norm = 0;
  for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm <= 0) return null;
  const normalized = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) normalized[i] = arr[i] / norm;
  return { buffer: Buffer.from(normalized.buffer), dim: normalized.length };
}

function rowToChunk(row: Record<string, unknown>): StoredChunk {
  const parse = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
      } catch {
        /* fall through */
      }
    }
    return [];
  };
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    session_id: String(row.session_id ?? ""),
    source_type: (isChunkType(String(row.source_type)) ? String(row.source_type) : "tool_result") as ChunkType,
    source_path: String(row.source_path ?? ""),
    source_start: Number(row.source_start ?? 0),
    source_end: Number(row.source_end ?? 0),
    title: String(row.title ?? ""),
    text: String(row.text ?? ""),
    timestamp: String(row.timestamp ?? ""),
    valid_from: String(row.valid_from ?? ""),
    valid_until: row.valid_until == null ? null : String(row.valid_until),
    commit_sha: String(row.commit_sha ?? ""),
    concepts: parse(row.concepts),
    importance: Number(row.importance ?? 0.5),
    confidence: Number(row.confidence ?? 0.8),
    authority: Number(row.authority ?? 0.5),
    supersedes: parse(row.supersedes),
    superseded_by: String(row.superseded_by ?? ""),
    content_hash: String(row.content_hash ?? ""),
    embedder: String(row.embedder ?? ""),
    dim: Number(row.dim ?? 0),
    has_embedding: row.embedding != null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export interface OpenStoreOptions {
  projectId: string;
  /** Default true. False opens read-only and never creates the file. */
  create?: boolean;
}

export class ProjectVectorStore {
  readonly dbPath: string;
  readonly projectId: string;
  private db: DatabaseSync;

  private constructor(dbPath: string, projectId: string, db: DatabaseSync) {
    this.dbPath = dbPath;
    this.projectId = projectId;
    this.db = db;
  }

  static open(dbPath: string, opts: OpenStoreOptions): ProjectVectorStore {
    if (opts.create === false && !fs.existsSync(dbPath)) {
      throw new Error(`Project memory store does not exist: ${dbPath}`);
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    // Concurrent sessions share one DB file; writers wait instead of failing.
    db.exec("PRAGMA busy_timeout = 10000;");
    db.exec(SCHEMA);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (!version) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(PROJECT_STORE_SCHEMA_VERSION));
      db.prepare("INSERT INTO meta (key, value) VALUES ('project_id', ?)").run(opts.projectId);
      db.prepare("INSERT INTO meta (key, value) VALUES ('created_at', ?)").run(new Date().toISOString());
    } else if (Number(version.value) !== PROJECT_STORE_SCHEMA_VERSION) {
      db.close();
      throw new Error(`Unsupported project memory schema ${version.value} (want ${PROJECT_STORE_SCHEMA_VERSION}): ${dbPath}`);
    }
    return new ProjectVectorStore(dbPath, opts.projectId, db);
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Insert or replace by id. Returns "inserted" | "replaced" | "duplicate" (same hash, other id). */
  upsertChunk(input: UpsertChunkInput, now?: string): "inserted" | "replaced" | "duplicate" {
    if (!input.id || !input.text || !input.content_hash) throw new Error("upsertChunk requires id, text and content_hash");
    const at = now ?? new Date().toISOString();
    const vec = input.embedding && input.embedding.length ? toBuffer(input.embedding) : null;
    const existing = this.db.prepare("SELECT id, content_hash FROM chunks WHERE id = ?").get(input.id) as { id: string; content_hash: string } | undefined;
    const dup = this.db.prepare("SELECT id FROM chunks WHERE content_hash = ? AND id != ?").get(input.content_hash, input.id) as { id: string } | undefined;
    if (dup) return "duplicate";
    const row = {
      id: input.id,
      project_id: input.project_id,
      session_id: input.session_id ?? "",
      source_type: input.source_type,
      source_path: input.source_path ?? "",
      source_start: input.source_start ?? 0,
      source_end: input.source_end ?? 0,
      title: input.title ?? "",
      text: input.text,
      timestamp: input.timestamp ?? at,
      valid_from: input.valid_from ?? at,
      valid_until: input.valid_until ?? null,
      commit_sha: input.commit_sha ?? "",
      concepts: JSON.stringify(input.concepts ?? []),
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 0.8,
      authority: input.authority ?? 0.5,
      supersedes: JSON.stringify(input.supersedes ?? []),
      superseded_by: input.superseded_by ?? "",
      content_hash: input.content_hash,
      embedder: vec ? (input.embedder ?? "") : "",
      dim: vec ? vec.dim : 0,
      embedding: vec ? vec.buffer : null,
      created_at: at,
      updated_at: at,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (existing) {
        this.db.prepare("DELETE FROM chunks_fts WHERE rowid = (SELECT rowid FROM chunks WHERE id = ?)").run(input.id);
        this.db.prepare(`UPDATE chunks SET project_id=?, session_id=?, source_type=?, source_path=?, source_start=?, source_end=?, title=?, text=?, timestamp=?, valid_from=?, valid_until=?, commit_sha=?, concepts=?, importance=?, confidence=?, authority=?, supersedes=?, superseded_by=?, content_hash=?, embedder=?, dim=?, embedding=?, updated_at=? WHERE id=?`).run(
          row.project_id, row.session_id, row.source_type, row.source_path, row.source_start, row.source_end, row.title, row.text, row.timestamp, row.valid_from, row.valid_until, row.commit_sha, row.concepts, row.importance, row.confidence, row.authority, row.supersedes, row.superseded_by, row.content_hash, row.embedder, row.dim, row.embedding, row.updated_at, input.id,
        );
      } else {
        this.db.prepare(`INSERT INTO chunks (id, project_id, session_id, source_type, source_path, source_start, source_end, title, text, timestamp, valid_from, valid_until, commit_sha, concepts, importance, confidence, authority, supersedes, superseded_by, content_hash, embedder, dim, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          row.id, row.project_id, row.session_id, row.source_type, row.source_path, row.source_start, row.source_end, row.title, row.text, row.timestamp, row.valid_from, row.valid_until, row.commit_sha, row.concepts, row.importance, row.confidence, row.authority, row.supersedes, row.superseded_by, row.content_hash, row.embedder, row.dim, row.embedding, row.created_at, row.updated_at,
        );
      }
      this.db.prepare("INSERT INTO chunks_fts (rowid, title, text, concepts) VALUES ((SELECT rowid FROM chunks WHERE id = ?), ?, ?, ?)").run(
        input.id, row.title, row.text, (input.concepts ?? []).join(" "),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }
    return existing ? "replaced" : "inserted";
  }

  getChunk(id: string): StoredChunk | undefined {
    const row = this.db.prepare("SELECT id, project_id, session_id, source_type, source_path, source_start, source_end, title, text, timestamp, valid_from, valid_until, commit_sha, concepts, importance, confidence, authority, supersedes, superseded_by, content_hash, embedder, dim, embedding, created_at, updated_at FROM chunks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToChunk(row) : undefined;
  }

  getChunks(ids: string[]): StoredChunk[] {
    if (!ids.length) return [];
    const out: StoredChunk[] = [];
    // Bounded batches keep variable counts small.
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const rows = this.db.prepare(`SELECT id, project_id, session_id, source_type, source_path, source_start, source_end, title, text, timestamp, valid_from, valid_until, commit_sha, concepts, importance, confidence, authority, supersedes, superseded_by, content_hash, embedder, dim, embedding, created_at, updated_at FROM chunks WHERE id IN (${batch.map(() => "?").join(",")})`).all(...batch) as Record<string, unknown>[];
      for (const row of rows) out.push(rowToChunk(row));
    }
    const order = new Map(ids.map((id, index) => [id, index]));
    return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  hasHash(contentHash: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM chunks WHERE content_hash = ?").get(contentHash) as { id: string } | undefined;
    return row?.id;
  }

  /** Soft-delete: the tombstone stays for provenance; retrieval demotes it. */
  tombstone(id: string, now?: string): boolean {
    const at = now ?? new Date().toISOString();
    const result = this.db.prepare("UPDATE chunks SET valid_until = ?, updated_at = ? WHERE id = ? AND valid_until IS NULL").run(at, at, id);
    return (result.changes as number) > 0;
  }

  restore(id: string, now?: string): boolean {
    const at = now ?? new Date().toISOString();
    const result = this.db.prepare("UPDATE chunks SET valid_until = NULL, superseded_by = '', updated_at = ? WHERE id = ?").run(at, id);
    return (result.changes as number) > 0;
  }

  markSuperseded(id: string, canonicalId: string, now?: string): boolean {
    const at = now ?? new Date().toISOString();
    const result = this.db.prepare("UPDATE chunks SET valid_until = ?, superseded_by = ?, updated_at = ? WHERE id = ? AND valid_until IS NULL").run(at, canonicalId, at, id);
    return (result.changes as number) > 0;
  }

  setAuthority(id: string, authority: number, now?: string): boolean {
    const at = now ?? new Date().toISOString();
    const result = this.db.prepare("UPDATE chunks SET authority = ?, updated_at = ? WHERE id = ?").run(authority, at, id);
    return (result.changes as number) > 0;
  }

  addSupersedes(id: string, memberIds: string[], now?: string): boolean {
    const chunk = this.getChunk(id);
    if (!chunk) return false;
    const merged = [...new Set([...chunk.supersedes, ...memberIds])];
    const at = now ?? new Date().toISOString();
    const result = this.db.prepare("UPDATE chunks SET supersedes = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(merged), at, id);
    return (result.changes as number) > 0;
  }

  setEmbedding(id: string, embedder: string, embedding: number[] | Float32Array, now?: string): boolean {
    const vec = toBuffer(embedding);
    const at = now ?? new Date().toISOString();
    const result = this.db.prepare("UPDATE chunks SET embedder = ?, dim = ?, embedding = ?, updated_at = ? WHERE id = ?").run(
      vec ? embedder : "", vec ? vec.dim : 0, vec ? vec.buffer : null, at, id,
    );
    return (result.changes as number) > 0;
  }

  listRecent(limit = 20): StoredChunk[] {
    const rows = this.db.prepare("SELECT id, project_id, session_id, source_type, source_path, source_start, source_end, title, text, timestamp, valid_from, valid_until, commit_sha, concepts, importance, confidence, authority, supersedes, superseded_by, content_hash, embedder, dim, embedding, created_at, updated_at FROM chunks ORDER BY timestamp DESC LIMIT ?").all(Math.max(1, Math.min(200, limit))) as Record<string, unknown>[];
    return rows.map(rowToChunk);
  }

  counts(): StoreCounts {
    const total = this.db.prepare("SELECT COUNT(*) AS n, SUM(embedding IS NOT NULL) AS e, SUM(valid_until IS NOT NULL) AS t FROM chunks").get() as { n: number; e: number; t: number };
    const types: Record<string, number> = {};
    for (const row of this.db.prepare("SELECT source_type AS type, COUNT(*) AS n FROM chunks GROUP BY source_type").all() as Array<{ type: string; n: number }>) {
      types[row.type] = row.n;
    }
    return { chunks: total.n ?? 0, embedded: total.e ?? 0, tombstoned: total.t ?? 0, types };
  }

  embeddingDims(): Array<{ dim: number; n: number }> {
    // node:sqlite rows are null-prototype objects; copy to plain records.
    const rows = this.db.prepare("SELECT dim, COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL GROUP BY dim").all() as Array<{ dim: number; n: number }>;
    return rows.map((row) => ({ dim: row.dim, n: row.n }));
  }

  unembeddedIds(limit = 500): string[] {
    return (this.db.prepare("SELECT id FROM chunks WHERE embedding IS NULL AND valid_until IS NULL ORDER BY timestamp DESC LIMIT ?").all(Math.max(1, Math.min(5000, limit))) as Array<{ id: string }>).map((row) => row.id);
  }

  /** Lexical search over title/text/concepts. Terms are OR-ed with prefix match. */
  lexicalSearch(query: string, limit = 40): LexicalHit[] {
    const terms = query
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? [];
    const kept = [...new Set(terms.map((t) => t.replace(/[._-]+$/, "")))].filter((t) => t.length >= 2).slice(0, 12);
    if (!kept.length) return [];
    const match = kept.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
    const rows = this.db.prepare(`SELECT (SELECT id FROM chunks WHERE chunks.rowid = chunks_fts.rowid) AS id, bm25(chunks_fts) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, Math.max(1, Math.min(200, limit))) as Array<{ id: string | null; rank: number }>;
    return rows.filter((row) => row.id).map((row) => ({ id: row.id as string, rank: row.rank }));
  }

  /** Brute-force cosine over normalized vectors. Dim mismatches are skipped. */
  vectorSearch(queryVec: number[] | Float32Array, opts: { limit?: number; scanCap?: number; types?: ChunkType[]; since?: string; minAuthority?: number; includeSuperseded?: boolean } = {}): VectorHit[] {
    const arr = Array.isArray(queryVec) ? Float32Array.from(queryVec) : queryVec;
    const limit = Math.max(1, Math.min(200, opts.limit ?? 40));
    const scanCap = Math.max(100, Math.min(50000, opts.scanCap ?? 20000));
    const dim = arr.length;
    if (!dim) return [];
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 0) return [];
    const conditions = ["embedding IS NOT NULL", "dim = ?"];
    const params: unknown[] = [dim];
    if (!opts.includeSuperseded) conditions.push("valid_until IS NULL");
    if (opts.types?.length) {
      conditions.push(`source_type IN (${opts.types.map(() => "?").join(",")})`);
      params.push(...opts.types);
    }
    if (opts.since) {
      conditions.push("timestamp >= ?");
      params.push(opts.since);
    }
    if (opts.minAuthority !== undefined) {
      conditions.push("authority >= ?");
      params.push(opts.minAuthority);
    }
    const rows = this.db.prepare(`SELECT id, embedding FROM chunks WHERE ${conditions.join(" AND ")} ORDER BY rowid LIMIT ?`).all(...params, scanCap) as Array<{ id: string; embedding: Uint8Array }>;
    // Bounded top-K heap via partial selection (limit is small).
    const scored: VectorHit[] = [];
    for (const row of rows) {
      const bytes = row.embedding;
      if (!bytes || bytes.byteLength !== dim * 4) continue;
      const vec = new Float32Array(bytes.buffer, bytes.byteOffset, dim);
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += (arr[i] / norm) * vec[i];
      if (!Number.isFinite(dot)) continue;
      if (scored.length < limit) {
        scored.push({ id: row.id, score: dot });
        if (scored.length === limit) scored.sort((a, b) => a.score - b.score);
      } else if (dot > scored[0].score) {
        scored[0] = { id: row.id, score: dot };
        scored.sort((a, b) => a.score - b.score);
      }
    }
    return scored.sort((a, b) => b.score - a.score);
  }
}

export function openProjectStore(dbPath: string, opts: OpenStoreOptions): ProjectVectorStore {
  return ProjectVectorStore.open(dbPath, opts);
}

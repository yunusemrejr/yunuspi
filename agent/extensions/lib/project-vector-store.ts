/** Project vector store: one SQLite file per project.
 *
 * Layout: `<projectsDir>/<project-id>/memory.sqlite`
 *
 * Retrieval units and reading units are separate (schema v3):
 *
 *   - `chunks` table: parent spans (reading units) — chunk text + rich
 *     metadata (type, provenance, time bounds, authority, supersession
 *     links, content hash). A chunk is what the agent reads.
 *   - `atoms` table: semantic atoms (retrieval units) — 200–800 char
 *     fragments of one parent chunk, each carrying its own embedding.
 *     An atom is what the query matches; the parent supplies context.
 *   - `chunks_fts` (FTS5, porter stemming): lexical search over title, text,
 *     concepts. Managed manually in the same transaction as `chunks`.
 *   - Vectors: L2-normalized float32 BLOBs, cosine via brute-force dot
 *     product over a bounded scan. No sqlite-vec dependency; project-scale
 *     corpora (thousands of chunks) scan in milliseconds.
 *
 * Legacy chunk-level vectors (schema v2 and earlier) remain searchable
 * through the original chunk scan; new writes embed atoms instead. Touching
 * a legacy chunk via backfill atomizes it and retires its chunk vector, so
 * databases converge to atoms without a bulk rewrite.
 *
 * The store is synchronous (node:sqlite) and never calls a model: callers
 * embed query/atom text and pass vectors in. JSONL/Markdown remain the
 * authoritative history; this file is a lossy, rebuildable index.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { sensitiveMemoryPath } from "./memory-redaction.ts";

export const PROJECT_STORE_SCHEMA_VERSION = 3;

export interface EmbeddingSpace { id: string; backend: string; model: string; version: number; dim: number }
export function legacyEmbeddingSpace(id: string, dim: number): EmbeddingSpace {
  const remote = /^openrouter:(.+):v(\d+)$/.exec(id);
  return { id, backend: remote ? 'openrouter' : id === 'needle3' ? 'needle' : 'local', model: remote?.[1] ?? id, version: remote ? Number(remote[2]) : 1, dim };
}

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
  embedded_at: string;
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
  embeddingSpace?: EmbeddingSpace;
  /** L2-normalized by the store; null/empty clears the embedding. */
  embedding?: number[] | Float32Array | null;
}

/** One semantic atom: a retrieval unit within a parent chunk. Char offsets
 * locate the fragment inside the parent text; source_start/end repeat the
 * parent's file lines when the parent carries them. */
export interface StoredAtom {
  id: string;
  chunk_id: string;
  ordinal: number;
  title: string;
  text: string;
  source_start: number;
  source_end: number;
  char_start: number;
  char_end: number;
  concepts: string[];
  content_hash: string;
  embedder: string;
  dim: number;
  has_embedding: boolean;
  embedded_at: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertAtomInput {
  id: string;
  chunk_id: string;
  ordinal?: number;
  title?: string;
  text: string;
  source_start?: number;
  source_end?: number;
  char_start?: number;
  char_end?: number;
  concepts?: string[];
  content_hash: string;
}

export interface VectorHit {
  id: string;
  /** Cosine similarity in [-1, 1] (dot product of normalized vectors). */
  score: number;
}

export interface AtomHit extends VectorHit {
  atomId: string;
  chunkId: string;
  ordinal: number;
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

const LEXICAL_STOP_WORDS = new Set('the a an and or with from this that is are was were of to in on at for as it its we our they their be been can could should would will has have had what how why which who when where bir bu şu ile ve için mi mı mu mü ne neden nasıl'.split(' '));

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
CREATE TABLE IF NOT EXISTS atoms (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  source_start INTEGER NOT NULL DEFAULT 0,
  source_end INTEGER NOT NULL DEFAULT 0,
  char_start INTEGER NOT NULL DEFAULT 0,
  char_end INTEGER NOT NULL DEFAULT 0,
  concepts TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  embedder TEXT NOT NULL DEFAULT '',
  dim INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  embedded_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS atoms_chunk ON atoms(chunk_id, ordinal);
CREATE INDEX IF NOT EXISTS atoms_space ON atoms(embedder, dim);
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

function parseStringArray(value: unknown): string[] {
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
}

function rowToAtom(row: Record<string, unknown>): StoredAtom {
  return {
    id: String(row.id),
    chunk_id: String(row.chunk_id),
    ordinal: Number(row.ordinal ?? 0),
    title: String(row.title ?? ""),
    text: String(row.text ?? ""),
    source_start: Number(row.source_start ?? 0),
    source_end: Number(row.source_end ?? 0),
    char_start: Number(row.char_start ?? 0),
    char_end: Number(row.char_end ?? 0),
    concepts: parseStringArray(row.concepts),
    content_hash: String(row.content_hash ?? ""),
    embedder: String(row.embedder ?? ""),
    dim: Number(row.dim ?? 0),
    has_embedding: row.embedding != null,
    embedded_at: String(row.embedded_at ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

const ATOM_COLUMNS = "id, chunk_id, ordinal, title, text, source_start, source_end, char_start, char_end, concepts, content_hash, embedder, dim, embedding, embedded_at, created_at, updated_at";

function likeEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function rowToChunk(row: Record<string, unknown>): StoredChunk {
  const parse = parseStringArray;
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
    embedded_at: String(row.embedded_at ?? ""),
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
    } else if (![1, 2, PROJECT_STORE_SCHEMA_VERSION].includes(Number(version.value))) {
      db.close();
      throw new Error(`Unsupported project memory schema ${version.value} (want ${PROJECT_STORE_SCHEMA_VERSION}): ${dbPath}`);
    }
    // Additive, transactional migration: existing chunk IDs, FTS rows and
    // provenance stay intact. v3 adds the atoms table; legacy chunk vectors
    // stay searchable and converge to atoms when backfill touches the chunk.
    // No bulk rewrite: opening an old database never re-embeds anything.
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!(db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>).some(c => c.name === 'embedded_at')) {
        db.exec("ALTER TABLE chunks ADD COLUMN embedded_at TEXT NOT NULL DEFAULT ''");
        db.exec("UPDATE chunks SET embedded_at = updated_at WHERE embedding IS NOT NULL");
      }
      db.exec("CREATE TABLE IF NOT EXISTS embedding_spaces (id TEXT PRIMARY KEY, backend TEXT NOT NULL, model TEXT NOT NULL, version INTEGER NOT NULL, dim INTEGER NOT NULL, created_at TEXT NOT NULL)");
      db.exec(`CREATE TABLE IF NOT EXISTS atoms (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        source_start INTEGER NOT NULL DEFAULT 0,
        source_end INTEGER NOT NULL DEFAULT 0,
        char_start INTEGER NOT NULL DEFAULT 0,
        char_end INTEGER NOT NULL DEFAULT 0,
        concepts TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        embedder TEXT NOT NULL DEFAULT '',
        dim INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        embedded_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS chunks_space ON chunks(embedder, dim)");
      db.exec("CREATE INDEX IF NOT EXISTS atoms_chunk ON atoms(chunk_id, ordinal)");
      db.exec("CREATE INDEX IF NOT EXISTS atoms_space ON atoms(embedder, dim)");
      const spaces = db.prepare(`SELECT embedder AS id, dim, MIN(updated_at) AS created_at FROM (
        SELECT embedder, dim, updated_at FROM chunks WHERE embedding IS NOT NULL AND embedder != ''
        UNION ALL
        SELECT embedder, dim, updated_at FROM atoms WHERE embedding IS NOT NULL AND embedder != ''
      ) GROUP BY embedder, dim`).all() as Array<{ id: string; dim: number; created_at: string }>;
      for (const row of spaces) {
        const space = legacyEmbeddingSpace(row.id, row.dim);
        db.prepare("INSERT OR IGNORE INTO embedding_spaces VALUES (?, ?, ?, ?, ?, ?)").run(space.id, space.backend, space.model, space.version, space.dim, row.created_at);
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(PROJECT_STORE_SCHEMA_VERSION));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
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
    let vec = input.embedding && input.embedding.length ? toBuffer(input.embedding) : null;
    if (vec && ((input.embeddingSpace && input.embeddingSpace.dim !== vec.dim)
      || !this.registerSpace(input.embeddingSpace ?? legacyEmbeddingSpace(input.embedder ?? '', vec.dim), at))) vec = null;
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
      embedder: vec ? (input.embeddingSpace?.id ?? input.embedder ?? "") : "",
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
      this.db.prepare("UPDATE chunks SET embedded_at = ? WHERE id = ?").run(vec ? at : '', input.id);
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
    const row = this.db.prepare("SELECT id, project_id, session_id, source_type, source_path, source_start, source_end, title, text, timestamp, valid_from, valid_until, commit_sha, concepts, importance, confidence, authority, supersedes, superseded_by, content_hash, embedder, dim, embedding, embedded_at, created_at, updated_at FROM chunks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToChunk(row) : undefined;
  }

  getChunks(ids: string[]): StoredChunk[] {
    if (!ids.length) return [];
    const out: StoredChunk[] = [];
    // Bounded batches keep variable counts small.
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const rows = this.db.prepare(`SELECT id, project_id, session_id, source_type, source_path, source_start, source_end, title, text, timestamp, valid_from, valid_until, commit_sha, concepts, importance, confidence, authority, supersedes, superseded_by, content_hash, embedder, dim, embedding, embedded_at, created_at, updated_at FROM chunks WHERE id IN (${batch.map(() => "?").join(",")})`).all(...batch) as Record<string, unknown>[];
      for (const row of rows) out.push(rowToChunk(row));
    }
    const order = new Map(ids.map((id, index) => [id, index]));
    return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  hasHash(contentHash: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM chunks WHERE content_hash = ?").get(contentHash) as { id: string } | undefined;
    return row?.id;
  }

  /** Replace all atoms of one parent chunk. The parent must exist; atoms are
   * never orphaned. Callers atomize once per parent — re-atomization drops
   * the previous atom rows (and their vectors) for that parent only. */
  setAtoms(chunkId: string, atoms: UpsertAtomInput[], now?: string): number {
    const at = now ?? new Date().toISOString();
    const parent = this.db.prepare("SELECT id FROM chunks WHERE id = ?").get(chunkId) as { id: string } | undefined;
    if (!parent) throw new Error(`setAtoms: unknown parent chunk ${chunkId}`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM atoms WHERE chunk_id = ?").run(chunkId);
      const insert = this.db.prepare(`INSERT INTO atoms (id, chunk_id, ordinal, title, text, source_start, source_end, char_start, char_end, concepts, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      atoms.forEach((atom, index) => {
        if (!atom.id || !atom.text || !atom.content_hash) throw new Error("setAtoms requires id, text and content_hash per atom");
        insert.run(atom.id, chunkId, atom.ordinal ?? index, atom.title ?? "", atom.text,
          atom.source_start ?? 0, atom.source_end ?? 0, atom.char_start ?? 0, atom.char_end ?? 0,
          JSON.stringify(atom.concepts ?? []), atom.content_hash, at, at);
      });
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }
    return atoms.length;
  }

  getAtom(id: string): StoredAtom | undefined {
    const row = this.db.prepare(`SELECT ${ATOM_COLUMNS} FROM atoms WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToAtom(row) : undefined;
  }

  getAtoms(chunkId: string): StoredAtom[] {
    const rows = this.db.prepare(`SELECT ${ATOM_COLUMNS} FROM atoms WHERE chunk_id = ? ORDER BY ordinal, rowid`).all(chunkId) as Record<string, unknown>[];
    return rows.map(rowToAtom);
  }

  getAtomsForChunks(ids: string[]): Map<string, StoredAtom[]> {
    const out = new Map<string, StoredAtom[]>();
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const rows = this.db.prepare(`SELECT ${ATOM_COLUMNS} FROM atoms WHERE chunk_id IN (${batch.map(() => "?").join(",")}) ORDER BY chunk_id, ordinal, rowid`).all(...batch) as Record<string, unknown>[];
      for (const row of rows) {
        const atom = rowToAtom(row);
        const list = out.get(atom.chunk_id) ?? [];
        list.push(atom);
        out.set(atom.chunk_id, list);
      }
    }
    return out;
  }

  atomCounts(): { atoms: number; embedded: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS n, SUM(embedding IS NOT NULL) AS e FROM atoms").get() as { n: number; e: number };
    return { atoms: row.n ?? 0, embedded: row.e ?? 0 };
  }

  setAtomEmbedding(id: string, embedder: string | EmbeddingSpace, embedding: number[] | Float32Array, now?: string, expectedHash?: string): boolean {
    const vec = toBuffer(embedding), at = now ?? new Date().toISOString();
    const space = typeof embedder === 'string' ? legacyEmbeddingSpace(embedder, vec?.dim ?? 0) : embedder;
    if (!vec || vec.dim !== space.dim || !this.registerSpace(space, at)) return false;
    // A tombstoned parent or a replaced atom invalidates this vector.
    const result = this.db.prepare(`UPDATE atoms SET embedder = ?, dim = ?, embedding = ?, embedded_at = ?, updated_at = ? WHERE id = ? AND (? IS NULL OR content_hash = ?)
      AND NOT EXISTS (SELECT 1 FROM chunks WHERE chunks.id = atoms.chunk_id AND chunks.valid_until IS NOT NULL)`).run(
      space.id, vec.dim, vec.buffer, at, at, id, expectedHash ?? null, expectedHash ?? null,
    );
    return (result.changes as number) > 0;
  }

  /** Retire a legacy chunk-level vector once atoms carry the chunk's vectors.
   * Text, FTS, provenance and temporal history are untouched. */
  clearChunkVector(id: string, now?: string): boolean {
    const at = now ?? new Date().toISOString();
    const result = this.db.prepare("UPDATE chunks SET embedder = '', dim = 0, embedding = NULL, embedded_at = '', updated_at = ? WHERE id = ? AND embedding IS NOT NULL").run(at, id);
    return (result.changes as number) > 0;
  }

  /** Chunks from one source path ordered by file position (for read expansion). */
  getChunksByPath(sourcePath: string, limit = 64): StoredChunk[] {
    const rows = this.db.prepare("SELECT id, project_id, session_id, source_type, source_path, source_start, source_end, title, text, timestamp, valid_from, valid_until, commit_sha, concepts, importance, confidence, authority, supersedes, superseded_by, content_hash, embedder, dim, embedding, embedded_at, created_at, updated_at FROM chunks WHERE source_path = ? ORDER BY source_start, timestamp LIMIT ?").all(sourcePath, Math.max(1, Math.min(200, limit))) as Record<string, unknown>[];
    return rows.map(rowToChunk);
  }

  /** Chunks that supersede the given id (backlink side of the chain). */
  findSuperseding(id: string): Array<{ id: string; title: string; source_type: string; timestamp: string }> {
    const rows = this.db.prepare("SELECT id, title, source_type, timestamp FROM chunks WHERE superseded_by = ? OR supersedes LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT 32").all(id, `%"${likeEscape(id)}"%`) as Array<{ id: string; title: string; source_type: string; timestamp: string }>;
    return rows.map((row) => ({ id: row.id, title: row.title, source_type: row.source_type, timestamp: row.timestamp }));
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

  embeddingSpaces(): Array<EmbeddingSpace & { created_at: string; count: number }> {
    // Count is stored vectors in the space: legacy chunk vectors plus atoms.
    return (this.db.prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM chunks c WHERE c.embedder=s.id AND c.dim=s.dim AND c.embedding IS NOT NULL)
      + (SELECT COUNT(*) FROM atoms a WHERE a.embedder=s.id AND a.dim=s.dim AND a.embedding IS NOT NULL)
      AS count FROM embedding_spaces s ORDER BY s.id`).all() as any[]).map(row => ({ ...row }));
  }

  private registerSpace(space: EmbeddingSpace, at: string): boolean {
    if (!space.id || !space.backend || !space.model || !Number.isSafeInteger(space.dim) || space.dim < 1 || space.dim > 16384 || !Number.isSafeInteger(space.version) || space.version < 1) return false;
    this.db.prepare("INSERT OR IGNORE INTO embedding_spaces VALUES (?, ?, ?, ?, ?, ?)").run(space.id, space.backend, space.model, space.version, space.dim, at);
    const stored = this.db.prepare("SELECT * FROM embedding_spaces WHERE id = ?").get(space.id) as any;
    const matches = stored.dim === space.dim && stored.backend === space.backend && stored.model === space.model && stored.version === space.version;
    this.setMeta('embedding-error', matches ? '' : 'space-metadata-mismatch');
    return matches;
  }

  setEmbedding(id: string, embedder: string | EmbeddingSpace, embedding: number[] | Float32Array, now?: string, expectedHash?: string): boolean {
    const vec = toBuffer(embedding), at = now ?? new Date().toISOString();
    const space = typeof embedder === 'string' ? legacyEmbeddingSpace(embedder, vec?.dim ?? 0) : embedder;
    if (!vec || vec.dim !== space.dim || !this.registerSpace(space, at)) return false;
    const result = this.db.prepare("UPDATE chunks SET embedder = ?, dim = ?, embedding = ?, embedded_at = ?, updated_at = ? WHERE id = ? AND (? IS NULL OR (content_hash = ? AND valid_until IS NULL))").run(
      space.id, vec.dim, vec.buffer, at, at, id, expectedHash ?? null, expectedHash ?? null,
    );
    return (result.changes as number) > 0;
  }

  /** Consolidation reuses persisted compatible vectors, never re-embeds history.
   * Legacy chunk vectors win; atom-only chunks contribute the mean of their
   * atom vectors in the space (callers cosine-normalize before comparing). */
  storedVectors(ids: string[], embedder: string): Map<string, number[]> {
    const out = new Map<string, number[]>();
    const dim = this.embeddingSpaces().find(space => space.id === embedder)?.dim;
    if (!dim) return out;
    const decode = (blob: Uint8Array): number[] | undefined => {
      if (blob?.byteLength !== dim * 4) return undefined;
      const vec = Array.from(new Float32Array(Uint8Array.from(blob).buffer));
      return vec.every(Number.isFinite) ? vec : undefined;
    };
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const rows = this.db.prepare(`SELECT id, embedding FROM chunks WHERE embedder = ? AND dim = ? AND id IN (${batch.map(() => '?').join(',')})`).all(embedder, dim, ...batch) as Array<{ id: string; embedding: Uint8Array }>;
      for (const row of rows) {
        const vec = row.embedding ? decode(row.embedding) : undefined;
        if (vec) out.set(row.id, vec);
      }
      const missing = batch.filter(id => !out.has(id));
      if (!missing.length) continue;
      const atomRows = this.db.prepare(`SELECT chunk_id, embedding FROM atoms WHERE embedder = ? AND dim = ? AND embedding IS NOT NULL AND chunk_id IN (${missing.map(() => '?').join(',')})`).all(embedder, dim, ...missing) as Array<{ chunk_id: string; embedding: Uint8Array }>;
      const grouped = new Map<string, number[][]>();
      for (const row of atomRows) {
        const vec = decode(row.embedding);
        if (!vec) continue;
        const list = grouped.get(row.chunk_id) ?? [];
        list.push(vec);
        grouped.set(row.chunk_id, list);
      }
      for (const [chunkId, vecs] of grouped) {
        const mean = new Array<number>(dim).fill(0);
        for (const vec of vecs) for (let d = 0; d < dim; d++) mean[d] += vec[d] / vecs.length;
        out.set(chunkId, mean);
      }
    }
    return out;
  }

  listRecent(limit = 20): StoredChunk[] {
    const rows = this.db.prepare("SELECT id, project_id, session_id, source_type, source_path, source_start, source_end, title, text, timestamp, valid_from, valid_until, commit_sha, concepts, importance, confidence, authority, supersedes, superseded_by, content_hash, embedder, dim, embedding, embedded_at, created_at, updated_at FROM chunks ORDER BY timestamp DESC LIMIT ?").all(Math.max(1, Math.min(5000, limit))) as Record<string, unknown>[];
    return rows.map(rowToChunk);
  }

  counts(): StoreCounts {
    // Embedded means semantically retrievable: a legacy chunk vector or at
    // least one embedded atom.
    const total = this.db.prepare(`SELECT COUNT(*) AS n,
      SUM(CASE WHEN embedding IS NOT NULL OR EXISTS (SELECT 1 FROM atoms a WHERE a.chunk_id = chunks.id AND a.embedding IS NOT NULL) THEN 1 ELSE 0 END) AS e,
      SUM(valid_until IS NOT NULL) AS t FROM chunks`).get() as { n: number; e: number; t: number };
    const types: Record<string, number> = {};
    for (const row of this.db.prepare("SELECT source_type AS type, COUNT(*) AS n FROM chunks GROUP BY source_type").all() as Array<{ type: string; n: number }>) {
      types[row.type] = row.n;
    }
    return { chunks: total.n ?? 0, embedded: total.e ?? 0, tombstoned: total.t ?? 0, types };
  }

  embeddingDims(): Array<{ dim: number; n: number }> {
    // node:sqlite rows are null-prototype objects; copy to plain records.
    const rows = this.db.prepare(`SELECT dim, SUM(n) AS n FROM (
      SELECT dim, COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL GROUP BY dim
      UNION ALL
      SELECT dim, COUNT(*) AS n FROM atoms WHERE embedding IS NOT NULL GROUP BY dim
    ) GROUP BY dim`).all() as Array<{ dim: number; n: number }>;
    return rows.map((row) => ({ dim: row.dim, n: row.n }));
  }

  /** Chunk ids that still need embedding work. Without a space: chunks with
   * no legacy vector and no embedded atom. With a space: chunks not covered
   * in that space (no legacy vector and at least one atom missing it, or no
   * atoms yet so backfill atomizes them first). */
  unembeddedIds(limit = 500, embedder?: string): string[] {
    const need = embedder
      ? `(embedding IS NULL OR embedder != ?) AND (NOT EXISTS (SELECT 1 FROM atoms WHERE atoms.chunk_id = chunks.id) OR EXISTS (SELECT 1 FROM atoms WHERE atoms.chunk_id = chunks.id AND (atoms.embedding IS NULL OR atoms.embedder != ?)))`
      : `embedding IS NULL AND (NOT EXISTS (SELECT 1 FROM atoms WHERE atoms.chunk_id = chunks.id) OR EXISTS (SELECT 1 FROM atoms WHERE atoms.chunk_id = chunks.id AND atoms.embedding IS NULL))`;
    const ids: string[] = [], cap = Math.max(1, Math.min(5000, limit));
    const rows = this.db.prepare(`SELECT id, source_path FROM chunks WHERE ${need} AND valid_until IS NULL AND source_type != 'tool_result' AND NOT (source_type = 'code' AND text LIKE 'File edited via %') ORDER BY importance DESC, timestamp DESC, id`)
      .iterate(...(embedder ? [embedder, embedder] : []));
    for (const row of rows) {
      if (sensitiveMemoryPath(String(row.source_path))) continue;
      ids.push(String(row.id));
      if (ids.length >= cap) break;
    }
    return ids;
  }

  /** Lexical search over title/text/concepts. Terms are OR-ed with prefix match. */
  lexicalSearch(query: string, limit = 40): LexicalHit[] {
    const terms = query
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? [];
    let kept = [...new Set(terms.map((t) => t.replace(/[._-]+$/, "")))].filter((t) => t.length >= 2);
    // Long natural-language questions otherwise match nearly every row on
    // "the"/"to" alone. Short literal/identifier queries retain every term.
    if (terms.length > 3) kept = kept.filter(term => !LEXICAL_STOP_WORDS.has(term));
    kept = kept.slice(0, 12);
    if (!kept.length) return [];
    const match = kept.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
    const rows = this.db.prepare(`SELECT (SELECT id FROM chunks WHERE chunks.rowid = chunks_fts.rowid) AS id, bm25(chunks_fts) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, Math.max(1, Math.min(200, limit))) as Array<{ id: string | null; rank: number }>;
    return rows.filter((row) => row.id).map((row) => ({ id: row.id as string, rank: row.rank }));
  }

  /** Brute-force cosine over legacy chunk-level vectors. Dim mismatches are skipped. */
  vectorSearch(queryVec: number[] | Float32Array, opts: { embedder?: string; limit?: number; scanCap?: number; types?: ChunkType[]; since?: string; minAuthority?: number; includeSuperseded?: boolean } = {}): VectorHit[] {
    const arr = Array.isArray(queryVec) ? Float32Array.from(queryVec) : queryVec;
    const limit = Math.max(1, Math.min(200, opts.limit ?? 40));
    const scanCap = Math.max(100, Math.min(50000, opts.scanCap ?? 20000));
    const dim = arr.length;
    if (!dim || !opts.embedder || this.embeddingSpaces().find(space => space.id === opts.embedder)?.dim !== dim) return [];
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 0) return [];
    const conditions = ["embedding IS NOT NULL", "dim = ?", "embedder = ?"];
    const params: unknown[] = [dim, opts.embedder];
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
      const vec = new Float32Array(Uint8Array.from(bytes).buffer);
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

  /** Brute-force cosine over atom vectors, joined to parents for filtering.
   * One hit per atom; callers collapse to the best atom per parent chunk. */
  atomVectorSearch(queryVec: number[] | Float32Array, opts: { embedder?: string; limit?: number; scanCap?: number; types?: ChunkType[]; since?: string; minAuthority?: number; includeSuperseded?: boolean } = {}): AtomHit[] {
    const arr = Array.isArray(queryVec) ? Float32Array.from(queryVec) : queryVec;
    const limit = Math.max(1, Math.min(200, opts.limit ?? 60));
    const scanCap = Math.max(100, Math.min(100000, opts.scanCap ?? 40000));
    const dim = arr.length;
    if (!dim || !opts.embedder || this.embeddingSpaces().find(space => space.id === opts.embedder)?.dim !== dim) return [];
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 0) return [];
    const conditions = ["a.embedding IS NOT NULL", "a.dim = ?", "a.embedder = ?"];
    const params: unknown[] = [dim, opts.embedder];
    if (!opts.includeSuperseded) conditions.push("c.valid_until IS NULL");
    if (opts.types?.length) {
      conditions.push(`c.source_type IN (${opts.types.map(() => "?").join(",")})`);
      params.push(...opts.types);
    }
    if (opts.since) {
      conditions.push("c.timestamp >= ?");
      params.push(opts.since);
    }
    if (opts.minAuthority !== undefined) {
      conditions.push("c.authority >= ?");
      params.push(opts.minAuthority);
    }
    const rows = this.db.prepare(`SELECT a.id AS atom_id, a.chunk_id, a.ordinal, a.embedding FROM atoms a JOIN chunks c ON c.id = a.chunk_id WHERE ${conditions.join(" AND ")} ORDER BY a.rowid LIMIT ?`).all(...params, scanCap) as Array<{ atom_id: string; chunk_id: string; ordinal: number; embedding: Uint8Array }>;
    // Bounded top-K heap via partial selection (limit is small).
    const scored: AtomHit[] = [];
    for (const row of rows) {
      const bytes = row.embedding;
      if (!bytes || bytes.byteLength !== dim * 4) continue;
      const vec = new Float32Array(Uint8Array.from(bytes).buffer);
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += (arr[i] / norm) * vec[i];
      if (!Number.isFinite(dot)) continue;
      const hit = { id: row.atom_id, atomId: row.atom_id, chunkId: row.chunk_id, ordinal: row.ordinal, score: dot };
      if (scored.length < limit) {
        scored.push(hit);
        if (scored.length === limit) scored.sort((a, b) => a.score - b.score);
      } else if (dot > scored[0].score) {
        scored[0] = hit;
        scored.sort((a, b) => a.score - b.score);
      }
    }
    return scored.sort((a, b) => b.score - a.score);
  }
}

export function openProjectStore(dbPath: string, opts: OpenStoreOptions): ProjectVectorStore {
  return ProjectVectorStore.open(dbPath, opts);
}

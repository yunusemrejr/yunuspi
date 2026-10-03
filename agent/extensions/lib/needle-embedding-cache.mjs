/** Persistent Needle embedding cache.
 *
 * An embedding is a pure function of (model files, normalized text), so it can
 * be computed once and reused by every session and worker restart. Embedding
 * runs at roughly 3 ms per character on one thread; a 12-candidate skill rank
 * over a cold in-memory cache measured 4.8-7.1 s against an 8 s ceiling, and a
 * timeout used to discard every vector computed so far. Rows are written
 * through as soon as they are produced, so even a killed worker keeps its
 * progress and the next attempt converges.
 *
 * The store is a small SQLite file (WAL, safe across concurrent sessions).
 * Rows are namespaced by a fingerprint of the pinned model files and the
 * dimension; either changing invalidates the table. Retention is bounded
 * (oldest rows go first). Every operation is best effort: a failure disables
 * the disk layer for the worker's lifetime and never fails an embedding.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const EMBEDDING_CACHE_MAX_ROWS = 8192;
export const EMBEDDING_CACHE_KEEP_ROWS = 6144;
const PRUNE_EVERY_WRITES = 256;
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * @param {{ path: string, fingerprint: string, dim: number, maxRows?: number, keepRows?: number }} options
 * @returns {{ get(key: string): Float32Array | undefined, set(key: string, vector: Float32Array): void, size(): number, close(): void } | null}
 */
export function openEmbeddingDisk(options) {
  const { path, fingerprint, dim } = options;
  const maxRows = options.maxRows ?? EMBEDDING_CACHE_MAX_ROWS;
  const keepRows = Math.min(options.keepRows ?? EMBEDDING_CACHE_KEEP_ROWS, maxRows);
  if (typeof path !== "string" || !path || typeof fingerprint !== "string" || !Number.isSafeInteger(dim) || dim <= 0) return null;
  let db;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;");
    db.exec("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS emb(key TEXT PRIMARY KEY, vec BLOB NOT NULL);");
    const identity = `${fingerprint}:${dim}`;
    const stored = db.prepare("SELECT v FROM meta WHERE k = 'identity'").get();
    if (stored?.v !== identity) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("DELETE FROM emb");
        db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('identity', ?)").run(identity);
        db.exec("COMMIT");
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* connection state is reset below */ } throw error; }
    }
  } catch {
    try { db?.close(); } catch { /* closed or never opened */ }
    return null;
  }
  const read = db.prepare("SELECT vec FROM emb WHERE key = ?");
  const write = db.prepare("INSERT OR REPLACE INTO emb(key, vec) VALUES (?, ?)");
  const count = db.prepare("SELECT COUNT(*) AS n FROM emb");
  const prune = db.prepare("DELETE FROM emb WHERE rowid <= (SELECT rowid FROM emb ORDER BY rowid DESC LIMIT 1 OFFSET ?)");
  let errors = 0, writes = 0, dead = false;
  const fail = () => { if (++errors >= MAX_CONSECUTIVE_ERRORS) { dead = true; try { db.close(); } catch { /* already closed */ } } };
  return {
    get(key) {
      if (dead) return undefined;
      try {
        const row = read.get(key);
        errors = 0;
        const blob = row?.vec;
        if (!blob || blob.byteLength !== dim * 4) return undefined;
        // Copy: the driver's buffer may be unaligned and is reused.
        const bytes = new Uint8Array(blob.byteLength);
        bytes.set(blob);
        const vector = new Float32Array(bytes.buffer, 0, dim);
        for (let i = 0; i < dim; i++) if (!Number.isFinite(vector[i])) return undefined;
        return vector;
      } catch { fail(); return undefined; }
    },
    set(key, vector) {
      if (dead || !(vector instanceof Float32Array) || vector.length !== dim) return;
      try {
        write.run(key, new Uint8Array(vector.buffer, vector.byteOffset, dim * 4));
        errors = 0;
        if (++writes % PRUNE_EVERY_WRITES === 0 && count.get().n > maxRows) prune.run(keepRows);
      } catch { fail(); }
    },
    size() {
      if (dead) return 0;
      try { return count.get().n; } catch { fail(); return 0; }
    },
    close() {
      dead = true;
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

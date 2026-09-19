import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite backed project intelligence storage.
 *
 * This module intentionally has no asynchronous surface. It is used from
 * workers and the viewer server, where a short synchronous transaction is
 * easier to reason about than a process-local cache or a file replacement.
 */

const SQLITE_BUSY_TIMEOUT_MS = 5000;
const SCHEMA_VERSION = 1;
const SHARED_SCOPE = 'shared';
const DEFAULT_STATUS = 'inferred';
const DEFAULT_CONFIDENCE = 0.5;
const MAX_ID = 256;
const MAX_SCOPE = 160;
const MAX_TYPE = 64;
const MAX_LABEL = 1024;
const MAX_KEY = 1024;
const MAX_PREDICATE = 256;
const MAX_LITERAL = 8192;
const MAX_LOCATOR = 4096;
const MAX_FINGERPRINT = 512;
const MAX_SOURCE_NODES = 12000;
const MAX_SOURCE_CLAIMS = 24000;
const MAX_TOTAL_SOURCES = 4096;
const MAX_TOTAL_SOURCE_NODES = 300000;
const MAX_TOTAL_SOURCE_CLAIMS = 600000;
const MAX_META_BYTES = 128 * 1024;
const MAX_HISTORY_ROWS = 5000;
const MAX_CLAIM_HISTORY_ROWS = 12000;
const MAX_HISTORY_DETAILS_BYTES = 24000;
const MAX_ACTIVITY_FILES = 512;
const MAX_ACTIVITY_FILE_BYTES = 1024;
const MAX_ACTIVITY_STATE_BYTES = 32 * 1024;
const MAX_LEASE_TTL_MS = 60 * 60 * 1000;
const MAX_SOURCE_TTL_MS = 366 * 24 * 60 * 60 * 1000;

const STATUS_RANK = Object.freeze({
  verified: 5,
  inferred: 4,
  assumed: 3,
  temporary: 2,
  historical: 1,
});

const SOURCE_KINDS = new Set(['file', 'git', 'session', 'user', 'agent', 'deployment']);
const KNOWN_TYPES = new Set([
  'project', 'repository', 'branch', 'component', 'feature', 'file', 'directory',
  'api', 'database', 'table', 'dependency', 'configuration', 'pipeline',
  'environment', 'infrastructure', 'decision', 'change', 'issue', 'constraint',
  'session', 'external',
]);

function errorWithCode(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw errorWithCode('INVALID_INPUT', `${label} must be an object`);
  }
}

function boundedString(value, label, max, { required = true, trim = true } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw errorWithCode('INVALID_INPUT', `${label} is required`);
  }
  if (typeof value !== 'string') {
    throw errorWithCode('INVALID_INPUT', `${label} must be a string`);
  }
  const result = trim ? value.trim() : value;
  if (result.length === 0 && required) {
    throw errorWithCode('INVALID_INPUT', `${label} must not be empty`);
  }
  if (result.length > max) {
    throw errorWithCode('QUOTA_EXCEEDED', `${label} exceeds ${max} characters`);
  }
  if (result.includes('\u0000')) {
    throw errorWithCode('INVALID_INPUT', `${label} contains a NUL byte`);
  }
  return result;
}

function shortId(value, label, max = MAX_ID) {
  const result = boundedString(value, label, max);
  if (!/^[^\u0000\r\n]+$/.test(result)) {
    throw errorWithCode('INVALID_INPUT', `${label} contains a line break`);
  }
  return result;
}

function validateType(value, label = 'node type') {
  const type = boundedString(value, label, MAX_TYPE).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(type) || type.startsWith('_')) {
    throw errorWithCode('INVALID_INPUT', `${label} must be a short slug`);
  }
  return type;
}

function validateScope(value, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw errorWithCode('INVALID_INPUT', 'source scope is required');
  }
  const scope = boundedString(value, 'scope', MAX_SCOPE);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(scope)) {
    throw errorWithCode('INVALID_INPUT', 'scope must be a filesystem-safe short identifier');
  }
  return scope;
}

function validateStatus(value, label = 'status') {
  const status = value === undefined || value === null ? DEFAULT_STATUS : boundedString(value, label, 32).toLowerCase();
  if (!Object.hasOwn(STATUS_RANK, status)) {
    throw errorWithCode('INVALID_INPUT', `${label} must be verified, inferred, assumed, historical, or temporary`);
  }
  return status;
}

function validateConfidence(value, label = 'confidence') {
  if (value === undefined || value === null) return DEFAULT_CONFIDENCE;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw errorWithCode('INVALID_INPUT', `${label} must be a finite number in [0, 1]`);
  }
  return value;
}

function parseDate(value, label, { optional = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw errorWithCode('INVALID_INPUT', `${label} is required`);
  }
  let date;
  if (value instanceof Date) date = new Date(value.getTime());
  else if (typeof value === 'number') date = new Date(value);
  else if (typeof value === 'string') date = new Date(value);
  else throw errorWithCode('INVALID_INPUT', `${label} must be an ISO date, Date, or milliseconds`);
  if (!Number.isFinite(date.getTime())) throw errorWithCode('INVALID_INPUT', `${label} is invalid`);
  return date.toISOString();
}

function dateMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nowMs(value = undefined) {
  if (value === undefined || value === null) return Date.now();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value instanceof Date ? value.toISOString() : String(value));
  if (!Number.isFinite(parsed)) throw errorWithCode('INVALID_INPUT', 'now is invalid');
  return parsed;
}

function parseExpectedVersion(value) {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
    throw errorWithCode('INVALID_INPUT', 'expectedVersion must be a non-negative integer');
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return Number(item);
    return item;
  });
}

function hashText(text, length = 32) {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

/** Deterministic short SHA-256 node identifier. */
export function nodeId(type, key) {
  const normalizedType = validateType(type, 'type');
  const normalizedKey = boundedString(key, 'key', MAX_KEY, { trim: false });
  return hashText(`${normalizedType}\u0000${normalizedKey}`, 32);
}

function edgeId(subject, predicate, target) {
  return hashText(`edge\u0000${subject}\u0000${predicate}\u0000${target}`, 32);
}

function claimKey(claim) {
  return stableJson([claim.subject, claim.predicate, claim.relation ? 1 : 0, claim.object]);
}

function provenanceFromRow(row) {
  const result = {
    sourceId: row.source_id,
    scope: row.scope,
    kind: row.kind,
    locator: row.locator,
    observedAt: row.observed_at,
    version: Number(row.version),
  };
  if (row.expires_at) result.expiresAt = row.expires_at;
  if (Number(row.stale) !== 0) result.stale = true;
  if (Number(row.active) === 0) result.active = false;
  return result;
}

function sourceIsVisible(row, includeInactive, atMs) {
  if (!includeInactive && Number(row.active) === 0) return false;
  if (!includeInactive && Number(row.stale) !== 0) return false;
  if (!includeInactive && row.expires_at && (dateMs(row.expires_at) ?? 0) <= atMs) return false;
  return true;
}

function sourceSummary(row) {
  return {
    id: row.id,
    scope: row.scope,
    fingerprint: row.fingerprint,
    version: Number(row.version),
    locator: row.locator,
    kind: row.kind,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    active: Number(row.active) !== 0,
    stale: Number(row.stale) !== 0,
    complete: Number(row.complete) !== 0,
  };
}

function projectFromRow(row) {
  if (!row) return null;
  const project = {
    id: row.id,
    checkoutId: row.checkout_id,
    root: row.root,
    name: row.name,
    git: Number(row.git) !== 0,
    stateDir: row.state_dir,
    rootNodeId: row.root_node_id,
  };
  if (row.common_dir) project.commonDir = row.common_dir;
  if (row.branch) project.branch = row.branch;
  if (row.head) project.head = row.head;
  return project;
}

function ensureArray(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw errorWithCode('INVALID_INPUT', `${label} must be an array`);
  return value;
}

function normalizeNode(raw, index) {
  assertObject(raw, `nodes[${index}]`);
  const type = validateType(raw.type, `nodes[${index}].type`);
  const key = raw.key === undefined || raw.key === null ? null : boundedString(raw.key, `nodes[${index}].key`, MAX_KEY, { trim: false });
  const id = raw.id === undefined || raw.id === null
    ? (key === null ? null : nodeId(type, key))
    : shortId(raw.id, `nodes[${index}].id`);
  if (!id) throw errorWithCode('INVALID_INPUT', `nodes[${index}].id is required`);
  const label = boundedString(raw.label ?? key ?? id, `nodes[${index}].label`, MAX_LABEL);
  return {
    id,
    type,
    key,
    label,
    status: validateStatus(raw.status, `nodes[${index}].status`),
    confidence: validateConfidence(raw.confidence, `nodes[${index}].confidence`),
  };
}

function normalizeClaim(raw, index) {
  assertObject(raw, `claims[${index}]`);
  const subject = shortId(raw.subject, `claims[${index}].subject`);
  const predicate = boundedString(raw.predicate, `claims[${index}].predicate`, MAX_PREDICATE);
  const relation = raw.relation === undefined ? false : raw.relation;
  if (typeof relation !== 'boolean') throw errorWithCode('INVALID_INPUT', `claims[${index}].relation must be boolean`);
  const object = shortId(raw.object, `claims[${index}].object`, relation ? MAX_ID : MAX_LITERAL);
  return {
    subject,
    predicate,
    object,
    relation,
    status: validateStatus(raw.status, `claims[${index}].status`),
    confidence: validateConfidence(raw.confidence, `claims[${index}].confidence`),
    exclusive: Boolean(raw.exclusive),
  };
}

function mergeNodes(nodes) {
  const byId = new Map();
  for (const node of nodes) {
    const previous = byId.get(node.id);
    if (!previous) {
      byId.set(node.id, node);
      continue;
    }
    if (previous.type !== node.type) throw errorWithCode('INVALID_NODE', `node ${node.id} has conflicting types`);
    const previousRank = STATUS_RANK[previous.status] ?? 0;
    const nextRank = STATUS_RANK[node.status] ?? 0;
    if (nextRank > previousRank || (nextRank === previousRank && node.label.localeCompare(previous.label) < 0)) {
      previous.label = node.label;
      previous.status = node.status;
    }
    if (node.confidence > previous.confidence) previous.confidence = node.confidence;
    if (previous.key === null && node.key !== null) previous.key = node.key;
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function mergeClaims(claims) {
  const byKey = new Map();
  for (const claim of claims) {
    const key = claimKey(claim);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, { ...claim });
      continue;
    }
    const previousRank = STATUS_RANK[previous.status] ?? 0;
    const nextRank = STATUS_RANK[claim.status] ?? 0;
    if (nextRank > previousRank) previous.status = claim.status;
    previous.confidence = Math.max(previous.confidence, claim.confidence);
    previous.exclusive = previous.exclusive || claim.exclusive;
  }
  return [...byKey.values()].sort((a, b) => claimKey(a).localeCompare(claimKey(b)));
}

function normalizeSource(raw) {
  assertObject(raw, 'source');
  const id = shortId(raw.id, 'source.id');
  const scope = validateScope(raw.scope ?? SHARED_SCOPE);
  const kind = boundedString(raw.kind ?? 'agent', 'source.kind', 64).toLowerCase();
  if (!SOURCE_KINDS.has(kind)) throw errorWithCode('INVALID_INPUT', `source.kind must be one of ${[...SOURCE_KINDS].join(', ')}`);
  const locator = boundedString(raw.locator ?? 'unknown', 'source.locator', MAX_LOCATOR);
  const fingerprint = boundedString(raw.fingerprint ?? hashText(stableJson(raw), 48), 'source.fingerprint', MAX_FINGERPRINT, { trim: false });
  const observedAtProvided = raw.observedAt !== undefined && raw.observedAt !== null && raw.observedAt !== '';
  const observedAt = parseDate(raw.observedAt, 'source.observedAt') ?? new Date().toISOString();
  const expiresAt = parseDate(raw.expiresAt, 'source.expiresAt');
  const rawNodes = ensureArray(raw.nodes, 'source.nodes');
  const rawClaims = ensureArray(raw.claims, 'source.claims');
  if (rawNodes.length > MAX_SOURCE_NODES) throw errorWithCode('QUOTA_EXCEEDED', `source.nodes exceeds ${MAX_SOURCE_NODES}`);
  if (rawClaims.length > MAX_SOURCE_CLAIMS) throw errorWithCode('QUOTA_EXCEEDED', `source.claims exceeds ${MAX_SOURCE_CLAIMS}`);
  const nodes = mergeNodes(rawNodes.map(normalizeNode));
  const claims = mergeClaims(rawClaims.map(normalizeClaim));
  return {
    id,
    scope,
    kind,
    locator,
    fingerprint,
    observedAt,
    observedAtProvided,
    expiresAt,
    complete: raw.complete === undefined ? true : Boolean(raw.complete),
    nodes,
    claims,
  };
}

function sourceMetadataEqual(row, source) {
  if (!row) return false;
  const expectedStale = source.expiresAt && (dateMs(source.expiresAt) ?? 0) <= Date.now() ? 1 : 0;
  return Number(row.active) === 1
    && Number(row.stale) === expectedStale
    && row.scope === source.scope
    && row.kind === source.kind
    && row.locator === source.locator
    && row.fingerprint === source.fingerprint
    && (!source.observedAtProvided || row.observed_at === source.observedAt)
    && row.expires_at === source.expiresAt
    && Number(row.complete) === (source.complete ? 1 : 0);
}

const BUSY_WAIT = new Int32Array(new SharedArrayBuffer(4));

function setupSchema(db) {
  // Connection pragmas must be set before the WAL switch. DDL itself is
  // guarded by one immediate transaction so a killed first opener leaves a
  // clean, retryable schema rather than a half-created set of tables.
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  // journal_mode transitions can return SQLITE_BUSY before busy_timeout is
  // honored (16-way cold opens lose ~1/16 without this). Retry init only,
  // mirroring identity.mjs; the pragmas are idempotent so a partial
  // success is safe to replay. Sync sleep: this module has no async surface.
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      break;
    } catch (error) {
      if (attempt >= 4 || !/(?:busy|locked)/i.test(error?.message ?? '')) throw error;
      Atomics.wait(BUSY_WAIT, 0, 0, 20 * (attempt + 1));
    }
  }
  withImmediate(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS store_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT ${SCHEMA_VERSION}
    );
    INSERT OR IGNORE INTO store_state (id, revision, schema_version) VALUES (1, 0, ${SCHEMA_VERSION});
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY,
      checkout_id TEXT NOT NULL,
      root TEXT NOT NULL,
      common_dir TEXT,
      branch TEXT,
      head TEXT,
      name TEXT NOT NULL,
      git INTEGER NOT NULL,
      state_dir TEXT NOT NULL,
      root_node_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      node_key TEXT,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      persistent INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS nodes_type_idx ON nodes(type);
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      locator TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT,
      version INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      stale INTEGER NOT NULL DEFAULT 0,
      complete INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sources_scope_idx ON sources(scope, active, stale);
    CREATE TABLE IF NOT EXISTS source_nodes (
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      node_key TEXT,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      PRIMARY KEY (source_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS source_nodes_node_idx ON source_nodes(node_id);
    CREATE TABLE IF NOT EXISTS source_claims (
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      claim_key TEXT NOT NULL,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      relation INTEGER NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      exclusive INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source_id, claim_key)
    );
    CREATE INDEX IF NOT EXISTS source_claims_subject_idx ON source_claims(subject);
    CREATE INDEX IF NOT EXISTS source_claims_predicate_idx ON source_claims(predicate);
    CREATE INDEX IF NOT EXISTS source_claims_relation_idx ON source_claims(relation, object);
    CREATE TABLE IF NOT EXISTS history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      source_id TEXT,
      scope TEXT,
      from_version INTEGER,
      to_version INTEGER,
      at INTEGER NOT NULL,
      details TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS history_at_idx ON history(at DESC, seq DESC);
    CREATE TABLE IF NOT EXISTS claim_history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      action TEXT NOT NULL,
      claim_json TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS claim_history_source_idx ON claim_history(source_id, seq DESC);
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      checkout_id TEXT,
      label TEXT NOT NULL,
      files_json TEXT NOT NULL,
      state_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_expiry_idx ON activity(expires_at);
    CREATE TABLE IF NOT EXISTS leases (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS leases_expiry_idx ON leases(expires_at);
  `));
}

function withImmediate(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

function withReadSnapshot(db, fn) {
  db.exec('BEGIN');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

function bumpRevision(db) {
  db.prepare('UPDATE store_state SET revision = revision + 1 WHERE id = 1').run();
  return Number(db.prepare('SELECT revision FROM store_state WHERE id = 1').get().revision);
}

function currentRevision(db) {
  return Number(db.prepare('SELECT revision FROM store_state WHERE id = 1').get()?.revision ?? 0);
}

function trimHistory(db) {
  db.prepare(`DELETE FROM history WHERE seq NOT IN (SELECT seq FROM history ORDER BY seq DESC LIMIT ?)`)
    .run(MAX_HISTORY_ROWS);
  db.prepare(`DELETE FROM claim_history WHERE seq NOT IN (SELECT seq FROM claim_history ORDER BY seq DESC LIMIT ?)`)
    .run(MAX_CLAIM_HISTORY_ROWS);
}

function recordHistory(db, entry) {
  let details = stableJson(entry.details ?? {});
  if (details.length > MAX_HISTORY_DETAILS_BYTES) details = details.slice(0, MAX_HISTORY_DETAILS_BYTES);
  db.prepare(`INSERT INTO history (event, source_id, scope, from_version, to_version, at, details)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(entry.event, entry.sourceId ?? null, entry.scope ?? null, entry.fromVersion ?? null,
      entry.toVersion ?? null, entry.at ?? Date.now(), details);
}

function rowSource(db, id) {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
}

function activeNodeIds(db, sourceId, complete) {
  const ids = new Set();
  const root = db.prepare('SELECT root_node_id FROM project LIMIT 1').get();
  if (root?.root_node_id) ids.add(root.root_node_id);
  const observedAt = new Date(Date.now()).toISOString();
  const rows = db.prepare(`
    SELECT sn.node_id
    FROM source_nodes sn
    JOIN sources s ON s.id = sn.source_id
    WHERE s.active = 1 AND s.stale = 0
      AND (s.expires_at IS NULL OR s.expires_at > ?)
      AND (? = 0 OR sn.source_id <> ?)
  `).all(observedAt, complete ? 1 : 0, sourceId);
  for (const row of rows) ids.add(row.node_id);
  return ids;
}

function activeNodeIdsExcept(db, sourceIds) {
  const ids = new Set();
  const root = db.prepare('SELECT root_node_id FROM project LIMIT 1').get();
  if (root?.root_node_id) ids.add(root.root_node_id);
  const excluded = [...sourceIds];
  const exclusion = excluded.length ? `AND sn.source_id NOT IN (${excluded.map(() => '?').join(',')})` : '';
  const observedAt = new Date(Date.now()).toISOString();
  const rows = db.prepare(`
    SELECT sn.node_id
    FROM source_nodes sn
    JOIN sources s ON s.id = sn.source_id
    WHERE s.active = 1 AND s.stale = 0
      AND (s.expires_at IS NULL OR s.expires_at > ?)
      ${exclusion}
  `).all(observedAt, ...excluded);
  for (const row of rows) ids.add(row.node_id);
  return ids;
}

function validateEndpoints(db, source, existingSource, availableNodeIds = null) {
  const available = availableNodeIds ?? activeNodeIds(db, source.id, source.complete);
  const expired = source.expiresAt && (dateMs(source.expiresAt) ?? 0) <= Date.now();
  const sameExpiredSource = expired && existingSource && source.fingerprint === existingSource.fingerprint;
  if (!availableNodeIds && existingSource && (!source.complete || sameExpiredSource) && !expired) {
    for (const row of db.prepare('SELECT node_id FROM source_nodes WHERE source_id = ?').all(source.id)) available.add(row.node_id);
  }
  if (!availableNodeIds && sameExpiredSource) {
    for (const row of db.prepare('SELECT node_id FROM source_nodes WHERE source_id = ?').all(source.id)) available.add(row.node_id);
  }
  if (!expired) for (const node of source.nodes) available.add(node.id);
  for (const claim of source.claims) {
    if (!available.has(claim.subject)) {
      throw errorWithCode('INVALID_ENDPOINT', `claim subject ${claim.subject} is not a known node`, { claim });
    }
    if (claim.relation && !available.has(claim.object)) {
      throw errorWithCode('INVALID_ENDPOINT', `claim target ${claim.object} is not a known node`, { claim });
    }
  }
}

function upsertGlobalNode(db, node, persistent = false, timestamp = Date.now()) {
  const existing = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.id);
  if (existing && existing.type !== node.type) {
    throw errorWithCode('INVALID_NODE', `node ${node.id} has conflicting types`);
  }
  if (!existing) {
    db.prepare(`INSERT INTO nodes (id, type, label, node_key, status, confidence, persistent, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(node.id, node.type, node.label, node.key, node.status, node.confidence, persistent ? 1 : 0, timestamp, timestamp);
    return;
  }
  const oldRank = STATUS_RANK[existing.status] ?? 0;
  const newRank = STATUS_RANK[node.status] ?? 0;
  const label = newRank > oldRank || (newRank === oldRank && node.label.localeCompare(existing.label) < 0)
    ? node.label : existing.label;
  const status = newRank > oldRank ? node.status : existing.status;
  const key = existing.node_key ?? node.key;
  const confidence = Math.max(Number(existing.confidence), node.confidence);
  db.prepare(`UPDATE nodes
              SET label = ?, node_key = ?, status = ?, confidence = ?, persistent = ?, updated_at = ?
              WHERE id = ?`)
    .run(label, key, status, confidence, Number(existing.persistent) || persistent ? 1 : 0, timestamp, node.id);
}

function deleteOrphanNodes(db) {
  db.exec(`DELETE FROM nodes
           WHERE persistent = 0
             AND NOT EXISTS (SELECT 1 FROM source_nodes sn WHERE sn.node_id = nodes.id)`);
}

function rowsForSources(db, sourceRows, table) {
  if (sourceRows.length === 0) return [];
  const placeholders = sourceRows.map(() => '?').join(',');
  const ids = sourceRows.map(row => row.id);
  if (table === 'source_nodes') {
    return db.prepare(`SELECT sn.*, s.scope, s.kind, s.locator, s.observed_at, s.expires_at,
                              s.version, s.active, s.stale
                       FROM source_nodes sn JOIN sources s ON s.id = sn.source_id
                       WHERE sn.source_id IN (${placeholders})
                       ORDER BY sn.node_id, sn.source_id`).all(...ids);
  }
  return db.prepare(`SELECT sc.*, s.scope, s.kind, s.locator, s.observed_at, s.expires_at,
                            s.version, s.active, s.stale
                     FROM source_claims sc JOIN sources s ON s.id = sc.source_id
                     WHERE sc.source_id IN (${placeholders})
                     ORDER BY sc.subject, sc.predicate, sc.object, sc.source_id`).all(...ids);
}

function deriveConflicts(claimRows) {
  const groups = new Map();
  for (const row of claimRows) {
    if (Number(row.relation) !== 0 || Number(row.exclusive) === 0) continue;
    if (Number(row.active) === 0 || Number(row.stale) !== 0) continue;
    if (row.expires_at && (dateMs(row.expires_at) ?? 0) <= Date.now()) continue;
    const key = stableJson([row.scope, row.subject, row.predicate]);
    let group = groups.get(key);
    if (!group) {
      group = { scope: row.scope, subject: row.subject, predicate: row.predicate, objects: new Map() };
      groups.set(key, group);
    }
    let object = group.objects.get(row.object);
    if (!object) {
      object = { object: row.object, sources: [] };
      group.objects.set(row.object, object);
    }
    object.sources.push(row.source_id);
  }
  const conflicts = [];
  for (const group of groups.values()) {
    if (group.objects.size < 2) continue;
    const objects = [...group.objects.values()].sort((a, b) => a.object.localeCompare(b.object));
    conflicts.push({
      scope: group.scope,
      subject: group.subject,
      predicate: group.predicate,
      objects: objects.map(entry => entry.object),
      sources: objects.flatMap(entry => entry.sources).sort(),
    });
  }
  conflicts.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  return conflicts;
}

function projectedCounts(db, source, existingSource, counts = null) {
  const oldNodes = counts?.oldNodes?.get(source.id) ?? (existingSource
    ? Number(db.prepare('SELECT COUNT(*) AS count FROM source_nodes WHERE source_id = ?').get(source.id).count)
    : 0);
  const oldClaims = counts?.oldClaims?.get(source.id) ?? (existingSource
    ? Number(db.prepare('SELECT COUNT(*) AS count FROM source_claims WHERE source_id = ?').get(source.id).count)
    : 0);
  const nodeRows = counts?.sourceNodes ?? Number(db.prepare('SELECT COUNT(*) AS count FROM source_nodes').get().count);
  const claimRows = counts?.claims ?? Number(db.prepare('SELECT COUNT(*) AS count FROM source_claims').get().count);
  const keptNodes = source.complete ? 0 : oldNodes;
  const keptClaims = source.complete ? 0 : oldClaims;
  return {
    sourceNodes: nodeRows - oldNodes + keptNodes + source.nodes.length,
    claims: claimRows - oldClaims + keptClaims + source.claims.length,
  };
}

function commitSourceReplacement(db, source, expectedVersion, options = {}) {
  const availableNodeIds = options.availableNodeIds ?? null;
  const counts = options.counts ?? null;
  const deferConflict = options.deferConflict === true;
  const deferHistoryTrim = options.deferHistoryTrim === true;
  const deferRevision = options.deferRevision === true;
  const timestamp = Date.now();
  const existing = rowSource(db, source.id);
  if (!existing) {
    if (expectedVersion !== 0) {
      throw errorWithCode('STALE_SOURCE', `source ${source.id} does not exist at version ${expectedVersion}`, { currentVersion: 0 });
    }
    if (!counts) {
      const sourceCount = Number(db.prepare('SELECT COUNT(*) AS count FROM sources WHERE active = 1').get().count);
      if (sourceCount >= MAX_TOTAL_SOURCES) throw errorWithCode('QUOTA_EXCEEDED', 'source quota exceeded');
    }
  } else if (Number(existing.version) !== expectedVersion) {
    throw errorWithCode('STALE_SOURCE', `source ${source.id} expected version ${expectedVersion}, current version ${existing.version}`, { currentVersion: Number(existing.version) });
  }
  if (existing && Number(existing.active) === 0 && !counts) {
    const sourceCount = Number(db.prepare('SELECT COUNT(*) AS count FROM sources WHERE active = 1').get().count);
    if (sourceCount >= MAX_TOTAL_SOURCES) throw errorWithCode('QUOTA_EXCEEDED', 'source quota exceeded');
  }
  if (existing && sourceMetadataEqual(existing, source)) {
    return { revision: currentRevision(db), changed: false };
  }
  validateEndpoints(db, source, existing, availableNodeIds);
  const projected = projectedCounts(db, source, existing, counts);
  if (projected.sourceNodes > MAX_TOTAL_SOURCE_NODES) throw errorWithCode('QUOTA_EXCEEDED', 'source node quota exceeded');
  if (projected.claims > MAX_TOTAL_SOURCE_CLAIMS) throw errorWithCode('QUOTA_EXCEEDED', 'claim quota exceeded');

  const version = existing ? Number(existing.version) + 1 : 1;
  const stale = source.expiresAt && (dateMs(source.expiresAt) ?? 0) <= timestamp ? 1 : 0;
  const oldClaims = existing ? db.prepare('SELECT * FROM source_claims WHERE source_id = ? ORDER BY claim_key').all(source.id) : [];
  const oldNodes = existing ? db.prepare('SELECT * FROM source_nodes WHERE source_id = ? ORDER BY node_id').all(source.id) : [];
  if (!existing) {
    db.prepare(`INSERT INTO sources
      (id, scope, kind, locator, fingerprint, observed_at, expires_at, version, active, stale, complete, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .run(source.id, source.scope, source.kind, source.locator, source.fingerprint, source.observedAt,
        source.expiresAt, version, stale, source.complete ? 1 : 0, timestamp, timestamp);
  } else {
    db.prepare(`UPDATE sources SET scope = ?, kind = ?, locator = ?, fingerprint = ?, observed_at = ?,
                expires_at = ?, version = ?, active = 1, stale = ?, complete = ?, updated_at = ? WHERE id = ?`)
      .run(source.scope, source.kind, source.locator, source.fingerprint, source.observedAt, source.expiresAt,
        version, stale, source.complete ? 1 : 0, timestamp, source.id);
  }
  if (source.complete) {
    for (const claim of oldClaims) {
      let claimJson = stableJson({
        subject: claim.subject,
        predicate: claim.predicate,
        object: claim.object,
        relation: Number(claim.relation) !== 0,
        status: claim.status,
        confidence: Number(claim.confidence),
        exclusive: Number(claim.exclusive) !== 0,
      });
      if (claimJson.length > MAX_HISTORY_DETAILS_BYTES) claimJson = claimJson.slice(0, MAX_HISTORY_DETAILS_BYTES);
      db.prepare(`INSERT INTO claim_history (source_id, version, action, claim_json, at) VALUES (?, ?, 'withdrawn', ?, ?)`)
        .run(source.id, version, claimJson, timestamp);
    }
    db.prepare('DELETE FROM source_claims WHERE source_id = ?').run(source.id);
    db.prepare('DELETE FROM source_nodes WHERE source_id = ?').run(source.id);
  }
  for (const node of source.nodes) {
    upsertGlobalNode(db, node, false, timestamp);
    db.prepare(`INSERT INTO source_nodes (source_id, node_id, type, label, node_key, status, confidence)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_id, node_id) DO UPDATE SET type = excluded.type,
                  label = excluded.label, node_key = excluded.node_key, status = excluded.status,
                  confidence = excluded.confidence`)
      .run(source.id, node.id, node.type, node.label, node.key, node.status, node.confidence);
  }
  for (const claim of source.claims) {
    db.prepare(`INSERT INTO source_claims
                (source_id, claim_key, subject, predicate, object, relation, status, confidence, exclusive)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_id, claim_key) DO UPDATE SET subject = excluded.subject,
                  predicate = excluded.predicate, object = excluded.object, relation = excluded.relation,
                  status = excluded.status, confidence = excluded.confidence, exclusive = excluded.exclusive`)
      .run(source.id, claimKey(claim), claim.subject, claim.predicate, claim.object, claim.relation ? 1 : 0,
        claim.status, claim.confidence, claim.exclusive ? 1 : 0);
  }
  const withdrawnClaims = source.complete ? oldClaims.length : 0;
  const addedClaims = source.claims.length;
  const conflicts = deferConflict ? [] : deriveConflicts(db.prepare(`SELECT sc.*, s.scope, s.kind, s.locator, s.observed_at,
      s.expires_at, s.version, s.active, s.stale FROM source_claims sc JOIN sources s ON s.id = sc.source_id`).all());
  recordHistory(db, {
    event: existing?.active === 0 ? 'source-restored' : existing ? 'source-replaced' : 'source-added',
    sourceId: source.id,
    scope: source.scope,
    fromVersion: existing ? Number(existing.version) : 0,
    toVersion: version,
    at: timestamp,
    details: { withdrawnClaims, addedClaims, nodes: source.nodes.length, complete: source.complete, conflicts: conflicts.length },
  });
  if (!deferHistoryTrim) trimHistory(db);
  const revision = deferRevision ? currentRevision(db) : bumpRevision(db);
  if (counts) {
    counts.sourceNodes = projected.sourceNodes;
    counts.claims = projected.claims;
  }
  return {
    revision,
    changed: true,
    ...(conflicts.length ? { conflict: conflicts.find(item => item.scope === source.scope) ?? conflicts[0] } : {}),
  };
}

function commitSourceBatch(db, entries) {
  const existingById = new Map();
  for (const entry of entries) {
    const existing = rowSource(db, entry.source.id);
    existingById.set(entry.source.id, existing);
    if (!existing) {
      if (entry.expectedVersion !== 0) {
        throw errorWithCode('STALE_SOURCE', `source ${entry.source.id} does not exist at version ${entry.expectedVersion}`, { currentVersion: 0 });
      }
    } else if (Number(existing.version) !== entry.expectedVersion) {
      throw errorWithCode('STALE_SOURCE', `source ${entry.source.id} expected version ${entry.expectedVersion}, current version ${existing.version}`, { currentVersion: Number(existing.version) });
    }
  }
  if (entries.every(entry => sourceMetadataEqual(existingById.get(entry.source.id), entry.source))) {
    const revision = currentRevision(db);
    return {
      revision,
      changed: false,
      count: entries.length,
      changedCount: 0,
      results: entries.map(entry => ({ sourceId: entry.source.id, revision, changed: false })),
    };
  }

  let sourceCount = Number(db.prepare('SELECT COUNT(*) AS count FROM sources WHERE active = 1').get().count);
  for (const entry of entries) {
    const existing = existingById.get(entry.source.id);
    if (!existing || Number(existing.active) === 0) sourceCount++;
  }
  if (sourceCount > MAX_TOTAL_SOURCES) throw errorWithCode('QUOTA_EXCEEDED', 'source quota exceeded');

  const sourceIds = entries.map(entry => entry.source.id);
  const availableNodeIds = activeNodeIdsExcept(db, sourceIds);
  for (const entry of entries) {
    const existing = existingById.get(entry.source.id);
    const expired = entry.source.expiresAt && (dateMs(entry.source.expiresAt) ?? 0) <= Date.now();
    const sameExpiredSource = expired && existing && entry.source.fingerprint === existing.fingerprint;
    // The replacement set is excluded above so a complete update cannot use
    // nodes that it is about to withdraw. An unchanged, still-visible source
    // is a different case: it survives this transaction and its nodes remain
    // valid endpoints for another source in the same batch.
    if (existing && sourceMetadataEqual(existing, entry.source) && !expired) {
      for (const row of db.prepare('SELECT node_id FROM source_nodes WHERE source_id = ?').all(entry.source.id)) {
        availableNodeIds.add(row.node_id);
      }
    }
    if (existing && !entry.source.complete && (!expired || sameExpiredSource)) {
      for (const row of db.prepare('SELECT node_id FROM source_nodes WHERE source_id = ?').all(entry.source.id)) {
        availableNodeIds.add(row.node_id);
      }
    }
    if (!expired) for (const node of entry.source.nodes) availableNodeIds.add(node.id);
  }
  for (const entry of entries) {
    validateEndpoints(db, entry.source, existingById.get(entry.source.id), availableNodeIds);
  }

  const placeholders = sourceIds.map(() => '?').join(',');
  const oldNodes = new Map();
  const oldClaims = new Map();
  if (sourceIds.length) {
    for (const row of db.prepare(`SELECT source_id, COUNT(*) AS count FROM source_nodes WHERE source_id IN (${placeholders}) GROUP BY source_id`).all(...sourceIds)) {
      oldNodes.set(row.source_id, Number(row.count));
    }
    for (const row of db.prepare(`SELECT source_id, COUNT(*) AS count FROM source_claims WHERE source_id IN (${placeholders}) GROUP BY source_id`).all(...sourceIds)) {
      oldClaims.set(row.source_id, Number(row.count));
    }
  }
  const counts = {
    sourceNodes: Number(db.prepare('SELECT COUNT(*) AS count FROM source_nodes').get().count),
    claims: Number(db.prepare('SELECT COUNT(*) AS count FROM source_claims').get().count),
    oldNodes,
    oldClaims,
  };
  const results = [];
  let changedCount = 0;
  for (const entry of entries) {
    const result = commitSourceReplacement(db, entry.source, entry.expectedVersion, {
      availableNodeIds,
      counts,
      deferConflict: true,
      deferHistoryTrim: true,
      deferRevision: true,
    });
    results.push({ sourceId: entry.source.id, changed: result.changed });
    if (result.changed) changedCount++;
  }

  let conflicts = [];
  if (changedCount) {
    conflicts = deriveConflicts(db.prepare(`SELECT sc.*, s.scope, s.kind, s.locator, s.observed_at,
        s.expires_at, s.version, s.active, s.stale FROM source_claims sc JOIN sources s ON s.id = sc.source_id`).all());
    trimHistory(db);
  }
  const revision = changedCount ? bumpRevision(db) : currentRevision(db);
  for (const result of results) {
    const source = entries.find(entry => entry.source.id === result.sourceId).source;
    const conflict = conflicts.find(item => item.scope === source.scope);
    result.revision = revision;
    if (conflict) result.conflict = conflict;
  }
  return {
    revision,
    changed: changedCount !== 0,
    count: entries.length,
    changedCount,
    results,
  };
}

function storeSnapshot(db, options = {}) {
  const scope = validateScope(options.scope, { optional: true });
  const includeInactive = Boolean(options.includeInactive);
  const allSourceRows = scope
    ? db.prepare(`SELECT * FROM sources WHERE scope = ? OR scope = 'shared' ORDER BY id`).all(scope)
    : db.prepare('SELECT * FROM sources ORDER BY id').all();
  const visibleAt = Date.now();
  const visibleRows = allSourceRows.filter(row => sourceIsVisible(row, includeInactive, visibleAt));
  const selectedSources = includeInactive ? allSourceRows : visibleRows;
  const selectedSourceIds = new Set(selectedSources.map(row => row.id));
  const nodeRows = rowsForSources(db, selectedSources, 'source_nodes');
  const claimRows = rowsForSources(db, selectedSources, 'source_claims');
  const nodesById = new Map();
  for (const row of nodeRows) {
    if (!selectedSourceIds.has(row.source_id)) continue;
    const sourceTimestamp = dateMs(row.observed_at) ?? 0;
    const existing = nodesById.get(row.node_id);
    const candidate = {
      id: row.node_id,
      type: row.type,
      label: row.label,
      key: row.node_key,
      status: row.status,
      confidence: Number(row.confidence),
      _sourceTimestamp: sourceTimestamp,
      _sourceId: row.source_id,
    };
    if (!existing || sourceTimestamp > existing._sourceTimestamp ||
        (sourceTimestamp === existing._sourceTimestamp && row.source_id.localeCompare(existing._sourceId) < 0)) {
      nodesById.set(row.node_id, candidate);
    } else {
      existing.confidence = Math.max(existing.confidence, candidate.confidence);
      if ((STATUS_RANK[candidate.status] ?? 0) > (STATUS_RANK[existing.status] ?? 0)) existing.status = candidate.status;
    }
  }
  const projectRow = db.prepare('SELECT * FROM project LIMIT 1').get();
  if (projectRow?.root_node_id) {
    const rootNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(projectRow.root_node_id);
    if (rootNode) {
      nodesById.set(rootNode.id, {
        id: rootNode.id,
        type: rootNode.type,
        label: rootNode.label,
        key: rootNode.node_key,
        status: rootNode.status,
        confidence: Number(rootNode.confidence),
        _sourceTimestamp: Number.MAX_SAFE_INTEGER,
        _sourceId: '',
      });
    }
  }
  const nodes = [...nodesById.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ _sourceTimestamp: _a, _sourceId: _b, ...node }) => node);

  const conflictRows = deriveConflicts(claimRows);
  const conflictKeys = new Set(conflictRows.map(item => stableJson([item.scope, item.subject, item.predicate, item.objects])));
  const conflictByGroup = new Map(conflictRows.map(item => [stableJson([item.scope, item.subject, item.predicate]), item]));
  const edgeMap = new Map();
  const factMap = new Map();
  const allNodeIds = new Set(nodes.map(node => node.id));
  for (const row of claimRows) {
    if (!allNodeIds.has(row.subject)) continue;
    const provenance = provenanceFromRow(row);
    const status = row.status;
    const confidence = Number(row.confidence);
    if (Number(row.relation) !== 0) {
      if (!allNodeIds.has(row.object)) continue;
      const id = edgeId(row.subject, row.predicate, row.object);
      const previous = edgeMap.get(id);
      if (!previous) {
        edgeMap.set(id, {
          id,
          source: row.subject,
          target: row.object,
          type: row.predicate,
          status,
          confidence,
          provenance: [provenance],
        });
      } else {
        previous.confidence = Math.max(previous.confidence, confidence);
        if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[previous.status] ?? 0)) previous.status = status;
        previous.provenance.push(provenance);
      }
      continue;
    }
    const id = hashText(`fact\u0000${row.subject}\u0000${row.predicate}\u0000${row.object}`, 32);
    const previous = factMap.get(id);
    if (!previous) {
      const conflict = conflictByGroup.get(stableJson([row.scope, row.subject, row.predicate]));
      factMap.set(id, {
        id,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        status,
        confidence,
        provenance: [provenance],
        ...(conflict ? { conflict: true, conflictScope: conflict.scope } : {}),
      });
    } else {
      previous.confidence = Math.max(previous.confidence, confidence);
      if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[previous.status] ?? 0)) previous.status = status;
      previous.provenance.push(provenance);
    }
  }
  const edges = [...edgeMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  const facts = [...factMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  const conflicts = conflictRows;
  const orphanCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM nodes n
    WHERE n.persistent = 0 AND NOT EXISTS (SELECT 1 FROM source_nodes sn WHERE sn.node_id = n.id)`).get().count);
  const staleSources = allSourceRows.filter(row => Number(row.active) !== 0 &&
    (Number(row.stale) !== 0 || (row.expires_at && (dateMs(row.expires_at) ?? 0) <= Date.now()))).length;
  const inactiveSources = allSourceRows.filter(row => Number(row.active) === 0).length;
  const health = {
    ok: conflicts.length === 0,
    conflicts,
    staleSources,
    inactiveSources,
    orphanNodes: orphanCount,
    sourceCount: selectedSources.length,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    factCount: facts.length,
  };
  const activities = db.prepare('SELECT * FROM activity ORDER BY id').all();
  const activity = activities
    .filter(row => (!scope || row.checkout_id === scope) && (includeInactive || row.expires_at > Date.now()))
    .map(row => {
      let files = [];
      let state = {};
      try { files = JSON.parse(row.files_json); } catch { /* rows are written by us */ }
      try { state = JSON.parse(row.state_json); } catch { /* rows are written by us */ }
      return {
        id: row.id,
        checkoutId: row.checkout_id,
        label: row.label,
        files,
        state,
        expiresAt: new Date(row.expires_at).toISOString(),
        active: row.expires_at > Date.now(),
      };
    });
  return {
    revision: currentRevision(db),
    project: projectFromRow(projectRow),
    nodes,
    edges,
    facts,
    sources: selectedSources.map(sourceSummary),
    health,
    activity,
  };
}

function normalizeActivity(raw) {
  assertObject(raw, 'activity');
  const id = shortId(raw.id, 'activity.id');
  const checkoutId = raw.checkoutId === undefined || raw.checkoutId === null ? null : shortId(raw.checkoutId, 'activity.checkoutId', MAX_SCOPE);
  const label = boundedString(raw.label ?? id, 'activity.label', MAX_LABEL);
  const files = ensureArray(raw.files, 'activity.files');
  if (files.length > MAX_ACTIVITY_FILES) throw errorWithCode('QUOTA_EXCEEDED', `activity.files exceeds ${MAX_ACTIVITY_FILES}`);
  const normalizedFiles = files.map((value, index) => boundedString(value, `activity.files[${index}]`, MAX_ACTIVITY_FILE_BYTES));
  const state = raw.state === undefined || raw.state === null ? {} : raw.state;
  const stateJson = stableJson(state);
  if (stateJson.length > MAX_ACTIVITY_STATE_BYTES) throw errorWithCode('QUOTA_EXCEEDED', 'activity.state is too large');
  let expiresAt = raw.expiresAt;
  if (expiresAt === undefined || expiresAt === null) expiresAt = Date.now() + 5 * 60 * 1000;
  const expiry = nowMs(expiresAt);
  return { id, checkoutId, label, files: normalizedFiles, stateJson, expiresAt: expiry };
}

class ProjectIntelligenceStore {
  #db;
  #closed = false;

  constructor(db) {
    this.#db = db;
  }

  #dbOrThrow() {
    if (this.#closed) throw errorWithCode('STORE_CLOSED', 'project intelligence store is closed');
    return this.#db;
  }

  ensureProject(identity) {
    const db = this.#dbOrThrow();
    assertObject(identity, 'identity');
    const id = shortId(identity.id, 'identity.id');
    const checkoutId = shortId(identity.checkoutId ?? id, 'identity.checkoutId', MAX_SCOPE);
    const root = boundedString(identity.root, 'identity.root', MAX_LOCATOR);
    const name = boundedString(identity.name ?? id, 'identity.name', MAX_LABEL);
    const git = Boolean(identity.git);
    const stateDir = boundedString(identity.stateDir ?? dirname(root), 'identity.stateDir', MAX_LOCATOR);
    const commonDir = identity.commonDir === undefined || identity.commonDir === null ? null : boundedString(identity.commonDir, 'identity.commonDir', MAX_LOCATOR);
    const branch = identity.branch === undefined || identity.branch === null ? null : boundedString(identity.branch, 'identity.branch', MAX_LABEL);
    const head = identity.head === undefined || identity.head === null ? null : boundedString(identity.head, 'identity.head', MAX_LABEL);
    const rootNode = { id: nodeId('project', id), type: 'project', label: name, key: id, status: 'verified', confidence: 1 };
    return withImmediate(db, () => {
      const timestamp = Date.now();
      const existing = db.prepare('SELECT * FROM project LIMIT 1').get();
      if (existing && existing.id !== id) throw errorWithCode('PROJECT_MISMATCH', `store belongs to project ${existing.id}`);
      let changed = false;
      if (!existing) {
        db.prepare(`INSERT INTO project
          (id, checkout_id, root, common_dir, branch, head, name, git, state_dir, root_node_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, checkoutId, root, commonDir, branch, head, name, git ? 1 : 0, stateDir, rootNode.id, timestamp, timestamp);
        changed = true;
      } else {
        // A project database is shared by worktrees. Checkout identity and
        // branch/head are represented by checkout-scoped sources; replacing
        // them here would make opening another worktree churn the graph
        // revision and overwrite the canonical project metadata.
        const sameGitDomain = Boolean(Number(existing.git) && git && existing.common_dir && commonDir && existing.common_dir === commonDir);
        const stableRoot = sameGitDomain ? existing.root : root;
        const stableCommonDir = sameGitDomain ? existing.common_dir : commonDir;
        const stableName = sameGitDomain ? existing.name : name;
        const fields = [sameGitDomain ? existing.checkout_id : checkoutId, stableRoot, stableCommonDir,
          sameGitDomain ? existing.branch : branch, sameGitDomain ? existing.head : head,
          stableName, git ? 1 : 0, stateDir];
        const old = [existing.checkout_id, existing.root, existing.common_dir, existing.branch, existing.head,
          existing.name, Number(existing.git), existing.state_dir];
        changed = fields.some((value, index) => value !== old[index]);
        if (changed) {
          db.prepare(`UPDATE project SET checkout_id = ?, root = ?, common_dir = ?, branch = ?, head = ?,
                      name = ?, git = ?, state_dir = ?, updated_at = ? WHERE id = ?`)
            .run(...fields, timestamp, id);
        }
      }
      const sameGitDomain = Boolean(existing && Number(existing.git) && git && existing.common_dir && commonDir && existing.common_dir === commonDir);
      const canonicalRootNode = sameGitDomain ? { ...rootNode, label: existing.name } : rootNode;
      const globalNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(canonicalRootNode.id);
      if (!globalNode || globalNode.type !== canonicalRootNode.type || globalNode.label !== canonicalRootNode.label || Number(globalNode.persistent) === 0) {
        upsertGlobalNode(db, canonicalRootNode, true, timestamp);
        changed = true;
      }
      if (!changed) return { revision: currentRevision(db), changed: false, project: projectFromRow(existing) };
      const revision = bumpRevision(db);
      return { revision, changed: true, project: projectFromRow(db.prepare('SELECT * FROM project LIMIT 1').get()) };
    });
  }

  sources(scope = undefined) {
    const db = this.#dbOrThrow();
    const normalized = validateScope(scope, { optional: true });
    return withReadSnapshot(db, () => db.prepare(normalized
      ? `SELECT * FROM sources WHERE scope = ? OR scope = 'shared' ORDER BY id`
      : 'SELECT * FROM sources ORDER BY id').all(...(normalized ? [normalized] : [])).map(sourceSummary));
  }

  nodeSources(nodeIdValue, scopeValue) {
    const db = this.#dbOrThrow();
    const id = boundedString(nodeIdValue, 'nodeId', MAX_KEY);
    const scope = validateScope(scopeValue, { optional: true });
    return withReadSnapshot(db, () => db.prepare(`SELECT s.* FROM sources s JOIN source_nodes sn ON sn.source_id = s.id
      WHERE sn.node_id = ? ${scope ? "AND (s.scope = ? OR s.scope = 'shared')" : ''} ORDER BY s.id LIMIT 80`)
      .all(id, ...(scope ? [scope] : [])).map(sourceSummary));
  }

  /** Read a source and the exact claims it owns for optimistic corrections. */
  source(idValue, options = {}) {
    const db = this.#dbOrThrow();
    const id = boundedString(idValue, 'sourceId', MAX_KEY * 4);
    const scope = validateScope(options.scope, { optional: true });
    const limit = Math.min(80, Math.max(1, Number.isInteger(options.limit) ? options.limit : 30));
    return withReadSnapshot(db, () => {
      const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
      if (!row || scope && row.scope !== scope && row.scope !== 'shared') return null;
      const nodes = db.prepare('SELECT node_id AS id, type, label, node_key AS key FROM source_nodes WHERE source_id = ? ORDER BY node_id LIMIT ?').all(id, limit);
      const claims = db.prepare('SELECT subject, predicate, object, relation, status, confidence, exclusive FROM source_claims WHERE source_id = ? ORDER BY claim_key LIMIT ?').all(id, limit);
      const counts = {
        nodes: Number(db.prepare('SELECT COUNT(*) AS n FROM source_nodes WHERE source_id = ?').get(id).n),
        claims: Number(db.prepare('SELECT COUNT(*) AS n FROM source_claims WHERE source_id = ?').get(id).n),
      };
      return { ...sourceSummary(row), nodes, claims: claims.map(claim => ({ ...claim, relation: Boolean(claim.relation), exclusive: Boolean(claim.exclusive) })), counts, truncated: counts.nodes > nodes.length || counts.claims > claims.length };
    });
  }

  replaceSource(rawSource, options = {}) {
    const db = this.#dbOrThrow();
    const source = normalizeSource(rawSource);
    assertObject(options ?? {}, 'replaceSource options');
    const expectedVersion = parseExpectedVersion(options.expectedVersion);
    return withImmediate(db, () => commitSourceReplacement(db, source, expectedVersion));
  }

  /** Replace a discovery batch in one bounded transaction. */
  replaceSources(rawSources, options = {}) {
    const db = this.#dbOrThrow();
    if (!Array.isArray(rawSources)) throw errorWithCode('INVALID_INPUT', 'sources must be an array');
    if (rawSources.length > MAX_TOTAL_SOURCES) throw errorWithCode('QUOTA_EXCEEDED', 'source batch exceeds source quota');
    assertObject(options ?? {}, 'replaceSources options');
    const entries = [];
    const ids = new Set();
    for (const [index, rawSource] of rawSources.entries()) {
      assertObject(rawSource, `sources[${index}]`);
      const source = normalizeSource(rawSource);
      if (ids.has(source.id)) throw errorWithCode('INVALID_INPUT', `sources contains duplicate id ${source.id}`);
      ids.add(source.id);
      entries.push({ source, expectedVersion: parseExpectedVersion(rawSource.expectedVersion) });
    }
    if (!entries.length) return { revision: currentRevision(db), changed: false, count: 0, changedCount: 0, results: [] };
    return withImmediate(db, () => commitSourceBatch(db, entries));
  }

  removeSource(idValue, options = {}) {
    const db = this.#dbOrThrow();
    const id = shortId(idValue, 'source.id');
    assertObject(options ?? {}, 'removeSource options');
    const expectedVersion = parseExpectedVersion(options.expectedVersion);
    return withImmediate(db, () => {
      const row = rowSource(db, id);
      if (!row) {
        if (expectedVersion !== 0) {
          throw errorWithCode('STALE_SOURCE', `source ${id} expected version ${expectedVersion}, current version 0`, { currentVersion: 0 });
        }
        return { revision: currentRevision(db), changed: false };
      }
      if (Number(row.active) === 0) {
        if (expectedVersion !== 0 && Number(row.version) !== expectedVersion) {
          throw errorWithCode('STALE_SOURCE', `source ${id} expected version ${expectedVersion}, current version ${row.version}`, { currentVersion: Number(row.version) });
        }
        return { revision: currentRevision(db), changed: false };
      }
      if (Number(row.version) !== expectedVersion) {
        throw errorWithCode('STALE_SOURCE', `source ${id} expected version ${expectedVersion}, current version ${row.version}`, { currentVersion: Number(row.version) });
      }
      const timestamp = Date.now();
      const toVersion = Number(row.version) + 1;
      const oldClaims = db.prepare('SELECT * FROM source_claims WHERE source_id = ? ORDER BY claim_key').all(id);
      for (const claim of oldClaims) {
        let claimJson = stableJson({ subject: claim.subject, predicate: claim.predicate, object: claim.object,
          relation: Number(claim.relation) !== 0, status: claim.status, confidence: Number(claim.confidence),
          exclusive: Number(claim.exclusive) !== 0 });
        if (claimJson.length > MAX_HISTORY_DETAILS_BYTES) claimJson = claimJson.slice(0, MAX_HISTORY_DETAILS_BYTES);
        db.prepare(`INSERT INTO claim_history (source_id, version, action, claim_json, at) VALUES (?, ?, 'removed', ?, ?)`)
          .run(id, toVersion, claimJson, timestamp);
      }
      db.prepare('UPDATE sources SET active = 0, stale = 1, version = ?, updated_at = ? WHERE id = ?')
        .run(toVersion, timestamp, id);
      db.prepare('DELETE FROM source_claims WHERE source_id = ?').run(id);
      db.prepare('DELETE FROM source_nodes WHERE source_id = ?').run(id);
      deleteOrphanNodes(db);
      recordHistory(db, { event: 'source-removed', sourceId: id, scope: row.scope,
        fromVersion: Number(row.version), toVersion, at: timestamp,
        details: { claims: oldClaims.length } });
      trimHistory(db);
      const revision = bumpRevision(db);
      return { revision, changed: true };
    });
  }

  snapshot(options = {}) {
    const db = this.#dbOrThrow();
    assertObject(options ?? {}, 'snapshot options');
    return withReadSnapshot(db, () => storeSnapshot(db, options));
  }

  /** One numeric/category observation per session and aspect, updated atomically
   * across workers. Source contents and review prose stay in the session. */
  reviewHistory(scopeValue, sessionValue, samples) {
    const db = this.#dbOrThrow();
    const scope = boundedString(scopeValue, 'review scope', MAX_SCOPE);
    const session = createHash('sha256').update(boundedString(sessionValue, 'review session', MAX_ID)).digest('hex').slice(0,32);
    const key = `quality-review:${scope}`;
    const aspects = ['correctness','security','interface','content','runtime','delivery'];
    if (samples !== undefined && (!Array.isArray(samples) || samples.length > 6 || samples.some(s => !s || !aspects.includes(s.aspect) || !['pass','changes','unknown'].includes(s.outcome)))) throw errorWithCode('INVALID_INPUT','Invalid review observations');
    return withImmediate(db, () => {
      const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
      let history = []; try { history = JSON.parse(row?.value ?? '[]'); } catch {}
      if (!Array.isArray(history)) history = [];
      history = history.filter(s => s && aspects.includes(s.aspect) && ['pass','changes','unknown'].includes(s.outcome) && Number.isFinite(s.at) && Date.now()-s.at < 90*86400000).slice(-60);
      if (samples !== undefined) {
        for (const sample of samples) {
          const prior = history.find(s=>s.session===session && s.aspect===sample.aspect);
          history = history.filter(s=>s.session!==session || s.aspect!==sample.aspect);
          history.push({session,aspect:sample.aspect,outcome:sample.outcome,hadChanges:prior?.hadChanges===true || sample.outcome==='changes',at:Date.now()});
        }
        history = history.slice(-60);
        db.prepare(`INSERT INTO metadata (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key,JSON.stringify(history),Date.now());
      }
      return history.filter(s=>s.session!==session).slice(-20).map(({aspect,outcome,hadChanges,at})=>({aspect,outcome,hadChanges,at}));
    });
  }

  getMeta(keyValue) {
    const db = this.#dbOrThrow();
    const key = boundedString(keyValue, 'metadata key', MAX_ID);
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
    if (!row) return undefined;
    try { return JSON.parse(row.value); } catch { return undefined; }
  }

  setMeta(keyValue, value) {
    const db = this.#dbOrThrow();
    const key = boundedString(keyValue, 'metadata key', MAX_ID);
    if (value === undefined) throw errorWithCode('INVALID_INPUT', 'metadata value must be JSON serializable');
    let serialized;
    try { serialized = stableJson(value); } catch (error) { throw errorWithCode('INVALID_INPUT', `metadata value is not JSON serializable: ${error.message}`); }
    if (serialized === undefined || serialized.length > MAX_META_BYTES) throw errorWithCode('QUOTA_EXCEEDED', 'metadata value is too large');
    return withImmediate(db, () => {
      const existing = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
      if (existing?.value === serialized) return { revision: currentRevision(db), changed: false };
      const timestamp = Date.now();
      db.prepare(`INSERT INTO metadata (key, value, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(key, serialized, timestamp);
      // Metadata is discovery bookkeeping and is intentionally outside the
      // graph revision used by snapshot caches. Graph mutations still bump it.
      return { revision: currentRevision(db), changed: true };
    });
  }

  revision() {
    return currentRevision(this.#dbOrThrow());
  }

  maintain(options = {}) {
    const db = this.#dbOrThrow();
    assertObject(options ?? {}, 'maintain options');
    const at = nowMs(options.now);
    return withImmediate(db, () => {
      let changed = false;
      const expired = db.prepare(`SELECT * FROM sources WHERE active = 1 AND expires_at IS NOT NULL`).all()
        .filter(row => (dateMs(row.expires_at) ?? Number.MAX_SAFE_INTEGER) <= at && Number(row.stale) === 0);
      for (const row of expired) {
        db.prepare('UPDATE sources SET stale = 1, updated_at = ? WHERE id = ?').run(at, row.id);
        recordHistory(db, { event: 'source-expired', sourceId: row.id, scope: row.scope,
          fromVersion: Number(row.version), toVersion: Number(row.version), at,
          details: { expiresAt: row.expires_at } });
        changed = true;
      }
      const orphanBefore = Number(db.prepare(`SELECT COUNT(*) AS count FROM nodes n
        WHERE n.persistent = 0 AND NOT EXISTS (SELECT 1 FROM source_nodes sn WHERE sn.node_id = n.id)`).get().count);
      deleteOrphanNodes(db);
      const orphanAfter = Number(db.prepare(`SELECT COUNT(*) AS count FROM nodes n
        WHERE n.persistent = 0 AND NOT EXISTS (SELECT 1 FROM source_nodes sn WHERE sn.node_id = n.id)`).get().count);
      if (orphanBefore !== orphanAfter) changed = true;
      db.prepare('DELETE FROM activity WHERE expires_at <= ?').run(at);
      db.prepare('DELETE FROM leases WHERE expires_at <= ?').run(at);
      trimHistory(db);
      if (!changed) return { revision: currentRevision(db), changed: false, expiredSources: expired.length, removedOrphans: Math.max(0, orphanBefore - orphanAfter) };
      return { revision: bumpRevision(db), changed: true, expiredSources: expired.length, removedOrphans: Math.max(0, orphanBefore - orphanAfter) };
    });
  }

  setActivity(rawActivity) {
    const db = this.#dbOrThrow();
    const activity = normalizeActivity(rawActivity);
    return withImmediate(db, () => {
      const timestamp = Date.now();
      db.prepare(`INSERT INTO activity (id, checkout_id, label, files_json, state_json, expires_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET checkout_id = excluded.checkout_id, label = excluded.label,
                    files_json = excluded.files_json, state_json = excluded.state_json,
                    expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
        .run(activity.id, activity.checkoutId, activity.label, stableJson(activity.files), activity.stateJson, activity.expiresAt, timestamp);
      return { changed: true, revision: currentRevision(db), id: activity.id, expiresAt: new Date(activity.expiresAt).toISOString() };
    });
  }

  deleteActivity(idValue) {
    const db = this.#dbOrThrow();
    const id = shortId(idValue, 'activity.id');
    return withImmediate(db, () => {
      const result = db.prepare('DELETE FROM activity WHERE id = ?').run(id);
      return { changed: Number(result.changes) !== 0, revision: currentRevision(db) };
    });
  }

  claimLease(nameValue, ownerValue, ttlMsValue) {
    const db = this.#dbOrThrow();
    const name = shortId(nameValue, 'lease.name');
    const owner = shortId(ownerValue, 'lease.owner');
    if (!Number.isFinite(ttlMsValue) || !Number.isInteger(ttlMsValue) || ttlMsValue <= 0 || ttlMsValue > MAX_LEASE_TTL_MS) {
      throw errorWithCode('INVALID_INPUT', `lease ttlMs must be an integer in (0, ${MAX_LEASE_TTL_MS}]`);
    }
    return withImmediate(db, () => {
      const at = Date.now();
      const existing = db.prepare('SELECT * FROM leases WHERE name = ?').get(name);
      if (existing && Number(existing.expires_at) > at && existing.owner !== owner) return false;
      db.prepare(`INSERT INTO leases (name, owner, expires_at, updated_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at,
                    updated_at = excluded.updated_at`)
        .run(name, owner, at + ttlMsValue, at);
      return true;
    });
  }

  renewLease(nameValue, ownerValue, ttlMsValue) {
    const db = this.#dbOrThrow();
    const name = shortId(nameValue, 'lease.name');
    const owner = shortId(ownerValue, 'lease.owner');
    if (!Number.isFinite(ttlMsValue) || !Number.isInteger(ttlMsValue) || ttlMsValue <= 0 || ttlMsValue > MAX_LEASE_TTL_MS) {
      throw errorWithCode('INVALID_INPUT', `lease ttlMs must be an integer in (0, ${MAX_LEASE_TTL_MS}]`);
    }
    return withImmediate(db, () => {
      const at = Date.now();
      const result = db.prepare(`UPDATE leases SET expires_at = ?, updated_at = ?
        WHERE name = ? AND owner = ? AND expires_at > ?`).run(at + ttlMsValue, at, name, owner, at);
      return Number(result.changes) !== 0;
    });
  }

  releaseLease(nameValue, ownerValue) {
    const db = this.#dbOrThrow();
    const name = shortId(nameValue, 'lease.name');
    const owner = shortId(ownerValue, 'lease.owner');
    return withImmediate(db, () => {
      const result = db.prepare('DELETE FROM leases WHERE name = ? AND owner = ?').run(name, owner);
      return Number(result.changes) !== 0;
    });
  }

  history(options = {}) {
    const db = this.#dbOrThrow();
    assertObject(options ?? {}, 'history options');
    const limit = options.limit === undefined ? 20 : options.limit;
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_HISTORY_ROWS) throw errorWithCode('INVALID_INPUT', `history limit must be in [0, ${MAX_HISTORY_ROWS}]`);
    const scope = validateScope(options.scope, { optional: true });
    const sourceIds = Array.isArray(options.sourceIds) ? options.sourceIds.slice(0, 400) : options.sourceId ? [options.sourceId] : null;
    if (sourceIds && !sourceIds.length) return [];
    const where = [], params = [];
    if (scope) { where.push("(scope = ? OR scope = 'shared')"); params.push(scope); }
    if (sourceIds) { where.push(`source_id IN (${sourceIds.map(() => '?').join(',')})`); params.push(...sourceIds); }
    return withReadSnapshot(db, () => db.prepare(`SELECT * FROM history ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`).all(...params, limit).map(row => {
      let details = {};
      try { details = JSON.parse(row.details); } catch { details = { raw: row.details }; }
      return {
        id: Number(row.seq),
        event: row.event,
        sourceId: row.source_id,
        scope: row.scope,
        fromVersion: row.from_version === null ? null : Number(row.from_version),
        toVersion: row.to_version === null ? null : Number(row.to_version),
        at: new Date(Number(row.at)).toISOString(),
        details,
      };
    }));
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

export function openStore(dbPath) {
  const path = boundedString(dbPath, 'dbPath', MAX_LOCATOR * 4);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    setupSchema(db);
  } catch (error) {
    try { db.close(); } catch { /* preserve original error */ }
    throw error;
  }
  return new ProjectIntelligenceStore(db);
}

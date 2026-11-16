import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const readers = new Map();
const MAX_FILE_BYTES = 128 * 1024 * 1024, MAX_RECORDS = 200_000;
const MAX_CACHED_FILE_BYTES = 24 * 1024 * 1024, MAX_CACHED_RECORDS = 50_000;
const MAX_CACHED_STATS = 8;

// One reader per owned core keeps parsing off Electron's main thread without
// creating a process (or loading extensions) for every history being browsed.
export function readHistory({ directory, sessionId, cwd, before, revision, statsOnly = false, limit = 80, coreRoot, timeoutMs = 20_000 }) {
  if (!isMainThread) return Promise.reject(Error('History reads must be requested by the application.'));
  if (![directory, cwd, coreRoot].every(value => typeof value === 'string' && path.isAbsolute(value))
    || typeof sessionId !== 'string' || !sessionId || sessionId.length > 128
    || !Number.isInteger(limit) || limit < 1 || limit > 200
    || before !== undefined && (!Number.isInteger(before) || before < 0)
    || revision !== undefined && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))
    || typeof statsOnly !== 'boolean' || statsOnly && before !== undefined
    || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return Promise.reject(Error('Invalid history request.'));
  const key = path.resolve(coreRoot);
  let reader = readers.get(key);
  if (!reader) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'yunuspi-history', coreRoot: key }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 }, name: 'yunuspi-history' });
    reader = { worker, pending: new Map(), nextId: 1 };
    readers.set(key, reader);
    const fail = error => {
      if (readers.get(key) === reader) readers.delete(key);
      for (const pending of reader.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      reader.pending.clear();
    };
    reader.fail = fail;
    worker.on('message', message => {
      const pending = reader.pending.get(message.id);
      if (!pending) return;
      reader.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(Error(message.error)); else pending.resolve(message.data);
    });
    worker.on('error', error => fail(Error(`History reader stopped: ${error.message}`)));
    worker.on('exit', code => fail(Error(`History reader exited before completing the read (${code}).`)));
    // A passive reader must never keep the desktop alive after shutdown.
    worker.unref();
  }
  return new Promise((resolve, reject) => {
    const id = reader.nextId++;
    const timer = setTimeout(() => {
      reader.fail(Error('History read timed out. The transcript is retained; reopen the session to retry.'));
      void reader.worker.terminate();
    }, timeoutMs);
    reader.pending.set(id, { resolve, reject, timer });
    try { reader.worker.postMessage({ id, directory, sessionId, cwd, before, revision, statsOnly, limit }); }
    catch (error) { clearTimeout(timer); reader.pending.delete(id); reject(error); }
  });
}

export async function closeHistoryReaders() {
  const active = [...readers.values()]; readers.clear();
  for (const reader of active) reader.fail(Error('History reader closed. The transcript is retained.'));
  await Promise.allSettled(active.map(reader => reader.worker.terminate()));
}

export async function cancelPendingHistoryReads() {
  const pending = [...readers.values()].filter(reader => reader.pending.size);
  for (const reader of pending) reader.fail(Error('History selection changed. The transcript is retained.'));
  await Promise.allSettled(pending.map(reader => reader.worker.terminate()));
  return pending.length;
}

function historyFiles(directory) {
  let names;
  try { names = fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (names.length > 128) throw Error('This history folder exceeds the 128-file discovery limit. Its original files are retained.');
  // SessionManager.list() allocates searchable metadata for the whole file.
  return names.map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile()) throw Error('The transcript must be a regular file.');
    if (stat.size > MAX_FILE_BYTES) throw Error('This transcript exceeds the 128 MiB history-reader limit. Its original file is retained.');
    return { path: file, name, stat };
  }).sort((a, b) => Number(b.stat.mtimeNs - a.stat.mtimeNs) || a.name.localeCompare(b.name));
}

function historyRevision({ directory, cwd, sessionId }, files) {
  const hash = createHash('sha256').update([directory, cwd, sessionId].join('\0'));
  for (const { name, stat } of files) {
    hash.update(['', name, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('\0'));
  }
  return hash.digest('hex');
}

function readSnapshot(request, files, [manager, projection]) {
  const { loadEntriesFromFile, migrateSessionEntries, isAccountingOnlySessionEntry } = manager;
  const { desktopBranchMessages, desktopGoal } = projection;
  const canonical = directory => { try { return fs.realpathSync(directory); } catch { return path.resolve(directory); } };
  const cwd = canonical(request.cwd);
  let selected, fallback;
  for (const file of files) {
    const candidate = loadEntriesFromFile(file.path, { readOnly: true, bounds: {
      expected: file.stat, maxBytes: MAX_FILE_BYTES, maxRecords: MAX_RECORDS,
    } });
    if (candidate[0]?.type !== 'session' || candidate[0].id !== request.sessionId) {
      if (file.name.endsWith(`_${request.sessionId}.jsonl`) || file.name === `${request.sessionId}.jsonl`) throw Error('The transcript identity changed while opening it. Reopen the session to retry.');
      continue;
    }
    const match = { entries: candidate, sessionFile: file.path };
    if (files.length === 1 || typeof candidate[0].cwd === 'string' && canonical(candidate[0].cwd) === cwd) { selected = match; break; }
    // The dedicated folder and session ID retain ownership after a project moves.
    fallback ??= match;
  }
  const { entries = [], sessionFile } = selected ?? fallback ?? {};
  if (entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw Error('The transcript contains an invalid record. Its original file is retained.');
  // Migrate only in memory. Viewing a transcript never repairs or rewrites it.
  if (entries.length) migrateSessionEntries(entries);
  const byId = new Map();
  let leaf;
  for (const entry of entries) {
    if (entry.type === 'session') continue;
    if (typeof entry.id !== 'string' || !entry.id || byId.has(entry.id)
      || entry.parentId != null && typeof entry.parentId !== 'string') throw Error('The transcript contains invalid entry identifiers. Its original file is retained.');
    byId.set(entry.id, entry);
    if (!isAccountingOnlySessionEntry(entry)) leaf = entry;
  }
  const branch = [];
  while (leaf) {
    if (branch.length >= byId.size) throw Error('The transcript contains a branch cycle. Its original file is retained.');
    branch.push(leaf);
    leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
  }
  branch.reverse();
  const snapshot = { records: entries.length };
  if (!request.statsOnly) snapshot.messages = desktopBranchMessages(branch);
  if (request.before === undefined) {
    snapshot.goal = desktopGoal(branch);
    snapshot.accounting = { entries, sessionFile };
  }
  return snapshot;
}

function updateSnapshotStats(snapshot, { collectSessionStats, recoverRetainedChildCosts }) {
  if (!snapshot.accounting) return;
  const { entries, sessionFile } = snapshot.accounting;
  const recovered = sessionFile ? recoverRetainedChildCosts(entries, { sessionFile }) : undefined;
  snapshot.stats = collectSessionStats(recovered?.entries.length ? [...entries, ...recovered.entries] : entries);
  // Keep the full accounting input only when a child can settle later without
  // changing the parent transcript. Pagination never reruns reconciliation.
  if (!recovered?.candidates) snapshot.accounting = undefined;
}

if (!isMainThread && workerData?.kind === 'yunuspi-history') {
  const core = workerData.coreRoot;
  const modules = Promise.all([
    import(pathToFileURL(path.join(core, 'dist/core/session-manager.js')).href),
    import(pathToFileURL(path.join(core, 'dist/modes/rpc/desktop-projection.js')).href),
    import(pathToFileURL(path.join(core, 'dist/core/session-accounting.js')).href),
  ]);
  // Keep initialization failures attached to a request rather than unhandled.
  modules.catch(() => {});
  let tail = Promise.resolve();
  let cached;
  const metadata = new Map();

  function readPage(request, components) {
    const [, { desktopHistory }, accounting] = components;
    const files = historyFiles(request.directory);
    const revision = historyRevision(request, files);
    const key = files.length === 1 && files[0].stat.size <= MAX_CACHED_FILE_BYTES ? revision : undefined;
    const initial = request.before === undefined;
    const unchanged = initial && request.revision === revision;
    if (!initial && request.revision !== undefined && request.revision !== revision) return { reset: true, revision };

    // The renderer already owns the pages for a matching revision. Keep only
    // their compact totals across session switches.
    const saved = unchanged || request.statsOnly ? metadata.get(revision) : undefined;
    if (saved && !saved.reconcile) {
      metadata.delete(revision);
      metadata.set(revision, saved);
      return { ...saved.data, revision };
    }
    let snapshot = key && cached?.key === key && (!initial || cached.snapshot.stats) ? cached.snapshot : undefined;
    const includeMessages = !unchanged && !request.statsOnly;
    if (!snapshot) {
      if (includeMessages) cached = undefined;
      snapshot = readSnapshot({ ...request, statsOnly: !includeMessages }, files, components);
      if (includeMessages && key && snapshot.records <= MAX_CACHED_RECORDS) cached = { key, snapshot };
    }
    if (initial) updateSnapshotStats(snapshot, accounting);
    const data = { isStreaming: false, streamingMessage: null, revision };
    if (includeMessages) Object.assign(data, desktopHistory(snapshot.messages, { before: request.before, limit: request.limit }));
    if (initial) { data.goal = snapshot.goal; data.stats = snapshot.stats; }
    // Malformed imported metadata must stay within the page transfer budget.
    if (Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024 + 4096) throw Error('This history preview exceeds the 8 MiB transfer limit. Its original file is retained.');
    if (initial) {
      metadata.delete(revision);
      metadata.set(revision, { reconcile: Boolean(snapshot.accounting), data: { goal: data.goal, stats: data.stats, isStreaming: false, streamingMessage: null } });
      if (metadata.size > MAX_CACHED_STATS) metadata.delete(metadata.keys().next().value);
    }
    return data;
  }

  parentPort.on('message', request => {
    tail = tail.then(async () => {
      try {
        const components = await modules;
        let data;
        try {
          data = readPage(request, components);
        } catch (error) {
          if (error.code !== 'SESSION_READ_CHANGED') throw error;
          data = readPage(request, components);
        }
        parentPort.postMessage({ id: request.id, data });
      } catch (error) {
        const message = error.code === 'SESSION_READ_RECORD_LIMIT'
          ? 'This transcript exceeds the 200,000-record history-reader limit. Its original file is retained.'
          : error.message || 'Unable to read this transcript. Its original file is retained.';
        parentPort.postMessage({ id: request.id, error: message });
      }
    });
  });
}

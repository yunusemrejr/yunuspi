import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const readers = new Map();
const MAX_FILE_BYTES = 128 * 1024 * 1024, MAX_RECORDS = 200_000;

// One reader per owned core keeps parsing off Electron's main thread without
// creating a process (or loading extensions) for every history being browsed.
export function readHistory({ directory, sessionId, cwd, before, limit = 80, coreRoot, timeoutMs = 20_000 }) {
  if (!isMainThread) return Promise.reject(Error('History reads must be requested by the application.'));
  if (![directory, cwd, coreRoot].every(value => typeof value === 'string' && path.isAbsolute(value))
    || typeof sessionId !== 'string' || !sessionId || sessionId.length > 128
    || !Number.isInteger(limit) || limit < 1 || limit > 200
    || before !== undefined && (!Number.isInteger(before) || before < 0)
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
    try { reader.worker.postMessage({ id, directory, sessionId, cwd, before, limit }); }
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

if (!isMainThread && workerData?.kind === 'yunuspi-history') {
  const core = workerData.coreRoot;
  const modules = Promise.all([
    import(pathToFileURL(path.join(core, 'dist/core/session-manager.js')).href),
    import(pathToFileURL(path.join(core, 'dist/modes/rpc/desktop-projection.js')).href),
  ]);
  // Keep initialization failures attached to a request rather than unhandled.
  modules.catch(() => {});
  let tail = Promise.resolve();
  parentPort.on('message', request => {
    tail = tail.then(async () => {
      try {
        const [{ loadEntriesFromFile, migrateSessionEntries }, { desktopBranchMessages, desktopHistory }] = await modules;
        let names;
        try { names = fs.readdirSync(request.directory).filter(name => name.endsWith('.jsonl')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
        if (names.length > 128) throw Error('This history folder exceeds the 128-file discovery limit. Its original files are retained.');
        // Do not call SessionManager.list(): its searchable metadata joins all
        // message text and would parse/allocate the complete history twice.
        const files = names.map(name => {
          const file = path.join(request.directory, name), stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink()) throw Error('The transcript must be a regular file.');
          if (stat.size > MAX_FILE_BYTES) throw Error('This transcript exceeds the 128 MiB history-reader limit. Its original file is retained.');
          return { path: file, name, modified: stat.mtimeMs };
        }).sort((a, b) => b.modified - a.modified);
        const canonical = directory => { try { return fs.realpathSync(directory); } catch { return path.resolve(directory); } };
        let entries, fallback;
        for (const file of files) {
          const candidate = loadEntriesFromFile(file.path, { readOnly: true });
          if (candidate[0]?.type !== 'session' || candidate[0].id !== request.sessionId) {
            if (file.name.endsWith(`_${request.sessionId}.jsonl`) || file.name === `${request.sessionId}.jsonl`) throw Error('The transcript identity changed while opening it. Reopen the session to retry.');
            continue;
          }
          if (typeof candidate[0].cwd === 'string' && canonical(candidate[0].cwd) === canonical(request.cwd)) { entries = candidate; break; }
          // The dedicated transcript folder and session ID establish ownership.
          // A moved/deleted project must not make its saved history disappear.
          fallback ??= candidate;
        }
        entries ??= fallback;
        let branch = [];
        if (entries) {
          if (entries.length > MAX_RECORDS) throw Error('This transcript exceeds the 200,000-record history-reader limit. Its original file is retained.');
          if (entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw Error('The transcript contains an invalid record. Its original file is retained.');
          // Native migration mutates only these in-memory entries. Unlike
          // SessionManager.open(), reading never repairs or rewrites the file.
          migrateSessionEntries(entries);
          const byId = new Map(); let leaf;
          for (const entry of entries) {
            if (entry.type === 'session') continue;
            if (typeof entry.id !== 'string' || !entry.id || byId.has(entry.id)
              || entry.parentId != null && typeof entry.parentId !== 'string') throw Error('The transcript contains invalid entry identifiers. Its original file is retained.');
            byId.set(entry.id, entry); leaf = entry;
          }
          const visited = new Set();
          while (leaf) {
            if (visited.has(leaf.id)) throw Error('The transcript contains a branch cycle. Its original file is retained.');
            visited.add(leaf.id); branch.push(leaf);
            leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
          }
          branch.reverse();
        }
        const data = { ...desktopHistory(desktopBranchMessages(branch), { before: request.before, limit: request.limit }), isStreaming: false, streamingMessage: null };
        // The projection clips normal text/images; malformed imported metadata
        // must not bypass its page budget on the first returned message.
        if (Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024 + 4096) throw Error('This history preview exceeds the 8 MiB transfer limit. Its original file is retained.');
        parentPort.postMessage({ id: request.id, data });
      } catch (error) { parentPort.postMessage({ id: request.id, error: error.message || 'Unable to read this transcript. Its original file is retained.' }); }
    });
  });
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSessionCost, mergeCostEvidence, readCostEvidence } from './session-accounting.js';

const maxRuns = 16;
const maxStatusBytes = 512 * 1024;
const maxChildBytes = 4 * 1024 * 1024;
const maxChildTotalBytes = 16 * 1024 * 1024;
const terminal = new Set(['complete', 'failed', 'partial', 'stopped']);
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const childFilePattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/run-0\/session\.jsonl$/;
const spent = cost => cost.reported + cost.estimated;

function defaultStatusRoot() {
  const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (configured) return path.join(path.resolve(configured), 'async-subagent-runs');
  if (typeof process.getuid === 'function') return path.join(os.tmpdir(), `pi-subagents-uid-${process.getuid()}`, 'async-subagent-runs');
}

function readOwnedFile(file, limit) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o002) || before.uid !== process.getuid() ||
        before.size === 0 || before.size > limit || fs.realpathSync(file) !== file) return;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino || opened.size !== before.size) return;
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return;
      offset += count;
    }
    const after = fs.lstatSync(file);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.ctimeMs !== opened.ctimeMs || fs.realpathSync(file) !== file) return;
    return bytes;
  } catch { /* The original accounting remains usable when an artifact is unavailable. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readChildLedger(bytes) {
  const entries = [], ids = new Set();
  let incomplete = false;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entries.length) {
        if (entry?.type !== 'session' || !entry.id) return;
      } else if (!entry || entry.type === 'session' || typeof entry.id !== 'string' || ids.has(entry.id)) {
        incomplete = true;
        continue;
      }
      entries.push(entry);
      ids.add(entry.id);
    } catch {
      if (!entries.length) return;
      incomplete = true;
    }
  }
  if (entries.length) return {entries, incomplete};
}

/** Resolve legacy single-child accounting from a parent-owned terminal artifact.
 * Returns in-memory receipts. Viewing history does not change any artifact. */
export function recoverRetainedChildCosts(entries, {sessionFile, statusRoot = defaultStatusRoot()} = {}) {
  const none = {entries:[], candidates:false};
  const sessionId = entries?.[0]?.type === 'session' ? entries[0].id : undefined;
  if (typeof sessionId !== 'string' || typeof sessionFile !== 'string' || !path.isAbsolute(sessionFile) ||
      path.normalize(sessionFile) !== sessionFile || !sessionFile.endsWith('.jsonl') || typeof process.getuid !== 'function') return none;
  const childRoot = sessionFile.slice(0, -6);
  const candidates = new Map(), knownByFile = new Map();
  for (let i = entries.length - 1; i >= Math.max(0, entries.length - 2048); i--) {
    const entry = entries[i];
    if (entry?.type !== 'custom' || entry.customType !== 'subagent-cost-v1') continue;
    const data = entry.data;
    if (data?.recoveredForSessionId !== undefined && data.recoveredForSessionId !== sessionId) continue;
    if (typeof data?.runId !== 'string' || !runIdPattern.test(data.runId) ||
        !Array.isArray(data.results) || data.results.length !== 1) continue;
    const row = data.results[0];
    const childFile = row?.sessionFile;
    if (typeof childFile !== 'string' || !path.isAbsolute(childFile) || path.normalize(childFile) !== childFile ||
        !childFilePattern.test(path.relative(childRoot, childFile))) continue;
    const known = Math.max(spent(readCostEvidence(row.usage)), Number.isFinite(row.totalCost?.costUsd) ? row.totalCost.costUsd : 0);
    knownByFile.set(childFile, Math.max(knownByFile.get(childFile) ?? 0, known));
    const key = `${data.runId}\0${childFile}`;
    if (candidates.size < maxRuns && !candidates.has(key) && !row.children?.length && !row.steps?.length) {
      candidates.set(key, {data, row, childFile});
    }
  }
  if (!candidates.size) return none;
  const recovered = {entries:[], candidates:true};
  if (typeof statusRoot !== 'string' || !path.isAbsolute(statusRoot) || path.normalize(statusRoot) !== statusRoot) return recovered;
  const readFiles = new Set();
  let remaining = maxChildTotalBytes;
  // Keep replay work bounded even when a historical parent has a long ledger.
  let comparisons = Math.max(1, Math.floor(200_000 / entries.length));
  let currentTotal;
  for (const {data, row, childFile} of candidates.values()) {
    if (!comparisons || !remaining) break;
    if (readFiles.has(childFile)) continue;
    const rawStatus = readOwnedFile(path.join(statusRoot, data.runId, 'status.json'), maxStatusBytes);
    if (!rawStatus) continue;
    let status;
    try { status = JSON.parse(rawStatus.toString('utf8')); }
    catch { continue; }
    if (status?.runId !== data.runId || status.sessionId !== sessionFile || status.mode !== 'single' ||
        !terminal.has(status.state) || !Array.isArray(status.steps) || status.steps.length !== 1) continue;
    const step = status.steps[0];
    if (!terminal.has(step?.status ?? step?.state) || (step.sessionFile ?? step.result?.sessionFile) !== childFile ||
        (step.result?.sessionFile !== undefined && step.result.sessionFile !== childFile)) continue;
    readFiles.add(childFile);
    const bytes = readOwnedFile(childFile, Math.min(maxChildBytes, remaining));
    if (!bytes) continue;
    remaining -= bytes.length;
    const child = readChildLedger(bytes);
    if (!child) continue;
    const actual = collectSessionCost(child.entries);
    // The inclusive nested graph may already be represented in the parent.
    // Recover leaf charges only until every descendant can be tied to a node.
    if (actual.rows.some(result => result.scope === 'children') || actual.total <= knownByFile.get(childFile)) continue;
    const own = mergeCostEvidence(actual.main, actual.auxiliary);
    const previous = readCostEvidence(row.usage);
    own.unknown ||= child.incomplete || actual.unknown || previous.unknown;
    own.subscription ||= previous.subscription;
    const usage = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'turns'].flatMap(key =>
      Number.isFinite(row.usage?.[key]) && row.usage[key] >= 0 ? [[key, row.usage[key]]] : []));
    const costByModel = actual.rows.length <= 64 ? actual.rows.map(({route, ...evidence}) => ({
      route:route.slice(0, 512), evidence:readCostEvidence({costDetails:evidence}),
    })) : undefined;
    const index = Number.isSafeInteger(row.index) && row.index >= 0 ? row.index : 0;
    const receipt = {type:'custom', customType:'subagent-cost-v1', data:{
      runId:data.runId, recoveredForSessionId:sessionId, results:[{
        index, ...(Number.isSafeInteger(row.attempt) && row.attempt > 0 ? {attempt:row.attempt} : {}), sessionFile:childFile,
        model:typeof row.model === 'string' ? row.model.slice(0, 512) : undefined,
        usage:{...usage, cost:actual.total, costDetails:own, costByModel},
        totalCost:{costUsd:actual.total, costDetails:own},
      }],
    }};
    // A native alias or older wrapper may already carry these charges. Use the
    // same graph reducer as the footer, including retained off-branch history.
    comparisons--;
    currentTotal ??= collectSessionCost(entries).total;
    const nextTotal = collectSessionCost([...entries, ...recovered.entries, receipt]).total;
    if (nextTotal > currentTotal) {
      recovered.entries.push(receipt);
      currentTotal = nextTotal;
    }
  }
  return recovered;
}

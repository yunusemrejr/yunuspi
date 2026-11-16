import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectAuxiliaryModelUsage, collectSessionCost, mergeCostEvidence, readCostEvidence } from './session-accounting.js';

const maxRuns = 16;
const maxStatusBytes = 512 * 1024;
const maxChildBytes = 4 * 1024 * 1024;
const maxChildTotalBytes = 16 * 1024 * 1024;
const terminal = new Set(['complete', 'failed', 'partial', 'stopped']);
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const childFilePattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/run-0\/session\.jsonl$/;
const spent = cost => cost.reported + cost.estimated;
const maxCoverageRoutes = 64;
const tokenFields = ['input', 'output', 'cacheRead', 'cacheWrite'];

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

function directFootprint(child, cost) {
  if (child.incomplete || cost.unknown || !cost.seen || cost.estimatedUsage || cost.subscription ||
      cost.rows.length !== 1 || cost.rows[0].scope !== 'main') return;
  const replies = child.entries.filter(entry => entry.type === 'message' && entry.message?.role === 'assistant');
  if (replies.length !== 1) return;
  const { usage } = replies[0].message;
  if (usage?.cost?.source !== 'provider-reported' || !Number.isSafeInteger(usage.input) || !Number.isSafeInteger(usage.output)) return;
  const tokens = Object.fromEntries(tokenFields.map(field => [field, usage[field] ?? 0]));
  if (Object.values(tokens).some(n => !Number.isSafeInteger(n) || n < 0) || !Object.values(tokens).some(n => n > 0)) return;
  return {route:cost.rows[0].route, tokens};
}

function amountEvidence(node) {
  const evidence = node.own ?? node.totalEvidence ?? readCostEvidence({cost:node.inclusive});
  const remainder = (node.inclusive ?? 0) - spent(evidence);
  return remainder > 0 ? {...evidence, estimated:evidence.estimated + remainder, seen:true, estimatedUsage:true} : evidence;
}

function attributableRoutes(routes, required) {
  if (!Array.isArray(routes) || !routes.length || routes.length > maxCoverageRoutes) return;
  const amounts = new Map();
  for (const row of routes) {
    if (typeof row?.route !== 'string' || row.route.length > 512) return;
    const evidence = readCostEvidence({costDetails:row.evidence});
    const before = amounts.get(row.route);
    amounts.set(row.route, before ? mergeCostEvidence(before, evidence) : evidence);
  }
  if (Math.abs([...amounts.values()].reduce((sum, evidence) => sum + spent(evidence), 0) - required) < 1e-10) return amounts;
}

/** Merge filesystem observations after alias folding. Each observation can
 * refine coverage without outranking a node's confirmed monetary evidence. */
export function applyRetainedChildCost(node, row, coverage) {
  const previous = amountEvidence(node);
  const observed = readCostEvidence(row.usage);
  const direct = coverage?.direct;
  const sameDirectUsage = direct && node.turns === 1 && node.route === direct.route &&
    Number.isSafeInteger(node.usage?.input) && Number.isSafeInteger(node.usage?.output) &&
    tokenFields.every(field => (node.usage[field] ?? 0) === direct.tokens?.[field]);
  const completeCorrection = sameDirectUsage && previous.estimated > 0 && !observed.unknown &&
    observed.seen && !observed.estimatedUsage && !observed.subscription;
  const useObservedCost = observed.seen && observed.reported >= previous.reported && (completeCorrection ||
    spent(observed) > spent(previous) || spent(observed) === spent(previous) && (!previous.seen || observed.reported > previous.reported));
  // A later aggregate estimate can include work absent from the child copy.
  // Keep its residual estimate without demoting the observed billed portion.
  const retainsReportedFloor = !useObservedCost && observed.reported > previous.reported;
  const observedRoutes = attributableRoutes(row.usage?.costByModel, spent(observed));
  const ledger = node.retainedCoverage;
  const priorBreakdown = attributableRoutes(node.routes, spent(previous));
  const priorRoutes = ledger?.paidRoutes ?? priorBreakdown ?? new Map([[node.route, previous]]);
  const priorZeroes = ledger?.zeroRoutes ?? new Map([...(priorBreakdown ?? [])].filter(([, evidence]) => spent(evidence) === 0));
  let paidRoutes = useObservedCost ? observedRoutes ?? new Map([[node.route, observed]]) : priorRoutes;
  const zeroRoutes = new Map(priorZeroes), gaps = new Map(ledger?.gaps);
  let overflow = ledger?.overflow ?? false;
  for (const request of Array.isArray(coverage?.requests) ? coverage.requests.slice(0, maxCoverageRoutes) : []) {
    if (!Array.isArray(request) || typeof request[0] !== 'string' || typeof request[1] !== 'string') continue;
    const [key, route, state] = request;
    if (state === 'known') gaps.delete(key);
    else if (state === 'pending' || state === 'unpriced') {
      if (gaps.has(key) || gaps.size < maxCoverageRoutes) gaps.set(key, {route, state});
      else overflow = true;
    }
  }
  for (const [route, evidence] of observedRoutes ?? []) {
    if (spent(evidence) > 0) zeroRoutes.delete(route);
    else if (zeroRoutes.has(route) || zeroRoutes.size < maxCoverageRoutes) zeroRoutes.set(route, evidence);
    else overflow ||= evidence.unknown;
  }
  const explicitUnknown = ledger?.explicitUnknown ?? (node.incomplete || (previous.unknown && node.explicitUnknown));
  let money = useObservedCost ? observed : previous;
  if (retainsReportedFloor) {
    const estimated = Math.max(0, spent(previous) - observed.reported);
    money = {...previous, reported:observed.reported, estimated, seen:true, estimatedUsage:estimated > 0};
    const confirmed = new Map([...(observedRoutes ?? new Map([[node.route, observed]]))].flatMap(([route, evidence]) =>
      evidence.reported > 0 ? [[route, {...evidence, estimated:0, estimatedUsage:false}]] : []));
    const residual = readCostEvidence({cost:estimated});
    if (estimated > 0) {
      const current = confirmed.get(node.route);
      confirmed.set(node.route, current ? mergeCostEvidence(current, residual) : residual);
    }
    paidRoutes = confirmed;
  }
  const own = {...money, unknown:Boolean(explicitUnknown || observed.unknown || gaps.size || overflow || !money.seen && previous.unknown),
    subscription:previous.subscription || observed.subscription,
    estimatedUsage:money.estimatedUsage || [...zeroRoutes.values()].some(evidence => evidence.estimatedUsage)};
  const facts = (evidence, zeroes, missing, limited) => JSON.stringify([evidence, [...zeroes], [...missing], limited]);
  if (facts(own, zeroRoutes, gaps, overflow) === facts(previous, priorZeroes, ledger?.gaps ?? [], ledger?.overflow ?? false)) return node;
  const routes = new Map([...paidRoutes].filter(([, evidence]) => spent(evidence) > 0));
  for (const [route, evidence] of zeroRoutes) {
    const prior = routes.get(route);
    routes.set(route, prior ? mergeCostEvidence(prior, evidence) : evidence);
  }
  for (const {route} of gaps.values()) {
    const evidence = routes.get(route) ?? readCostEvidence();
    routes.set(route, {...evidence, unknown:true});
  }
  return {...node, own, inclusive:spent(own),
    routes:[...routes].map(([route, evidence]) => ({route, evidence})),
    retainedCoverage:{paidRoutes, zeroRoutes, gaps, overflow, explicitUnknown}};
}

/** Resolve legacy single-child accounting from a parent-owned terminal artifact.
 * Returns in-memory receipts. Viewing history does not change any artifact. */
export function recoverRetainedChildCosts(entries, {sessionFile, statusRoot = defaultStatusRoot()} = {}) {
  const none = {entries:[], candidates:false};
  const sessionId = entries?.[0]?.type === 'session' ? entries[0].id : undefined;
  if (typeof sessionId !== 'string' || typeof sessionFile !== 'string' || !path.isAbsolute(sessionFile) ||
      path.normalize(sessionFile) !== sessionFile || !sessionFile.endsWith('.jsonl') || typeof process.getuid !== 'function') return none;
  const childRoot = sessionFile.slice(0, -6);
  const candidates = new Map();
  for (let i = entries.length - 1; i >= Math.max(0, entries.length - 2048); i--) {
    const entry = entries[i];
    if (entry?.type !== 'custom' || entry.customType !== 'subagent-cost-v1') continue;
    const data = entry.data;
    if (data?.recoveredForSessionId !== undefined) continue;
    if (typeof data?.runId !== 'string' || !runIdPattern.test(data.runId) ||
        !Array.isArray(data.results) || data.results.length !== 1) continue;
    const row = data.results[0];
    const childFile = row?.sessionFile;
    if (typeof childFile !== 'string' || !path.isAbsolute(childFile) || path.normalize(childFile) !== childFile ||
        !childFilePattern.test(path.relative(childRoot, childFile))) continue;
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
  const proposals = [];
  for (const {data, row, childFile} of candidates.values()) {
    if (!remaining) break;
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
    const requests = collectAuxiliaryModelUsage(child.entries);
    const actual = collectSessionCost(child.entries, false, requests);
    // The inclusive nested graph may already be represented in the parent.
    // Recover leaf charges only until every descendant can be tied to a node.
    if ((!actual.rows.length && !actual.unknown && !child.incomplete) || actual.rows.some(result => result.scope === 'children')) continue;
    const own = mergeCostEvidence(actual.main, actual.auxiliary);
    own.unknown ||= child.incomplete || actual.unknown;
    const usage = Object.fromEntries([...tokenFields, 'turns'].flatMap(key =>
      Number.isFinite(row.usage?.[key]) && row.usage[key] >= 0 ? [[key, row.usage[key]]] : []));
    const costByModel = actual.rows.length <= maxCoverageRoutes ? actual.rows.map(({route, ...evidence}) => ({
      route:route.slice(0, 512), evidence:readCostEvidence({costDetails:evidence}),
    })) : undefined;
    const coverage = {
      direct:status.state === 'complete' && (step.status ?? step.state) === 'complete' ? directFootprint(child, actual) : undefined,
      requests:requests.rows.length <= maxCoverageRoutes ? requests.rows.map(request => [
        JSON.stringify([request.owner, request.id, request.route]), request.route,
        request.status === 'pending' ? 'pending' : request.evidence.unknown ? 'unpriced' : 'known',
      ]) : undefined,
    };
    const index = Number.isSafeInteger(row.index) && row.index >= 0 ? row.index : 0;
    const receipt = {type:'custom', customType:'subagent-cost-v1', data:{
      runId:data.runId, recoveredForSessionId:sessionId, childLedgerCoverage:coverage, results:[{
        index, ...(Number.isSafeInteger(row.attempt) && row.attempt > 0 ? {attempt:row.attempt} : {}), sessionFile:childFile,
        model:typeof row.model === 'string' ? row.model.slice(0, 512) : undefined,
        usage:{...usage, cost:actual.total, costDetails:own, costByModel},
        totalCost:{costUsd:actual.total, costDetails:own},
      }],
    }};
    proposals.push(receipt);
  }
  if (proposals.length) {
    // A single graph pass covers retained off-branch and native alias rows.
    const changed = new Set();
    collectSessionCost([...entries, ...proposals], false, undefined, entry => changed.add(entry));
    recovered.entries = proposals.filter(entry => changed.has(entry));
  }
  return recovered;
}

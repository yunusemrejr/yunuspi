import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
const privateWorkflowStates = new Set([...terminal, 'paused', 'rejected']);
const workflowKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

function fileAbsent(file) {
  try { fs.lstatSync(file); return false; }
  catch (error) { return error.code === 'ENOENT'; }
}

function ownsSessionFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && !(stat.mode & 0o002) && fs.realpathSync(file) === file;
  } catch { return false; }
}

function readOwnedJson(file, limit, budget) {
  const bytes = readOwnedFile(file, budget ? Math.min(limit, budget.remaining) : limit);
  if (bytes) {
    if (budget) budget.remaining -= bytes.length;
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { /* An invalid artifact is not an outcome. */ }
  }
}

function privateWorkflowReferences(entries, sessionId, onlyRunId) {
  const references = new Map();
  const persisted = new Map();
  const add = (runId, workflowRunId, key) => {
    if (typeof runId !== 'string' || !runIdPattern.test(runId) || runId === workflowRunId ||
        (onlyRunId !== undefined && runId !== onlyRunId) || typeof workflowRunId !== 'string' || !runIdPattern.test(workflowRunId) ||
        typeof key !== 'string' || !workflowKeyPattern.test(key)) return;
    const old = references.get(runId);
    if (old === null) return;
    if (old && (old.workflowRunId !== workflowRunId || old.key !== key)) references.set(runId, null);
    else if (!old && references.size < maxRuns) references.set(runId, {workflowRunId, key});
  };
  for (const entry of entries.slice(-2048).reverse()) {
    const data = entry?.data;
    if (entry?.type !== 'custom' || !data) continue;
    if (entry.customType === 'subagent-lifecycle-v1' && data.privateWorkflow?.ownerSessionId === sessionId) {
      const { workflowRunId, key } = data.privateWorkflow;
      add(data.runId, workflowRunId, key);
    }
    if (entry.customType !== 'subagent-cost-v1') continue;
    if (data.recoveredForSessionId === sessionId && data.privateWorkflow && !persisted.has(data.runId)) {
      persisted.set(data.runId, JSON.stringify(data));
    }
    // Retained async workflow results already recorded their physical row identity.
    if (data.recoveredForSessionId !== undefined || data.mode !== 'workflow' || !Array.isArray(data.results)) continue;
    for (const row of data.results.slice(0, 128)) add(row?.runId, data.runId, row?.workflowKey);
  }
  return {references, persisted};
}

function projectPrivateWorkflowCost(root, sessionFile, sessionId, runId, reference, budget) {
  const {workflowRunId, key} = reference;
  const directory = path.join(root, runId);
  const status = readOwnedJson(path.join(directory, 'status.json'), maxStatusBytes);
  if (status?.runId !== runId || status.sessionId !== sessionFile || status.mode !== 'single' ||
      status.resultDelivery !== 'workflow' || status.parentWorkflowRunId !== workflowRunId || status.workflowKey !== key ||
      !Array.isArray(status.steps) || status.steps.length !== 1) return;
  const ownsReceipt = receipt => (receipt?.runId ?? receipt?.id) === runId && (receipt.id === undefined || receipt.id === runId) &&
      receipt.sessionId === sessionFile && receipt.asyncDir === directory && receipt.mode === 'single' &&
      receipt.parentWorkflowRunId === workflowRunId && receipt.workflowKey === key && privateWorkflowStates.has(receipt.state) &&
      Number.isFinite(receipt.timestamp) && Number.isFinite(status.startedAt) && receipt.timestamp >= status.startedAt &&
      Array.isArray(receipt.results) && receipt.results.length === 1;
  let receipt = readOwnedJson(path.join(directory, 'workflow-result.json'), maxChildBytes, budget);
  if (!ownsReceipt(receipt) && /^[0-9a-f-]{36}$/.test(runId)) {
    // Session paths end in .jsonl, so the result index uses its hashed segment.
    const ownerSegment = `~sha256-${createHash('sha256').update(sessionFile).digest('hex')}`;
    receipt = readOwnedJson(path.join(directory, 'result-pending', ownerSegment, `${runId}.json`), maxChildBytes, budget);
  }
  if (!ownsReceipt(receipt)) return;
  const row = receipt.results[0];
  if (!row || typeof row !== 'object' || (row.runId !== undefined && row.runId !== runId)) return;
  const own = readCostEvidence(row.usage);
  const total = readCostEvidence({cost:row.totalCost?.costUsd, costDetails:row.totalCost?.costDetails});
  const knownOwn = own.seen || own.subscription;
  const knownTotal = total.seen || total.subscription;
  if (!knownOwn && !knownTotal) return;
  const counts = Object.fromEntries([...tokenFields, 'turns'].flatMap(field =>
    Number.isSafeInteger(row.usage?.[field]) && row.usage[field] >= 0 ? [[field, row.usage[field]]] : []));
  const costByModel = Array.isArray(row.usage?.costByModel) && row.usage.costByModel.length <= maxCoverageRoutes
    ? row.usage.costByModel.flatMap(item => typeof item?.route === 'string' && item.route.length <= 512
      ? [{route:item.route, evidence:readCostEvidence({costDetails:item.evidence})}] : []) : undefined;
  return {type:'custom', customType:'subagent-cost-v1', data:{
    runId, mode:'single', state:receipt.state, recoveredForSessionId:sessionId, privateWorkflow:{workflowRunId, key},
    results:[{index:0, runId,
      ...(typeof row.model === 'string' && row.model.length <= 512 ? {model:row.model} : {}),
      ...(knownOwn ? {usage:{...counts, cost:spent(own), costDetails:own, ...(costByModel ? {costByModel} : {})}} : {}),
      ...(knownTotal ? {totalCost:{costUsd:spent(total),costDetails:total}} : {}),
    }],
  }};
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

function nativeTerminalResult(data, row, relativeFile) {
  const nativeId = relativeFile.split(path.sep)[0];
  const states = [data.state, row.status ?? row.state];
  return row.runId === nativeId && (row.index ?? 0) === 0 && data.asyncId === undefined &&
    (data.mode === undefined || data.mode === 'single') && row.childProcessStarted !== false &&
    Number.isSafeInteger(row.exitCode) && row.exitCode >= 0 && row.evidence?.version === 1 &&
    states.every(state => state === undefined || state === 'completed' || terminal.has(state));
}

// Foreground runs can have no async status file. A retained native result
// already records process exit and the direct usage it observed. Use that
// receipt to attest the child file before recovering separate auxiliary work.
function matchesNativeDirectUsage(row, child, actual) {
  const {main, auxiliary} = actual;
  const recorded = readCostEvidence(row.usage);
  if (child.incomplete || spent(auxiliary) <= 0 || (!recorded.seen && !recorded.subscription) ||
      ['reported', 'estimated', 'seen', 'unknown', 'subscription'].some(key => recorded[key] !== main[key]) ||
      (row.totalCost !== undefined && row.totalCost?.costUsd !== spent(recorded))) return false;

  const recordedRoutes = attributableRoutes(row.usage?.costByModel, spent(recorded));
  const directRoutes = actual.rows.filter(route => route.scope === 'main');
  if (!recordedRoutes || recordedRoutes.size !== directRoutes.length || directRoutes.some(route => {
    const saved = recordedRoutes.get(route.route);
    return !saved || ['reported', 'estimated', 'seen', 'unknown', 'subscription'].some(key => saved[key] !== route[key]);
  })) return false;

  const usage = row.evidence.usage;
  if (!Number.isSafeInteger(usage?.turns) || usage.turns < 1 || usage.turns !== row.usage.turns ||
      tokenFields.some(key => !Number.isSafeInteger(usage[key]) || usage[key] < 0 || usage[key] !== row.usage[key])) return false;
  const direct = {input:0, output:0, cacheRead:0, cacheWrite:0};
  let turns = 0;
  for (const entry of child.entries) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    turns++;
    for (const key of tokenFields) {
      const count = entry.message.usage?.[key] ?? 0;
      if (!Number.isSafeInteger(count) || count < 0) return false;
      direct[key] += count;
    }
  }
  return turns === usage.turns && tokenFields.every(key => direct[key] === usage[key]);
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
export function recoverRetainedChildCosts(entries, {sessionFile, statusRoot = defaultStatusRoot(), privateWorkflowRunId} = {}) {
  const none = {entries:[], candidates:false};
  const sessionId = entries?.[0]?.type === 'session' ? entries[0].id : undefined;
  if (typeof sessionId !== 'string' || typeof sessionFile !== 'string' || !path.isAbsolute(sessionFile) ||
      path.normalize(sessionFile) !== sessionFile || !sessionFile.endsWith('.jsonl') || typeof process.getuid !== 'function') return none;
  const {references, persisted} = privateWorkflowReferences(entries, sessionId, privateWorkflowRunId);
  const privateEntries = [];
  const validStatusRoot = typeof statusRoot === 'string' && path.isAbsolute(statusRoot) && path.normalize(statusRoot) === statusRoot;
  if (validStatusRoot && references.size && ownsSessionFile(sessionFile)) {
    const budget = {remaining:maxChildTotalBytes};
    for (const [runId, reference] of references) {
      if (budget.remaining === 0) break;
      if (!reference) continue;
      const observed = projectPrivateWorkflowCost(statusRoot, sessionFile, sessionId, runId, reference, budget);
      if (observed && persisted.get(runId) !== JSON.stringify(observed.data)) privateEntries.push(observed);
    }
  }
  if (privateWorkflowRunId !== undefined) return {entries:privateEntries, candidates:references.size > 0};
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
    if (typeof childFile !== 'string' || !path.isAbsolute(childFile) || path.normalize(childFile) !== childFile) continue;
    const relativeFile = path.relative(childRoot, childFile);
    if (!childFilePattern.test(relativeFile)) continue;
    const key = `${data.runId}\0${childFile}`;
    if (candidates.size < maxRuns && !candidates.has(key) && !row.children?.length && !row.steps?.length) {
      candidates.set(key, {data, row, childFile, nativeTerminal:nativeTerminalResult(data, row, relativeFile)});
    }
  }
  const recovered = {entries:privateEntries, candidates:candidates.size > 0 || references.size > 0};
  if (!candidates.size || !validStatusRoot) return recovered;
  const readFiles = new Set();
  let remaining = maxChildTotalBytes;
  const proposals = [];
  let ownedParent;
  for (const {data, row, childFile, nativeTerminal} of candidates.values()) {
    if (!remaining) break;
    if (readFiles.has(childFile)) continue;
    const statusFile = path.join(statusRoot, data.runId, 'status.json');
    const rawStatus = readOwnedFile(statusFile, maxStatusBytes);
    let complete = false;
    if (rawStatus) {
      let status;
      try { status = JSON.parse(rawStatus.toString('utf8')); }
      catch { continue; }
      if (status?.runId !== data.runId || status.sessionId !== sessionFile || status.mode !== 'single' ||
          !terminal.has(status.state) || !Array.isArray(status.steps) || status.steps.length !== 1) continue;
      const step = status.steps[0];
      if (!terminal.has(step?.status ?? step?.state) || (step.sessionFile ?? step.result?.sessionFile) !== childFile ||
          (step.result?.sessionFile !== undefined && step.result.sessionFile !== childFile)) continue;
      complete = status.state === 'complete' && (step.status ?? step.state) === 'complete';
    } else {
      if (!nativeTerminal || !fileAbsent(statusFile) ||
          (row.runId !== data.runId && !fileAbsent(path.join(statusRoot, row.runId, 'status.json')))) continue;
      ownedParent ??= ownsSessionFile(sessionFile);
      if (!ownedParent) continue;
    }
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
    if (!rawStatus && !matchesNativeDirectUsage(row, child, actual)) continue;
    readFiles.add(childFile);
    const own = mergeCostEvidence(actual.main, actual.auxiliary);
    own.unknown ||= child.incomplete || actual.unknown;
    const usage = Object.fromEntries([...tokenFields, 'turns'].flatMap(key =>
      Number.isFinite(row.usage?.[key]) && row.usage[key] >= 0 ? [[key, row.usage[key]]] : []));
    const costByModel = actual.rows.length <= maxCoverageRoutes ? actual.rows.map(({route, ...evidence}) => ({
      route:route.slice(0, 512), evidence:readCostEvidence({costDetails:evidence}),
    })) : undefined;
    const coverage = {
      direct:complete ? directFootprint(child, actual) : undefined,
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
    collectSessionCost([...entries, ...privateEntries, ...proposals], false, undefined, entry => changed.add(entry));
    recovered.entries.push(...proposals.filter(entry => changed.has(entry)));
  }
  return recovered;
}

import type { Usage } from './types.ts';
import { collectAuxiliaryModelUsage, readCostEvidence, mergeCostEvidence } from '../../../lib/cost-evidence.ts';
import { collectSessionCost } from '../../../lib/session-cost.ts';
const auxiliaryEvents = new WeakMap<Usage, Set<string>>();
const auxiliaryReceipts = new WeakMap<Usage, { entries: any[]; aggregate?: Usage }>();
const auxiliaryReceiptTypes = new Set(['auxiliary-model-usage-v1', 'jev-usage-v1', 'span-usage-v1']);
const tokenFields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

/** Runs may switch models and retry. Carry facts from each actual response;
 * never multiply cumulative tokens by the final selected model's price. */
export function projectCostByModel(value: any): NonNullable<Usage['costByModel']> | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  return value.filter(row=>typeof row?.route === 'string' && row.route.length <= 512).map(row=>({
    route:row.route, evidence:readCostEvidence({costDetails:row.evidence}),
  }));
}

export function addUsageCost(target: Usage, source: any, provider?: string, model?: string): void {
  const before = target.costDetails ?? (['input','output','cacheRead','cacheWrite','cost','turns'].every(k=>target[k] === 0)
    ? {reported:0,estimated:0,unknown:false,subscription:false,seen:false} : readCostEvidence(target));
  const next = readCostEvidence(source, provider);
  const routes = new Map((projectCostByModel(target.costByModel) ?? []).map(row=>[row.route,row.evidence]));
  if (!routes.size && (before.seen || before.unknown || before.subscription)) routes.set('unattributed child',before);
  const routeProvider = provider ?? source?.cost?.provider;
  const routeModel = model ?? source?.cost?.model;
  const route = routeProvider && routeModel ? `${routeProvider}/${routeModel}` : 'unattributed child';
  const incoming = projectCostByModel(source?.costByModel) ?? [{route,evidence:next}];
  for (const row of incoming) {
    const key = routes.has(row.route) || routes.size < 255 ? row.route : 'other child models';
    routes.set(key,routes.has(key) ? mergeCostEvidence(routes.get(key),row.evidence) : row.evidence);
  }
  target.costByModel = [...routes].map(([route,evidence])=>({route,evidence}));
  target.costDetails = mergeCostEvidence(before, next);
  target.cost = target.costDetails.reported + target.costDetails.estimated;
}

export function addAuxiliaryUsage(target: Usage, event: any): void {
  const entry = event.type === 'entry_appended' ? event.entry : undefined;
  if (entry?.type === 'custom' && auxiliaryReceiptTypes.has(entry.customType)) {
    if (typeof entry.id === 'string' && !acceptAuxiliaryEvent(target, `receipt:${entry.id}`)) return;
    const ledger = auxiliaryReceipts.get(target) ?? {entries: []};
    ledger.entries.push(entry);
    ledger.aggregate = undefined;
    auxiliaryReceipts.set(target, ledger);
    return;
  }
  const message = ['message_end','tool_result_end'].includes(event.type) ? event.message : undefined;
  const usage = event.type === 'compaction_end' ? event.result?.usage :
    message?.role === 'toolResult' && !['subagent', 'bg_wait'].includes(message.toolName) ? message.usage : undefined;
  if (!usage) return;
  const id = message?.toolCallId ? `tool:${message.toolCallId}` : event.result?.id ? `compaction:${event.result.id}` : undefined;
  if (id && !acceptAuxiliaryEvent(target, id)) return;
  addUsageCost(target, usage, usage.cost?.provider);
  for (const key of tokenFields) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) target[key] += value;
  }
}

function acceptAuxiliaryEvent(target: Usage, id: string): boolean {
  const seen = auxiliaryEvents.get(target) ?? new Set<string>();
  if (seen.has(id)) return false;
  seen.add(id);
  auxiliaryEvents.set(target, seen);
  return true;
}

function aggregateAuxiliaryReceipts(entries: any[]): Usage {
  const { rows, truncated } = collectAuxiliaryModelUsage(entries);
  const aggregate: Usage = {input:0, output:0, cacheRead:0, cacheWrite:0, turns:0, cost:0};
  let evidence = {reported:0, estimated:0, unknown:truncated, subscription:false, seen:false};
  const routes = new Map<string, NonNullable<Usage['costDetails']>>();
  const addRoute = (name: string, contribution: NonNullable<Usage['costDetails']>) => {
    evidence = mergeCostEvidence(evidence, contribution);
    const route = routes.has(name) || routes.size < 255 ? name : 'other child models';
    const previous = routes.get(route);
    routes.set(route, previous ? mergeCostEvidence(previous, contribution) : contribution);
  };
  for (const row of rows) {
    addRoute(row.route, row.evidence);
    for (const field of tokenFields) aggregate[field] += row.usage[field] ?? 0;
  }
  // Jev/Span predate per-request auxiliary rows. Reuse their legacy
  // evidence handling and keep them out of the modern request fold.
  const legacy = entries.filter(entry => entry.customType !== 'auxiliary-model-usage-v1');
  if (legacy.length) {
    for (const { route, ...cost } of collectSessionCost(legacy).rows) addRoute(route, cost);
  }
  aggregate.costByModel = [...routes].map(([route, evidence]) => ({route, evidence}));
  aggregate.costDetails = evidence;
  aggregate.cost = evidence.reported + evidence.estimated;
  return aggregate;
}

/** Pending, final and corrected records describe one request. Project them
 * separately from cumulative message/tool usage so final records can replace
 * a partial or earlier estimated amount. Refresh only when a receipt changes. */
export function snapshotChildUsage(target: Usage): Usage {
  const snapshot = {...target};
  const ledger = auxiliaryReceipts.get(target);
  if (!ledger) return snapshot;
  const aggregate = ledger.aggregate ??= aggregateAuxiliaryReceipts(ledger.entries);
  addUsageCost(snapshot, aggregate);
  for (const field of tokenFields) snapshot[field] += aggregate[field];
  return snapshot;
}

/** Once the child stream is drained, fold its auxiliary total into the result
 * carried by retry, detach and nested parent receipts. */
export function finalizeChildUsage(target: Usage): void {
  if (!auxiliaryReceipts.has(target)) return;
  Object.assign(target, snapshotChildUsage(target));
  auxiliaryReceipts.delete(target);
}

/** Preserve nested identities for session-wide deduplication, with bounded depth.
 * Compact only known accounting fields; never serialize an arbitrary child. */
export function projectCostChildren(nodes: any, depth = 0): any[] | undefined {
  if (!Array.isArray(nodes)) return undefined;
  if (depth >= 16) return [{accountingIncomplete:true}];
  return nodes.map(n => ({
    ...(typeof n?.id === 'string' ? {id:n.id} : {}),
    ...(typeof n?.runId === 'string' ? {runId:n.runId} : {}),
    ...(typeof n?.sessionFile === 'string' ? {sessionFile:n.sessionFile} : {}),
    ...(n?.totalCost ? {totalCost:{costUsd:n.totalCost.costUsd, ...(n.totalCost.costDetails ? {costDetails:readCostEvidence({costDetails:n.totalCost.costDetails})} : {})}} : {}),
    ...(n?.children ? {children:projectCostChildren(n.children,depth+1)} : {}),
    ...(Array.isArray(n?.steps) ? {steps:n.steps.map((s:any)=>({children:projectCostChildren(s?.children,depth+1)}))} : {}),
  }));
}

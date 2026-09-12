import type { Usage } from './types.ts';
import { readCostEvidence, mergeCostEvidence } from '../../../lib/cost-evidence.ts';
const auxiliaryEvents = new WeakMap<Usage, Set<string>>();

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
  const message = ['message_end','tool_result_end'].includes(event.type) ? event.message : undefined;
  const usage = event.type === 'compaction_end' ? event.result?.usage :
    message?.role === 'toolResult' && !['subagent', 'bg_wait'].includes(message.toolName) ? message.usage : undefined;
  if (!usage) return;
  const id = message?.toolCallId ? `tool:${message.toolCallId}` : event.result?.id ? `compaction:${event.result.id}` : undefined;
  if (id) {
    const seen = auxiliaryEvents.get(target) ?? new Set<string>();
    if (seen.has(id)) return;
    seen.add(id); auxiliaryEvents.set(target,seen);
  }
  addUsageCost(target, usage, usage.cost?.provider);
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) target[key] += value;
  }
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

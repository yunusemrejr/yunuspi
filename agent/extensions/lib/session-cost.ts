// @ts-nocheck -- Pure collector, embedded in SDK/CLI; imports supplied by patch.
import {readCostEvidence, mergeCostEvidence} from './cost-evidence.ts';

export function collectSessionCost(entries, subscription = false) {
  const empty = () => ({reported:0, estimated:0, unknown:false, subscription:false, seen:false});
  const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const rows = new Map(), nodes = new Map(), aliases = new Map();
  const pending = new Set(), settled = new Set(), seenEntries = new Set();
  let main = empty(), children = empty(), auxiliary = empty(), truncated = false;
  const addRow = (scope, route, evidence) => {
    const key = `${scope}:${route}`;
    const previous = rows.get(key) ?? {scope, route, ...empty()};
    rows.set(key, {...previous, ...mergeCostEvidence(previous,evidence)});
  };
  const idOf = (node, fallback) => {
    const id = typeof node?.runId === 'string' ? `${node.runId}:0` : typeof node?.id === 'string' ? `${node.id}:0` : fallback;
    const file = typeof node?.sessionFile === 'string' ? `file:${node.sessionFile}` : undefined;
    const key = aliases.get(id) ?? (file && aliases.get(file)) ?? id;
    aliases.set(id,key);
    if (file) aliases.set(file,key);
    return key;
  };
  const recordNode = (node, fallback, depth = 0) => {
    if (!node || typeof node !== 'object') { truncated = true; return undefined; }
    if (depth >= 16) { truncated = true; return undefined; }
    const key = idOf(node,fallback);
    const nested = new Set();
    const visit = (list, prefix) => {
      if (!Array.isArray(list)) return;
      list.forEach((child,i) => { const id = recordNode(child,`${key}/${prefix}:${i}`,depth+1); if (id) nested.add(id); });
    };
    visit(node.children,'child');
    for (const [i,step] of (Array.isArray(node.steps) ? node.steps : []).entries()) visit(step?.children,`step:${i}`);
    const inclusive = valid(node.totalCost?.costUsd) ? node.totalCost.costUsd : undefined;
    const own = node.usage ? readCostEvidence(node.usage, node.provider ?? node.usage.cost?.provider) : undefined;
    const totalEvidence = node.totalCost?.costDetails ? readCostEvidence({costDetails:node.totalCost.costDetails}) : undefined;
    const value = inclusive ?? (own?.seen ? own.reported + own.estimated : undefined);
    const next = {key, own, inclusive, totalEvidence, nested, value, turns:node.usage?.turns, routes:node.usage?.costByModel,
      route:node.model ?? node.usage?.cost?.model ?? 'unattributed child', incomplete:node.accountingIncomplete === true};
    const old = nodes.get(key);
    const correction = own && old?.own && next.turns > 0 && next.turns === old.turns &&
      own.seen && own.estimated === 0 && !own.estimatedUsage && old.own.estimatedUsage && !own.unknown;
    const staleEstimate = own?.estimatedUsage && old?.own?.seen && !old.own.estimatedUsage && !old.own.unknown && next.turns > 0 && next.turns === old.turns;
    const quality = e => (e?.unknown ? 0 : 1) + (e?.seen && !e.estimatedUsage ? 2 : 0);
    if (!old || !staleEstimate && (correction || valid(value) && (!valid(old.value) || value > old.value || value === old.value && quality(own) >= quality(old.own)))) {
      next.routes ??= old?.routes;
      if (old) for (const child of old.nested) next.nested.add(child);
      nodes.set(key,next);
    } else for (const child of nested) old.nested.add(child);
    return key;
  };
  const record = (data, terminal) => {
    if (!data || typeof data !== 'object') return;
    const root = data.runId ?? data.asyncId ?? data.id;
    if (typeof root !== 'string') return;
    if (terminal) { pending.delete(root); settled.add(root); }
    else if (!settled.has(root)) pending.add(root);
    if (!Array.isArray(data.results)) return;
    data.results.forEach((node,i) => recordNode(node,`${root}:${node?.index ?? i}`));
  };
  for (const entry of entries) {
    const m = entry.type === 'message' ? entry.message : undefined;
    if (m?.role === 'toolResult' && m.toolName === 'subagent') record(m.details, !m.details?.asyncId && Array.isArray(m.details?.results) && m.details.results.length > 0);
    if (entry.type === 'custom' && entry.customType === 'subagent-cost-v1') record(entry.data,true);
    if (entry.type === 'custom' && entry.customType === 'subagent-lifecycle-v1') {
      const data = entry.data;
      // Terminal lifecycle without cost remains pending until accounting arrives.
      if (typeof data?.runId === 'string' && !settled.has(data.runId) && data.results?.some(r=>r.status !== 'queued')) pending.add(data.runId);
    }
    const isMain = m?.role === 'assistant';
    const isAuxiliary = m?.role === 'toolResult' && !['subagent','bg_wait'].includes(m.toolName) && m.usage || ['compaction','branch_summary'].includes(entry.type);
    if (!isMain && !isAuxiliary) continue;
    const id = m?.responseId ? `response:${m.provider}:${m.responseId}` : entry.id ? `entry:${entry.id}` : undefined;
    if (id && seenEntries.has(id)) continue;
    if (id) seenEntries.add(id);
    const usage = m ? m.usage : entry.usage;
    const evidence = readCostEvidence(usage, m?.provider ?? usage?.cost?.provider);
    if (isMain) main = mergeCostEvidence(main,evidence);
    else auxiliary = mergeCostEvidence(auxiliary,evidence);
    const provider = m?.provider ?? usage?.cost?.provider;
    const model = m?.model ?? usage?.cost?.model;
    addRow(isMain ? 'main' : 'auxiliary', provider && model ? `${provider}/${model}` : 'unattributed usage', evidence);
  }
  // Resolve inclusive tree snapshots into own charges. A shared descendant can
  // appear in both a workflow and a step; it is charged once for the session.
  const totals = new Map();
  const totalFor = (key, visiting = new Set()) => {
    if (totals.has(key)) return totals.get(key);
    if (visiting.has(key)) { truncated = true; return 0; }
    const node = nodes.get(key);
    if (!node) return 0;
    visiting.add(key);
    const nested = [...node.nested].reduce((sum,id)=>sum+totalFor(id,visiting),0);
    visiting.delete(key);
    const own = node.own?.seen ? node.own.reported + node.own.estimated : 0;
    const total = Math.max(node.inclusive ?? 0, own + nested);
    totals.set(key,total);
    return total;
  };
  for (const node of nodes.values()) {
    const nested = [...node.nested].reduce((sum,id)=>sum+totalFor(id),0);
    const total = totalFor(node.key);
    const ownTotal = Math.max(0,total - nested);
    let evidence = node.own ?? (node.totalEvidence ? {...node.totalEvidence} :
      readCostEvidence({cost:ownTotal > 0 ? ownTotal : node.inclusive}));
    if (!node.own && nested > 0) {
      // Inclusive provenance cannot establish each descendant's share.
      evidence = {reported:0,estimated:ownTotal,unknown:node.incomplete,subscription:evidence.subscription,seen:ownTotal > 0};
    } else if (ownTotal > evidence.reported + evidence.estimated) {
      evidence = {...evidence, estimated:evidence.estimated + ownTotal - evidence.reported - evidence.estimated, seen:true};
    }
    if (!node.own && node.inclusive === undefined && node.nested.size > 0) evidence = empty();
    evidence.unknown ||= node.incomplete;
    children = mergeCostEvidence(children,evidence);
    const routes = Array.isArray(node.routes) ? node.routes.filter(r=>typeof r?.route === 'string' && r.route.length <= 512).map(r=>({route:r.route,evidence:readCostEvidence({costDetails:r.evidence})})) : [];
    const routeTotal = routes.reduce((sum,r)=>sum+r.evidence.reported+r.evidence.estimated,0);
    if (routes.length && Math.abs(routeTotal - evidence.reported - evidence.estimated) < 1e-10)
      for (const r of routes) addRow('children',r.route,r.evidence);
    else addRow('children',node.route,evidence);
  }
  const evidence = mergeCostEvidence(mergeCostEvidence(main,auxiliary),children);
  // Current selection alone is not proof that this session used a subscription.
  evidence.subscription ||= subscription && !evidence.seen;
  evidence.unknown ||= pending.size > 0 || truncated;
  const total = evidence.reported + evidence.estimated;
  const amount = total > 0 && total < 0.000001 ? total.toExponential(3) : total > 0 && total < 1 ? total.toFixed(6) : total.toFixed(3);
  const formatted = evidence.seen ? `$${evidence.estimatedUsage ? '~' : ''}${amount}${evidence.unknown ? '+?' : ''}${evidence.subscription ? ' (sub)' : ''}` : evidence.subscription ? `sub${evidence.unknown ? '+?' : ''}` : '$?';
  return {total, ...evidence, main, children, auxiliary, pending:pending.size, rows:[...rows.values()], formatted};
}

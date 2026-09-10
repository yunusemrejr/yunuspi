import { sumResultsCost } from "../shared/utils.ts";
/** Persist compact accounting evidence, never prompts or tool output. Footer
 * owns summation/deduplication; this bridges detached completion into history. */
export function persistSubagentCost(pi: any, state: any, payload: any): void {
  if (!payload || payload.sessionId !== state.currentSessionId || payload.completionOwnerId !== state.completionOwnerId) return;
  const runId = payload.runId ?? payload.id;
  if (typeof runId !== 'string' || !Array.isArray(payload.results)) return;
  const results = payload.results.map((r: any, index: number) => ({
    index: r?.index ?? index,
    ...(typeof r?.runId === 'string' ? {runId:r.runId} : {}),
    ...(typeof r?.sessionFile === 'string' ? {sessionFile:r.sessionFile} : {}),
    usage: r?.usage ? {input:r.usage.input,output:r.usage.output,cacheRead:r.usage.cacheRead,cacheWrite:r.usage.cacheWrite,cost:r.usage.cost,turns:r.usage.turns} : undefined,
    totalCost: r?.usage ? {costUsd:Math.max(sumResultsCost([r]).costUsd, r.totalCost?.costUsd ?? 0)} : r?.totalCost ? {costUsd:r.totalCost.costUsd} : undefined,
  }));
  pi.appendEntry('subagent-cost-v1',{runId,results});
  try { (globalThis as any)[Symbol.for('yunus-pi.health.v1')]?.('subagent.accounted',{count:results.length}); } catch {}
}

/** Recover retained detached accounting by exact run IDs from this session;
 * no directory scan and no provider calls. Already persisted runs are skipped. */
export function restoreSubagentCosts(pi: any, state: any, entries: any[], lookup: (id: string) => any): void {
  const recorded = new Set(entries.filter(e => e.type === 'custom' && e.customType === 'subagent-cost-v1').map(e => e.data?.runId));
  const ids = new Set<string>();
  for (const entry of entries.slice(-2048).reverse()) {
    const m = entry.type === 'message' ? entry.message : undefined;
    const id = m?.role === 'toolResult' && m.toolName === 'subagent' ? m.details?.asyncId : undefined;
    if (typeof id === 'string' && !recorded.has(id)) ids.add(id);
    if (ids.size >= 128) break;
  }
  for (const id of ids) {
    const replay = lookup(id);
    if (replay?.sessionId !== state.currentSessionId) continue;
    persistSubagentCost(pi,state,{...replay.completion,sessionId:replay.sessionId,completionOwnerId:state.completionOwnerId});
  }
}

import { sumResultsCost } from "../shared/utils.ts";
/** Persist compact accounting evidence, never prompts or tool output. Footer
 * owns summation/deduplication; this bridges detached completion into history. */
export function persistSubagentCost(pi: any, state: any, payload: any): void {
  if (!payload || payload.sessionId !== state.currentSessionId || payload.completionOwnerId !== state.completionOwnerId) return;
  const runId = payload.runId ?? payload.id;
  if (typeof runId !== 'string' || !Array.isArray(payload.results)) return;
  const results = payload.results.map((r: any, index: number) => ({
    index: r?.index ?? index,
    ...(typeof r?.workflowKey === 'string' ? {workflowKey:r.workflowKey} : {}),
    ...(typeof r?.status === 'string' ? {status:r.status} : typeof r?.state === 'string' ? {status:r.state} : typeof r?.success === 'boolean' ? {status:r.success?'completed':'failed'} : payload.success === true ? {status:'completed'} : payload.results.length === 1 && ['complete','completed','failed','paused','stopped'].includes(payload.state) ? {status:payload.state} : {}),
    ...(typeof r?.exitCode === 'number' ? {exitCode:r.exitCode} : {}),
    ...(r?.error ? {error:'child-error'} : {}),
    ...(r?.stopped ? {stopped:true} : {}),
    ...(r?.interrupted ? {interrupted:true} : {}),
    ...(r?.detached ? {detached:true} : {}),
    ...(r?.timedOut ? {timedOut:true} : {}),
    ...(typeof r?.runId === 'string' ? {runId:r.runId} : {}),
    ...(typeof r?.sessionFile === 'string' ? {sessionFile:r.sessionFile} : {}),
    usage: r?.usage ? {input:r.usage.input,output:r.usage.output,cacheRead:r.usage.cacheRead,cacheWrite:r.usage.cacheWrite,cost:r.usage.cost,turns:r.usage.turns} : undefined,
    totalCost: r?.usage ? {costUsd:Math.max(sumResultsCost([r]).costUsd, r.totalCost?.costUsd ?? 0)} : r?.totalCost ? {costUsd:r.totalCost.costUsd} : undefined,
  }));
  pi.appendEntry('subagent-cost-v1',{runId,...(typeof payload.mode==='string'?{mode:payload.mode}:{}),...(typeof payload.state==='string'?{state:payload.state}:{}),...(typeof payload.success==='boolean'?{success:payload.success}:{}),...(payload.activityMetrics?{events:Object.fromEntries(['swarms','fusions','recoveries'].filter(k=>Number.isSafeInteger(payload.activityMetrics[k])&&payload.activityMetrics[k]>=0).map(k=>[k,payload.activityMetrics[k]]))}:{}),results});
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

/** Persist only lifecycle changes from the session-owned tracker. Queued workflow
 * plans are not child launches; the tracker supplies observed started rows. */
export function persistSubagentActivity(pi: any, state: any, payload: any): void {
  if (!payload || payload.sessionId !== state.currentSessionId || typeof payload.runId !== 'string' || !Array.isArray(payload.results)) return;
  const results = payload.results.map((r:any,index:number)=>({index:r.index??index,
    ...(typeof r.runId==='string'?{runId:r.runId}:{}),
    ...(typeof r.workflowKey==='string'?{workflowKey:r.workflowKey}:{}),
    status:['queued','running','complete','completed','failed','stopped','paused','detached','unknown'].includes(r.status)?r.status:'unknown',
  }));
  const data={runId:payload.runId,mode:payload.mode,state:payload.state,results,
    ...(payload.events?{events:Object.fromEntries(['swarms','fusions','recoveries'].filter(k=>Number.isSafeInteger(payload.events[k])&&payload.events[k]>=0).map(k=>[k,payload.events[k]]))}:{}),
    ...(Array.isArray(payload.parallelGroups)?{parallelGroups:payload.parallelGroups.map((g:any)=>({start:g.start,count:g.count}))}:{})};
  pi.appendEntry('subagent-lifecycle-v1',data);
}

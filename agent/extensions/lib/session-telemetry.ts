import {randomUUID} from 'node:crypto';
import {buildSessionReport} from './session-report.ts';
import {createMetricsPanel} from './metrics-panel.ts';
import {createHookLedger} from './hook-ledger.ts';
export const METRICS_SINK=Symbol.for('yunus-pi.metrics.v1');
export const METRICS_VIEW=Symbol.for('yunus-pi.metrics-view.v1');
/** Read-only ledger view; diagnostics only, never model-visible. */
export const HOOK_LEDGER_VIEW=Symbol.for('yunus-pi.hook-ledger.v1');
/** Process-wide: a /reload must not erase duplication evidence. */
const hookLedger=createHookLedger();
/** Numeric counters plus fixed-size content hashes only. Never persists hook arguments, output, thinking or message text. */
export function registerSessionTelemetry(pi:any) {
 let current:any,owner=0,dirty=false;
 const snapshot=()=>current?structuredClone(current.data):undefined;
 const flush=()=>{if(current&&dirty){pi.appendEntry('session-metrics-v1',snapshot());dirty=false;}};
 const start=(_event:any,ctx:any)=>{
  const epoch=++owner;
  current={id:ctx.sessionManager.getSessionId(),data:{version:2,segment:randomUUID(),startedAt:Date.now(),hooks:{},events:{}}};dirty=false;
  (globalThis as any)[METRICS_SINK]=(kind:string,data:any={})=>{
   if(kind==='hook'&&typeof data.hook==='string'&&typeof data.owner==='string'){
    hookLedger.record({owner:data.owner,hook:data.hook,eventId:typeof data.eventId==='string'?data.eventId:'',seq:Number.isSafeInteger(data.seq)?data.seq:0,changed:data.changed===true,blocked:data.blocked===true,error:data.error===true,addedChars:data.addedChars,removedChars:data.removedChars});
   }
   if(epoch!==owner||!current)return;
   if(kind==='hook'&&typeof data.hook==='string'&&typeof data.owner==='string'){
    const key=`${data.owner}:${data.hook}`.replace(/[^a-z0-9_.:/-]/gi,'_').slice(0,160);
    if(!current.data.hooks[key]&&Object.keys(current.data.hooks).length>=256)return;
    const h=current.data.hooks[key]??={calls:0,errors:0,ms:0,changed:0,removedChars:0,addedChars:0,charsChanged:0,tokensChanged:0};
    h.calls++;h.errors+=data.error===true?1:0;h.changed+=data.changed===true?1:0;
    for(const [key,value] of [['ms',data.ms],['removedChars',data.removedChars],['addedChars',data.addedChars],['charsChanged',data.charsChanged],['tokensChanged',data.tokensChanged]] as const)if(Number.isFinite(value)&&value>=0)h[key]+=value;
    // Safe diagnostic fingerprints: 8-hex hashes and positions only, no payload.
    // First-seen per hook key bounds transcript growth; revision tracks the
    // latest dispatch order and cacheAgeMs tracks the latest write age.
    for(const [key,value] of [['beforeHash',data.beforeHash],['afterHash',data.afterHash],['semanticHash',data.semanticHash]] as const)if(typeof value==='string'&&/^[0-9a-f]{8}$/.test(value)&&h[key]===undefined)h[key]=value;
    if(Number.isSafeInteger(data.changedAt)&&data.changedAt>=0&&data.changedAt<=20000&&(h.changedAt===undefined||data.changedAt<h.changedAt))h.changedAt=data.changedAt;
    if(Number.isSafeInteger(data.revision)&&data.revision>=0)h.revision=data.revision;
    if(Number.isFinite(data.at)&&data.at>=current.data.startedAt)h.cacheAgeMs=Math.max(h.cacheAgeMs??0,data.at-current.data.startedAt);
   }else if(['swarms','fusions','recoveries','aborted'].includes(kind))current.data.events[kind]=(current.data.events[kind]||0)+1;
   else return;
   dirty=true;
  };
  (globalThis as any)[METRICS_VIEW]=(id:string)=>id===current?.id?snapshot():undefined;
  (globalThis as any)[HOOK_LEDGER_VIEW]=()=>hookLedger.snapshot();
 };
 pi.on('session_start',start);pi.on('session_switch',start);
 for(const hook of ['agent_end','session_before_compact','session_before_switch'])pi.on(hook,flush);
 pi.on('session_shutdown',()=>{flush();owner++;current=undefined;});
 pi.registerCommand('metrics',{description:'Session tools, errors, agents, swarms, fusions, skills, hooks and measured context reductions',handler:async(_args:any,ctx:any)=>{
  const entries=ctx.sessionManager.getEntries();
  const report=buildSessionReport(entries,ctx.sessionManager.getBranch?.()??entries,snapshot(),pi.getActiveTools?.());
  if(!ctx.hasUI)return;
  await ctx.ui.custom((tui:any,theme:any,_keys:any,done:any)=>{
   return createMetricsPanel(report.lines,tui,theme,done);
  }, {overlay:true, overlayOptions:{width:"100%",maxHeight:"100%",anchor:"top-left"}});
 }});
 pi.registerCommand('hook-audit',{description:'Hook execution ledger: duplicate dispatch, missing paired execution, reload duplication and first prefix mutators (numeric only)',handler:async(_args:any,ctx:any)=>{
  const s=hookLedger.snapshot();
  const lines=[
   'Hook execution ledger — numeric accounting only; no arguments or output are stored.',
   `Observed handler invocations: ${s.records}; dispatches tracked: ${s.dispatches} (bounded ring); paired tool calls: ${s.expectedPairs}.`,
   `Execution multiplicity per (extension, event, eventId): once ${s.multiplicity.once}, twice ${s.multiplicity.twice}, 3x+ ${s.multiplicity.thrice}.`,
   s.duplicated.length?'Duplicate executions (owner | event | eventId | count):': 'Duplicate executions: none observed in the retained window.',
   ...s.duplicated.map(d=>`  ${d.owner} | ${d.hook} | ${d.eventId} | ${d.count}x`),
   s.missingResults.length?'tool_call handled without the paired tool_result (owner(s)):':'Missing paired executions: none observed.',
   ...s.missingResults.map(m=>`  ${m.toolCallId} — ${m.owners.join(', ')}`),
   s.suspectedStale.length?'Reload/stale-listener suspects (2x+ across many dispatches):':'Reload/stale-listener suspects: none observed.',
   ...s.suspectedStale.map(v=>`  ${v.owner} | ${v.hook} | ${v.events} dispatches, max ${v.maxCount}x`),
   s.firstMutators.length?'First mutation per dispatch, by (event, owner):':'First mutation attribution: none observed.',
   ...s.firstMutators.slice(0,10).map(f=>`  ${f.hook} | ${f.owner} | ${f.dispatches} dispatch(es)`),
   'A once-only count is not proof of useful work; duplicates and missing pairs are the actionable signals.',
  ];
  if(ctx.hasUI){ctx.ui.notify(lines.join('\n'),'info');return;}
  ctx.ui?.notify?.(lines.join('\n'),'info');
 }});
 return {snapshot,flush};
}

import {randomUUID} from 'node:crypto';
import {buildSessionReport} from './session-report.ts';
import {createMetricsPanel} from './metrics-panel.ts';
export const METRICS_SINK=Symbol.for('yunus-pi.metrics.v1');
export const METRICS_VIEW=Symbol.for('yunus-pi.metrics-view.v1');
/** Numeric counters only. Never persists hook arguments, output or thinking. */
export function registerSessionTelemetry(pi:any) {
 let current:any,owner=0,dirty=false;
 const snapshot=()=>current?structuredClone(current.data):undefined;
 const flush=()=>{if(current&&dirty){pi.appendEntry('session-metrics-v1',snapshot());dirty=false;}};
 const start=(_event:any,ctx:any)=>{
  const epoch=++owner;
  current={id:ctx.sessionManager.getSessionId(),data:{version:2,segment:randomUUID(),startedAt:Date.now(),hooks:{},events:{}}};dirty=false;
  (globalThis as any)[METRICS_SINK]=(kind:string,data:any={})=>{
   if(epoch!==owner||!current)return;
   if(kind==='hook'&&typeof data.hook==='string'&&typeof data.owner==='string'){
    const key=`${data.owner}:${data.hook}`.replace(/[^a-z0-9_.:/-]/gi,'_').slice(0,160);
    if(!current.data.hooks[key]&&Object.keys(current.data.hooks).length>=256)return;
    const h=current.data.hooks[key]??={calls:0,errors:0,ms:0,changed:0,removedChars:0,addedChars:0};
    h.calls++;h.errors+=data.error===true?1:0;h.changed+=data.changed===true?1:0;
    for(const [key,value] of [['ms',data.ms],['removedChars',data.removedChars],['addedChars',data.addedChars]] as const)if(Number.isFinite(value)&&value>=0)h[key]+=value;
   }else if(['swarms','fusions','recoveries'].includes(kind))current.data.events[kind]=(current.data.events[kind]||0)+1;
   else return;
   dirty=true;
  };
  (globalThis as any)[METRICS_VIEW]=(id:string)=>id===current?.id?snapshot():undefined;
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
 return {snapshot,flush};
}

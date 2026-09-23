import { sessionObservability } from './lib/session-observability.ts';
import {registerSessionTelemetry} from './lib/session-telemetry.ts';
import {getAgentDir,guardianOwnerForSession,relayIntelligenceUsageFromChild} from '@yunuspi/coding-agent';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createHealthLog,HEALTH_SINK} from './lib/health-log.ts';
import {sharedCapabilityHealth} from './lib/capability-health.ts';
import {createActivityIndicators,describeIntelligenceActivity,skillNameFromPath} from './lib/activity-indicators.ts';
import {createHelperUsageLedger,HELPER_USAGE_ENTRY,HELPER_USAGE_VIEW} from './lib/helper-usage.ts';
const childRelayNames:Record<string,'JEV'|'Needle3'|'FuzzyML'|'Kompress'|'Smol'|'retrieval'|'Neural ranker'|'Intent classifier'|'WASM source check'|'Deterministic selection'>={
 'JEV':'JEV','Needle3':'Needle3','Fuzzy matching':'FuzzyML','Kompress':'Kompress','Smol':'Smol',
 'Retrieval intelligence':'retrieval','Neural ranker':'Neural ranker','Intent classifier':'Intent classifier','WASM source check':'WASM source check','Deterministic selection':'Deterministic selection',
};
export default function healthLog(pi:any) {
 registerSessionTelemetry(pi);
 const activity=createActivityIndicators((message,options)=>pi.sendMessage(message,options));
 let log:ReturnType<typeof createHealthLog>|undefined;
 let timer:ReturnType<typeof setInterval>|undefined;
 const calls=new Map<string,number>();
 let activeSessionId:string|undefined;
 let activeSessionOwner:object|undefined;
 let helperUsage:ReturnType<typeof createHelperUsageLedger>|undefined,helperView:any;
 const flushHelperUsage=()=>{try{helperUsage?.flush(data=>pi.appendEntry(HELPER_USAGE_ENTRY,data));}catch{/* Keep the ledger dirty for retry; diagnostics never interrupt lifecycle cleanup. */}};
 let epoch=0, sink:typeof emit|undefined;
 const childPending=new Map<string,Parameters<typeof relayIntelligenceUsageFromChild>[0]>();
 let childFlushPending=false;
 const relayChildUse=(kind:string,data:Record<string,unknown>)=>{
  if(process.env.PI_SUBAGENT_CHILD!=='1'||!activeSessionId)return;
  const activity=describeIntelligenceActivity(kind,data),name=activity?childRelayNames[activity.label]:undefined;
  if(!name||kind==='ml.smol.offer')return;
  const ownerId=guardianOwnerForSession(activeSessionId,activeSessionOwner);
  if(!ownerId)return;
  const stage=kind==='ml.evidence.returned'?'returned':kind==='ml.evidence.delivered'?'delivered':data.cached===true?'cached':activity!.status!=='ok'?'skipped':kind==='ml.needle.call'||kind==='ml.jev.used'||kind==='ml.smol.inference'||kind==='ml.mini.select'||kind==='ml.wasm.completed'?'result':'applied';
  const source=name==='JEV'?'remote':name==='Needle3'||name==='WASM source check'?'wasm':'local';
  const key=[name,stage,source].join(':');
  const pending=childPending.get(key);
  if(pending){pending.count=(pending.count??0)+1;if(activity!.ms!==undefined)pending.durationMs=(pending.durationMs??0)+activity!.ms;if(typeof data.savedChars==='number'&&Number.isFinite(data.savedChars)&&data.savedChars>=0)pending.savedChars=(pending.savedChars??0)+data.savedChars;}
  else if(childPending.size<64)childPending.set(key,{name,sessionId:activeSessionId,ownerId,stage,source,count:1,durationMs:activity!.ms,savedChars:typeof data.savedChars==='number'?data.savedChars:undefined});
  if(childFlushPending)return;
  childFlushPending=true;
  const generation=epoch;
  queueMicrotask(()=>{
   if(generation!==epoch)return;
   childFlushPending=false;
   const entries=[...childPending.values()];childPending.clear();
   for(const entry of entries)try{relayIntelligenceUsageFromChild(entry);}catch{/* display-only diagnostics never interrupt helpers */}
  });
 };
 const emit=(kind:string,data:Record<string,unknown>={})=>{helperUsage?.note(kind,data);log?.record(kind,data);activity.note(kind,data);relayChildUse(kind,data);};
 let warn:((message:string)=>void)|undefined;
 let writeWarning=false;
 const flush=async(closing=false)=>{
  const current=log;
  if(current&&!(await (closing?current.close():current.flush()))&&current===log&&!writeWarning){
   writeWarning=true;
   try{warn?.(closing?'Health log could not be saved before closing; buffered diagnostics may be unavailable.':'Health log could not be written; recent events remain buffered and will be retried.');}catch{/* diagnostics must not interrupt the session */}
  }
 };
 const start=async(_:unknown,ctx:any)=>{
  const generation=++epoch;
  if(timer)clearInterval(timer);
  await flush(true);
  if(generation!==epoch)return;
  calls.clear();activity.reset();childPending.clear();childFlushPending=false;
  const id=ctx.sessionManager?.getSessionId?.();
  activeSessionId=typeof id==='string'?id:undefined;
  activeSessionOwner=ctx.sessionManager;
  helperUsage=createHelperUsageLedger();
  sessionObservability()[HELPER_USAGE_VIEW]=helperView=(sessionId:string)=>sessionId===activeSessionId?helperUsage?.snapshot():undefined;
  warn=message=>ctx.ui?.notify?.(message,'warning');writeWarning=false;
  log=createHealthLog(path.join(getAgentDir(),'logs/health'),activeSessionId??'unknown');
  sink=(kind,data={})=>{if(generation===epoch)emit(kind,data);};
  sessionObservability()[HEALTH_SINK]=sink;
  emit('session.start');timer=setInterval(()=>{void flush();},5000);timer.unref();
 };
 pi.on('session_start',start);pi.on('session_switch',start);
 for(const hook of ['agent_start','agent_end','turn_start','turn_end','session_compact','model_select'])pi.on(hook,()=>{emit('hook',{hook});if(hook==='agent_end')void flush();if(hook==='agent_end'||hook==='turn_end')flushHelperUsage();});
 pi.on('session_before_switch',flushHelperUsage);pi.on('session_before_compact',flushHelperUsage);
 pi.on('tool_call',(e:any)=>{if(calls.size<1024)calls.set(e.toolCallId,Date.now());emit('tool.call',{tool:e.toolName});});
 pi.on('tool_result',(e:any)=>{
  const began=calls.get(e.toolCallId);calls.delete(e.toolCallId);
  emit('tool.result',{tool:e.toolName,isError:!!e.isError,durationMs:began===undefined?undefined:Date.now()-began});
  // Shadow capability health: observations accumulate for audits; nothing gates yet.
  if(typeof e.toolName==='string'&&e.toolName)sharedCapabilityHealth().observe(`tool:${e.toolName}`,{ok:e.isError!==true});
  if(e.toolName==='read'&&typeof e.input?.path==='string'&&/SKILL\.md$/.test(e.input.path)){const skill=skillNameFromPath(e.input.path)??createHash('sha256').update(e.input.path).digest('hex').slice(0,16),partial=!!e.input.limit||e.input.offset>1||!!e.details?.truncation?.truncated;emit('skill.read',{skill,isError:!!e.isError,partial});sharedCapabilityHealth().observe(`skill:${skill}`,{ok:e.isError!==true,useful:e.isError!==true&&!partial});}
  if(e.toolName==='subagent')emit('subagent.result',{isError:!!e.isError,count:e.details?.results?.length??0});
 });
 pi.on('message_end',(e:any)=>{if(e.message?.role==='assistant')emit('inference.end',{outcome:e.message.stopReason,inputTokens:e.message.usage?.input,outputTokens:e.message.usage?.output});});
 pi.on('session_shutdown',async()=>{
  if(timer)clearInterval(timer);
  try{emit('session.end');flushHelperUsage();}finally{
   epoch++;childPending.clear();childFlushPending=false;activity.dispose();
   if(sessionObservability()[HEALTH_SINK]===sink)delete sessionObservability()[HEALTH_SINK];
   if(sessionObservability()[HELPER_USAGE_VIEW]===helperView)delete sessionObservability()[HELPER_USAGE_VIEW];
   helperUsage=undefined;
   await flush(true);
  }
 });
}

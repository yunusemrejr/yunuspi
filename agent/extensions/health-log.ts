import { sessionObservability } from './lib/session-observability.ts';
import {registerSessionTelemetry} from './lib/session-telemetry.ts';
import {getAgentDir,guardianOwnerForSession,relayIntelligenceUsageFromChild} from '@yunuspi/coding-agent';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createHealthLog,HEALTH_SINK} from './lib/health-log.ts';
import {sharedCapabilityHealth} from './lib/capability-health.ts';
import {createActivityIndicators,intelligenceUseForEvent,skillNameFromPath} from './lib/activity-indicators.ts';
const childRelayNames:Record<string,'JEV'|'Needle3'|'FuzzyML'|'Kompress'|'Smol'|'retrieval'|'Neural ranker'|'Intent classifier'>={
 'JEV':'JEV','Needle3':'Needle3','Fuzzy matching':'FuzzyML','Kompress':'Kompress','Smol':'Smol',
 'Retrieval intelligence':'retrieval','Neural ranker':'Neural ranker','Intent classifier':'Intent classifier',
};
export default function healthLog(pi:any) {
 registerSessionTelemetry(pi);
 const activity=createActivityIndicators((message,options)=>pi.sendMessage(message,options));
 let log:ReturnType<typeof createHealthLog>|undefined;
 let timer:ReturnType<typeof setInterval>|undefined;
 const calls=new Map<string,number>();
 let activeSessionId:string|undefined;
 let activeSessionOwner:object|undefined;
 let epoch=0, sink:typeof emit|undefined;
 const childRelayedAt=new Map<string,number>();
 const relayChildUse=(kind:string,data:Record<string,unknown>)=>{
  if(process.env.PI_SUBAGENT_CHILD!=='1'||!activeSessionId)return;
  const component=intelligenceUseForEvent(kind,data),name=component?childRelayNames[component]:undefined;
  if(!name)return;
  const now=Date.now();if(now-(childRelayedAt.get(component)??-Infinity)<60_000)return;
  try{
   const ownerId=guardianOwnerForSession(activeSessionId,activeSessionOwner);
   if(ownerId&&relayIntelligenceUsageFromChild({name,sessionId:activeSessionId,ownerId}))childRelayedAt.set(component,now);
  }catch{/* child observability must not interrupt helper execution */}
 };
 const emit=(kind:string,data:Record<string,unknown>={})=>{log?.record(kind,data);activity.note(kind,data);relayChildUse(kind,data);};
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
  if(timer)clearInterval(timer);await flush(true);calls.clear();activity.reset();childRelayedAt.clear();
  const id=ctx.sessionManager?.getSessionId?.();
  activeSessionId=typeof id==='string'?id:undefined;
  activeSessionOwner=ctx.sessionManager;
  warn=message=>ctx.ui?.notify?.(message,'warning');writeWarning=false;
  log=createHealthLog(path.join(getAgentDir(),'logs/health'),activeSessionId??'unknown');
  sink=(kind,data={})=>{if(generation===epoch)emit(kind,data);};
  sessionObservability()[HEALTH_SINK]=sink;
  emit('session.start');timer=setInterval(()=>{void flush();},5000);timer.unref();
 };
 pi.on('session_start',start);pi.on('session_switch',start);
 for(const hook of ['agent_start','agent_end','turn_start','turn_end','session_compact','model_select'])pi.on(hook,()=>{emit('hook',{hook});if(hook==='agent_end')void flush();});
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
 pi.on('session_shutdown',async()=>{if(timer)clearInterval(timer);emit('session.end');epoch++;await flush(true);activity.dispose();if(sessionObservability()[HEALTH_SINK]===sink)delete sessionObservability()[HEALTH_SINK];});
}

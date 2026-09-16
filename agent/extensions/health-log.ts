import {registerSessionTelemetry} from './lib/session-telemetry.ts';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createHealthLog,HEALTH_SINK} from './lib/health-log.ts';
import {sharedCapabilityHealth} from './lib/capability-health.ts';
import {createActivityIndicators,skillNameFromPath} from './lib/activity-indicators.ts';
export default function healthLog(pi:any) {
 registerSessionTelemetry(pi);
 const activity=createActivityIndicators((message,options)=>pi.sendMessage(message,options));
 let log:ReturnType<typeof createHealthLog>|undefined;
 let timer:ReturnType<typeof setInterval>|undefined;
 const calls=new Map<string,number>();
 const emit=(kind:string,data:Record<string,unknown>={})=>{log?.record(kind,data);activity.note(kind,data);};
 const start=async(_:unknown,ctx:any)=>{
  if(timer)clearInterval(timer);await log?.close();calls.clear();activity.reset();
  const id=ctx.sessionManager?.getSessionId?.();
  log=createHealthLog(path.join(os.homedir(),'.pi/agent/logs/health'),typeof id==='string'?id:'unknown');
  (globalThis as any)[HEALTH_SINK]=emit;
  emit('session.start');timer=setInterval(()=>{void log?.flush();},5000);timer.unref();
 };
 pi.on('session_start',start);pi.on('session_switch',start);
 for(const hook of ['agent_start','agent_end','turn_start','turn_end','session_compact','model_select'])pi.on(hook,()=>{emit('hook',{hook});if(hook==='agent_end')void log?.flush();});
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
 pi.on('session_shutdown',async()=>{if(timer)clearInterval(timer);emit('session.end');await log?.close();activity.dispose();if((globalThis as any)[HEALTH_SINK]===emit)delete (globalThis as any)[HEALTH_SINK];});
}

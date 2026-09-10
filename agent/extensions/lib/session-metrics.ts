// @ts-nocheck
/** Pure, transcript-backed accounting. Embedded verbatim in both footer builds.
 * Cumulative snapshots are replaced by segment ID, never added twice. */
export function collectSessionMetrics(entries, live) {
 const m={responses:0,toolCalls:0,toolResults:0,errors:0,modelErrors:0,blocked:0,compactions:0,agents:0,agentFailures:0,agentOutcomeUnknown:0,swarms:0,fusions:0,recoveries:0,tools:{},skillsRead:[],skillsRouted:[],input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0,childTokens:0,hooks:{},hookCalls:0,hookErrors:0,trimmedChars:0,addedChars:0,telemetry:false};
 const calls=new Set(), results=new Set(), agents=new Map(), segments=new Map(), read=new Set(), routed=new Set(), groups=[],nativeGroups=new Set(),legacyFusions=[];
 const number=v=>Number.isFinite(v)&&v>=0?v:0;
 const name=p=>String(p).replace(/\\/g,'/').split('/').filter(Boolean).slice(-2,-1)[0]||String(p);
 const text=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(p=>p?.type==='text').map(p=>p.text).join('\n'):'';
 const usage=u=>{if(u)for(const k of ['input','output','cacheRead','cacheWrite','reasoning'])m[k]+=number(u[k]);};
 const record=(d,fallback)=>{
  if(!d||typeof d!=='object')return;
  const root=d.runId||d.asyncId||d.id||fallback;
  if(!root)return;
  if(d.mode==='parallel'&&d.results?.length>1)nativeGroups.add(root);
  for(const [i,r] of (Array.isArray(d.results)?d.results:[]).entries()) {
   if(!r||typeof r!=='object')continue;
   const key=r.runId||`${root}:${r.index??i}`,old=agents.get(key)||{};
   const tokens=['input','output','cacheRead','cacheWrite'].reduce((s,k)=>s+number(r.usage?.[k]),0);
   const failed=!!(r.error||r.stopped||r.timedOut||r.exitCode!==undefined&&r.exitCode!==0);
   const known=failed||r.exitCode===0;
   agents.set(key,{tokens:Math.max(old.tokens||0,tokens),failed:known?failed:old.failed,known:known||old.known});
  }
 };
 for(const [i,e] of entries.entries()) {
  const msg=e.type==='message'?e.message:undefined;
  if(msg?.role==='assistant') {
   m.responses++;usage(msg.usage);if(msg.stopReason==='error')m.modelErrors++;
   for(const c of msg.content??[])if(c.type==='toolCall'&&!calls.has(c.id??`call:${i}`)){calls.add(c.id??`call:${i}`);m.toolCalls++;}
  }
  if(msg?.role==='toolResult'&&!results.has(msg.toolCallId??`result:${i}`)) {
   results.add(msg.toolCallId??`result:${i}`);m.toolResults++;m.tools[msg.toolName]=(m.tools[msg.toolName]||0)+1;
   if(msg.isError || msg.toolName==='web_search' && msg.details?.queryCount>0 && msg.details?.successfulQueries===0){m.errors++;if(/^Blocked:/.test(text(msg.content)))m.blocked++;}
   if(msg.toolName==='subagent')record(msg.details,msg.toolCallId);
  }
  if(e.type==='compaction'){m.compactions++;usage(e.usage);}
  if(e.type==='branch_summary')usage(e.usage);
  if(e.type==='custom'&&e.customType==='subagent-cost-v1')record(e.data,e.id);
  if(e.type==='custom'&&e.customType==='relevant-guidance'){
   for(const p of e.data?.read??[])read.add(name(p));
   for(const p of e.data?.shown??[])if(p.startsWith('skill:'))routed.add(name(p));
  }
  if(e.type==='custom'&&e.customType==='provider-recovery'&&/^Automatic free read-only group:/.test(e.data?.text??''))groups.push({id:e.id??`legacy:${i}`,time:Date.parse(e.timestamp)||0});

  if(e.type==='custom_message'&&e.customType==='autonomous-free-fusion')legacyFusions.push({id:e.id??`fusion:${i}`,time:Date.parse(e.timestamp)||0});
  if(e.type==='custom'&&e.customType==='session-metrics-v1'&&typeof e.data?.segment==='string')segments.set(e.data.segment,e.data);
 }
 if(live?.segment)segments.set(live.segment,live);
 for(const s of segments.values()){
  m.telemetry=true;
  for(const [k,v] of Object.entries(s.hooks??{})){
   const h=m.hooks[k]??={calls:0,errors:0,ms:0,changed:0,removedChars:0,addedChars:0};
   for(const key of Object.keys(h))h[key]+=number(v[key]);
  }
  for(const k of ['swarms','fusions','recoveries'])m[k]+=number(s.events?.[k]);
 }
 // Legacy auto-groups are only inferred when no corresponding new event exists.
 const measuredSince=Math.min(...[...segments.values()].map(s=>Number.isFinite(s.startedAt)?s.startedAt:Infinity));
 m.swarms+=new Set(groups.filter(g=>g.time<measuredSince).map(g=>g.id)).size+nativeGroups.size;
 m.fusions+=new Set(legacyFusions.filter(g=>g.time<measuredSince).map(g=>g.id)).size;
 for(const h of Object.values(m.hooks)){m.hookCalls+=h.calls;m.hookErrors+=h.errors;m.trimmedChars+=h.removedChars;m.addedChars+=h.addedChars;}
 for(const a of agents.values()){m.agents++;m.childTokens+=a.tokens;if(a.failed)m.agentFailures++;else if(!a.known)m.agentOutcomeUnknown++;}
 m.skillsRead=[...read].sort();m.skillsRouted=[...routed].sort();
 const prompt=m.input+m.cacheRead+m.cacheWrite;m.cacheRate=prompt>0?100*m.cacheRead/prompt:null;
 const compact=n=>n>=1e6?`${(n/1e6).toFixed(2)}M`:n>=1e3?`${(n/1e3).toFixed(1)}k`:String(n);
 m.footer=[`Swarms ${m.swarms}`,`Fusions ${m.fusions}`,`Agents ${m.agents}`,`Tools ${m.toolResults}`,`Errors ${m.errors+m.modelErrors}`,`Skills ${m.skillsRead.length}`,`Hooks ${m.telemetry?compact(m.hookCalls):'?'}`,`Compact ${m.compactions}`];
 m.detail=[
  'Session activity (all retained entries; includes pre-compaction history)',
  `Swarms / parallel groups: ${m.swarms}; fusions: ${m.fusions}; recovery plans: ${m.telemetry?m.recoveries:'unknown before telemetry'}`,
  `Distinct child agents: ${m.agents}; failed: ${m.agentFailures}; unknown outcome: ${m.agentOutcomeUnknown}`,
  `Parent model responses: ${m.responses}; tool calls: ${m.toolCalls}; tool results: ${m.toolResults}`,
  `Parent errors: ${m.errors} tool + ${m.modelErrors} model; blocked tools: ${m.blocked}; hook errors: ${m.telemetry?m.hookErrors:'unknown'}`,
  `Compactions: ${m.compactions}; recorded child token traffic: ${m.childTokens.toLocaleString('en-US')}`,
  `Parent + compaction token traffic: input ${m.input.toLocaleString('en-US')}, output ${m.output.toLocaleString('en-US')}, cached reads ${m.cacheRead.toLocaleString('en-US')}, cache writes ${m.cacheWrite.toLocaleString('en-US')}`,
  `Reported reasoning tokens: ${m.reasoning.toLocaleString('en-US')} (a subset of output, not additional traffic)`,
  `Cumulative prompt cache reuse: ${m.cacheRate===null?'unknown':m.cacheRate.toFixed(2)+'%'}; cached tokens were reused, not removed from traffic.`,
  m.telemetry?`Measured hook payload reduction: ${m.trimmedChars.toLocaleString('en-US')} characters (~${Math.round(m.trimmedChars/4).toLocaleString('en-US')} tokens at 4 chars/token); additions: ${m.addedChars.toLocaleString('en-US')} chars. Counts each observed projection, not unique tokens or billed savings.`:'Historical harness token savings: unknown; context payload reductions were not recorded.',
  `Skills routed: ${m.skillsRouted.join(', ')||'none recorded'}`,
  `Skills fully read: ${m.skillsRead.join(', ')||'none recorded'}`,
  'Tools: '+Object.entries(m.tools).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${v}`).join(', '),
  m.telemetry?'Measured extension hooks (since instrumentation):':'Extension hook invocations before instrumentation: unknown. Health logs contain lifecycle events only.',
  ...Object.entries(m.hooks).sort((a,b)=>b[1].calls-a[1].calls).map(([k,v])=>`${k}: ${v.calls} calls, ${v.errors} errors, ${Math.round(v.ms)} ms, ${v.changed} changed results`),
 ];
 return m;
}

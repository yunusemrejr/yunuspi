// @ts-nocheck
/** Pure, transcript-backed accounting. Embedded verbatim in both footer builds.
 * Cumulative snapshots are replaced by segment ID, never added twice. */
export function collectSessionMetrics(entries, live) {
 const m={responses:0,toolCalls:0,toolResults:0,errors:0,modelErrors:0,blocked:0,compactions:0,agents:0,agentFailures:0,agentsActive:0,agentsCompleted:0,agentsStopped:0,agentsPaused:0,agentOutcomeUnknown:0,workflows:0,workflowFailures:0,workflowsActive:0,workflowOutcomeUnknown:0,swarms:0,fusions:0,legacySwarms:0,legacyFusions:0,recoveries:0,tools:{},skillsRead:[],skillsPartial:[],skillsRouted:[],input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0,childTokens:0,hooks:{},hookCalls:0,hookExcluded:0,hookChanged:0,hookErrors:0,trimmedChars:0,addedChars:0,telemetry:false};
 const calls=new Set(), results=new Set(), agents=new Map(), workflows=new Map(), segments=new Map(), activities=new Map(), read=new Set(), partial=new Set(), routed=new Set(), callInputs=new Map(), aliases=new Map(), groups=[],nativeGroups=new Set(),legacyFusions=[];
 const number=v=>Number.isFinite(v)&&v>=0?v:0;
 const name=p=>String(p).replace(/\\/g,'/').split('/').filter(Boolean).slice(-2,-1)[0]||String(p);
 const text=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(p=>p?.type==='text').map(p=>p.text).join('\n'):'';
 const usage=u=>{if(u)for(const k of ['input','output','cacheRead','cacheWrite','reasoning'])m[k]+=number(u[k]);};
 const terminal=new Set(['completed','failed','stopped']);
 const hookNames=new Set(['input','before_agent_start','context','before_provider_request','tool_call','tool_result','session_before_switch','session_before_fork','session_before_compact','session_before_tree']);
 const normalizedState=v=>v==='complete'?'completed':v==='rejected'?'failed':['queued','running','completed','failed','stopped','paused','detached'].includes(v)?v:'unknown';
 // Older automatic-helper ledgers used a wrapper ID and omitted the native
 // ID. Repair only exact run-0 session paths naming an observed single run;
 // never infer identity from model, timing, status, or a neighboring entry.
 const nativeSingles=new Set(entries.filter(e=>e.type==='custom'&&e.customType==='subagent-lifecycle-v1'&&e.data?.mode==='single').map(e=>e.data.runId));
 const helperRuns=new Map();
 for(const e of entries){
  const d=e.type==='custom'&&e.customType==='subagent-cost-v1'?e.data:undefined;
  if(!d||!/^(?:auto-assist|quality-review|skill-discovery|scope-council)-/.test(d.runId)||d.results?.length!==1)continue;
  const r=d.results[0];
  if(!r||r.runId||(r.index??0)!==0||typeof r.sessionFile!=='string'||r.sessionFile.length>4096||r.sessionFile.split('/').some(p=>p==='.'||p==='..'))continue;
  const id=r.sessionFile.match(/^\/.*\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/run-0\/session\.jsonl$/)?.[1];
  if(id&&nativeSingles.has(id))helperRuns.set(d.runId,helperRuns.has(d.runId)&&helperRuns.get(d.runId)!==id?null:id);
 }
 const record=(d,fallback,accounted=false)=>{
  if(!d||typeof d!=='object')return;
  const root=d.runId||d.asyncId||d.id||fallback;
  if(!root)return;
  if(d.mode==='workflow'||workflows.has(root)){
   const old=workflows.get(root);let status=normalizedState(d.state??d.workflowChildren?.workflowState??(d.success===true?'completed':d.success===false?'failed':undefined));
   if(status==='unknown')status=accounted?'finished-unknown':d.asyncId?'queued':old??'unknown';
   if(terminal.has(old)&&!terminal.has(status))status=old;
   workflows.set(root,status);
  }
  if(d.events){const previous=activities.get(root)??{};activities.set(root,Object.fromEntries(['swarms','fusions','recoveries'].map(k=>[k,Math.max(number(previous[k]),number(d.events[k]))])));}
  const workflow=Array.isArray(d.workflowChildren?.children)?d.workflowChildren.children:undefined;
  let rows=workflow??(Array.isArray(d.results)?d.results:[]);
  // A detached single launch has no completed results yet. Count its accepted
  // child immediately; never count a workflow controller as a child.
  if(!rows.length&&d.mode==='single'&&d.asyncId)rows=[{index:0,status:d.state??'queued'}];
  if(d.mode==='parallel'&&rows.filter(r=>!['pending'].includes(r?.status??r?.state)&&((r?.status??r?.state)&&normalizedState(r.status??r.state)!=='unknown'||r?.runId||r?.exitCode!==undefined||r?.usage)).length>1)nativeGroups.add(root);
  for(const group of d.mode==='parallel'?[]:d.parallelGroups??[])if(group.count>1&&rows.filter((r,i)=>(r?.index??i)>=group.start&&(r?.index??i)<group.start+group.count&&!['pending','unknown'].includes(r?.status??r?.state??'unknown')).length>1)nativeGroups.add(`${root}:group:${group.start}`);
  for(const [i,r] of rows.entries()) {
   if(!r||typeof r!=='object'||r.status==='pending'||r.state==='pending')continue;
   const ids=[`${root}:${r.workflowKey??r.childId??r.index??i}`];
   const nativeId=r.runId??(rows.length===1&&(r.index??i)===0?helperRuns.get(root):undefined);
   if(nativeId)ids.push(`${nativeId}:0`);
   const keys=[...new Set(ids.map(id=>aliases.get(id)??id))];
   const key=keys.find(k=>agents.has(k))??keys[0];
   let old=agents.get(key)||{};
   for(const duplicate of keys)if(duplicate!==key&&agents.has(duplicate)){
    const other=agents.get(duplicate);old={...other,...old,status:terminal.has(old.status)?old.status:terminal.has(other.status)?other.status:old.status??other.status,tokens:Math.max(old.tokens||0,other.tokens||0)};agents.delete(duplicate);
    for(const [alias,target] of aliases)if(target===duplicate)aliases.set(alias,key);
   }
   for(const id of ids)aliases.set(id,key);
   const tokens=['input','output','cacheRead','cacheWrite'].reduce((s,k)=>s+number(r.usage?.[k]),0);
   let status=normalizedState(r.status??r.state);
   if(r.stopped||status==='stopped')status='stopped';
   else if(r.interrupted||status==='paused')status='paused';
   else if(r.detached||status==='detached')status='detached';
   else if(r.error||r.timedOut||r.exitCode!==undefined&&r.exitCode!==0)status='failed';
   else if(r.exitCode===0)status='completed';
   // Late start receipts/accounting without an outcome cannot resurrect a
   // completed child. Unknown old metadata remains visibly unknown.
   if(status==='unknown'&&(r.usage||r.sessionFile)&&['queued','running','detached'].includes(old.status))status='finished-unknown';
   else if(status==='unknown'||terminal.has(old.status)&&!terminal.has(status))status=old.status??status;
   agents.set(key,{tokens:Math.max(old.tokens||0,tokens),status});
  }
 };

 for(const [i,e] of entries.entries()) {
  const msg=e.type==='message'?e.message:undefined;
  if(msg?.role==='assistant') {
   m.responses++;usage(msg.usage);if(msg.stopReason==='error')m.modelErrors++;
   for(const c of msg.content??[])if(c.type==='toolCall'&&!calls.has(c.id??`call:${i}`)){calls.add(c.id??`call:${i}`);m.toolCalls++;callInputs.set(c.id,{name:c.name,input:c.arguments??{}});}
  }
  if(msg?.role==='toolResult'&&!results.has(msg.toolCallId??`result:${i}`)) {
   results.add(msg.toolCallId??`result:${i}`);m.toolResults++;m.tools[msg.toolName]=(m.tools[msg.toolName]||0)+1;
   if(msg.isError || msg.toolName==='web_search' && msg.details?.queryCount>0 && msg.details?.successfulQueries===0){m.errors++;if(/^Blocked:/.test(text(msg.content)))m.blocked++;}
   // Status/list/inspection can legally view another session's runs. Only
   // execution receipts and owner-scoped lifecycle ledgers contribute agents.
   if(msg.toolName==='subagent'&&!callInputs.get(msg.toolCallId)?.input?.action)record(msg.details,msg.toolCallId);
   const call=callInputs.get(msg.toolCallId),input=call?.input??{};
   const path=input.path??input.file_path;
   if(!msg.isError&&call?.name==='read'&&typeof path==='string'&&/(?:^|[\\/])SKILL\.md$/i.test(path)){
    const full=(input.offset===undefined||input.offset===1)&&input.limit===undefined&&msg.details?.truncation?.truncated!==true;
    (full?read:partial).add(name(path));
   }
  }
  if(e.type==='compaction'){m.compactions++;usage(e.usage);}
  if(e.type==='branch_summary')usage(e.usage);
  if(e.type==='custom'&&['subagent-cost-v1','subagent-lifecycle-v1'].includes(e.customType))record(e.data,e.id,e.customType==='subagent-cost-v1');
  if(e.type==='custom'&&e.customType==='relevant-guidance'){
   for(const p of e.data?.read??[])read.add(name(p));
   for(const p of e.data?.shown??[])if(p.startsWith('skill:')||p.startsWith('skillctx:'))routed.add(name(p));
  }
  if(e.type==='custom'&&e.customType==='provider-recovery'&&/^Automatic free read-only group:/.test(e.data?.text??''))groups.push({id:e.id??`legacy:${i}`,time:Date.parse(e.timestamp)||0});

  if(e.type==='custom_message'&&e.customType==='autonomous-free-fusion')legacyFusions.push({id:e.id??`fusion:${i}`,time:Date.parse(e.timestamp)||0});
  if(e.type==='custom'&&e.customType==='session-metrics-v1'&&typeof e.data?.segment==='string')segments.set(e.data.segment,e.data);
 }
 if(live?.segment)segments.set(live.segment,live);
 for(const s of segments.values()){
  m.telemetry=true;
  for(const [k,v] of Object.entries(s.hooks??{})){
   const cut=k.lastIndexOf(':'),owner=k.slice(0,cut).split('/').pop(),hook=k.slice(cut+1);
   if(!hookNames.has(hook)||['health-log.ts','session-telemetry.ts'].includes(owner)){m.hookExcluded+=number(v.calls);continue;}
   const h=m.hooks[k]??={calls:0,errors:0,ms:0,changed:0,removedChars:0,addedChars:0};
   for(const key of Object.keys(h))h[key]+=number(v[key]);
  }
  for(const k of ['swarms','fusions','recoveries'])m[s.version===2||k==='recoveries'?k:k==='swarms'?'legacySwarms':'legacyFusions']+=number(s.events?.[k]);
 }
 // Legacy auto-groups are only inferred when no corresponding new event exists.
 const measuredSince=Math.min(...[...segments.values()].map(s=>Number.isFinite(s.startedAt)?s.startedAt:Infinity));
 m.legacySwarms+=new Set(groups.filter(g=>g.time<measuredSince).map(g=>g.id)).size;m.swarms+=nativeGroups.size;
 for(const a of activities.values())for(const k of ['swarms','fusions','recoveries'])m[k]+=number(a[k]);
 m.legacyFusions+=new Set(legacyFusions.filter(g=>g.time<measuredSince).map(g=>g.id)).size;
 for(const h of Object.values(m.hooks)){m.hookCalls+=h.calls;m.hookChanged+=h.changed;m.hookErrors+=h.errors;m.trimmedChars+=h.removedChars;m.addedChars+=h.addedChars;}
 for(const a of agents.values()){m.agents++;m.childTokens+=a.tokens;if(a.status==='failed')m.agentFailures++;else if(a.status==='completed')m.agentsCompleted++;else if(a.status==='stopped')m.agentsStopped++;else if(a.status==='paused')m.agentsPaused++;else if(['queued','running','detached'].includes(a.status))m.agentsActive++;else m.agentOutcomeUnknown++;}
 // Diagnostics consume the same identity resolution and final outcomes.
 m.agentAliases=Object.fromEntries(aliases);
 m.agentStates=Object.fromEntries([...agents].map(([key,a])=>[key,a.status]));
 for(const status of workflows.values()){m.workflows++;if(status==='failed')m.workflowFailures++;else if(['queued','running','detached'].includes(status))m.workflowsActive++;else if(['unknown','finished-unknown'].includes(status))m.workflowOutcomeUnknown++;}
 m.skillsRead=[...read].sort();m.skillsPartial=[...partial].filter(s=>!read.has(s)).sort();m.skillsRouted=[...routed].sort();
 m.distinctTools=Object.keys(m.tools).length;
 const prompt=m.input+m.cacheRead+m.cacheWrite;m.cacheRate=prompt>0?100*m.cacheRead/prompt:null;
 const parentFailures=m.errors+m.modelErrors, totalFailures=parentFailures+m.agentFailures+m.workflowFailures;
 m.footer=[`Agents ${m.agents} (${m.agentsActive} active)`,totalFailures?`Failures ${totalFailures} (P${parentFailures} C${m.agentFailures} W${m.workflowFailures})`:'Failures 0'];
 m.detail=[
  'Session activity (all retained entries; includes pre-compaction history)',
  `Verified swarm / parallel-group operations: ${m.swarms}; fusions: ${m.fusions}; legacy records with older definitions: ${m.legacySwarms} swarms, ${m.legacyFusions} fusions (may include reused groups or single-output forwarding); recovery plans: ${m.telemetry?m.recoveries:'unknown before telemetry'}`,
  `Accepted/observed child runs: ${m.agents}; last observed active (queued/running/detached): ${m.agentsActive}; completed: ${m.agentsCompleted}; failed: ${m.agentFailures}; stopped: ${m.agentsStopped}; paused: ${m.agentsPaused}; unknown outcome: ${m.agentOutcomeUnknown}`,
  `Workflow controllers: ${m.workflows}; last observed active: ${m.workflowsActive}; failed: ${m.workflowFailures}; unknown outcome: ${m.workflowOutcomeUnknown}. Controllers are not child agents; a reported controller failure may also be a parent tool error.`,
  `Parent model responses: ${m.responses}; tool calls: ${m.toolCalls}; tool results: ${m.toolResults}; distinct tools observed: ${m.distinctTools}. Breadth is descriptive, not a target or proof of effective use.`,
  `Parent errors: ${m.errors} tool + ${m.modelErrors} model; blocked tools: ${m.blocked}; hook errors: ${m.telemetry?m.hookErrors:'unknown'}`,
  `Compactions: ${m.compactions}; recorded child token traffic: ${m.childTokens.toLocaleString('en-US')}`,
  `Parent + compaction token traffic: input ${m.input.toLocaleString('en-US')}, output ${m.output.toLocaleString('en-US')}, cached reads ${m.cacheRead.toLocaleString('en-US')}, cache writes ${m.cacheWrite.toLocaleString('en-US')}`,
  `Reported reasoning tokens: ${m.reasoning.toLocaleString('en-US')} (a subset of output, not additional traffic)`,
  `Cumulative prompt cache reuse: ${m.cacheRate===null?'unknown':m.cacheRate.toFixed(2)+'%'}; cached tokens were reused, not removed from traffic.`,
  m.telemetry?`Measured hook payload reduction: ${m.trimmedChars.toLocaleString('en-US')} characters (~${Math.round(m.trimmedChars/4).toLocaleString('en-US')} tokens at 4 chars/token); additions: ${m.addedChars.toLocaleString('en-US')} chars. Counts each observed projection, not unique tokens or billed savings.`:'Historical harness token savings: unknown; context payload reductions were not recorded.',
  `Parent skills suggested: ${m.skillsRouted.join(', ')||'none recorded'}`,
  `Parent skills fully read: ${m.skillsRead.join(', ')||'none recorded'}; partial reads only: ${m.skillsPartial.join(', ')||'none'}. A routed suggestion is not a read or proof of application.`,
  'Tools: '+Object.entries(m.tools).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${v}`).join(', '),
  m.telemetry?`Hook checks: ${m.hookCalls} intervention-handler calls; ${m.hookChanged} returned results (not proof of useful changes). Excluded ${m.hookExcluded} streaming/lifecycle-observer notifications from legacy telemetry.`:'Extension hook invocations before instrumentation: unknown. Health logs contain lifecycle events only.',
  ...Object.entries(m.hooks).sort((a,b)=>b[1].calls-a[1].calls).map(([k,v])=>`${k}: ${v.calls} calls, ${v.errors} errors, ${Math.round(v.ms)} ms, ${v.changed} returned results`),
 ];
 return m;
}

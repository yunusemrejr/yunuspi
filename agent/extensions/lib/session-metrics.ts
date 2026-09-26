// @ts-nocheck
import {hasRecordedTokenUsage, collectAuxiliaryModelUsage} from './cost-evidence.ts';
/** Pure, transcript-backed accounting. Embedded verbatim in both footer builds.
 * Cumulative snapshots are replaced by segment ID, never added twice. */
export function collectSessionMetrics(entries, live) {
 entries=Array.isArray(entries)?entries.filter(e=>e&&typeof e==='object'):[];
 const m={responses:0,toolCalls:0,toolResults:0,errors:0,modelErrors:0,blocked:0,compactions:0,agents:0,agentFailures:0,agentsActive:0,agentsCompleted:0,agentsStopped:0,agentsPaused:0,agentOutcomeUnknown:0,workflows:0,workflowFailures:0,workflowsActive:0,workflowOutcomeUnknown:0,swarms:0,fusions:0,legacySwarms:0,legacyFusions:0,recoveries:0,tools:Object.create(null),skillsRead:[],skillsPartial:[],skillsRouted:[],input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0,childTokens:0,childRows:0,childRowsWithUsage:0,hooks:Object.create(null),hookCalls:0,hookExcluded:0,hookChanged:0,hookErrors:0,confirmDialogs:0,confirmWaitMs:0,trimmedChars:0,addedChars:0,telemetry:false,rawReturnedChars:0,uncachedInput:0,cachedReuse:0,noCacheTurns:0,noCacheInput:0,invalidationTurns:0,invalidationExcessTokens:0,abortedTelemetry:0,assistantTurns:0,perModel:Object.create(null),jev:{hits:0,cached:0,tokens:0,costUsd:0,bySite:Object.create(null)}};
 const calls=new Set(), results=new Set(), agents=new Map(), workflows=new Map(), segments=new Map(), activities=new Map(), read=new Set(), partial=new Set(), routed=new Set(), callInputs=new Map(), aliases=new Map(), groups=[],nativeGroups=new Set(),legacyFusions=[];
 const number=v=>Number.isFinite(v)&&v>=0?v:0;
 const name=p=>String(p).replace(/\\/g,'/').split('/').filter(Boolean).slice(-2,-1)[0]||String(p);
 const text=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(p=>p?.type==='text').map(p=>p.text).join('\n'):'';
 const usage=u=>{if(u)for(const k of ['input','output','cacheRead','cacheWrite','reasoning'])m[k]+=number(u[k]);};
 // Per-route usage keys off the assistant message's own provider/model (usage
 // objects do not carry a route). Compaction/summary usage names no route and
 // stays explicitly unattributed — never guessed from neighbors.
 const rowFor=route=>{
  if(typeof route!=='string'||!route)return undefined;
  if(!m.perModel[route]){
   if(Object.keys(m.perModel).length>=256)return undefined;
   m.perModel[route]={turns:0,input:0,cacheRead:0,cacheWrite:0,output:0,reasoning:0,errors:0,thinking:[],routing:[],endpoints:[]};
  }
  return m.perModel[route];
 };
 const routeOf=(msg,u)=>{
  if(u&&typeof u.route==='string'&&u.route.trim())return u.route.trim().slice(0,160);
  const p=msg?.provider,id=msg?.model;
  if(typeof p==='string'&&p.trim()&&typeof id==='string'&&id.trim())return `${p.trim()}/${id.trim()}`.slice(0,160);
  return null;
 };
 const noteModel=(route,u,isError)=>{
  const r=rowFor(route);
  if(!r||!u||typeof u!=='object')return;
  r.turns++;if(isError)r.errors++;
  for(const k of ['input','cacheRead','cacheWrite','output','reasoning'])r[k]+=number(u[k]);
 };
 const pinText=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return '';
  try{const text=JSON.stringify(value);return text.length>256?'':text;}catch{return '';}
 };
 // Turn-level cache accounting needs new-content context: characters appended
 // since the previous assistant message plus that message's output. This
 // mirrors scripts/lib/token-cost-diagnostics.mjs at transcript scale: it is
 // a magnitude check, not a tokenizer, and separates uncached input,
 // cached reuse, no-cache routes and prefix-invalidation excess explicitly.
 let pendingChars=0, prevOutput=0;
 const visibleChars=c=>typeof c==='string'?c.length:Array.isArray(c)?c.filter(p=>p?.type==='text'&&typeof p.text==='string').reduce((s,p)=>s+p.text.length,0)+c.filter(p=>p?.type==='toolCall').reduce((s,p)=>s+String(p.name??'').length,0):0;
 const noteAssistant=(u,msg,isError=false,unattributed=false)=>{
  if(!u||typeof u!=='object')return;
  const input=number(u.input),cacheRead=number(u.cacheRead),cacheWrite=number(u.cacheWrite),output=number(u.output);
  const prompt=input+cacheRead+cacheWrite;
  m.assistantTurns++;
  m.uncachedInput+=input;m.cachedReuse+=cacheRead;
  noteModel(unattributed?'(unattributed compaction/summary)':routeOf(msg,u),u,isError);
  if(cacheRead===0&&cacheWrite===0&&prompt>=3000){m.noCacheTurns++;m.noCacheInput+=input;}
  const newContent=Math.round(pendingChars/4)+prevOutput;
  const excess=input-newContent;
  if(cacheRead>0&&excess>=3000){m.invalidationTurns++;m.invalidationExcessTokens+=excess;}
  pendingChars=0;prevOutput=output+number(u.reasoning);
 };
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
  for(const group of d.mode==='parallel'||!Array.isArray(d.parallelGroups)?[]:d.parallelGroups)if(group?.count>1&&rows.filter((r,i)=>(r?.index??i)>=group.start&&(r?.index??i)<group.start+group.count&&!['pending','unknown'].includes(r?.status??r?.state??'unknown')).length>1)nativeGroups.add(`${root}:group:${group.start}`);
  for(const [i,r] of rows.entries()) {
   if(!r||typeof r!=='object'||r.status==='pending'||r.state==='pending')continue;
   const attempt = Number.isSafeInteger(r.attempt) && r.attempt > 0 ? `:attempt-${r.attempt}` : "";
   const ids=[`${root}:${r.workflowKey??r.childId??r.index??i}${attempt}`];
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
   // Coverage of child accounting: many ledger rows are non-terminal
   // placeholders without usage (measured 81 of 166 rows on 2026-09-14), so a
   // bare total would read as "zero child traffic" when it is really "no usage
   // recorded yet for these rows".
   m.childRows++;if(hasRecordedTokenUsage(r.usage, r.childProcessStarted === false && r.stage === 'launch'))m.childRowsWithUsage++;
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
  if(e.type==='custom'&&e.customType==='fs-confirm-wait-v1'){
   const d=e.data??{};
   const waiters=Number.isSafeInteger(d.waiters)&&d.waiters>0?Math.min(d.waiters,256):1;
   m.confirmDialogs++;m.confirmWaitMs+=number(d.waitMs)*waiters;
  }
  if(e.type==='custom'&&e.customType==='jev-usage-v1'){
   const d=e.data??{};
   m.jev.hits++;if(d.cached===true)m.jev.cached++;m.jev.tokens+=number(d.inputTokens);
   if(typeof d.costUsd==='number'&&d.costUsd>=0)m.jev.costUsd+=d.costUsd;
   const site=typeof d.site==='string'&&d.site?d.site.slice(0,48):'unknown';
   if(!m.jev.bySite[site]&&Object.keys(m.jev.bySite).length<64)m.jev.bySite[site]={hits:0,tokens:0,costUsd:0};
   const row=m.jev.bySite[site];if(row){row.hits++;row.tokens+=number(d.inputTokens);if(typeof d.costUsd==='number'&&d.costUsd>=0)row.costUsd+=d.costUsd;}
  }
  if(msg?.role==='assistant') {
   m.responses++;usage(msg.usage);noteAssistant(msg.usage,msg,msg.stopReason==='error');if(msg.stopReason==='error')m.modelErrors++;
   // Aborted/zero-content attempts are telemetry, never model-visible
   // evidence: counted here so the footer can report them without
   // projecting their empty body back into context.
   if((msg.stopReason==='aborted'||msg.stopReason==='error')&&visibleChars(msg.content)===0&&!String(msg.errorMessage??''))m.abortedTelemetry++;
   else if(visibleChars(msg.content)===0&&(msg.content??[]).length===0&&number(msg.usage?.input)===0&&number(msg.usage?.output)===0)m.abortedTelemetry++;
   for(const c of Array.isArray(msg.content)?msg.content:[])if(c?.type==='toolCall'&&!calls.has(c.id??`call:${i}`)){calls.add(c.id??`call:${i}`);m.toolCalls++;callInputs.set(c.id,{name:c.name,input:c.arguments??{}});}
  }
  if(msg?.role==='toolResult'&&!results.has(msg.toolCallId??`result:${i}`)) {
   results.add(msg.toolCallId??`result:${i}`);m.toolResults++;m.tools[msg.toolName]=(m.tools[msg.toolName]||0)+1;m.rawReturnedChars+=visibleChars(msg.content);pendingChars+=visibleChars(msg.content);
   if(msg.isError&&/^\[harness gate\]/.test(text(msg.content))){/* deliberate re-check gate, not a failure */}
   else if(msg.isError || msg.toolName==='web_search' && msg.details?.queryCount>0 && msg.details?.successfulQueries===0){m.errors++;if(/^Blocked:/.test(text(msg.content)))m.blocked++;}
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
  if(msg?.role==='user')pendingChars+=visibleChars(msg.content);
  if(e.type==='compaction'){m.compactions++;usage(e.usage);noteAssistant(e.usage,undefined,false,true);pendingChars=0;}
  if(e.type==='branch_summary'){usage(e.usage);noteAssistant(e.usage,undefined,false,true);}
  // A harness helper's native lifecycle duplicates its wrapper's own record
  // (scope council, review, skill discovery) until they link at completion;
  // counting both showed "Agents 14 (7 active)" for one review round.
  const helperNative=e.type==='custom'&&e.customType==='subagent-lifecycle-v1'&&e.data?.results?.length===1&&['automatic-free-assistant','automatic-skill-discovery'].includes(e.data.results[0]?.agent)&&!/^(?:auto-assist|quality-review|skill-discovery|scope-council)-/.test(e.data.runId);
  if(e.type==='custom'&&['subagent-cost-v1','subagent-lifecycle-v1'].includes(e.customType)&&!helperNative)record(e.data,e.id,e.customType==='subagent-cost-v1');
  if(e.type==='custom'&&e.customType==='relevant-guidance'){
   for(const p of Array.isArray(e.data?.read)?e.data.read:[])if(typeof p==='string')read.add(name(p));
   for(const p of Array.isArray(e.data?.shown)?e.data.shown:[])if(typeof p==='string'&&(p.startsWith('skill:')||p.startsWith('skillctx:')))routed.add(name(p));
  }
  if(e.type==='custom'&&e.customType==='provider-recovery'&&/^Automatic free read-only group:/.test(e.data?.text??''))groups.push({id:e.id??`legacy:${i}`,time:Date.parse(e.timestamp)||0});

  if(e.type==='custom_message'&&e.customType==='autonomous-free-fusion')legacyFusions.push({id:e.id??`fusion:${i}`,time:Date.parse(e.timestamp)||0});
  if(e.type==='custom'&&e.customType==='session-metrics-v1'&&typeof e.data?.segment==='string')segments.set(e.data.segment,e.data);
  // Selection-boundary records pair each used route with the thinking level
  // and OpenRouter backend routing it ran with. Thinking/routing for routes
  // without a record stays empty — never reconstructed by guessing.
  if(e.type==='custom'&&e.customType==='model-config-v1'&&e.data&&typeof e.data==='object'){
   const route=typeof e.data.route==='string'&&e.data.route.trim()?e.data.route.trim().slice(0,160):null;
   const r=rowFor(route);
   if(r){
    if(typeof e.data.thinking==='string'&&e.data.thinking.trim()){
     const level=e.data.thinking.trim().slice(0,16);
     if(!r.thinking.includes(level))r.thinking.push(level);
    }
    const pin=pinText(e.data.openRouterRouting);
    if(pin&&!r.routing.includes(pin))r.routing.push(pin);
    if(typeof e.data.recoveryEndpointName==='string'&&e.data.recoveryEndpointName.trim()){
     const name=e.data.recoveryEndpointName.trim().slice(0,160);
     if(!r.endpoints.includes(name))r.endpoints.push(name);
    }
   }
  }
 }
 // Direct SDK helpers have separate accounting: no fabricated child runs,
 // parent responses, cache-invalidation turns, JEV judgments, or tool calls.
 const auxiliaryRequests=collectAuxiliaryModelUsage(entries);
 m.auxiliary={calls:auxiliaryRequests.rows.length,pending:0,usageRecorded:0,unknownUsage:0,truncated:auxiliaryRequests.truncated,input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0,tokens:0};
 const auxiliaryModels=new Map();
 for(const row of auxiliaryRequests.rows){
  if(row.status==='pending')m.auxiliary.pending++;
  if(row.usageRecorded)m.auxiliary.usageRecorded++;else m.auxiliary.unknownUsage++;
  const model=auxiliaryModels.get(row.route)??{route:row.route,calls:0,input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0};
  model.calls++;
  for(const k of ['input','output','cacheRead','cacheWrite','reasoning']){m.auxiliary[k]+=number(row.usage[k]);model[k]+=number(row.usage[k]);}
  m.auxiliary.tokens+=row.tokens;
  if(auxiliaryModels.has(row.route)||auxiliaryModels.size<256)auxiliaryModels.set(row.route,model);
 }
 m.auxiliaryModels=[...auxiliaryModels.values()];
 if(live?.segment)segments.set(live.segment,live);
 for(const s of segments.values()){
  m.telemetry=true;
  for(const [k,v] of Object.entries(s.hooks??{})){
   if(!v||typeof v!=='object')continue;
   const cut=k.lastIndexOf(':'),owner=k.slice(0,cut).split('/').pop(),hook=k.slice(cut+1);
   if(!hookNames.has(hook)||['health-log.ts','session-telemetry.ts'].includes(owner)){m.hookExcluded+=number(v.calls);continue;}
   const h=m.hooks[k]??={calls:0,errors:0,ms:0,changed:0,removedChars:0,addedChars:0,charsChanged:0,tokensChanged:0};
   for(const key of ['calls','errors','ms','changed','removedChars','addedChars','charsChanged','tokensChanged'])h[key]+=number(v[key]);
   for(const key of ['beforeHash','afterHash','semanticHash'])if(h[key]===undefined&&typeof v[key]==='string'&&/^[0-9a-f]{8}$/.test(v[key]))h[key]=v[key];
   if(Number.isSafeInteger(v.changedAt)&&v.changedAt>=0&&v.changedAt<=20000&&(h.changedAt===undefined||v.changedAt<h.changedAt))h.changedAt=v.changedAt;
   if(Number.isSafeInteger(v.revision)&&v.revision>=0)h.revision=v.revision;
   if(Number.isFinite(v.cacheAgeMs)&&v.cacheAgeMs>=0)h.cacheAgeMs=Math.max(h.cacheAgeMs??0,v.cacheAgeMs);
  }
  for(const k of ['swarms','fusions','recoveries'])m[s.version===2||k==='recoveries'?k:k==='swarms'?'legacySwarms':'legacyFusions']+=number(s.events?.[k]);
  m.abortedTelemetry+=number(s.events?.aborted);
 }
 // Legacy auto-groups are only inferred when no corresponding new event exists.
 const measuredSince=[...segments.values()].reduce((min,s)=>Number.isFinite(s.startedAt)?Math.min(min,s.startedAt):min,Infinity);
 m.legacySwarms+=new Set(groups.filter(g=>g.time<measuredSince).map(g=>g.id)).size;m.swarms+=nativeGroups.size;
 for(const a of activities.values())for(const k of ['swarms','fusions','recoveries'])m[k]+=number(a[k]);
 m.legacyFusions+=new Set(legacyFusions.filter(g=>g.time<measuredSince).map(g=>g.id)).size;
 for(const h of Object.values(m.hooks)){m.hookCalls+=h.calls;m.hookChanged+=h.changed;m.hookErrors+=h.errors;m.trimmedChars+=h.removedChars;m.addedChars+=h.addedChars;}
 // Core hook telemetry measures inclusive handler wall time, so every
 // filesystem-safety confirmation dialog inflates its tool_call row once per
 // waiter. Reconcile here, at the canonical telemetry owner: the row keeps
 // its inclusive ms and gains the user-wait split, floored at zero so stale
 // segments can never drive active time negative.
 if(m.confirmWaitMs>0)for(const [k,h] of Object.entries(m.hooks)){
  const cut=k.lastIndexOf(':');
  if(String(k.slice(0,cut).split('/').pop())!=='filesystem-safety.ts'||k.slice(cut+1)!=='tool_call')continue;
  h.confirmWaitMs=Math.min(m.confirmWaitMs,h.ms);h.activeMs=Math.max(0,h.ms-h.confirmWaitMs);h.confirmDialogs=m.confirmDialogs;
 }
 for(const a of agents.values()){m.agents++;m.childTokens+=a.tokens;if(a.status==='failed')m.agentFailures++;else if(a.status==='completed')m.agentsCompleted++;else if(a.status==='stopped')m.agentsStopped++;else if(a.status==='paused')m.agentsPaused++;else if(['queued','running','detached'].includes(a.status))m.agentsActive++;else m.agentOutcomeUnknown++;}
 // Diagnostics consume the same identity resolution and final outcomes.
 m.agentAliases=Object.fromEntries(aliases);
 m.agentStates=Object.fromEntries([...agents].map(([key,a])=>[key,a.status]));
 for(const status of workflows.values()){m.workflows++;if(status==='failed')m.workflowFailures++;else if(['queued','running','detached'].includes(status))m.workflowsActive++;else if(['unknown','finished-unknown'].includes(status))m.workflowOutcomeUnknown++;}
 m.skillsRead=[...read].sort();m.skillsPartial=[...partial].filter(s=>!read.has(s)).sort();m.skillsRouted=[...routed].sort();
 m.distinctTools=Object.keys(m.tools).length;
 const prompt=m.input+m.cacheRead+m.cacheWrite;m.cacheRate=prompt>0?100*m.cacheRead/prompt:null;
 // Unique vs repeated: segment snapshots are cumulative and replaced by
 // segment ID, so trimmedChars is unique context removed per segment, while
 // addedChars is repeated projection churn (bytes re-added on later
 // projections). Repeatedly processed characters are churn, never unique
 // token savings and never billed savings.
 m.uniqueContextRemovedChars=m.trimmedChars;m.projectionChurnChars=m.addedChars;
 m.estimatedBilledSavingsNote='cached-token reuse avoids full-price rebill of the matched prefix; it is not a billed-amount saving and repeated churn must not be counted as savings';
 const parentFailures=m.errors+m.modelErrors, totalFailures=parentFailures+m.agentFailures+m.workflowFailures;
 // Bottom KPI layer: only the powers this session actually used, emoji + label + count.
 // The full breakdown stays in /metrics (m.detail); ordering is stable by count
 // then name so the footer does not reshuffle between renders.
 const powerLabels = {subagent:'🤖 Agents',quality_review:'🔍 Review',project_tests:'🧪 Tests',skill_review:'📚 Skills',session_self:'🪞 Self',project_report:'🗺️ Project',module_report:'🧭 Module',symbol_search:'🔎 Symbols',context_slice:'✂️ Context',context_score:'🎯 Rank',handoff_capsule:'💊 Handoff',evidence_cache:'🗃️ Evidence',bg_run:'⏳ Jobs',media_info:'🎬 Media',media_edit:'🎞️ Edit',video_frames:'🎬 Frames',audio_analyze:'🔊 Audio',music_compose:'🎵 Music',browser_session:'🌐 Browser',agentmail_status:'✉️ Mail',agentmail_send:'✉️ Send',agentmail_messages:'📬 Inbox',agentmail_search:'🔎 Mail',agentmail_message:'📨 Read',render_see:'👁️ Render',sandbox_run:'📦 Sandbox',obs_read:'🔬 Observe',context_profile:'📈 Profile',tool_search:'🧰 Tools'};
 const powers=Object.entries(m.tools).filter(([name])=>powerLabels[name]).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,8).map(([name,count])=>`${powerLabels[name]} ${count}`);
 const sessionEntry=entries.find(e=>e?.type==='session');
 const shortSessionId=typeof sessionEntry?.id==='string'?sessionEntry.id.slice(0,8):'';
 m.footer=[`Agents ${m.agents} (${m.agentsActive} active)`,totalFailures?`Failures ${totalFailures} (P${parentFailures} C${m.agentFailures} W${m.workflowFailures})`:'Failures 0'];
 if(powers.length)m.footer.push(`Powers ${powers.join(' · ')}`);
 if(shortSessionId)m.footer.push(`session ${shortSessionId}`);
 m.detail=[
  'Session activity (all retained entries; includes pre-compaction history)',
  `Verified swarm / parallel-group operations: ${m.swarms}; fusions: ${m.fusions}; legacy records with older definitions: ${m.legacySwarms} swarms, ${m.legacyFusions} fusions (may include reused groups or single-output forwarding); recovery plans: ${m.telemetry?m.recoveries:'unknown before telemetry'}`,
  `Accepted/observed child runs: ${m.agents}; last observed active (queued/running/detached): ${m.agentsActive}; completed: ${m.agentsCompleted}; failed: ${m.agentFailures}; stopped: ${m.agentsStopped}; paused: ${m.agentsPaused}; unknown outcome: ${m.agentOutcomeUnknown}`,
  `Workflow controllers: ${m.workflows}; last observed active: ${m.workflowsActive}; failed: ${m.workflowFailures}; unknown outcome: ${m.workflowOutcomeUnknown}. Controllers are not child agents; a reported controller failure may also be a parent tool error.`,
  `Parent model responses: ${m.responses}; tool calls: ${m.toolCalls}; tool results: ${m.toolResults}; distinct tools observed: ${m.distinctTools}. Breadth is descriptive, not a target or proof of effective use.`,
  `Parent errors: ${m.errors} tool + ${m.modelErrors} model; blocked tools: ${m.blocked}; hook errors: ${m.telemetry?m.hookErrors:'unknown'}`,
  `Compactions: ${m.compactions}; recorded child token traffic: ${m.childTokens.toLocaleString('en-US')} (from ${m.childRowsWithUsage.toLocaleString('en-US')} of ${m.childRows.toLocaleString('en-US')} recorded child row(s) carrying usage)`,
  `Parent + compaction token traffic: input ${m.input.toLocaleString('en-US')}, output ${m.output.toLocaleString('en-US')}, cached reads ${m.cacheRead.toLocaleString('en-US')}, cache writes ${m.cacheWrite.toLocaleString('en-US')}`,
  `Reported reasoning tokens: ${m.reasoning.toLocaleString('en-US')} (a subset of output, not additional traffic)`,
  ...(m.auxiliary.calls||m.auxiliary.truncated?[`Auxiliary model requests: ${m.auxiliary.calls}; pending ${m.auxiliary.pending}; recorded token traffic ${m.auxiliary.tokens.toLocaleString('en-US')} from ${m.auxiliary.usageRecorded} request(s); usage unknown for ${m.auxiliary.unknownUsage}${m.auxiliary.truncated?'; receipt coverage incomplete':''}. Reported auxiliary reasoning ${m.auxiliary.reasoning.toLocaleString('en-US')} is a subset of output. These requests are not child agents or parent responses.`]:[]),
  `Cumulative prompt cache reuse: ${m.cacheRate===null?'unknown':m.cacheRate.toFixed(2)+'%'}; cached tokens were reused, not removed from traffic.`,
  `Cache detail: uncached input ${m.uncachedInput.toLocaleString('en-US')} tokens across ${m.assistantTurns} billed assistant turns; cached reuse ${m.cachedReuse.toLocaleString('en-US')} tokens; no-cache turns ${m.noCacheTurns} (${m.noCacheInput.toLocaleString('en-US')} uncached tokens on routes without caching); invalidation turns ${m.invalidationTurns} with ~${m.invalidationExcessTokens.toLocaleString('en-US')} excess uncached tokens (cached prefix stopped matching and was rebilled). New-content is chars/4 magnitude, not a tokenizer.`,
  `Estimated billed effect: reuse avoids full-price rebill of the matched prefix; it is NOT a billed-amount saving. Repeated projection churn must never be reported as unique savings. Actual billed amounts live in /cost and session-cost evidence, not here.`,
  `Context occupancy vs raw traffic: raw returned characters ${m.rawReturnedChars.toLocaleString('en-US')} in ${m.toolResults} results are pre-projection bytes, not active-context occupancy, tokens, or billed savings. Active occupancy is the live window (see session_self context); unique context removed is below.`,
  m.telemetry?`Unique context removed: ${m.uniqueContextRemovedChars.toLocaleString('en-US')} characters (~${Math.round(m.uniqueContextRemovedChars/4).toLocaleString('en-US')} tokens at 4 chars/token), deduplicated by telemetry segment; repeated projection churn re-added: ${m.projectionChurnChars.toLocaleString('en-US')} chars. Churn is reprocessing cost, not savings.`:'Historical harness token savings: unknown; context payload reductions were not recorded.',
  m.abortedTelemetry?`Aborted/zero-content assistant attempts kept as telemetry (not model-visible): ${m.abortedTelemetry}.`:'Aborted/zero-content assistant attempts: none counted; empty aborted attempts stay telemetry, never projected context.',
  `Parent skills suggested: ${m.skillsRouted.join(', ')||'none recorded'}`,
  `Parent skills fully read: ${m.skillsRead.join(', ')||'none recorded'}; partial reads only: ${m.skillsPartial.join(', ')||'none'}. A routed suggestion is not a read or proof of application.`,
  'Tools: '+Object.entries(m.tools).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${v}`).join(', '),
  m.telemetry?`Hook checks: ${m.hookCalls} intervention-handler calls; ${m.hookChanged} returned results (not proof of useful changes). Excluded ${m.hookExcluded} streaming/lifecycle-observer notifications from legacy telemetry.${m.confirmDialogs?` User-confirm waits: ${m.confirmDialogs} dialogs holding ${Math.round(m.confirmWaitMs).toLocaleString('en-US')} ms of hook wall time, split out of the filesystem-safety row below.`:''}`:'Extension hook invocations before instrumentation: unknown. Health logs contain lifecycle events only.',
  ...Object.entries(m.hooks).sort((a,b)=>b[1].calls-a[1].calls).map(([k,v])=>v.confirmWaitMs>0?`${k}: ${v.calls} calls, ${v.errors} errors, ${Math.round(v.activeMs)} ms active (+${Math.round(v.confirmWaitMs)} ms user-confirm wait across ${v.confirmDialogs} dialogs), ${v.changed} returned results`:`${k}: ${v.calls} calls, ${v.errors} errors, ${Math.round(v.ms)} ms, ${v.changed} returned results`),
 ];
 // Ordered route table for /metrics and export. perModel stays the keyed form.
 m.modelsUsed=Object.entries(m.perModel).map(([route,r])=>({route,...r})).sort((a,b)=>b.input-a.input||b.turns-a.turns);
 return m;
}

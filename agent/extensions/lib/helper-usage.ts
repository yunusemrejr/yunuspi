import { randomUUID } from 'node:crypto';
import { sessionObservability } from './session-observability.ts';
import { describeIntelligenceActivity, HELPER_LABELS } from './activity-indicators.ts';
import { collectAuxiliaryModelUsage } from './cost-evidence.ts';

export const HELPER_USAGE_VIEW = Symbol.for('yunuspi.helper-usage-view.v1');
export const HELPER_USAGE_ENTRY = 'helper-usage-v1';
const names = ['JEV', 'Needle3', 'Local LM', 'Kompress', 'Fuzzy matching', 'Retrieval intelligence', 'Neural ranker', 'Intent classifier', 'WASM source check', 'Deterministic selection', 'Span sensor', 'Micro worker', 'Remote rerank'];
const fields = ['events','executions','cached','results','applied','delivered','returned','skipped','failed','timingSamples','durationMs','matches'];
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const clean = (value: unknown, max=200) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g,'').slice(0,max) : '';
const text = (value: any) => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(part=>part?.type==='text').map(part=>part.text).join('\n') : '';
const timestamp = (value: unknown) => { const n=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;return numeric(n)?n:undefined; };
const blank = () => Object.fromEntries(fields.map(key=>[key,0]));
const guardianFields = ['observed','toolResults','classifierEvaluations','similarityEvaluations','candidates','admitted','abstained','quarantined','constraintCandidates','constraintRejected','suppressedWindow','suppressedHistory','peerMessagesSent','peerMessagesReceived'];

/** Numeric event accounting before display deduplication. Snapshots are cumulative
 * within a segment, so report readers replace them rather than adding repeats. */
export function createHelperUsageLedger() {
  const state:any={version:1,segment:randomUUID(),startedAt:Date.now(),updatedAt:Date.now(),components:{},guardians:{}};
  let dirty=false;
  return {
    note(kind:string,data:any={}) {
      if(kind==='guardian.observing'||kind==='guardian.evaluated') {
        const id=clean(data.guardianInstanceId,160)||'legacy';
        const row:any={at:Date.now(),state:clean(data.decision,40),promptCoverage:clean(data.promptCoverage,40)};
        for(const key of guardianFields)if(numeric(data.stats?.[key]))row[key]=data.stats[key];
        for(const[key,value]of Object.entries({toolResults:data.count,classifierEvaluations:data.evaluations,similarityEvaluations:data.similarityEvaluations}))if(numeric(value))row[key]=value;
        if(Object.hasOwn(state.guardians,id)||Object.keys(state.guardians).length<32)state.guardians[id]=row;
        dirty=true;state.updatedAt=Date.now();return;
      }
      if(!kind.startsWith('ml.'))return;
      if(kind==='ml.helper.applied'){
        // Remote prompt analysis ("llm") is auxiliary model usage, not a helper.
        const label=HELPER_LABELS[clean(data.helper,24)];
        if(!label)return;
        const row=state.components[label]??={...blank(),operations:{},reasons:{}};
        row.applied++;dirty=true;state.updatedAt=Date.now();return;
      }
      const described=describeIntelligenceActivity(kind,data);if(!described||!names.includes(described.label))return;
      const row=state.components[described.label]??={...blank(),operations:{},reasons:{}};
      row.events++;
      const cached=data.cached===true||data.coalesced===true||data.decision==='cache-hit';
      if(cached)row.cached++;
      if(['ml.needle.call','ml.jev.used','ml.smol.inference','ml.mini.select','ml.wasm.completed','ml.span.used','ml.microworker.used','ml.rerank.used'].includes(kind)) {
        if(!cached)row.executions++;
        if(described.status==='ok')row.results++;
      }
      if(kind==='ml.evidence.delivered')row.delivered++;
      else if(kind==='ml.evidence.returned')row.returned++;
      else if(['ml.smol.used','ml.mini.used','ml.fuzzy.used','ml.retrieval.used','ml.intent','ml.radar.rank'].includes(kind))row.applied++;
      if(described.status==='skip')row.skipped++;
      if(described.status==='error')row.failed++;
      if(numeric(data.durationMs)){row.durationMs+=data.durationMs;row.timingSamples++;}
      if(kind==='ml.fuzzy.used'&&Number.isSafeInteger(data.count)&&data.count>=0)row.matches+=data.count;
      if(typeof data.op==='string'&&/^[a-z-]{1,40}$/.test(data.op)&&Object.keys(row.operations).length<16)row.operations[data.op]=(row.operations[data.op]??0)+1;
      if(typeof data.reason==='string'&&/^[a-z-]{1,48}$/.test(data.reason)&&Object.keys(row.reasons).length<16)row.reasons[data.reason]=(row.reasons[data.reason]??0)+1;
      dirty=true;state.updatedAt=Date.now();
    },
    snapshot:()=>structuredClone(state),
    flush(write:(value:any)=>void){if(dirty){write(structuredClone(state));dirty=false;}},
  };
}

export function helperUsageView(sessionId:string) {return sessionObservability()[HELPER_USAGE_VIEW]?.(sessionId);}

export function collectHarnessUsage(entries:any[],live?:any) {
  const segments=new Map<string,any>(),guardians=new Map<string,any>();
  const componentRows=new Map<string,any>();const notices:any[]=[];const observerEvents:any[]=[];const interventions:any[]=[];const deliveries=new Set<string>();const received=new Map<string,any>();
  const seenEntries=new Set<string>();
  const take=(value:any)=>{if(value?.version===1&&typeof value.segment==='string'&&value.segment.length<=160&&numeric(value.startedAt)&&numeric(value.updatedAt))segments.set(value.segment,value);};
  for(const entry of Array.isArray(entries)?entries:[]) {
    if(typeof entry?.id==='string'){if(seenEntries.has(entry.id))continue;seenEntries.add(entry.id);}
    if(entry?.type==='custom'&&entry.customType===HELPER_USAGE_ENTRY)take(entry.data);
    if(entry?.type==='custom'&&entry.customType==='session-observer-delivery-v1'&&typeof entry.data?.adviceId==='string') {
      if(entry.data.status==='prepared-context')deliveries.add(entry.data.adviceId);
      if(entry.data.status==='provider-received')received.set(entry.data.adviceId,{at:timestamp(entry.data.at),provider:clean(entry.data.provider,128),model:clean(entry.data.model,256)});
    }
    const message=entry?.type==='custom_message'?entry:entry?.type==='message'&&entry.message?.role==='custom'?entry.message:undefined;
    if(!message)continue;
    const data=message.details??{},at=timestamp(message.timestamp??entry.timestamp);
    if(message.customType==='harness-activity'&&data.kind==='intelligence.activity'&&names.includes(data.label))notices.push({name:data.label,count:Number.isSafeInteger(data.count)&&data.count>0?data.count:1,status:data.status,at});
    if(message.customType==='session-observer') {
      const status=clean(data.status,40),content=clean(text(message.content),2400);
      observerEvents.push({status,at,detail:clean(data.detail,300),adviceId:clean(data.adviceId,160),note:clean(data.note,1600)||(status==='completed'?content.split('\n').slice(1).join('\n'):''),evidence:Array.isArray(data.evidence)?data.evidence.map((v:any)=>clean(v,100)).slice(0,8):[],tools:Array.isArray(data.tools)?data.tools.map((v:any)=>clean(v,100)).slice(0,8):[],skills:Array.isArray(data.skills)?data.skills.map((v:any)=>clean(v,100)).slice(0,8):[]});
    }
    if(message.customType==='guardian_intervention')interventions.push({at,category:clean(data.category??data.kind,100),content:clean(text(message.content),1800)});
    if(message.customType==='guardian_status'&&data.stats){const row:any={at:at??0,state:data.enabled?'enabled':'disabled'};for(const key of guardianFields)if(numeric(data.stats[key]))row[key]=data.stats[key];guardians.set(clean(data.guardianInstanceId,160)||'legacy',row);}
  }
  take(live);
  for(const segment of segments.values()) {
    for(const[name,value]of Object.entries(segment.components??{}) as [string,any][]) {
      if(!names.includes(name)||!value||typeof value!=='object')continue;
      const row=componentRows.get(name)??{name,...blank(),operations:{},reasons:{}};
      for(const key of fields)if(numeric(value[key]))row[key]+=value[key];
      for(const group of ['operations','reasons'])for(const[key,count]of Object.entries(value[group]??{}))if(/^[a-z-]{1,48}$/.test(key)&&numeric(count)&&Object.keys(row[group]).length<32)row[group][key]=(row[group][key]??0)+count;
      componentRows.set(name,row);
    }
    for(const[id,value]of Object.entries(segment.guardians??{}) as [string,any][])if(value&&numeric(value.at)&&(!guardians.has(id)||guardians.get(id).at<=value.at)){const row:any={at:value.at,state:clean(value.state,40),promptCoverage:clean(value.promptCoverage,40)};for(const key of guardianFields)if(numeric(value[key]))row[key]=value[key];guardians.set(id,row);}
  }
  const components=names.map(name=>{const row=componentRows.get(name);const displayed=notices.filter(n=>n.name===name).reduce((n,row)=>n+row.count,0);return row?{...row,measured:true,displayed}:{name,measured:false,displayed};});
  // Historical status messages lacked owner identity and may describe an identified
  // supervisor above. Keep that coverage separate instead of double-counting it.
  const identifiedGuardians=[...guardians].filter(([id])=>id!=='legacy');
  const guardianTotals:any={};for(const[,row]of identifiedGuardians)for(const key of guardianFields)if(numeric(row[key]))guardianTotals[key]=(guardianTotals[key]??0)+row[key];
  const requests=collectAuxiliaryModelUsage(entries).rows.filter((row:any)=>row.owner==='session-observer');
  const statuses:any={};for(const row of observerEvents)if(row.status)statuses[row.status]=(statuses[row.status]??0)+1;
  const notes=observerEvents.filter(row=>row.note).map(row=>({...row,prepared:!!row.adviceId&&deliveries.has(row.adviceId),received:received.get(row.adviceId)}));
  return {segments:segments.size,components,guardian:{...guardianTotals,snapshotAt:identifiedGuardians.length?Math.max(...identifiedGuardians.map(([,row])=>row.at)):undefined,instances:identifiedGuardians.length,legacyCoverage:guardians.has('legacy'),states:[...new Set([...guardians.values()].map(row=>row.state).filter(Boolean))],interventions:interventions.slice(-30),interventionTotal:interventions.length},observer:{statuses,requests:requests.length?requests:undefined,notes:notes.slice(-30),noteTotal:notes.length,prepared:deliveries.size,received:received.size,events:observerEvents.slice(-60),eventTotal:observerEvents.length},startedAt:segments.size?Math.min(...[...segments.values()].map(row=>row.startedAt)):undefined};
}

/** Skill evidence is retained-branch read receipts plus first appearances in
 * cumulative guidance snapshots. A snapshot is not another suggestion/read. */
export function collectSkillEvidence(entries:any[]) {
  const rows=new Map<string,any>(),calls=new Map<string,any>(),results=new Set<string>(),guidance=new Set<string>();
  const rowFor=(name:string)=>{if(!rows.has(name))rows.set(name,{name,full:0,partial:0,failed:0,history:[],total:0});return rows.get(name);};
  const record=(name:string,event:any)=>{const row=rowFor(name);row.history.push(event);row.total++;if(row.history.length>12)row.history.shift();};
  const nameOf=(file:string)=>file.replaceAll('\\','/').split('/').filter(Boolean).at(-2)?.slice(0,120)||file.slice(0,120);
  for(const entry of entries) {
    const message=entry?.type==='message'?entry.message:undefined;
    if(message?.role==='assistant')for(const part of Array.isArray(message.content)?message.content:[])if(part?.type==='toolCall'&&typeof part.id==='string'&&!calls.has(part.id))calls.set(part.id,part);
  }
  for(const entry of entries) {
    const message=entry?.type==='message'?entry.message:undefined,at=timestamp(message?.timestamp??entry?.timestamp);
    if(message?.role==='toolResult'&&typeof message.toolCallId==='string'&&!results.has(message.toolCallId)) {
      results.add(message.toolCallId);const call=calls.get(message.toolCallId),args=call?.arguments??{},file=args.path??args.file_path;
      if(call?.name==='read'&&typeof file==='string'&&/(?:^|[\\/])SKILL\.md$/i.test(file)) {
        const name=nameOf(file),full=(args.offset===undefined||args.offset===1)&&args.limit===undefined&&message.details?.truncation?.truncated!==true;
        const status=message.isError?'failed':full?'full':'partial';rowFor(name)[status]++;
        record(name,{at,status,source:'read tool',path:clean(file,500),range:full?'entire file':`from line ${Number.isSafeInteger(args.offset)?args.offset:1}${Number.isSafeInteger(args.limit)?` · up to ${args.limit} lines`:''}${message.details?.truncation?.truncated===true?' · output truncated':''}`});
      }
    }
    if(entry?.type==='custom'&&entry.customType==='relevant-guidance')for(const field of ['read','shown'])for(const raw of Array.isArray(entry.data?.[field])?entry.data[field]:[]) {
      if(typeof raw!=='string'||field==='shown'&&!/^(skill|skillctx):/.test(raw))continue;
      const file=raw.replace(/^(skill|skillctx):/,''),key=field+':'+file;if(guidance.has(key))continue;guidance.add(key);
      record(nameOf(file),{at,status:field==='shown'?'suggested':'read recorded',source:'guidance snapshot · first recorded appearance',path:clean(file,500)});
    }
  }
  return Object.fromEntries(rows);
}

const esc=(value:any)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const count=(value:any)=>numeric(value)?value.toLocaleString('en-US'):'—';
const when=(value:any)=>numeric(value)&&value<=8.64e15?new Date(value).toISOString().replace('T',' ').replace(/\.\d+Z$/,' UTC'):'time not recorded';
const metric=(value:any,label:string,note?:string)=>`<div class="usage-kpi"><strong>${esc(count(value))}</strong><span>${esc(label)}</span>${note?`<small>${esc(note)}</small>`:''}</div>`;
const facts=(rows:any[])=>`<dl class="facts-grid">${rows.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v??'not recorded')}</dd>`).join('')}</dl>`;
const group=(id:string,title:string,meta:string,body:string,open=false)=>`<details id="${id}" class="group"${open?' open':''}><summary><span class="group-title">${title}</span><span class="group-meta">${esc(meta)}</span></summary><div class="group-body">${body}</div></details>`;

export function harnessUsageHtml(data:ReturnType<typeof collectHarnessUsage>) {
  const measured=data.components.filter(row=>row.measured),sum=(key:string)=>measured.length?measured.reduce((n,row)=>n+(row[key]??0),0):undefined;
  const components=data.components.map(row=>`<details class="usage-component"><summary><span><b>${esc(row.name)}</b><small>${row.name==='JEV'?'Remote structured judge':row.name==='Needle3'?'Local WASM model':row.name==='Fuzzy matching'?'Local lexical matching · JavaScript':row.name==='WASM source check'?'Tree-sitter WASM parser':'Local helper'}</small></span><span class="usage-component-value">${row.measured?`${count(row.executions)} recorded executions · ${count(row.applied)} applied`:row.displayed?`${count(row.displayed)} displayed notices`:'No measurement'}</span></summary>${row.measured?`<div class="usage-mini-grid">${metric(row.results,'Results ready')}${metric(row.delivered,'Context deliveries')}${metric(row.returned,'Excerpt returns')}${metric(row.cached,'Recorded cached/shared events')}${metric(row.skipped,'Skipped / abstained')}${metric(row.failed,'Unavailable / failed')}</div>${facts([['Measured latency',row.timingSamples?`${Math.round(row.durationMs/row.timingSamples)} ms average · ${count(row.timingSamples)} samples · ${Math.round(row.durationMs)} ms total`:'not recorded'],['Operations',Object.entries(row.operations).map(([k,v])=>`${k}: ${v}`).join(' · ')||'not recorded'],['Reasons',Object.entries(row.reasons).map(([k,v])=>`${k}: ${v}`).join(' · ')||'none recorded'],...(row.name==='Fuzzy matching'?[['Matched candidates',`${count(row.matches)} total across recorded operations`]]:[])])}`:`<p class="note">${row.displayed?'Only displayed notices survived in this branch; display deduplication prevents reconstructing total calls or timing.':'No component measurements in the retained evidence. This does not prove it was disabled or never ran.'}</p>`}</details>`).join('');
  const helper=group('usage-intelligence','Local intelligence & helpers',`${count(sum('executions'))} recorded executions · ${count(sum('delivered'))} context deliveries`,
    `<div class="usage-mini-grid">${metric(sum('executions'),'Recorded model / parser executions')}${metric(sum('applied'),'Local applications')}${metric(sum('delivered'),'Context deliveries')}${metric(sum('failed'),'Unavailable / failed events')}</div><p class="note">${data.segments?`${data.segments} main-session runtime telemetry segments; cumulative snapshots are counted once and can include earlier branches.`:'Historical coverage: displayed notices only.'} Child calls remain in child accounting. Results, applications and context delivery are separate stages, not additive task successes. Emitter coverage varies: these are recorded stages, not a complete census of attempts or cache hits. Latency is measured helper time, not time saved.</p><div class="usage-components">${components}</div>`,true);
  const g=data.guardian;
  const guardian=group('usage-guardians','Guardians & WASM checks',`${count(g.classifierEvaluations)} classifier checks · ${count(g.interventionTotal)} messages`,
    `<div class="usage-mini-grid">${metric(g.toolResults,'Tool results observed')}${metric(g.classifierEvaluations,'WASM classifier checks')}${metric(g.similarityEvaluations,'WASM similarity checks')}${metric(g.admitted,'Interventions admitted')}</div>${facts([['Latest recorded snapshot',when(g.snapshotAt)],['Runtime',g.states.join(' · ')||'not recorded'],['Abstained',count(g.abstained)],['Constraint candidates / rejected',`${count(g.constraintCandidates)} / ${count(g.constraintRejected)}`],['Suppressed: window / history',`${count(g.suppressedWindow)} / ${count(g.suppressedHistory)}`],['Quarantined',count(g.quarantined)],['Peer messages sent / received',`${count(g.peerMessagesSent)} / ${count(g.peerMessagesReceived)}`]])}<p class="note">Counters cover identified Guardian lifetimes and can include earlier branches; messages below are from this retained branch. Checks are not completed work or quality scores. ${g.legacyCoverage?'Older counters without an owner ID are excluded to avoid double-counting. ':''}Missing counters stay unknown.</p>${g.interventions.map(row=>`<details class="item"><summary><span class="item-name">${esc(row.category||'Guardian message')}</span><time>${esc(when(row.at))}</time></summary><p class="usage-note">${esc(row.content)}</p></details>`).join('')}${g.interventionTotal>g.interventions.length?'<p class="note">Latest 30 messages shown.</p>':''}`);
  const o=data.observer,requests=o.requests;
  const routeCounts=new Map<string,number>();for(const row of requests??[])routeCounts.set(row.route,(routeCounts.get(row.route)??0)+1);
  const observer=group('usage-observer','Session observer',`${o.noteTotal} suggestions returned · ${o.received} provider receipts`,
    `<div class="usage-mini-grid">${metric(requests?.length,'Review requests')}${metric(o.noteTotal,'Suggestions returned')}${metric(o.received,'Provider received')}${metric(requests?.filter(row=>['failed','timeout','cancelled'].includes(row.status)).length,'Failed / timed out / cancelled')}</div><p class="note">Suggestions and receipts come from this retained branch. Provider received means the final request carried the entire suggestion and received a successful response; it never proves the agent acted on it. Missing receipts mean delivery is unknown.</p>${facts([['Prepared context receipts',`${o.prepared} recorded; context preparation alone does not prove delivery`],['Models', [...routeCounts].map(([route,n])=>`${route} · ${n} requests`).join('\n')||'not recorded'],['Review notices',Object.entries(o.statuses).map(([k,v])=>`${k}: ${v}`).join(' · ')||'none recorded'],['First / last shown notice',o.events.length?`${when(o.events[0].at)} / ${when(o.events.at(-1)?.at)}`:'not recorded'],['Usage coverage',requests?`${requests.filter(row=>row.usageRecorded).length} of ${requests.length} requests reported token usage`:'not recorded']])}<h3>Suggestion history</h3>${o.notes.length?o.notes.slice().reverse().map(row=>`<details class="item"><summary><span class="item-name">${esc(row.note.split('\n')[0].slice(0,110))}</span><span class="badge ${row.received?'complete':'info'}">${row.received?'provider received':row.prepared?'prepared':'returned'}</span></summary><p class="usage-note">${esc(row.note)}</p>${facts([['When',when(row.at)],['Delivery',row.received?`Provider received · ${when(row.received.at)} · ${row.received.provider}/${row.received.model}`:row.prepared?'Prepared in main context; provider delivery unknown':'not recorded'],['Review timing',row.detail||'not recorded'],['Evidence',row.evidence.join(', ')||'not recorded'],['Tools / skills',[...row.tools,...row.skills].join(', ')||'none recorded']])}</details>`).join(''):'<div class="empty">No returned suggestion is recorded in this branch.</div>'}${o.noteTotal>o.notes.length?'<p class="note">Latest 30 suggestions shown.</p>':''}<details class="usage-history"><summary>Review timeline · ${o.eventTotal} recorded notices</summary><ol>${o.events.slice().reverse().map(row=>`<li><time>${esc(when(row.at))}</time><span><b>${esc(row.status||'notice')}</b> · ${esc(row.detail||'No detail recorded')}</span></li>`).join('')}</ol>${o.eventTotal>o.events.length?'<p class="note">Latest 60 notices shown.</p>':''}</details>`);
  return helper+observer+guardian;
}

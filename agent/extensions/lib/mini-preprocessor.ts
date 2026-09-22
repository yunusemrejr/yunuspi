import { sessionObservability } from './session-observability.ts';
/** Local non-generative paragraph selection. The transcript always owns raw text. */
import {createHash} from 'node:crypto';
import {beginHarnessActivity} from './harness-activity.ts';
import {protectedEvidence, relevanceScores, taskTerms} from './local-intelligence.mjs';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {microMetrics} from './micro-intelligence/metrics.ts';
export type MiniSelection = {version:1;status:'SELECT';sourceHash:string;keep:number[]};
type Runtime = {version:1;enabled:true;endpoint:'http://127.0.0.1:18736/select';apiKey:string};
const dependent = /^(?:This|That|These|Those|It|They|He|She|However|Therefore|Otherwise|Instead|Consequently)\b/i;
export function miniSource(raw:string) {
 if(typeof raw!=='string'||raw.length<800||raw.length>4096||/[^\x09\x0a\x0d\x20-\x7e]/.test(raw)||/```|<\||\|>|^\s*(?:[{}\[\]]|diff --git|@@|#!|at\s+\w+\s*\()/m.test(raw))return;
 const spans:Array<[number,number]>=[];let start=0;
 for(const m of raw.matchAll(/\n[ \t]*\n+/g)){if(raw.slice(start,m.index).trim())spans.push([start,m.index]);start=m.index!+m[0].length;}
 if(raw.slice(start).trim())spans.push([start,raw.length]);
 if(spans.length<4||spans.length>24)return;
 const paragraphs=spans.map(([a,b])=>raw.slice(a,b));
 // Soft line wrapping does not change paragraph ownership or its protected
 // facts. Spans keep the exact original bytes, including those newlines.
 if(paragraphs.some(p=>!/[.!?]["')]?\s*$/.test(p)))return;
 const required=new Set<number>();
 for(let i=0;i<paragraphs.length;i++){
  if(protectedEvidence.test(paragraphs[i])||paragraphs[i].trim().split(/\s+/).length<=6)required.add(i);
  if(dependent.test(paragraphs[i].trimStart())){required.add(i);if(i)required.add(i-1);}
 }
 return {hash:createHash('sha256').update(raw).digest('hex'),paragraphs,spans,required};
}
export function validateMiniSelection(raw:string,value:unknown):MiniSelection|undefined {
 const source=miniSource(raw),v=value as MiniSelection;
 if(!source||!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='keep,sourceHash,status,version'||v.version!==1||v.status!=='SELECT'||v.sourceHash!==source.hash||!Array.isArray(v.keep)||!v.keep.length||v.keep.length>24)return;
 if(v.keep.some((id,i)=>!Number.isSafeInteger(id)||id<0||id>=source.paragraphs.length||i>0&&id<=v.keep[i-1])||[...source.required].some(id=>!v.keep.includes(id)))return;
 return {version:1,status:'SELECT',sourceHash:source.hash,keep:[...v.keep]};
}
export function miniProjection(raw:string,value:unknown):string|undefined {
 const selected=validateMiniSelection(raw,value);if(!selected)return;
 const source=miniSource(raw)!;
 // Exact complete source paragraphs; IDs and ranges are independently reconstructed.
 return `[incomplete extract; sha256:${source.hash}; spans:${selected.keep.map(i=>source.spans[i].join(':')).join(',')}]\n`+selected.keep.map(i=>source.paragraphs[i]).join('\n\n');
}
/** Check the best possible valid extract before spending CPU on inference. */
export function miniPotentialSavings(raw:string,task=""):number {
 const source=miniSource(raw);if(!source)return 0;
 const scores=relevanceScores(source.paragraphs,task);
 const keep=[...new Set([...source.required,...scores.flatMap((score:number,i:number)=>score>0?[i]:[])])].sort((a,b)=>a-b);
 // A nonempty selection is required; choose the shortest possible paragraph.
 if(!keep.length)keep.push(source.paragraphs.reduce((best,p,i)=>p.length<source.paragraphs[best].length?i:best,0));
 const best=miniProjection(raw,{version:1,status:'SELECT',sourceHash:source.hash,keep});
 const saved=best?raw.length-best.length-256:0;
 return saved>=150 && saved/raw.length>=.15?saved:0;
}
// Context capacity still matters on cheap/free main routes. At this threshold
// the existing ten-second single-flight worker limit bounds local CPU use.
// .25 (was .35): on cheap/free routes the dollar gate can never pass, so the
// ratio floor is the only path — and 35% admitted nothing all day (0 hits).
const usefulContextSaving = (saved:number, total:number) => saved >= 1024 && saved / total >= .25;
async function loadRuntime():Promise<Runtime|undefined>{
 if(process.env.PI_MINI_PREPROCESSOR==='off')return;
 let handle;try{
  handle=await open(fileURLToPath(new URL('../../local-models/kompress-small/runtime.json',import.meta.url)),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const st=await handle.stat();if(!st.isFile()||st.size>8192)return;
  const bytes=Buffer.alloc(8193);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);if(bytesRead>8192)return;
  const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytesRead)));
  if(v.version===1&&v.enabled===true&&v.endpoint==='http://127.0.0.1:18736/select'&&typeof v.apiKey==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(v.apiKey))return v;
 }catch{}finally{await handle?.close().catch(()=>{});}
}
export function createMiniPreprocessor(options:{runtime?:Runtime;fetch?:typeof fetch;now?:()=>number}={}){
 let runtime=options.runtime,busy=false,last=-Infinity,generation=0;const now=options.now??Date.now,request=options.fetch??fetch;let current:AbortController|undefined;
 const cache=new Map<string,MiniSelection>();
 let failures=0;
 const stats={requests:0,cacheHits:0,accepted:0,fallbacks:0,timeouts:0,projectedSavedChars:0};
 // The shared service warms once at startup. Per-client warmups consume its
 // fleet-wide rate limit and can starve the first real selection.
 if(!runtime)void loadRuntime().then(v=>{runtime=v;});
 // Turn boundary: validated cache and in-flight selections stay valid (keyed by
 // source+task hash), so unlike reset this neither aborts nor clears.
 const endTurn=()=>{};
 return {
  reset(){generation++;current?.abort();cache.clear();},
  endTurn,
  inspect(){return {...stats,status:process.env.PI_MINI_PREPROCESSOR==='off'?'disabled':!runtime?'unavailable':busy?'busy':'ready',cached:cache.size,busy,cooldownMs:Math.max(0,last+Math.min(60000,10000*2**failures)-now())};},
  async select(raw:string,inputUsdPerMillion:unknown,task=''):Promise<MiniSelection|undefined>{
   const metrics=microMetrics();metrics.offer('kompress');
   const skip=(reason:string)=>{metrics.skip('kompress',reason);};
   if(process.env.PI_MINI_PREPROCESSOR==='off'){skip('disabled');return;}
   if(!runtime){skip('no-runtime');return;}
   // Unknown-price providers still benefit from the measured context floor.
   const inputPrice=typeof inputUsdPerMillion==='number'&&Number.isFinite(inputUsdPerMillion)?Math.max(0,inputUsdPerMillion):0;
   const source=miniSource(raw);if(!source){skip('ineligible');return;}
   const signal=process.env.PI_LOCAL_INTELLIGENCE==='off'?'':taskTerms(task).sort().join(' ');
   const key=source.hash+':'+createHash('sha256').update(signal).digest('hex');
   const cached=validateMiniSelection(raw,cache.get(key));
   if(cached){
    beginHarnessActivity('kompress')('cached');
    cache.delete(key);cache.set(key,cached);stats.cacheHits++;metrics.cacheHit('kompress');
    // Cache owns its own IDs: callers cannot mutate a future source projection.
    return {...cached,keep:[...cached.keep]};
   }
   if(busy||now()-last<Math.min(60000,10000*2**failures)){skip(busy?'busy':'cooldown');return;}
   // Conservative local compute budget proxy: $0.00002/CPU-second, 10x margin.
   // Newly produced tool bytes have not appeared in the provider prefix yet.
   const potential=miniPotentialSavings(raw,signal);
   if(!potential || !usefulContextSaving(potential,raw.length) && potential/6*inputPrice/1e6 < .45*.00002*10){skip('insufficient-savings');return;}
   const epoch=generation,abort=new AbortController();current=abort;busy=true;last=now();const started=performance.now();
   stats.requests++;let accepted=false,valid=false;
   const finishActivity=beginHarnessActivity('kompress');
   const deadline=new Promise<never>((_,reject)=>abort.signal.addEventListener("abort",()=>reject(new Error("mini preprocessing cancelled")),{once:true}));
   let expired=false;
   const timer=setTimeout(()=>{expired=true;abort.abort();},450);timer.unref?.();
   try{
    const res=await Promise.race([deadline, request(runtime.endpoint,{method:'POST',redirect:'error',signal:abort.signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${runtime.apiKey}`},body:JSON.stringify({version:1,raw})})]);
    if(!res.ok){valid=res.status===429||res.status===503;void res.body?.cancel().catch(()=>{});return;}
    if(!res.body)return;
    const reader=res.body.getReader();const chunks:Uint8Array[]=[];let length=0;
    try{while(true){const part=await Promise.race([deadline,reader.read()]);if(part.done)break;length+=part.value.byteLength;if(length>2048){void reader.cancel().catch(()=>{});return;}chunks.push(part.value);}}finally{reader.releaseLock();}
    if(abort.signal.aborted||generation!==epoch)return;
    const wire=Buffer.concat(chunks).toString('utf8');
    if(/^\s*\{\s*"version"\s*:\s*1\s*,\s*"status"\s*:\s*"UNKNOWN"\s*\}\s*$/.test(wire)){valid=true;return;}
    // Refuse duplicate/escaped/extra keys before JSON parsing.
    if(!/^\s*\{\s*"version"\s*:\s*1\s*,\s*"status"\s*:\s*"SELECT"\s*,\s*"sourceHash"\s*:\s*"[a-f0-9]{64}"\s*,\s*"keep"\s*:\s*\[\s*\d+(?:\s*,\s*\d+)*\s*\]\s*\}\s*$/.test(wire))return;
    let selection=validateMiniSelection(raw,JSON.parse(wire));if(!selection)return;valid=true;
    // Kompress is a token classifier, not an instruction model. Condition its
    // source-ID proposal locally; never prepend a prompt outside its training
    // distribution or allow task relevance to erase protected evidence.
    const scores=relevanceScores(source.paragraphs,signal);
    selection={...selection,keep:[...new Set([...selection.keep,...scores.flatMap((score:number,i:number)=>score>0?[i]:[])])].sort((a,b)=>a-b)};
    const projection=miniProjection(raw,selection)!;const saved=raw.length-projection.length-256;
    if(saved<150||saved/raw.length<.15||!usefulContextSaving(saved,raw.length)&&saved/6*inputPrice/1e6<(performance.now()-started)/1000*.00002*10)return;
    if(cache.size>=16)cache.delete(cache.keys().next().value!);
    cache.set(key,{...selection,keep:[...selection.keep]});accepted=true;failures=0;stats.accepted++;stats.projectedSavedChars+=saved;
    metrics.accept('kompress',saved,true);
    return selection;
   }catch{return;}finally{
    clearTimeout(timer);
    metrics.run('kompress',performance.now()-started,raw.length);
    if(!accepted)skip(expired?'timeout':valid?'no-useful-selection':'invalid-selection');
    finishActivity(epoch!==generation?'cancelled':expired||!valid?'error':accepted?'ok':'skipped');
    if(!accepted && epoch===generation){failures=valid?0:Math.min(3,failures+1);stats.fallbacks++;if(expired)stats.timeouts++;}
    try{sessionObservability()[Symbol.for('yunus-pi.health.v1')]?.('ml.mini.select',{decision:accepted?'selected':'raw',durationMs:performance.now()-started,count:1});}catch{}
    if(current===abort){busy=false;current=undefined;}
   }
  }
 };
}

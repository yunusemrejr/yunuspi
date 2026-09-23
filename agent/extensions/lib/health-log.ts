import {mkdir,open} from 'node:fs/promises';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const zip=promisify(gzip);
export const HEALTH_SINK=Symbol.for('yunus-pi.health.v1');
const fields=new Set(['tool','hook','owner','decision','skill','route','outcome','durationMs','similarity','overlap','count','evaluations','similarityEvaluations','dropped','isError','partial','inputTokens','outputTokens','helper','runtime','op','cached','coalesced','shadow','accepted','reason','shape','smol','kompress','needle','jev','savedChars','questions','findings']);
export function safeHealthEvent(kind:string,data:Record<string,unknown>={}) {
 const event:Record<string,unknown>={v:1,t:Date.now(),kind:kind.replace(/[^a-z0-9_.-]/gi,'_').slice(0,64)};
 for(const [k,v] of Object.entries(data))if(fields.has(k)) {
  if(typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))event[k]=v;
  else if(typeof v==='string'&&/^[a-z0-9_.:/-]{1,120}$/i.test(v))event[k]=v;
 }
 if(kind==='ml.evidence.route'&&Array.isArray(data.reasons))event.reasons=data.reasons.filter((value):value is string=>typeof value==='string'&&/^[a-z0-9_.:-]{1,80}$/i.test(value)).slice(0,16);
 return event;
}
/** Concatenated gzip members: each successful flush is independently decompressible.
 * Bounded queue and per-process session segment; errors never break inference. */
export function createHealthLog(directory:string,session:string) {
 const segment=randomUUID();
 const file=path.join(directory,`${session.replace(/[^a-z0-9_-]/gi,'_').slice(0,80)||'unknown'}-${segment}.jsonl.gz`);
 let queue:string[]=[],bytes=0,total=0,dropped=0,closed=false,failures=0;
 let chain:Promise<boolean>=Promise.resolve(true);
 const flush=()=>{
  chain=chain.then(async()=>{
   if(!queue.length&&!dropped)return true;
   // Keep the batch until append succeeds. A transient disk error must not erase it.
   const count=queue.length,lost=dropped,batchBytes=bytes;
   const batch=queue.join('')+(lost?JSON.stringify(safeHealthEvent('log.loss',{dropped:lost}))+'\n':'');
   try{
    await mkdir(directory,{recursive:true,mode:0o700});
    const data=await zip(batch,{level:1});
    const handle=await open(file,'a',0o600);
    try{
     const size=(await handle.stat()).size;
     try{await handle.writeFile(data);}catch(error){await handle.truncate(size);throw error;}
    }finally{await handle.close();}
    queue.splice(0,count);bytes-=batchBytes;dropped-=lost;return true;
   }catch{failures++;return false;}
  });
  return chain;
 };
 return {file,record(kind:string,data:Record<string,unknown>={}){
  if(closed)return;
  const line=JSON.stringify(safeHealthEvent(kind,data))+'\n';
  if(bytes+line.length>128*1024||total+line.length>16*1024*1024){dropped++;return;}
  queue.push(line);bytes+=line.length;total+=line.length;
 },flush,close(){closed=true;return flush();},get dropped(){return dropped;},get pending(){return queue.length;},get failures(){return failures;}};
}

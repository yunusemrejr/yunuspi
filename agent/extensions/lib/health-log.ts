import {mkdir,appendFile} from 'node:fs/promises';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const zip=promisify(gzip);
export const HEALTH_SINK=Symbol.for('yunus-pi.health.v1');
const fields=new Set(['tool','hook','decision','skill','route','outcome','durationMs','similarity','overlap','count','dropped','isError','partial','inputTokens','outputTokens']);
export function safeHealthEvent(kind:string,data:Record<string,unknown>={}) {
 const event:Record<string,unknown>={v:1,t:Date.now(),kind:kind.replace(/[^a-z0-9_.-]/gi,'_').slice(0,64)};
 for(const [k,v] of Object.entries(data))if(fields.has(k)) {
  if(typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))event[k]=v;
  else if(typeof v==='string'&&/^[a-z0-9_.:/-]{1,120}$/i.test(v))event[k]=v;
 }
 return event;
}
/** Concatenated gzip members: each successful flush is independently decompressible.
 * Bounded queue and per-process session segment; errors never break inference. */
export function createHealthLog(directory:string,session:string) {
 const segment=randomUUID();
 const file=path.join(directory,`${session.replace(/[^a-z0-9_-]/gi,'_').slice(0,80)||'unknown'}-${segment}.jsonl.gz`);
 let queue:string[]=[],bytes=0,total=0,dropped=0,chain=Promise.resolve(),busy=false;
 const flush=()=>{
  if(busy||!queue.length)return chain;
  const batch=queue.join('');queue=[];bytes=0;busy=true;
  chain=chain.then(async()=>{try{await mkdir(directory,{recursive:true,mode:0o700});const data=await zip(batch,{level:1});await appendFile(file,data,{mode:0o600});}catch{dropped++;}finally{busy=false;}});
  return chain;
 };
 return {file,record(kind:string,data:Record<string,unknown>={}){
  const line=JSON.stringify(safeHealthEvent(kind,data))+'\n';
  if(bytes+line.length>128*1024||total+line.length>16*1024*1024){dropped++;return;}
  if(dropped){const loss=JSON.stringify(safeHealthEvent('log.loss',{dropped}))+'\n';queue.push(loss);bytes+=loss.length;total+=loss.length;dropped=0;}
  queue.push(line);bytes+=line.length;total+=line.length;
 },flush,async close(){await flush();if(dropped){queue.push(JSON.stringify(safeHealthEvent('log.loss',{dropped}))+'\n');dropped=0;}await flush();},get dropped(){return dropped;}};
}

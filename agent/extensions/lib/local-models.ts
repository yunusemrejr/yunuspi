import {boundedContextLimit,positiveTokenLimit} from "./context-limits.ts";
/** Local runtime metadata only: no inference, downloads, model loads or subprocesses. */
import {readFileSync} from 'node:fs';
import path from 'node:path';
const positive=positiveTokenLimit;
export function loopbackBase(value:string): URL | undefined {
  try { const u=new URL(value);const h=u.hostname;
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return;
    if(h==='localhost'||h==='localhost.'||h==='[::1]'||/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(h))return u;
  } catch {}
}
const compat={supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:false,supportsStrictMode:false,supportsLongCacheRetention:false,maxTokensField:'max_tokens'};
export function mapLocalModels(kind:string, body:any, configured:any={}) {
  const rows=kind==='lmstudio' ? body?.models ?? body?.data : body?.models;
  if(!Array.isArray(rows))throw Error('Malformed local model list');
  const models:any[]=[];
  for(const row of rows.slice(0,256)) {
    if(!row || typeof row!=="object")continue;
    if(kind==='lmstudio' && row.type!=='llm' && row.type!=='vlm')continue;
    const instances=kind==='lmstudio' ? (Array.isArray(row.loaded_instances)?row.loaded_instances:row.state==='loaded'?[{id:row.id,config:{context_length:row.loaded_context_length}}]:[]) : [{id:row.name ?? row.model,config:{context_length:row.context_length}}];
    for(const instance of instances.slice(0,64)) {
      if(!instance || typeof instance!=="object")continue;
      const id=instance.id;if(typeof id!=='string'||!id||id.length>256)continue;
      const explicit=configured.modelOverrides?.[id] ?? {};
      // Never substitute the architecture maximum for the active allocation.
      const contextWindow=boundedContextLimit(explicit.contextWindow,instance.config?.context_length);
      // Older endpoints may omit allocation; require an explicit override instead of lying.
      if(!contextWindow)continue;
      const output=positive(explicit.maxTokens)??Math.min(8192,Math.max(512,Math.floor(contextWindow/4)));
      const capabilities=row.capabilities;
      const vision=kind==='lmstudio' && (capabilities?.vision===true||row.type==='vlm');
      models.push({id,name:`${row.display_name ?? id} (local, ${contextWindow} context${row.capabilities?.trained_for_tool_use===false ? "; tool use untrained" : ""})`,api:'openai-completions',
        reasoning:false,input:vision?['text','image']:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
        ...explicit,_piAllocatedContext:positive(instance.config?.context_length),contextWindow,maxTokens:Math.min(output,contextWindow),
        compat:{...compat,...configured.compat,...explicit.compat}});
    }
  }
  return [...new Map(models.map(m=>[m.id,m])).values()];
}
export function registerLocalModels(pi:any,agentDir:string):string[] {
  if(process.env.PI_LOCAL_MODELS==='off')return [];
  let providers:any={};try{providers=JSON.parse(readFileSync(path.join(agentDir,'models.json'),'utf8')).providers??{};}catch{}
  const ids:string[]=[];
  for(const [id,name,fallback] of [['lmstudio','LM Studio','http://127.0.0.1:1234/v1'],['ollama-local','Ollama Local','http://127.0.0.1:11434/v1']]) {
    const config=providers[id]??{},base=loopbackBase(config.baseUrl??fallback);if(!base)continue;
    let cache:any[]=[],last=0,pending:Promise<any[]>|undefined;
    const fetchModels=async(ctx:any)=>{
      if(ctx.signal?.aborted||ctx.allowNetwork===false||process.env.PI_OFFLINE==='1')return cache;
      if(!ctx.force&&Date.now()-last<15000)return cache;
      if(pending)return pending;
      const work=async()=>{
        const signal=ctx.signal?AbortSignal.any([ctx.signal,AbortSignal.timeout(2000)]):AbortSignal.timeout(2000);
        const key=ctx.credential?.type==='api_key'?ctx.credential.key:undefined;
        const headers=key?{Authorization:`Bearer ${key}`} : undefined;
        const get=async(endpoint:string)=>{
          const response=await fetch(new URL(endpoint,base),{signal,headers,redirect:'error'});
          if(!response.ok)throw Object.assign(Error('Local metadata unavailable'),{status:response.status});
          const reader=response.body?.getReader();if(!reader)throw Error('Empty local metadata');
          const chunks:Uint8Array[]=[];let bytes=0;
          try { while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;
            if(bytes>2_000_000){await reader.cancel();throw Error('Local metadata too large');}chunks.push(part.value);}
          } finally {reader.releaseLock();}
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        };
        try {
          let data;
          if(id==='lmstudio') {
            try{data=await get('/api/v1/models');}
            catch(error:any){if(error.status!==404)throw error;data=await get('/api/v0/models');}
          } else data=await get('/api/ps');
          const next=mapLocalModels(id,data,config);if(ctx.signal?.aborted)return cache;
          cache=next;last=Date.now();
          try{(globalThis as any)[Symbol.for('yunus-pi.health.v1')]?.('local.refresh',{route:id,outcome:'ok',count:next.length});}catch{}
          return cache;
        } catch { if(!ctx.signal?.aborted){cache=[];last=Date.now();try{(globalThis as any)[Symbol.for('yunus-pi.health.v1')]?.('local.refresh',{route:id,outcome:'unavailable',isError:true});}catch{}}return cache; }
      };
      pending=work();try{return await pending;}finally{pending=undefined;}
    };
    pi.registerProvider(id,{name,baseUrl:base.href,api:config.api??'openai-completions',
      apiKey:config.apiKey??'local-no-key',...(config.headers?{headers:config.headers}:{}),refreshModels:fetchModels});
    ids.push(id);
  }
  return ids;
}

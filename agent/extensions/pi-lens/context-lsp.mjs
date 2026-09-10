/** Optional read-only access to already running Pi Lens clients. Never starts servers. */
import path from 'node:path';
let selectClients;
const pending=new WeakSet();
export function configureContextLsp(selector) {selectClients=selector;}
export async function expandWithLsp({ctx,path:relative,line,character=1,signal}) {
  if(signal?.aborted)return {used:false,reason:'Cancelled'};
  if(!selectClients)return {used:false,reason:'Pi Lens active-client adapter unavailable'};
  const filename=path.resolve(ctx.cwd,relative);
  const entries=selectClients(ctx,filename)??[];
  const entry=entries.find(({client})=>client.isDocumentOpen(filename)&&!client.isBusy()&&!pending.has(client));
  if(!entry)return {used:false,reason:'No idle, already-running LSP client has this document open'};
  const {client,serverId}=entry,support=client.getOperationSupport();
  const operations=['references','typeDefinition'].filter(name=>support[name]&&typeof client[name]==='function');
  if(!operations.length)return {used:false,reason:'Active server lacks reference/type operations'};
  pending.add(client);
  const work=Promise.all(operations.map(async operation=>{
    try {const locations=await client[operation](filename,line-1,character-1);return {operation,locations:Array.isArray(locations)?locations.slice(0,12):[],omitted:Array.isArray(locations)?Math.max(0,locations.length-12):0};}
    catch(error){return {operation,error:String(error.message).slice(0,160)};}
  })).finally(()=>pending.delete(client));
  let timer;
  try {
    return await Promise.race([work.then(results=>({used:true,serverId,provenance:'Existing language-server snapshot; source freshness not independently verified',results})),new Promise(resolve=>{timer=setTimeout(()=>resolve({used:false,reason:'LSP exceeded 150 ms budget; AST candidates retained'}),150);})]);
  } finally {clearTimeout(timer);}
}

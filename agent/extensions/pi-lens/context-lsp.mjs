/** Adapters for existing Pi Lens clients and owned deferred source mutations. */
import path from 'node:path';
import fs from 'node:fs';
import { projectCheckCommand, checkInvocation } from '../lib/project-tests.ts';
let selectClients;
const pending=new WeakSet();
export function configureContextLsp(selector) {selectClients=selector;}

// The check owner awaits this before capturing source identity. Lens's own
// tool_call also uses it when hosted without the native checkpoint owner.
const mutationDrains = new WeakMap();
const mutationOwner = ctx => {
  try { return JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId()]); } catch { return undefined; }
};
export function configureDeferredMutationDrain(ctx, drain, readbackPaths) {
  if (!ctx?.sessionManager || typeof drain !== 'function') return;
  const owner=mutationOwner(ctx),current=mutationDrains.get(ctx.sessionManager);
  if (current?.owner===owner) Object.assign(current,{drain,readbackPaths});
  else mutationDrains.set(ctx.sessionManager, {owner,drain,readbackPaths});
}
function fullProseRead(event,ctx,filename) {
  if (event.input.offset !== undefined && event.input.offset !== 1) return false;
  try {
    const stat=fs.lstatSync(filename),relative=path.relative(fs.realpathSync(ctx.cwd),fs.realpathSync(filename));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size>16384 || !relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const lines=fs.readFileSync(filename,'utf8').split('\n').length,limit=event.input.limit;
    return lines<=200 && (limit===undefined || Number.isSafeInteger(limit) && limit>=lines);
  } catch { return false; }
}
export async function flushLensBeforeVerification(event, ctx, declaredCheck = false) {
  const record = ctx?.sessionManager && mutationDrains.get(ctx.sessionManager);
  if (!record || record.owner === undefined || record.owner !== mutationOwner(ctx) || ctx.signal?.aborted) return;
  const name = event?.toolName;
  const command = event?.input?.command;
  const check = ['bash','bg_run'].includes(name) && projectCheckCommand(checkInvocation(command)?.body ?? command,ctx.cwd,declaredCheck);
  try {
    let readbackPath;
    if (name==='read' && typeof event.input?.path==='string' && /\.(?:md|rst|txt)$/i.test(event.input.path)) {
      const filename=path.resolve(ctx.cwd,event.input.path);
      // This schedules owned source work, never grants a Guardian exception.
      // Its native read/edit hash equality remains authoritative afterwards.
      if ((!record.flightPaths?.has(filename) && !record.readbackPaths?.(ctx)?.includes(filename)) || !fullProseRead(event,ctx,filename)) return;
      readbackPath=filename;
    } else if (!check && !['project_tests','quality_review'].includes(name)) return;
    while (record.flight) {
      const covers=record.flightPath===undefined || record.flightPath===readbackPath;
      const result=await record.flight;
      if (result || covers) return result;
    }
    const paths=record.readbackPaths?.(ctx) ?? [];
    if (readbackPath && !paths.includes(readbackPath)) return;
    record.flightPath=readbackPath;
    record.flightPaths=new Set(readbackPath ? [readbackPath] : paths);
    const flight=Promise.resolve().then(()=>record.drain(ctx,readbackPath)).finally(()=>{if(record.flight===flight){record.flight=undefined;record.flightPaths=undefined;record.flightPath=undefined;}});
    record.flight=flight;
    return await flight;
  }
  catch { return {block:true,reason:'Pi Lens deferred source mutations could not finish before verification. Resolve the formatter/autofix failure and rerun this check/review.'}; }
}
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {register} from 'node:module';
import {pathToFileURL} from 'node:url';
const template=path.resolve(import.meta.dirname,'..');
const agent=[path.join(template,'agent'),path.resolve(template,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-memory/index.ts')));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-memory-exit-budget-'));
register('data:text/javascript,'+encodeURIComponent(`export function resolve(name,ctx,next){
 const sources={
 '@yunuspi/coding-agent':'export function convertToLlm(v){return v};export function serializeConversation(){return "fixture conversation"};export function getAgentDir(){return ${JSON.stringify(root)}};export function withFileMutationQueue(_p,fn){return fn()}',
 '@yunuspi/ai/compat':'export async function complete(...args){return globalThis.__exitBudgetComplete(...args)}'};
 return name in sources?{url:'data:text/javascript,'+encodeURIComponent(sources[name]),shortCircuit:true}:next(name,ctx);
}`),import.meta.url);
const memory=await import(pathToFileURL(path.join(agent,'extensions/pi-memory/index.ts')));
const {registerPriming}=await import(pathToFileURL(path.join(agent,'extensions/pi-memory/priming.ts')));
const original=Object.fromEntries(['PI_MEMORY_QMD_UPDATE','PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS','PI_MEMORY_EXIT_SUMMARY_MODEL','PI_MEMORY_EXIT_SUMMARY','PI_OFFLINE'].map(k=>[k,process.env[k]]));
// Keep the real schema constructors; only provider completion is intercepted.
// Isolate host/offline runner settings without weakening the runtime contract.
delete process.env.PI_MEMORY_EXIT_SUMMARY_MODEL;
delete process.env.PI_OFFLINE;
process.env.PI_MEMORY_EXIT_SUMMARY='1';
process.env.PI_MEMORY_QMD_UPDATE='off';
process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS='20';
function fixture(branch, model = {provider:"fixture",id:"costly"}, getApiKey = async()=> "fixture-only"){
 const hooks={};memory._setBaseDir(root);
 memory.default({on:(name,fn)=>{hooks[name]=fn},registerTool(){},registerCommand(){},appendEntry:(customType,data)=>branch?.push({type:"custom",customType,data})});
 const ctx={cwd:root,hasUI:false,model,modelRegistry:{getApiKey,find:()=>undefined},sessionManager:{getSessionId:()=> 'fixture',getBranch:()=>branch??Array.from({length:4},()=>({type:'message',message:{role:'user',content:'fixture'}}))}};
 return (name='session_shutdown')=>hooks[name]({reason:'quit'},ctx);
}
test.after(()=>{fs.rmSync(root,{recursive:true,force:true});delete globalThis.__exitBudgetComplete;for(const[k,v]of Object.entries(original))v===undefined?delete process.env[k]:process.env[k]=v;});
test('summary timeout aborts the provider request and bounds output',async()=>{
 let options;
 globalThis.__exitBudgetComplete=(_m,_c,o)=>{options=o;return new Promise(resolve=>o.signal?.addEventListener('abort',()=>resolve({content:[],stopReason:'aborted'}),{once:true}));};
 await fixture()();
 assert.ok(options.signal.aborted,'timeout must reach provider cancellation');
 assert.equal(options.maxTokens,2048);
});
test('missing explicit cheap summary route never falls back to the active model',async()=>{
 let calls=0;globalThis.__exitBudgetComplete=async()=>{calls++;return{content:[]}};
 process.env.PI_MEMORY_EXIT_SUMMARY_MODEL='fixture/missing';
 try{await fixture()();assert.equal(calls,0);}finally{delete process.env.PI_MEMORY_EXIT_SUMMARY_MODEL;}
});
test('offline mode makes no automatic summary request',async()=>{
 let calls=0;globalThis.__exitBudgetComplete=async()=>{calls++;return{content:[]}};
 process.env.PI_OFFLINE='1';
 try{await fixture()();assert.equal(calls,0);}finally{delete process.env.PI_OFFLINE;}
});
test('truncated summary text is never persisted as completed memory',async()=>{
 globalThis.__exitBudgetComplete=async()=>({content:[{type:'text',text:'UNFINISHED_SUMMARY_SENTINEL'}],stopReason:'length'});
 await fixture()();
 const files=fs.readdirSync(root,{recursive:true}).filter(f=>f.endsWith('.md'));
 for(const file of files)assert.equal(fs.readFileSync(path.join(root,file),'utf8').includes('UNFINISHED_SUMMARY_SENTINEL'),false);
});

test('resuming unchanged summarized history makes no second request; new messages do',async()=>{
 let calls=0;globalThis.__exitBudgetComplete=async()=>{calls++;return{content:[{type:'text',text:'### Decisions\n- Keep the documented interface.'}],stopReason:'stop'}};
 const branch=Array.from({length:4},(_,i)=>({type:'message',id:`message-${i}`,message:{role:'user',content:'fixture'}}));
 await fixture(branch)();
 await fixture(branch)();
 assert.equal(calls,1);
 assert.equal(branch.filter(e=>e.customType==='memory-exit-summary-v1').length,1);
 branch.push({type:'message',id:'message-new',message:{role:'user',content:'New work'}});
 await fixture(branch)();
 assert.equal(calls,2);
});

test('summary output cap respects a smaller model limit',async()=>{
 let cap;globalThis.__exitBudgetComplete=async(_m,_c,o)=>{cap=o.maxTokens;return{content:[],stopReason:'stop'}};
 await fixture(undefined,{provider:'fixture',id:'small',maxTokens:512})();
 assert.equal(cap,512);
});

test('a credential lookup resolving after the deadline cannot launch a late request',async()=>{
 let calls=0,release;globalThis.__exitBudgetComplete=async()=>{calls++;return{content:[]}};
 const key=new Promise(resolve=>{release=resolve});
 await fixture(undefined,undefined,()=>key)();
 release('fixture-only');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,0);
});


test('compaction never copies the daily log into itself or repeats unchanged scratchpad snapshots',async()=>{
 fs.writeFileSync(path.join(root,'SCRATCHPAD.md'),'- [ ] COMPACTION_OPEN_ITEM\n');
 const compact=fixture();
 await compact('session_before_compact');
 const files=fs.readdirSync(root,{recursive:true}).filter(file=>file.endsWith('.md') && fs.readFileSync(path.join(root,file),'utf8').includes('HANDOFF_STATE'));
 assert.equal(files.length,1);
 const file=path.join(root,files[0]);
 fs.appendFileSync(file,'\nDAILY_TAIL_SENTINEL\n');
 const before=fs.readFileSync(file,'utf8');
 for(let i=0;i<5;i++) await compact('session_before_compact');
 assert.equal(fs.readFileSync(file,'utf8'),before);
 fs.appendFileSync(path.join(root,'SCRATCHPAD.md'),'- [ ] SECOND_OPEN_ITEM\n');
 await compact('session_before_compact');
 const after=fs.readFileSync(file,'utf8');
 assert.equal(after.split('DAILY_TAIL_SENTINEL').length-1,1);
 assert.equal(after.split('<!-- HANDOFF_STATE').length-1,2);
 assert.match(after,/SECOND_OPEN_ITEM/);
});

test('default priming selects relevant project history once and abstains on generic or unrelated prompts',async()=>{
 const cwd=path.join(root,'widget');fs.mkdirSync(cwd,{recursive:true});
 const project=path.join(cwd,'project.md'),daily=path.join(cwd,'daily'),global=path.join(cwd,'global.md');
 fs.mkdirSync(daily,{recursive:true});
 fs.writeFileSync(project,'Widget authentication requires the current scoped cache policy.\n');
 fs.writeFileSync(path.join(daily,'2026-01-01.md'),'Widget deployment used a previous release branch.\n');
 fs.writeFileSync(global,'Widget authentication GLOBAL_OUT_OF_SCOPE reference.\n');
 fs.rmSync(path.join(root,'memory-priming.json'),{force:true});
 const make=()=>{
  const hooks={},entries=[];
  registerPriming({on:(name,fn)=>hooks[name]=fn,registerCommand(){},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})},()=>({project,daily,global}));
  const ctx={cwd,sessionManager:{getEntries:()=>entries}};
  return {entries,start:()=>hooks.session_start({},ctx),prompt:prompt=>hooks.before_agent_start({prompt},ctx)};
 };
 const f=make();f.start();
 assert.equal(await f.prompt('Continue working on this project'),undefined,'generic continuation does not spend the priming attempt');
 assert.equal(f.entries.length,0);
 const result=await f.prompt('Review widget authentication');
 assert.match(result?.message.content??'',/current scoped cache policy/,'missing config enables selective retrieval');
 assert.doesNotMatch(result.message.content,/previous release branch|GLOBAL_OUT_OF_SCOPE/);
 assert.ok(result.message.content.length<1800);
 assert.equal(await f.prompt('Review widget authentication'),undefined);
 f.start();assert.equal(await f.prompt('Review widget authentication'),undefined,'resume preserves the once-session receipt');
 const unrelated=make();unrelated.start();
 assert.equal(await unrelated.prompt('authentication astronomy'),undefined,'project directory names do not supply a second task match');
 const empty=make();empty.start();assert.equal(await empty.prompt(''),undefined);assert.equal(empty.entries.length,0);
});

test('explicit global and project priming opt-outs remain authoritative',async()=>{
 const cwd=path.join(root,'opt-out-project');fs.mkdirSync(cwd,{recursive:true});
 const project=path.join(cwd,'memory.md');fs.writeFileSync(project,'Widget authentication requires the current scoped cache policy.\n');
 const config=path.join(root,'memory-priming.json');
 try {
  for(const settings of [{enabled:false,projects:{}},{enabled:true,projects:{[cwd]:false}}]){
   fs.writeFileSync(config,JSON.stringify(settings));
   const hooks={},entries=[];
   registerPriming({on:(name,fn)=>hooks[name]=fn,registerCommand(){},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})},()=>({project,global:project,daily:path.join(cwd,'missing')}));
   const ctx={cwd,sessionManager:{getEntries:()=>entries}};hooks.session_start({},ctx);
   assert.equal(await hooks.before_agent_start({prompt:'widget authentication'},ctx),undefined);
   assert.equal(entries.length,0,'an explicit opt-out never consumes a priming attempt');
  }
 } finally {fs.rmSync(config,{force:true});}
});

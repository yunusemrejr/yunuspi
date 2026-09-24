import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {register} from 'node:module';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const release=path.resolve(import.meta.dirname,'..');
const agent=fs.existsSync(path.join(release,'agent'))?path.join(release,'agent'):path.dirname(release);
// Only resolve authored .js specifiers to their TS sources; no runtime or model mocks.
register('data:text/javascript,'+encodeURIComponent(`import fs from 'node:fs';export function resolve(n,c,next){if(n.startsWith('.')&&n.endsWith('.js')){const u=new URL(n.slice(0,-3)+'.ts',c.parentURL);if(fs.existsSync(u))return next(u.href,c);}return next(n,c);}`),import.meta.url);
const load=name=>import(pathToFileURL(path.join(agent,'extensions/rpiv-todo',name)).href);
const {applyTaskMutation}=await load('state/state-reducer.ts');
const {replayFromBranch}=await load('state/replay.ts');
const {renderPlan}=await load('state/plan.ts');
test('public action plan graph is atomic, recoverable and actionable',()=>{
 const empty={tasks:[],nextId:1};
 const made=applyTaskMutation(empty,'batch',{operations:[{action:'create',id:-1,subject:'Outcome'},{action:'create',id:-2,parentId:-1,subject:'Inspect',execution:'swarm'},{action:'create',parentId:-1,subject:'Verify',blockedBy:[-2],acceptance:'Check behavior'}]});
 assert.equal(made.op.kind,'batch');assert.equal(made.state.tasks.length,3);assert.equal(empty.tasks.length,0);
 const bad=applyTaskMutation(made.state,'batch',{operations:[{action:'create',subject:'temporary'},{action:'update',id:1,parentId:2}]});assert.equal(bad.op.kind,'error');assert.equal(bad.state,made.state);
 assert.equal(applyTaskMutation(made.state,'update',{id:3,status:'completed'}).op.kind,'error');
 assert.match(renderPlan(made.state.tasks,'frontier'),/#2 <#1/);assert.doesNotMatch(renderPlan(made.state.tasks,'frontier'),/#3 <#1/);
 const branch=[{type:'message',message:{role:'toolResult',toolName:'todo',details:made.state}}];
 assert.deepEqual(replayFromBranch({sessionManager:{getBranch:()=>branch}}),made.state);
});

test('action plans reject deleting a task that still blocks live work',()=>{
 const empty={tasks:[],nextId:1};
 const made=applyTaskMutation(empty,'batch',{operations:[
  {action:'create',id:-1,subject:'Dependency'},
  {action:'create',subject:'Dependent',blockedBy:[-1]},
 ]});
 const deleted=applyTaskMutation(made.state,'delete',{id:1});
 assert.equal(deleted.op.kind,'error');
 assert.match(deleted.op.message,/live task #2 still depends on it/);
 assert.equal(made.state.tasks[0].status,'pending');
 const cleaned=applyTaskMutation(made.state,'batch',{operations:[
  {action:'update',id:2,removeBlockedBy:[1]},
  {action:'delete',id:1},
 ]});
 assert.equal(cleaned.op.kind,'batch');
 assert.equal(cleaned.state.tasks[0].status,'deleted');
 assert.equal(cleaned.state.tasks[1].blockedBy,undefined);
});

const {miniSource,miniProjection,miniPotentialSavings,createMiniPreprocessor}=await import(pathToFileURL(path.join(agent,'extensions/lib/mini-preprocessor.ts')).href);
const {scoreContext}=await import(pathToFileURL(path.join(agent,'extensions/pi-memory/context-salience.ts')).href);
test('local selection protects evidence and supports meaningful free-route context savings',async()=>{
 const material='The current result must not be treated as verified before the source has been checked.';
 const filler='Broad introductory discussion describes ordinary surroundings and provides familiar background for readers exploring the wider topic in a leisurely manner.';
 const raw=[material,...Array(12).fill(filler)].join('\n\n'),source=miniSource(raw);
 const selection={version:1,status:'SELECT',sourceHash:source.hash,keep:[0]};
 assert.equal(miniProjection(raw,{...selection,keep:[1]}),undefined);
 assert.equal(miniPotentialSavings(Array(18).fill(material).join('\n\n')),0);
 let calls=0;const runtime={version:1,enabled:true,endpoint:'http://127.0.0.1:18736/select',apiKey:randomBytes(24).toString('base64url')};
 const client=createMiniPreprocessor({runtime,fetch:async(_url,options)=>{calls++;assert.equal(options.redirect,'error');return new Response(JSON.stringify(selection));}});
 assert.deepEqual(await client.select(raw,0),selection);
 assert.deepEqual(await client.select(raw,0),selection,'identical verified content reuses the bounded cache');
 assert.equal(await client.select(raw+'\n\nAdditional background.',0),undefined,'uncached work respects cooldown');
 assert.equal(calls,1,'cache hits and cooldown never make another request');
 assert.match(miniProjection(raw,selection),/must not/);
 const rows=[{id:'specific',text:'quaternion rendering architecture'},{id:'generic',text:'application rendering architecture'},...Array.from({length:20},(_,i)=>({id:'d'+i,text:'application common background'}))];
 assert.equal(scoreContext(rows,'quaternion application rendering')[0].id,'specific');
 assert.equal(scoreContext([...rows,{id:'critical',kind:'constraint',text:'Do not publish'}],'quaternion rendering')[0].id,'critical');
});

test('active plans share scopes and stale direct writes require a fresh read',async()=>{
 const previous=process.env.HOME,root=fs.mkdtempSync(path.join(os.tmpdir(),'action-plan-peers-'));
 process.env.HOME=root;
 const {default:coordinate}=await import(pathToFileURL(path.join(agent,'extensions/siblings.ts')).href);
 const bus=new EventEmitter(), opened=[];
 function session(id){
  const hooks={},tools={};coordinate({on(n,f){hooks[n]=f},registerTool(t){tools[t.name]=t},sendMessage(){},events:{on(n,f){bus.on(n,f);return ()=>bus.off(n,f)}}});
  const ctx={cwd:root,sessionManager:{getSessionId:()=>id,getBranch:()=>[]}};
  const self={hooks,ctx,call:(n,e={})=>hooks[n]?.(e,ctx),status:async()=>(await tools.session_coordinate.execute('status',{},undefined,undefined,ctx)).details};opened.push(self);return self;
 }
 try{
  const a=session('alpha'),b=session('bravo');await a.call('session_start');await b.call('session_start');
  const tasks=[{id:1,subject:'Own purpose',status:'in_progress',files:['source.txt']}];
  bus.emit('todo-plan-changed',{sessionId:'alpha',cwd:root,tasks});
  assert.deepEqual((await b.status()).peers[0].coordination.plan.files,[path.join(root,'source.txt')]);
  assert.equal((await b.status()).coordination.plan.objective,'','peer plan does not replace own intent');
  a.ctx.sessionManager.getSessionId=()=>{throw Error('stale SDK context')};
  bus.emit('todo-plan-changed',{sessionId:'alpha',cwd:root,tasks:tasks.map(t=>({...t,subject:'Recovered purpose'}))});
  assert.equal((await b.status()).peers[0].coordination.plan.objective,'Recovered purpose','publication uses captured identity rather than a stale SDK context');
  a.ctx.sessionManager.getSessionId=()=> 'alpha';
  const file=path.join(root,'source.txt');fs.writeFileSync(file,'initial');
  const write={toolName:'write',input:{path:'source.txt'}},read={toolName:'read',toolCallId:'read-1',input:{path:'source.txt'}};
  assert.equal((await b.call('tool_call',write)).block,true);
  await b.call('tool_call',read);await b.call('tool_result',read);assert.notEqual((await b.call('tool_call',write))?.block,true);
  fs.writeFileSync(file,'peer change');assert.equal((await b.call('tool_call',write)).block,true);
  const partial={...read,input:{path:'source.txt',limit:1}};await b.call('tool_call',partial);await b.call('tool_result',partial);assert.equal((await b.call('tool_call',write)).block,true,'whole-file writes need an untruncated full read');
  await b.call('tool_call',read);await b.call('tool_result',read);assert.notEqual((await b.call('tool_call',write))?.block,true);
  bus.emit('todo-plan-changed',{sessionId:'alpha',cwd:root,tasks:tasks.map(t=>({...t,status:'completed'}))});assert.deepEqual((await b.status()).peers[0].coordination.plan.files,[]);
 }finally{for(const s of opened)await s.call('session_shutdown');if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;fs.rmSync(root,{recursive:true,force:true});}
});

test('single-mutation actions carrying operations apply as an atomic batch',()=>{
 const empty={tasks:[],nextId:1};
 // A create call may arrive with an operations array instead of action=batch;
 // the batch intent wins rather than failing on the missing subject.
 const made=applyTaskMutation(empty,'create',{operations:[{action:'create',id:-1,subject:'Outcome'},{action:'create',id:-2,parentId:-1,subject:'Step'}]});
 assert.equal(made.op.kind,'batch');assert.equal(made.state.tasks.length,2);assert.equal(made.state.tasks[1].parentId,1);
 assert.deepEqual(made.op.ids,{'-1':1,'-2':2});
 const bad=applyTaskMutation(empty,'create',{operations:[{action:'create',subject:'temporary'},{action:'update',id:99,subject:'ghost'}]});
 assert.equal(bad.op.kind,'error');assert.equal(bad.state,empty);
 assert.equal(applyTaskMutation(empty,'create',{}).op.kind,'error');
 assert.equal(applyTaskMutation(empty,'update',{id:1,operations:[{action:'create',subject:'late'}]}).op.kind,'batch');
});

test('todo recovers only unambiguous batch operations that omit their action before validation', async () => {
 const {prepareTodoArguments}=await load('todo.ts');
 const {TodoParamsSchema}=await load('tool/types.ts');
 const {validateToolArguments}=await import(pathToFileURL(path.join(release,'core/ai/src/utils/validation.js')).href);
 const tool={name:'todo',parameters:TodoParamsSchema};
 const valid=args=>{try{validateToolArguments(tool,{name:'todo',id:'call',arguments:args});return true;}catch{return false;}};
 // Shapes recorded in real sessions: updates by id, creates by subject, and a JSON-string batch.
 const recorded={action:'batch',operations:[{id:3,status:'completed',evidence:'Verified with PIL.'},{subject:'Map site structure',acceptance:'List of pages'}]};
 assert.equal(valid(recorded),false,'the recorded shape fails the declared schema');
 const prepared=prepareTodoArguments(recorded);
 assert.deepEqual(prepared.operations.map(op=>op.action),['update','create']);
 assert.equal(valid(prepared),true);
 const stringBatch=prepareTodoArguments({batch:JSON.stringify({operations:[{action:'create',id:-1,subject:'Outcome'}]})});
 assert.equal(stringBatch.action,'batch');assert.equal(valid(stringBatch),true);
 const implicit=prepareTodoArguments({batch:true,operations:[{action:'create',subject:'Outcome'}]});
 assert.equal(implicit.action,'batch');assert.equal('batch' in implicit,false);assert.equal(valid(implicit),true);
 const ambiguous={action:'batch',operations:[{status:'completed'}]};
 assert.equal(prepareTodoArguments(ambiguous),ambiguous,'no id and no subject is left for validation to reject');
 assert.equal(valid(prepareTodoArguments(ambiguous)),false);
 const correct={action:'list'};assert.equal(prepareTodoArguments(correct),correct,'valid calls pass through untouched');
});

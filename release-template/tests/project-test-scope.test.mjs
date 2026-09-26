import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {register} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/project-tests.ts')));
const schema='data:text/javascript,'+encodeURIComponent('export const Type=new Proxy({}, {get:()=>()=>({})});');
register('data:text/javascript,'+encodeURIComponent(`export function resolve(n,c,next){return n==='typebox'?{url:${JSON.stringify(schema)},shortCircuit:true}:next(n,c);}`),import.meta.url);
const {projectCheckCommand,createProjectTestLifecycle}=await import(pathToFileURL(path.join(agent,'extensions/lib/project-tests.ts')));

test('a later failed receipt retires an older pass for the identical tree across scopes', async t => {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-latest-receipt-')),tools={};
 const ctx={cwd};
 const api=createProjectTestLifecycle({registerTool:d=>tools[d.name]=d,getActiveTools:()=>['project_tests','bash'],appendEntry(){}});
 t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 await api.restore(ctx);api.input({source:'interactive',text:'Fix the first scope'});
 const write=async value=>{fs.writeFileSync(path.join(cwd,'value.js'),`export const value=${value};`);await api.result({toolName:'write',toolCallId:`write-${value}`,input:{path:'value.js'},isError:false},ctx);};
 const assess=disposition=>tools.project_tests.execute('assess',{action:'assess',disposition,reason:'The focused check covers the changed behavior.',commands:disposition==='required'?['node --test']:[]},undefined,undefined,ctx);
 const run=async(isError,id)=>{const event={toolName:'bash',toolCallId:id,input:{command:'node --test'}};await api.call(event,ctx);await api.result({...event,isError,details:{exitCode:isError?1:0},content:[{type:'text',text:isError?'1 test failed':'1 test passed'}]},ctx);};
 await write(1);await assess('required');await run(false,'passed');assert.equal(api.snapshot().need,null);
 api.input({source:'interactive',text:'Fix the second scope'});await write(2);await write(1);await assess('required');
 assert.equal(api.snapshot().need,null,'unchanged tree can initially reuse the existing pass');
 await run(true,'failed');assert.equal(api.snapshot().need,'failed');await assess('blocked');
 api.input({source:'interactive',text:'Fix the third scope'});await write(2);await write(1);await assess('required');
 assert.notEqual(api.snapshot().need,null,'the newer failure must not disappear and reveal the older pass');
});

test('a late test from a completed scope cannot approve the next user scope',async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-scope-'));
 const tools={};
 const ctx={cwd};
 const api=createProjectTestLifecycle({registerTool:d=>tools[d.name]=d,getActiveTools:()=>['project_tests','bash'],appendEntry(){}});
 t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 await api.restore(ctx);api.input({source:'interactive',text:'Fix the first behavior'});
 const mutate=async value=>{
  fs.writeFileSync(path.join(cwd,'value.js'),`export const value=${value};`);
  await api.result({toolName:'write',toolCallId:`write-${value}`,input:{path:'value.js'},isError:false},ctx);
 };
 const assess=()=>tools.project_tests.execute('assess',{action:'assess',disposition:'required',reason:'The check covers the changed behavior.',commands:['node --test']},undefined,undefined,ctx);
 const event=id=>({toolName:'bash',toolCallId:id,input:{command:'node --test'}});
 const finish=e=>api.result({...e,isError:false,details:{exitCode:0},content:[{type:'text',text:'# tests 1\n# pass 1'}]},ctx);
 await mutate(1);await assess();await api.call(event('first'),ctx);await finish(event('first'));
 assert.equal(api.snapshot().need,null);
 await api.call(event('late'),ctx);
 api.input({source:'interactive',text:'Fix the next behavior'});
 await mutate(2);await assess();await finish(event('late'));
 assert.equal(api.snapshot().need,'missing');
 await api.call(event('current'),ctx);await finish(event('current'));
 assert.equal(api.snapshot().need,null);
});

test('Python script and literal-environment test receipts survive later assessment without a duplicate run',async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-receipt-'));
 const tools={},sent=[];
 const ctx={cwd,isIdle:()=>true,hasPendingMessages:()=>false};
 const api=createProjectTestLifecycle({registerTool:d=>tools[d.name]=d,getActiveTools:()=>['project_tests','bash'],appendEntry(){},sendMessage:(...args)=>sent.push(args)});
 t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 await api.restore(ctx);api.input({source:'interactive',text:'Fix the parser and verify its existing regressions'});
 fs.writeFileSync(path.join(cwd,'parser.py'),'value = 1');
 await api.result({toolName:'write',toolCallId:'write',input:{path:'parser.py'},isError:false},ctx);
 const commands=['python3 tests/test_parser.py','PYTHONPATH=. APP_TEST_MODE=1 python3 -m pytest tests -q'];
 for(const [index,command] of commands.entries()){
  const event={toolName:'bash',toolCallId:`run-${index}`,input:{command}};
  await api.call(event,ctx);
  await api.result({...event,isError:false,details:{exitCode:0},content:[{type:'text',text:'2 passed in 0.01s'}]},ctx);
 }
 const assess=commands=>tools.project_tests.execute('assess',{action:'assess',disposition:'required',reason:'Existing regressions cover the changed parser boundary.',commands},undefined,undefined,ctx);
 await assess(commands);
 assert.equal(api.snapshot().need,null,'already observed successful test commands remain current evidence');
 await api.settled({},ctx);assert.equal(sent.length,0,'no redundant verification turn');
 await assess(['PYTHONPATH=. APP_TEST_MODE=2 python3 -m pytest tests -q']);
 assert.equal(api.snapshot().need,'missing','a different test environment cannot inherit the original receipt');
 for(const command of ['PYTHONPATH=. echo pytest','PYTHONPATH=. python3 -c "print(1)"','APP_TEST_MODE=1 pytest --collect-only','APP_TEST_MODE=1 pytest || true','APP_TEST_MODE=1'])assert.equal(projectCheckCommand(command,cwd),null,command);
});


test('byte-identical writes retain tests but real edits and in-flight changes invalidate their receipts', async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-content-')),tools={};
 const ctx={cwd,isIdle:()=>true,hasPendingMessages:()=>false};
 const api=createProjectTestLifecycle({registerTool:d=>tools[d.name]=d,getActiveTools:()=>['project_tests','bash'],appendEntry(){}});
 t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 await api.restore(ctx);api.input({source:'interactive',text:'Repair the native window and test it'});
 const file=path.join(cwd,'window.cpp');
 const write=async text=>{fs.writeFileSync(file,text);await api.result({toolName:'write',toolCallId:'write',input:{path:'window.cpp'},isError:false},ctx);};
 const assess=()=>tools.project_tests.execute('assess',{action:'assess',disposition:'required',reason:'The focused suite exercises window buffer boundaries.',commands:['make test']},undefined,undefined,ctx);
 const call=id=>({toolName:'bash',toolCallId:id,input:{command:'make test'}});
 const finish=e=>api.result({...e,isError:false,details:{exitCode:0},content:[{type:'text',text:'1 test passed'}]},ctx);
 await write('int value = 1;');await assess(); await api.call(call('first'),ctx);await finish(call('first'));
 const {revision,tree}=api.snapshot();assert.equal(api.snapshot().need,null);
 assert.equal(api.snapshot().checks[0].label,'make test');
 await write('int value = 1;');await assess();
 assert.equal(api.snapshot().revision,revision);assert.equal(api.snapshot().tree,tree);assert.equal(api.snapshot().need,null);
 const now=new Date(Date.now()+5000);fs.utimesSync(file,now,now);await api.start(ctx);
 assert.equal(api.snapshot().revision,revision);assert.equal(api.snapshot().need,null);
 await api.call(call('overlap'),ctx); await write('int value = 2;'); await finish(call('overlap')); await assess();
 assert.equal(api.snapshot().need,'missing');
 const receipt=api.snapshot().checks.find(c=>c.callId==='overlap');assert.equal(receipt.tree,tree,'late result stays bound to the source where it started');
 await api.call(call('latest'),ctx);await finish(call('latest')); assert.equal(api.snapshot().need,null);
});


test('a successful write is still observed when startup discovery was unavailable', async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-discovery-recovery-'));let failed=true;
 const {projectTestFacts}=await import(pathToFileURL(path.join(agent,'scripts/workspace-facts.mjs')));
 const ctx={cwd},api=createProjectTestLifecycle({registerTool(){},getActiveTools:()=>['project_tests','bash'],appendEntry(){}},{discover:async(...args)=>{if(failed)throw Error('unavailable');return projectTestFacts(...args);}});
 t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 await api.restore(ctx);api.input({source:'interactive',text:'Fix the parser'});failed=false;
 fs.writeFileSync(path.join(cwd,'parser.js'),'export const value=1;');
 await api.result({toolName:'write',toolCallId:'write',input:{path:'parser.js'},isError:false},ctx);
 assert.deepEqual(api.snapshot().changed,['parser.js']);assert.equal(api.snapshot().need,'assessment');
});

test('reload validates dependencies outside changed files before restoring passed checks', async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-reload-dependency-')),tools={},branch=[],sent=[];
 const dependency=path.join(cwd,'dependency.js');fs.writeFileSync(dependency,'export const value=1;');
 const ctx={cwd,isIdle:()=>true,hasPendingMessages:()=>false,sessionManager:{getBranch:()=>branch}};
 const api=createProjectTestLifecycle({registerTool:d=>tools[d.name]=d,getActiveTools:()=>['project_tests','bash'],
  appendEntry:(customType,data)=>branch.push({type:'custom',customType,data:structuredClone(data)}),sendMessage:m=>sent.push(m)});
 t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 await api.restore(ctx);api.input({source:'interactive',text:'Fix the application behavior'});
 fs.writeFileSync(path.join(cwd,'app.js'),'export const app=1;');
 await api.result({toolName:'write',toolCallId:'write',input:{path:'app.js'},isError:false},ctx);
 const assess=()=>tools.project_tests.execute('assess',{action:'assess',disposition:'required',reason:'The focused check exercises the app and dependency.',commands:['node --test']},undefined,undefined,ctx);
 await assess();
 const event={toolName:'bash',toolCallId:'check',input:{command:'node --test'}};
 await api.call(event,ctx);await api.result({...event,isError:false,details:{exitCode:0},content:[{type:'text',text:'# tests 1\n# pass 1'}]},ctx);
 assert.deepEqual(api.snapshot().changed,['app.js']);assert.equal(api.snapshot().need,null);
 // Metadata-only changes preserve evidence because the source bytes match.
 const now=new Date(Date.now()+5000);fs.utimesSync(dependency,now,now);
 await api.restore(ctx);api.input({source:'interactive',text:'Continue'});assert.equal(api.snapshot().need,null);
 const tree=api.snapshot().tree;
 fs.writeFileSync(dependency,'export const value=2;');
 await api.restore(ctx);assert.equal(api.snapshot().paused,true);await api.settled({},ctx);
 assert.equal(sent.length,0,'reload never wakes the model');assert.notEqual(api.snapshot().tree,tree);
 api.input({source:'interactive',text:'Continue'});assert.equal(api.snapshot().need,'assessment');
 await assess();assert.equal(api.snapshot().need,'missing','an old pass cannot verify a changed dependency');
});

test('background completion observes source writes before accepting the command receipt', async t=>{
 for(const channel of ['notification','process','bg_status']) await t.test(channel,async t=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-background-source-')),tools={};
  const ctx={cwd},api=createProjectTestLifecycle({registerTool:d=>tools[d.name]=d,getActiveTools:()=>['project_tests','bash','bg_run'],appendEntry(){}});
  t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
  await api.restore(ctx);api.input({source:'interactive',text:'Fix and verify the application'});
  fs.writeFileSync(path.join(cwd,'app.js'),'export const value=1;');
  await api.result({toolName:'write',toolCallId:'write',input:{path:'app.js'},isError:false},ctx);
  const assess=()=>tools.project_tests.execute('assess',{action:'assess',disposition:'required',reason:'The check covers the application behavior.',commands:['node --test']},undefined,undefined,ctx);
  await assess();const event={toolName:'bg_run',toolCallId:'check',input:{command:'node --test'}};
  await api.call(event,ctx);await api.result({...event,isError:false,details:{task:{id:'job-1',status:'running'}}},ctx);
  const {tree}=api.snapshot();assert.equal(api.snapshot().need,'running');
  fs.writeFileSync(path.join(cwd,'generated.js'),'export const value=2;');
  const task={id:'job-1',status:'completed',exitCode:0};
  if(channel==='notification')await api.message({message:{role:'custom',customType:'background-task-notification',details:task}},ctx);
  else await api.result({toolName:channel,details:channel==='process'?{managedJob:task}:{tasks:[task]}},ctx);
  assert.ok(api.snapshot().changed.includes('generated.js'));assert.equal(api.snapshot().need,'assessment');
  assert.equal(api.snapshot().checks[0].tree,tree,'the command remains bound to its starting source');
  await assess();assert.equal(api.snapshot().need,'missing','the modified source needs current verification');
 });
});

test('safe pre-plan commands retain exact receipts, while composition and stale source never pass', async t => {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-preplan-')),tools={},sent=[];
 const ctx={cwd,isIdle:()=>true,hasPendingMessages:()=>false};
 const api=createProjectTestLifecycle({registerTool:d=>tools[d.name]=d,getActiveTools:()=>['project_tests','bash'],appendEntry(){},sendMessage:m=>sent.push(m)});
 t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 await api.restore(ctx);api.input({source:'interactive',text:'Build a small static page and verify its data'});
 fs.writeFileSync(path.join(cwd,'app.js'),'const value=1;');
 await api.result({toolName:'write',toolCallId:'write',input:{path:'app.js'},isError:false},ctx);
 const run=async(command,id,exitCode=0)=>{
  const event={toolName:'bash',toolCallId:id,input:{command}};
  await api.call(event,ctx);await api.result({...event,isError:exitCode!==0,details:{exitCode},content:[{type:'text',text:exitCode?'Assertion failed':'126 assertions passed'}]},ctx);
 };
 const assess=commands=>tools.project_tests.execute('assess',{action:'assess',disposition:'required',reason:'Syntax and the existing data invariant check cover this static page.',commands},undefined,undefined,ctx);
 await run('node --check app.js','syntax');await run('node check.js','behavior');
 assert.equal(api.snapshot().need,'assessment','receipts do not invent a verification plan');
 await assess(['node --check app.js','node check.js']);
 assert.equal(api.snapshot().need,null,'planning after execution does not require duplicate commands');
 assert.deepEqual(api.snapshot().plannedChecks.map(c=>c.outcome),['passed','passed']);
 await api.settled({},ctx);assert.equal(sent.length,0);
 await run('node check.js; echo passed','masked');
 await assert.rejects(assess(['node check.js; echo passed']),/shell composition/);
 await run('node other-check.js','failed',1);await assess(['node other-check.js']);
 assert.equal(api.snapshot().need,'failed','a declared failed command cannot inherit another pass');
 fs.writeFileSync(path.join(cwd,'app.js'),'const value=2;');
 await api.result({toolName:'write',toolCallId:'edit',input:{path:'app.js'},isError:false},ctx);
 await assess(['node --check app.js','node check.js']);
 assert.equal(api.snapshot().need,'missing');
 assert.deepEqual(api.snapshot().plannedChecks.map(c=>c.outcome),['stale','stale']);
});

test('follow-up turns that edit and settle recursively cannot replenish their two-turn budget', async t => {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-followup-budget-')),sent=[],branch=[];
 const ctx={cwd,isIdle:()=>true,hasPendingMessages:()=>false};
 let api;
 const mutate=async value=>{
  fs.writeFileSync(path.join(cwd,'app.js'),`const value=${value};`);
  await api.result({toolName:'write',toolCallId:`write-${value}`,input:{path:'app.js'},isError:false},ctx);
 };
 api=createProjectTestLifecycle({registerTool(){},getActiveTools:()=>['project_tests','bash'],appendEntry:(type,data)=>branch.push(structuredClone(data)),
  async sendMessage(message){
   sent.push(message);assert.ok(sent.length<=2,'no third triggered model turn');
   await api.message({message:{role:'custom',customType:message.customType}},ctx);
   await mutate(sent.length+1);
   await api.settled({},ctx);
  }});
 t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 await api.restore(ctx);api.input({source:'interactive',text:'Implement and verify the parser'});
 await mutate(1);await api.settled({},ctx);
 assert.equal(sent.length,2);assert.equal(api.snapshot().followups,2);
 assert.match(sent[0].content,/Automatic follow-up 1\/2/);assert.match(sent[1].content,/Automatic follow-up 2\/2/);
 await api.settled({},ctx);assert.equal(sent.length,2);
 assert.ok(branch.some(entry=>entry.followups===2),'reservation is persisted before model execution');
});

test('a rejected follow-up delivery refunds its reservation before any model work', async t => {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-followup-reject-'));let sends=0;
 const ctx={cwd,isIdle:()=>true,hasPendingMessages:()=>false};
 const api=createProjectTestLifecycle({registerTool(){},getActiveTools:()=>['project_tests','bash'],appendEntry(){},async sendMessage(){if(++sends===1)throw Error('queue unavailable');}});
 t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 await api.restore(ctx);api.input({source:'interactive',text:'Repair the parser'});
 fs.writeFileSync(path.join(cwd,'app.js'),'const value=1;');
 await api.result({toolName:'write',toolCallId:'write',input:{path:'app.js'},isError:false},ctx);
 await api.settled({},ctx);assert.equal(api.snapshot().followups,0);
 await api.settled({},ctx);assert.equal(api.snapshot().followups,1);assert.equal(sends,2);
});


test('planned command labels preserve working-directory prefixes and long literal arguments',()=>{
 const command='cd app && node check.js "'+'fixture-value'.repeat(35)+'"';
 const check=projectCheckCommand(command,'/project',true);
 assert.equal(check.label,command);
 assert.equal(projectCheckCommand(check.label,'/project',true).key,check.key);
 assert.notEqual(projectCheckCommand('node check.js "'+'fixture-value'.repeat(35)+'"','/project',true).key,check.key);
});

test('shaped planned checks bind receipts, bg terminal events settle them at once, recon is never evidence', async t => {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-shaped-')),tools={},listeners={};
 const ctx={cwd,sessionManager:{getSessionId:()=>'session-a'}};
 const api=createProjectTestLifecycle({registerTool:d=>tools[d.name]=d,getActiveTools:()=>['project_tests','bash','bg_run'],appendEntry(){},
  events:{on:(channel,handler)=>{listeners[channel]=handler;return()=>{};}}});
 t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 await api.restore(ctx);api.input({source:'interactive',text:'Fix the value'});
 const recon={toolName:'bash',toolCallId:'recon',input:{command:'ls -la'}};
 await api.call(recon,ctx);await api.result({...recon,isError:false,details:{exitCode:0},content:[{type:'text',text:'x'}]},ctx);
 assert.equal(api.snapshot().evidence.length,0,'read-only reconnaissance is not verification evidence');
 fs.writeFileSync(path.join(cwd,'value.js'),'export const value=1;');
 await api.result({toolName:'write',toolCallId:'w',input:{path:'value.js'},isError:false},ctx);
 const attribution=api.snapshot().attribution;
 assert.equal(attribution.length,1,'attribution is collapsed to one line per distinct status');
 assert.equal(attribution[0].status,'current_session','this session\'s native write is attributed without Git');
 await tools.project_tests.execute('assess',{action:'assess',disposition:'required',reason:'The focused check covers the change.',commands:['node --test']},undefined,undefined,ctx);
 const shaped={toolName:'bg_run',toolCallId:'shaped',input:{command:'node --test 2>&1 | tail -40'}};
 await api.call(shaped,ctx);
 assert.match(shaped.input.command,/^set -o pipefail; node --test 2>&1 \| tail -40$/,'pipefail keeps the check exit observable');
 await api.result({...shaped,isError:false,details:{task:{id:'b1',status:'running'}},content:[{type:'text',text:'started'}]},ctx);
 assert.equal(api.snapshot().need,'running');
 listeners['pi-background-tasks:terminal:v1']({task:{id:'b1',status:'completed',exitCode:0}});
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(api.snapshot().need,null,'the registry terminal event settles the receipt without waiting for the queued notification');
 const redirect={toolName:'bash',toolCallId:'redirect',input:{command:'node --test > build/verify/out.txt 2>&1'}};
 await api.call(redirect,ctx);
 assert.equal(redirect.input.command,'node --test > build/verify/out.txt 2>&1','a file redirect needs no rewrite');
 await api.result({...redirect,isError:true,details:{exitCode:1},content:[{type:'text',text:''}]},ctx);
 assert.equal(api.snapshot().need,'failed','a redirected check still records its real exit');
});

test('project tests and quality review share one workspace revision per change', async () => {
 const {createWorkspaceRevision}=await import(pathToFileURL(path.join(agent,'extensions/lib/project-tests.ts')));
 const revision=createWorkspaceRevision();
 assert.equal(revision.advance('scan:1'),1);
 assert.equal(revision.advance('scan:1'),1,'both lifecycles observing one scan advance it once');
 assert.equal(revision.advance('native:call-1'),2);
 revision.seed(7);assert.equal(revision.current,7,'restored revisions seed the shared counter');
 revision.seed(3);assert.equal(revision.current,7,'seeding never moves it backwards');
});

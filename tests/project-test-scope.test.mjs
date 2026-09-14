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

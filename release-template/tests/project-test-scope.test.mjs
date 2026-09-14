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

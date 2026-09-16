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

test('PHP test scripts are recognized without treating lint, application scripts or masked exits as tests',()=>{
 for(const command of ['php tests/run-tests.php','php -f tests/run-tests.php','php8.3 tests/regression.php']) assert.ok(projectCheckCommand(command,'/project'),command);
 // Contract change 2026-09-16: `php -l <file>` admitted as an auto-observed
 // syntax check (the PHP analogue of declared `bash -n`; its argv cannot hide
 // composition the way shell argv can). Without it, PHP-site sessions can
 // never produce check receipts and the checkpoint need never resolves.
 assert.ok(projectCheckCommand('php -l tests/run-tests.php','/project'),'php -l tests/run-tests.php');
 for(const command of ['php -r "echo 1;"','php index.php','php tests/run-tests.php || true','php tests/run-tests.php; echo done']) assert.equal(projectCheckCommand(command,'/project'),null,command);
});

test('a PHP check observed before its coverage assessment does not cause a redundant completion follow-up',async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'php-receipt-'));
 const tools={},sent=[];
 const ctx={cwd,isIdle:()=>true,hasPendingMessages:()=>false};
 const api=createProjectTestLifecycle({registerTool:d=>tools[d.name]=d,getActiveTools:()=>['project_tests','bash'],appendEntry(){},sendMessage:(...args)=>sent.push(args)});
 t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 await api.restore(ctx);api.input({source:'interactive',text:'Fix the PHP behavior'});
 fs.writeFileSync(path.join(cwd,'value.php'),'<?php return 1;');
 await api.result({toolName:'write',toolCallId:'write',input:{path:'value.php'},isError:false},ctx);
 const event={toolName:'bash',toolCallId:'check',input:{command:'php tests/run-tests.php'}};
 await api.call(event,ctx);
 await api.result({...event,isError:false,details:{exitCode:0},content:[{type:'text',text:'Passed 134 / Failed 0'}]},ctx);
 const assess=()=>tools.project_tests.execute('assess',{action:'assess',disposition:'required',reason:'The observed suite exercises this behavior and regression.',commands:['php tests/run-tests.php']},undefined,undefined,ctx);
 await assess();assert.equal(api.snapshot().need,null);await api.settled({},ctx);assert.equal(sent.length,0);
 fs.writeFileSync(path.join(cwd,'unrelated.php'),'<?php return 3;');
 await api.start(ctx);assert.equal(api.snapshot().need,null,'unrelated peer edits do not reopen finished test scope');
 assert.ok(!api.snapshot().changed.includes('unrelated.php'));
 fs.writeFileSync(path.join(cwd,'value.php'),'<?php return 2;');
 await api.result({toolName:'edit',toolCallId:'edit',input:{path:'value.php'},isError:false},ctx);
 await assess();assert.equal(api.snapshot().need,'missing');
 assert.match(api.notice(),/without pipes, trailing echo/,'missing receipt guidance explains how to expose the actual test exit status');
});

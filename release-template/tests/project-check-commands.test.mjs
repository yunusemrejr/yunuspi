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
const {projectCheckCommandReason,projectCheckCommand}=await import(pathToFileURL(path.join(agent,'extensions/lib/project-tests.ts')));

test('a trailing parenthetical annotation is named instead of reported as shell operators',()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-check-annotation-'));
 try{
  for(const [command,annotation] of [
   ['out/probe_wmclose (helper: send WM_DELETE_WINDOW to the window)','(helper: send WM_DELETE_WINDOW to the window)'],
   ['MSS_DEBUG_EVENTS=1 ./build/game --frames 300 (trace close path)','(trace close path)'],
   ['cd sub && node --test (fast subset)','(fast subset)'],
  ]){
   const reason=projectCheckCommandReason(command,cwd);
   assert.match(reason,/looks like an annotation, not part of the command/);
   assert.ok(reason.includes(annotation),'names the parenthetical');
  }
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});

test('bare commands stay accepted while genuine composition keeps the operator reason',()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-check-operators-'));
 try{
  assert.equal(projectCheckCommandReason('node --test',cwd),null);
  assert.equal(projectCheckCommandReason('MSS_DEBUG_EVENTS=1 ./build/game --frames 300',cwd),null);
  assert.match(projectCheckCommandReason('node --test | grep pass',cwd),/shell operators/);
  assert.match(projectCheckCommandReason('node --test > out.txt',cwd),/shell operators/);
  // Glued parens are not the annotation shape; they keep the generic reason.
  assert.match(projectCheckCommandReason('node --test(suite)',cwd),/shell operators/);
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});

test('literal AND arguments and dot-prefixed subdirectories retain their exact check identity',t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'literal-check-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const nested=path.join(cwd,'..unit&&suite');fs.mkdirSync(nested);
 assert.equal(projectCheckCommandReason("node scripts/verify.js --case 'a&&b'",cwd),null);
 const command="cd '..unit&&suite' && node --test";
 assert.equal(projectCheckCommandReason(command,cwd),null);
 assert.ok(projectCheckCommand(command,cwd));
 assert.notEqual(projectCheckCommand("node --test --test-name-pattern 'a&&b'",cwd).key,projectCheckCommand("node --test --test-name-pattern 'a&b'",cwd).key);
});

test('symlinked check directories cannot certify an outside workspace or reuse a different target',t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'check-root-'));
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'check-outside-'));
 t.after(()=>{fs.rmSync(cwd,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
 fs.symlinkSync(outside,path.join(cwd,'linked'));
 assert.match(projectCheckCommandReason('cd linked && node --test',cwd),/outside/);
 assert.equal(projectCheckCommand('cd linked && node --test',cwd),null);
 fs.unlinkSync(path.join(cwd,'linked'));
 for(const name of ['one','two'])fs.mkdirSync(path.join(cwd,name));
 fs.symlinkSync(path.join(cwd,'one'),path.join(cwd,'linked'));
 const first=projectCheckCommand('cd linked && node --test',cwd);
 fs.unlinkSync(path.join(cwd,'linked'));fs.symlinkSync(path.join(cwd,'two'),path.join(cwd,'linked'));
 assert.notEqual(first.key,projectCheckCommand('cd linked && node --test',cwd).key);
});

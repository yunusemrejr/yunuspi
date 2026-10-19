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

const {checkInvocation}=await import(pathToFileURL(path.join(agent,'extensions/lib/project-tests.ts')));
const recognize=(command,cwd)=>{const shaped=checkInvocation(command);return projectCheckCommand(command,cwd)??(shaped?projectCheckCommand(shaped.body,cwd):null);};

test('harmless prefixes (cd, export, set -o pipefail, inline assignments) are recognized as the same check',t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'check-prefix-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 for(const command of [
  'PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH npm test',
  'PATH=${HOME}/bin:~/.local/bin:/usr/bin:./node_modules/.bin npm test',
  'export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"; npm test',
  'export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" && npm test',
  `export PATH="$HOME/x/bin:$PATH" && cd ${cwd} && npm test`,
  `export A=1 && cd ${cwd} && set -o pipefail; npm test`,
  `cd ${cwd} && set -o pipefail; python3 -m pytest tests/ -q | tail -n 30`,
  'set -o pipefail; npm test 2>&1 | tail -20',
  'set -euo pipefail; npm test | head -5',
  'set -eo pipefail && npm test 2>&1 | tail -20',
  'export A=1; export B=2; export C=3; export D=4; npm test',
 ]) assert.ok(recognize(command,cwd),command);
 for(const command of [
  `cd ${cwd} && npm test 2>&1 | tail -20`,
  'npm test | tail -20',
 ]) assert.equal(checkInvocation(command).pipefailSet,false,`no prefix leaves pipefail to the harness: ${command}`);
 assert.equal(checkInvocation('set -o pipefail; npm test | tail -20').pipefailSet,true);
 assert.equal(checkInvocation('set -o pipefail; npm test | tail -20').pipefail,true);
 assert.equal(checkInvocation('set -o pipefail; npm test | tail -20').body,'npm test');
});

test('receipt identity: pipefail, export spelling and PATH do not change the key, other env values do',t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'check-prefix-key-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const bare=projectCheckCommand('npm test',cwd).key;
 assert.equal(projectCheckCommand('set -o pipefail; npm test',cwd).key,bare);
 assert.equal(projectCheckCommand('export PATH="$HOME/x/bin:$PATH"; npm test',cwd).key,projectCheckCommand('PATH=$HOME/x/bin:$PATH npm test',cwd).key);
 assert.equal(projectCheckCommand('PATH=$HOME/x/bin:$PATH npm test',cwd).key,bare,'a PATH that only locates npm satisfies a planned bare npm test');
 assert.equal(projectCheckCommand('export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" && npm test',cwd).key,bare);
 assert.notEqual(projectCheckCommand('APP_TEST_MODE=1 npm test',cwd).key,projectCheckCommand('APP_TEST_MODE=2 npm test',cwd).key);
});

test('expansion, substitution, operators and extra prefix items are still rejected',t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'check-prefix-reject-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 for(const command of [
  'PATH=$(which node) npm test',
  'PATH=`which node` npm test',
  'export A=$(x); npm test',
  'export A="$(x)" && npm test',
  'echo $HOME; npm test',
  'PATH=$HOME/bin npm test $FLAGS',
  'npm test; echo done',
  'npm test || true',
  'npm test "$X"',
  'set -o pipefail; npm test | tee out.log',
  'set -o pipefail; npm test 2>&1 | grep ok',
  'set -o pipefail; npm test | tail -20 | wc -l',
  `cd ${cwd} && cd ${cwd} && npm test`,
  'export A=1; export B=2; export C=3; export D=4; export E=5; npm test',
 ]) {
  assert.equal(recognize(command,cwd),null,command);
 }
});

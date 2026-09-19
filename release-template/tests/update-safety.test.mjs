import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import vm from 'node:vm';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'scripts/core-update.mjs')));
const {updateInvocation} = await import(pathToFileURL(path.join(agent, 'scripts/core-update.mjs')));
const {CORE_COMPATIBILITY_TESTS} = await import(pathToFileURL(path.join(agent, 'scripts/lib/core-compatibility.mjs')));

test('retirement checks match whole component names', () => {
 const source=fs.readFileSync(path.join(agent,'scripts/verify-harness.mjs'),'utf8');
 const declaration=source.match(/function retireNameRe\(name\) \{[\s\S]*?\n\}/)?.[0];assert.ok(declaration);
 const pattern=vm.runInNewContext(`(${declaration})`);
 assert.equal(pattern('capabilities.ts').test('lib/capabilities.ts'),true);
 assert.equal(pattern('capabilities.ts').test('harness-capabilities.ts'),false);
});
test('every source compatibility check is shipped without patch application', () => {
 assert.equal(new Set(CORE_COMPATIBILITY_TESTS).size,CORE_COMPATIBILITY_TESTS.length);
 for(const name of CORE_COMPATIBILITY_TESTS){const source=fs.readFileSync(path.join(agent,'scripts/compatibility',name),'utf8');assert.doesNotMatch(source,/import\s+["'][^"']*bench\//);assert.doesNotMatch(source,/from\s+["']\.\.\/patches\//);assert.doesNotMatch(source,/npm[^\n]*root/);}
});
test('update has no default source and refuses old upstream advance options', () => {
 assert.equal(updateInvocation([]),null);
 for(const option of ['--force','--rehearse','--recover','--self','--all'])assert.throws(()=>updateInvocation([option]),/Usage/);
});
test('explicit updates consume reviewed local YunusPi source and preserve installation backup', () => {
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-update-source-'));
 try {
  fs.mkdirSync(path.join(tmp,'core/coding-agent'),{recursive:true});fs.mkdirSync(path.join(tmp,'scripts'));
  const manifest=path.join(tmp,'core/coding-agent/package.json');fs.writeFileSync(manifest,JSON.stringify({name:'@yunuspi/coding-agent',version:'0.1.0'}));
  fs.writeFileSync(path.join(tmp,'scripts/install.mjs'),'// fixture');
  assert.deepEqual(updateInvocation(['--source',tmp,'--offline','--skip-needle'],'/tmp/private-agent'),[path.join(tmp,'scripts/install.mjs'),'--apply','--backup-existing','--preserve-state','--target','/tmp/private-agent','--offline','--skip-needle']);
  fs.writeFileSync(manifest,JSON.stringify({name:'external-core',version:'99.0.0'}));
  assert.throws(()=>updateInvocation(['--source',tmp]),/must own/);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('a hypothetical newer upstream release has no effect on idle update or timer', () => {
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-ignore-upstream-'));
 try {
  const bin=path.join(tmp,'bin'),scripts=path.join(tmp,'agent/scripts'),calls=path.join(tmp,'registry-calls');fs.mkdirSync(bin);fs.mkdirSync(scripts,{recursive:true});
  for(const name of ['npm','curl','wget'])fs.writeFileSync(path.join(bin,name),`#!/bin/sh\necho contacted >> '${calls}'\necho 99.0.0\n`,{mode:0o755});
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,PI_CODING_AGENT_DIR:path.dirname(scripts)};
  const unchanged=spawnSync(process.execPath,[path.join(agent,'scripts/core-update.mjs')],{encoding:'utf8',env});assert.equal(unchanged.status,0,unchanged.stderr);assert.match(unchanged.stdout,/No automatic core updates/);
  fs.copyFileSync(path.join(agent,'scripts/auto-update.sh'),path.join(scripts,'auto-update.sh'));fs.writeFileSync(path.join(scripts,'verify-harness.mjs'),'console.log("local-only verification");');
  const timer=spawnSync('/bin/bash',[path.join(scripts,'auto-update.sh')],{encoding:'utf8',env});assert.equal(timer.status,0,timer.stderr);assert(!fs.existsSync(calls));
  assert.match(fs.readFileSync(path.join(tmp,'agent/logs/auto-update.log'),'utf8'),/local-only verification/);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('verification does not apply runtime core patches or find a global npm core', () => {
 const source=fs.readFileSync(path.join(agent,'scripts/verify-harness.mjs'),'utf8');assert.doesNotMatch(source,/checkPatch\(|launcherSpec\(|npm root -g|core-update-transaction/);assert.match(source,/resolveOwnedCore/);
});

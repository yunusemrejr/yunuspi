import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {resolvePiLaunch} from '../agent/extensions/pi-background-tasks/src/core/pi-launch.ts';
import {resolvePiCliScript, getPiSpawnCommand} from '../agent/extensions/pi-subagents/src/runs/shared/pi-spawn.ts';

test('subagents use the declared owned CLI when hosted through RPC or SDK modules', () => {
 const core=path.resolve(import.meta.dirname,'../core/coding-agent');
 const cli=path.join(core,'dist/cli.js');
 for(const entry of ['dist/rpc-entry.js','dist/index.js','dist/cli.js']) {
  const deps={argv1:path.join(core,entry),env:{},piPackageRoot:core};
  assert.equal(resolvePiCliScript(deps),cli);
  assert.deepEqual(getPiSpawnCommand(['--version'],deps),{command:process.execPath,args:[cli,'--version']});
 }
});

test('background CLI resolves the owned package on Linux and Windows without PATH fallback', () => {
 for(const platform of ['linux','win32']) {
  const launch=resolvePiLaunch({platform,env:{}});
  assert.equal(launch.executable,process.execPath);
  assert.equal(launch.kind,'package-node-cli');
  assert.equal(fs.realpathSync(launch.argvPrefix[0]),fs.realpathSync(new URL('../core/coding-agent/dist/cli.js',import.meta.url)));
 }
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-bg-path-'));
 try {
  const marker=path.join(temporary,'wrong-core-ran');
  fs.writeFileSync(path.join(temporary,'pi'),`#!/bin/sh\ntouch '${marker}'\nexit 99\n`,{mode:0o755});
  const launch=resolvePiLaunch({platform:'linux',env:{PATH:temporary}});
  const result=spawnSync(launch.executable,[...launch.argvPrefix,'--core-info'],{encoding:'utf8',env:{...process.env,PATH:temporary},timeout:30000});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).core.releaseAuthority,'yunusemrejr/yunuspi');
  assert.equal(fs.existsSync(marker),false);
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

test('background children retain explicitly configured installed launcher leases', () => {
 const launch=resolvePiLaunch({platform:'linux',env:{PI_SUBAGENT_PI_BINARY:'/fixture/agent/bin/yunuspi'}});
 assert.deepEqual(launch,{executable:'/fixture/agent/bin/yunuspi',argvPrefix:[],kind:'path'});
});

test('background package resolution rejects an unowned identity or escaping CLI target', () => {
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-bg-package-'));
 try {
  const directory=path.join(temporary,'core');fs.mkdirSync(directory);
  const manifest=path.join(directory,'package.json');const cli=path.join(temporary,'outside.js');fs.writeFileSync(cli,'');
  fs.writeFileSync(manifest,JSON.stringify({name:'unowned',bin:{yunuspi:'../outside.js'}}));
  const deps={platform:'linux',env:{},resolvePackageJson:()=>manifest};
  assert.throws(()=>resolvePiLaunch(deps),/identity is not/);
  fs.writeFileSync(manifest,JSON.stringify({name:'@yunuspi/coding-agent',bin:{yunuspi:'../outside.js'}}));
  assert.throws(()=>resolvePiLaunch(deps),/outside the package root/);
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

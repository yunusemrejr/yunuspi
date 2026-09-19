import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const source=path.resolve(import.meta.dirname,'..');
function fixture(t, additions=[]){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-state-update-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo'), target=path.join(root,'installed');
  const write=(base,relative,text)=>{const file=path.join(base,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,{mode:0o600});};
  write(repo,'scripts/install.mjs',fs.readFileSync(path.join(source,'scripts/install.mjs')));
  write(repo,'scripts/build-core.mjs','// owned fixture build');
  write(repo,'package.json','{}');write(repo,'package-lock.json','{}');
  write(repo,'core/coding-agent/package.json',JSON.stringify({name:'@yunuspi/coding-agent',version:'0.1.0'}));
  write(repo,'core/coding-agent/src/cli.js','// owned source');
  write(repo,'agent/extensions/manifest.json','{}');
  write(repo,'agent/extensions/managed.ts','export const revision=1;');
  write(repo,'agent/npm/package.json','{}');
  for(const name of ['settings','models'])write(repo,`config/${name}.example.json`,'{}');
  for(const [relative,text] of additions)write(repo,`agent/${relative}`,text);
  const run=(...args)=>spawnSync(process.execPath,[path.join(repo,'scripts/install.mjs'),'--target',target,'--skip-needle','--apply',...args],{encoding:'utf8'});
  const first=run();assert.equal(first.status,0,first.stderr);
  const update=()=>run('--backup-existing','--preserve-state');
  const backups=()=>fs.readdirSync(root).filter(name=>name.startsWith('installed.backup-'));
  return {root,repo,target,write,update,backups,read:relative=>fs.readFileSync(path.join(target,relative),'utf8')};
}

test('an update preserves local state and custom source while advancing untouched managed files',t=>{
  const f=fixture(t);
  const state=['settings.json','models.json','auth.json','sessions/synthetic.jsonl','memory/notes.md','local-models/synthetic/runtime.json','extensions/custom.ts','cache/synthetic.txt'];
  for(const file of state)f.write(f.target,file,JSON.stringify({syntheticFixture:file}));
  f.write(f.repo,'agent/extensions/managed.ts','export const revision=2;');
  const updated=f.update();assert.equal(updated.status,0,updated.stderr);
  for(const file of state)assert.equal(f.read(file),JSON.stringify({syntheticFixture:file}),file);
  assert.equal(f.read('extensions/managed.ts'),'export const revision=2;');
  assert.equal(f.backups().length,1);
  assert.equal(fs.readFileSync(path.join(f.root,f.backups()[0],'extensions/managed.ts'),'utf8'),'export const revision=1;');
  assert.equal(fs.statSync(path.join(f.target,'auth.json')).mode&0o777,0o600);
  assert.equal(JSON.parse(f.read('installation.json')).managedFiles['extensions/managed.ts'].length,64);
});

test('conflicting local managed modifications abort before activation or backup',t=>{
  const f=fixture(t);f.write(f.target,'extensions/managed.ts','local edit');f.write(f.repo,'agent/extensions/managed.ts','incoming edit');
  const updated=f.update();assert.notEqual(updated.status,0);
  assert.equal(f.read('extensions/managed.ts'),'local edit');assert.equal(f.backups().length,0);
  assert.equal(fs.readdirSync(f.root).some(name=>name.startsWith('.yunuspi-install-')),false);
});

test('a local source modification survives an unchanged incoming baseline and conflicts on a later change',t=>{
  const f=fixture(t);f.write(f.target,'extensions/managed.ts','local edit');
  const updated=f.update();assert.equal(updated.status,0,updated.stderr);assert.equal(f.read('extensions/managed.ts'),'local edit');
  f.write(f.repo,'agent/extensions/managed.ts','incoming change');
  assert.notEqual(f.update().status,0);assert.equal(f.read('extensions/managed.ts'),'local edit');assert.equal(f.backups().length,1);
});

test('local deletion remains deleted when incoming owned source is unchanged, but conflicts if it changes',t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.target,'extensions/managed.ts'));
  const updated=f.update();assert.equal(updated.status,0,updated.stderr);assert.equal(fs.existsSync(path.join(f.target,'extensions/managed.ts')),false);
  f.write(f.repo,'agent/extensions/managed.ts','incoming change');assert.notEqual(f.update().status,0);
  assert.equal(fs.existsSync(path.join(f.target,'extensions/managed.ts')),false);
});

test('owned-core local edits cannot disappear during update and an explicit matching source port is accepted',t=>{
  const f=fixture(t);const coreFile='core/coding-agent/src/cli.js';
  f.write(f.target,`runtime/${coreFile}`,'// local core fix');
  assert.notEqual(f.update().status,0);assert.equal(f.read(`runtime/${coreFile}`),'// local core fix');assert.equal(f.backups().length,0);
  f.write(f.repo,coreFile,'// local core fix');
  const updated=f.update();assert.equal(updated.status,0,updated.stderr);assert.equal(f.read(`runtime/${coreFile}`),'// local core fix');
});

test('prototype-shaped filenames remain ordinary tracked source paths',t=>{
  const f=fixture(t,[['__proto__','prototype source'],['constructor','constructor source'],['toString','string source']]);
  const receipt=JSON.parse(f.read('installation.json'));
  for(const name of ['__proto__','constructor','toString']){
    assert.equal(Object.hasOwn(receipt.managedFiles,name),true,name);
    assert.match(receipt.managedFiles[name],/^[a-f0-9]{64}$/);
    f.write(f.repo,`agent/${name}`,`updated ${name}`);
  }
  const updated=f.update();assert.equal(updated.status,0,updated.stderr);
  for(const name of ['__proto__','constructor','toString'])assert.equal(f.read(name),`updated ${name}`);
});

test('a new managed file cannot overwrite conflicting custom source',t=>{
  const f=fixture(t);f.write(f.target,'extensions/custom.ts','private custom source');f.write(f.repo,'agent/extensions/custom.ts','new managed source');
  assert.notEqual(f.update().status,0);assert.equal(f.read('extensions/custom.ts'),'private custom source');assert.equal(f.backups().length,0);
});

test('private symlinks cannot cause source updates to read or replace external data',t=>{
  const f=fixture(t);const outside=path.join(f.root,'external');f.write(outside,'synthetic.txt','outside sentinel');
  fs.symlinkSync(outside,path.join(f.target,'memory'));
  assert.notEqual(f.update().status,0);assert.equal(fs.readlinkSync(path.join(f.target,'memory')),outside);
  assert.equal(fs.readFileSync(path.join(outside,'synthetic.txt'),'utf8'),'outside sentinel');assert.equal(f.backups().length,0);
});

test('missing and path-escaping managed inventories fail closed',t=>{
  const f=fixture(t);const receipt=JSON.parse(f.read('installation.json'));
  const valid=structuredClone(receipt);delete receipt.managedFiles;f.write(f.target,'installation.json',JSON.stringify(receipt));
  assert.notEqual(f.update().status,0);assert.equal(f.backups().length,0);
  valid.managedFiles['../outside']='0'.repeat(64);f.write(f.target,'installation.json',JSON.stringify(valid));
  assert.notEqual(f.update().status,0);assert.equal(f.backups().length,0);
});

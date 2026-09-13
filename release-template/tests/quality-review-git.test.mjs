import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {register} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/git-tools.ts')));
const schema='data:text/javascript,'+encodeURIComponent('export const Type=new Proxy({}, {get:(_t,name)=>(...args)=>({name,args})});');
register('data:text/javascript,'+encodeURIComponent(`export function resolve(n,c,next){return n==='typebox'?{url:${JSON.stringify(schema)},shortCircuit:true}:next(n,c);}`),import.meta.url);
const {runGitInfo}=await import(pathToFileURL(path.join(agent,'extensions/git-tools.ts')));
test('reviewer Git reads cannot run repository hooks/diff helpers or follow inherited repository overrides',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-git-safe-'));
 const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',cwd,...args],{env:cleanEnv,stdio:'pipe'});
 const repo=name=>{const p=path.join(dir,name);fs.mkdirSync(p);git(p,'init','-q');fs.writeFileSync(path.join(p,'source.txt'),'base\n');git(p,'add','.');git(p,'commit','-qm','base');return p;};
 const prior={GIT_DIR:process.env.GIT_DIR,GIT_WORK_TREE:process.env.GIT_WORK_TREE,GIT_INDEX_FILE:process.env.GIT_INDEX_FILE,GIT_EXTERNAL_DIFF:process.env.GIT_EXTERNAL_DIFF};
 try {
  const cwd=repo('project'),other=repo('foreign');fs.writeFileSync(path.join(cwd,'source.txt'),'reviewed change\n');
  const marker=path.join(dir,'unexpected-execution'),helper=path.join(dir,'helper.sh');fs.writeFileSync(helper,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o700});
  git(cwd,'config','diff.external',helper);git(cwd,'config','core.fsmonitor',helper);git(cwd,'config','diff.reviewfixture.textconv',helper);fs.writeFileSync(path.join(cwd,'.gitattributes'),'*.txt diff=reviewfixture\n');
  git(cwd,'config','log.showSignature','true');git(cwd,'config','gpg.program',helper);
  const parent=git(cwd,'rev-parse','HEAD').toString().trim(),tree=git(cwd,'rev-parse','HEAD^{tree}').toString().trim();
  const signed=`tree ${tree}\nparent ${parent}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fixture\n -----END PGP SIGNATURE-----\n\nsigned fixture\n`;
  const commit=execFileSync('git',['-C',cwd,'hash-object','-t','commit','-w','--stdin'],{env:cleanEnv,input:signed}).toString().trim();git(cwd,'update-ref','HEAD',commit);
  process.env.GIT_EXTERNAL_DIFF=helper;
  await runGitInfo({action:'status'},cwd);assert.equal(fs.existsSync(marker),false);
  assert.match(await runGitInfo({action:'diff'},cwd),/reviewed change/);await runGitInfo({action:'show'},cwd);await runGitInfo({action:'log'},cwd);assert.equal(fs.existsSync(marker),false);
  process.env.GIT_DIR=path.join(other,'.git');process.env.GIT_WORK_TREE=other;process.env.GIT_INDEX_FILE=path.join(dir,'foreign-index');
  assert.match(await runGitInfo({action:'diff'},cwd),/reviewed change/);assert.equal(fs.existsSync(process.env.GIT_INDEX_FILE),false);assert.equal(fs.existsSync(marker),false);
 } finally {for(const [key,value] of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;fs.rmSync(dir,{recursive:true,force:true});}
});

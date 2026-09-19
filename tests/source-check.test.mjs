import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const repository=path.resolve(import.meta.dirname,'..');
const agent=[path.join(repository,'agent'),path.resolve(repository,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/source-check.ts')));
const {sourceCheck,checkSourceText}=await import(pathToFileURL(path.join(agent,'extensions/lib/source-check.ts')));
const {matchHook}=await import(pathToFileURL(path.join(agent,'extensions/lib/session-hooks.ts')));
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'source-check-'));
const write=(name,text)=>{fs.mkdirSync(path.dirname(path.join(workspace,name)),{recursive:true});fs.writeFileSync(path.join(workspace,name),text);return name;};
process.on('exit',()=>fs.rmSync(workspace,{recursive:true,force:true}));

test('mixed source/config batch preserves failures and compact digest receipts',async()=>{
  const cases={'ok.mjs':'export const value = 1;', 'bad.js':'const value = ;','ok.ts':'const value: number = 1;', 'bad.tsx':'const View = () => <div>;',
    'ok.json':'{"a":1}','bad.json':'{"a":}','ok.yml':'name: service\n---\nname: worker\n','bad.yaml':'a: 1\na: 2\n'};
  const result=await sourceCheck({cwd:workspace,paths:Object.entries(cases).map(([file,text])=>write(file,text))});
  assert.equal(result.ok,false);assert.equal(result.results.length,8);
  assert.equal(result.counts.unavailable,0,'public dev dependencies must exercise actual JS/TS/YAML parsers');
  for(const r of result.results){assert.equal(r.status,r.path.startsWith('ok')?'passed':'failed',JSON.stringify(r));assert.match(r.digest,/^[a-f0-9]{24}$/);assert.equal(r.source,undefined);}
  assert.ok(JSON.stringify(result).length<5000);
  const before=result.results.find(r=>r.path==='bad.js').digest;
  write('bad.js','const value = 2;');
  const after=await sourceCheck({cwd:workspace,paths:['bad.js','bad.js']});
  assert.equal(after.results.length,1);assert.equal(after.ok,true);assert.notEqual(after.results[0].digest,before);
});

test('installed native parsers check syntax without running project code or startup hooks',async(t)=>{
  const marker=path.join(workspace,'EXECUTED');
  const cases=[
    ['py',`open(${JSON.stringify(marker)},'w').write('executed')\n`,'def invalid(:\n'],
    ['sh',`touch '${marker}'\n`,'if then\n'],
    ['rb',`BEGIN { File.write(${JSON.stringify(marker)},'executed') }\n`,'def invalid(\n'],
    ['php',`<?php file_put_contents(${JSON.stringify(marker)}, 'executed');`,'<?php function invalid( {'],
    ['go','package main\nfunc main() {}\n','package main\nfunc main( {'],
    ['toml','[service]\nport = 8080\n','[service\n'],
  ];
  // These variables would execute user/project startup code in unsafe wrappers.
  const previous={BASH_ENV:process.env.BASH_ENV,PYTHONPATH:process.env.PYTHONPATH,RUBYOPT:process.env.RUBYOPT};
  write('startup.sh',`touch '${marker}'`);write('sitecustomize.py',`open(${JSON.stringify(marker)},'w').write('executed')`);
  write('startup.rb',`File.write(${JSON.stringify(marker)},'executed')`);
  process.env.BASH_ENV=path.join(workspace,'startup.sh');process.env.PYTHONPATH=workspace;process.env.RUBYOPT=`-r${path.join(workspace,'startup.rb')}`;
  try {
    // This fixture proves syntax and startup-hook isolation, not cold-start
    // latency on shared CI hosts. Production keeps its 3-second bound; the
    // separate deadline/cancellation fixture still exercises incomplete results.
    const syntaxFixtureBudgetMs = 15000;
    for(const [ext,valid,invalid] of cases) {
      const good=await checkSourceText(`sample.${ext}`,valid,workspace,undefined,syntaxFixtureBudgetMs);
      if(good.status==='unavailable'){t.diagnostic(`${ext}: ${good.diagnostics.join(' ')}`);continue;}
      assert.equal(good.status,'passed',JSON.stringify(good));assert.equal(fs.existsSync(marker),false,ext);
      const bad=await checkSourceText(`sample.${ext}`,invalid,workspace,undefined,syntaxFixtureBudgetMs);
      assert.equal(bad.status,'failed',JSON.stringify(bad));assert.ok(bad.diagnostics.length,ext);
    }
  } finally {for(const [key,value] of Object.entries(previous)) if(value===undefined)delete process.env[key];else process.env[key]=value;}
  assert.equal(fs.existsSync(marker),false);
});

test('missing native tools cannot use a project PATH shim or count as a pass',async()=>{
  const previous=process.env.PATH;
  write('bin/python3','#!/bin/sh\nexit 0\n');fs.chmodSync(path.join(workspace,'bin/python3'),0o755);
  process.env.PATH=path.join(workspace,'bin')+path.delimiter+'.';
  try {
    const result=await sourceCheck({cwd:workspace,paths:[write('needs.py','value = 1\n')]});
    assert.equal(result.ok,false);assert.equal(result.counts.unavailable,1);
    assert.match(result.results[0].diagnostics[0],/not installed/);
  } finally {if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;}
});

test('native parser deadlines and cancellation do not become syntax passes',async(t)=>{
  const available=await checkSourceText('check.py','value = 1',workspace);
  if(available.status==='unavailable') return t.skip('Python is not installed');
  const timed=await checkSourceText('check.py','value = 1',workspace,undefined,1);
  assert.equal(timed.status,'incomplete');
  const controller=new AbortController();
  const pending=checkSourceText('check.py','value = 1',workspace,controller.signal);
  controller.abort();await assert.rejects(pending,/Cancelled/);
});

test('workspace escapes, unsupported files and bounded reads remain explicit',async()=>{
  const external=fs.mkdtempSync(path.join(os.tmpdir(),'source-check-external-'));
  try {
    fs.writeFileSync(path.join(external,'outside.json'),'{}');fs.symlinkSync(path.join(external,'outside.json'),path.join(workspace,'escape.json'));
    write('large.json',' '.repeat(262145));write('unknown.xyz','anything');
    const result=await sourceCheck({cwd:workspace,paths:['escape.json','large.json','unknown.xyz','missing.py']});
    assert.equal(result.ok,false);assert.equal(result.counts.unavailable,4);assert.equal(result.counts.passed,0);
    assert.ok(result.results.every(r=>r.diagnostics.length));
    await assert.rejects(sourceCheck({cwd:workspace,paths:[]}),/1–20/);
    await assert.rejects(sourceCheck({cwd:workspace,paths:Array(21).fill('ok.json')}),/1–20/);
    const controller=new AbortController();controller.abort();
    await assert.rejects(sourceCheck({cwd:workspace,paths:['ok.json'],signal:controller.signal}),/Cancelled/);
  } finally {fs.rmSync(external,{recursive:true,force:true});}
});

test('failure and success hooks use different bounded receipts',()=>{
  assert.equal(matchHook('syntax_check',{},true)?.key,'source-check-recovery');
  assert.equal(matchHook('syntax_check',{})?.key,'source-check-scope');
});

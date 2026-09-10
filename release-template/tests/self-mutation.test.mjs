import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(templateRoot, 'agent'), path.resolve(templateRoot, '..')]
  .find(dir => fs.existsSync(path.join(dir, 'extensions/lib/self-mutation-guard.ts')));
assert.ok(agent, 'self-mutation guard must be shipped');
const moduleUrl = pathToFileURL(path.join(agent, 'extensions/lib/self-mutation-guard.ts')).href;
const harness = path.dirname(agent);
const wrapper = path.join(agent, 'scripts/harness-readonly-exec.py');
assert.ok(fs.existsSync(wrapper), 'namespace launcher must be shipped');
function fixture() {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-mutation-'));
 const protectedDir = path.join(root, 'harness'), project = path.join(root, 'project');
 fs.mkdirSync(protectedDir); fs.mkdirSync(project);
 fs.writeFileSync(path.join(protectedDir, 'original'), 'unchanged');
 return {root, protectedDir, project, close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
function node(cwd, code, extra={}) {
 const env={...process.env}; delete env.PI_HARNESS_MUTATION_DENIED; delete env.PI_SUBAGENT_CHILD; delete env.NODE_TEST_CONTEXT;
 return spawnSync(process.execPath, ['--experimental-strip-types','--input-type=module','-e',code],
  {cwd,env:{...env,...extra},encoding:'utf8'});
}
function authority(cwd, extra={}, change=false) {
 const result=node(cwd, `const g=await import(${JSON.stringify(moduleUrl)});${change?`process.chdir(${JSON.stringify(harness)});`:''}console.log(JSON.stringify([g.SELF_MUTATION_ALLOWED,!!g.selfMutationDenial(${JSON.stringify(path.join(harness,'new-file'))},process.cwd())]));`,extra);
 assert.equal(result.status,0,result.stderr); return JSON.parse(result.stdout.trim());
}
test('maintenance authority is latched at original process launch',()=>{
 const f=fixture(); try {
  for(const cwd of [harness,path.dirname(harness),path.parse(harness).root]) assert.deepEqual(authority(cwd),[true,false]);
  assert.deepEqual(authority(f.project),[false,true]);
  assert.deepEqual(authority(f.project,{},true),[false,true]);
  assert.deepEqual(authority(harness,{PI_SUBAGENT_CHILD:'1'}),[false,true]);
  assert.deepEqual(authority(harness,{PI_HARNESS_MUTATION_DENIED:'1'}),[false,true]);
 } finally {f.close();}
});
test('new targets resolve symlink ancestors and unrelated prefixes remain outside',()=>{
 const f=fixture(); try {
  try {fs.symlinkSync(f.protectedDir,path.join(f.project,'alias'),'dir');} catch(error) {
   if(error.code==='EPERM' && process.platform==='win32') throw new Error('Symlink creation is required for this path-resolution test; enable Developer Mode.'); throw error;
  }
  const result=node(f.project,`const g=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify([g.canonicalMutationPath('alias/new/deep'),g.containsPath(${JSON.stringify(f.protectedDir)},${JSON.stringify(f.protectedDir+'-sibling')})]));`);
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),[path.join(f.protectedDir,'new/deep'),false]);
 } finally {f.close();}
});
test('unsupported namespace platform fails closed before launching a command',()=>{
 const f=fixture(); try {
  const result=node(f.project,`Object.defineProperty(process,'platform',{value:'unsupported-test'}); const g=await import(${JSON.stringify(moduleUrl)}); try {g.guardedCommand('arbitrary-command',[]);process.exit(99);} catch(e){if(!/No unisolated command was started/.test(e.message))throw e;}`);
  assert.equal(result.status,0,result.stderr);
 } finally {f.close();}
});
test('real namespace prevents mutation while allowing project work',t=>{
 const f=fixture(); try {
  const python=process.platform==='linux'?'/usr/bin/python3':'python3';
  const run=code=>spawnSync(python,['-I',wrapper,f.protectedDir,'--',python,'-c',code],{cwd:f.project,encoding:'utf8'});
  const probe=run("open('normal','w').write('ok')");
  if(probe.status!==0) {
   const unavailable = probe.error?.code === 'ENOENT' || /Linux bubblewrap runtime required|required executable unavailable: \/usr\/bin\/bwrap|bwrap:.*(?:Operation not permitted|Permission denied|No permissions to create|Creating new namespace failed|namespace)/i.test(probe.stderr ?? '');
   assert.ok(unavailable, `Namespace probe failed unexpectedly: ${probe.stderr ?? probe.error}`);
   assert.notEqual(process.env.PI_REQUIRE_ISOLATION_TEST, '1', `Required namespace integration unavailable: ${probe.stderr ?? probe.error}`);
   assert.ok(!fs.existsSync(path.join(f.project,'normal')),'failed isolation must not execute payload');
   assert.equal(fs.readFileSync(path.join(f.protectedDir,'original'),'utf8'),'unchanged');
   t.skip('Real namespace integration unavailable on this host; payload did not execute. Portable fail-closed checks ran separately.');return;
  }
  const target=JSON.stringify(path.join(f.protectedDir,'original'));
  for(const code of [`open(${target},'w').write('bad')`,`import os;os.chmod(${target},0o777)`,`import os;os.rename(${JSON.stringify(f.root)},${JSON.stringify(f.root+'-moved')})`,`import os;os.chdir(${JSON.stringify(f.protectedDir)});os.environ.clear();open('new','w').write('bad')`]) assert.notEqual(run(code).status,0,code);
  assert.equal(fs.readFileSync(path.join(f.protectedDir,'original'),'utf8'),'unchanged');
  fs.linkSync(path.join(f.protectedDir,'original'),path.join(f.project,'hardlink'));
  const linked=run("open('hardlink','w').write('bad')");assert.equal(linked.status,126);assert.match(linked.stderr,/hard-linked/);
  assert.equal(fs.readFileSync(path.join(f.protectedDir,'original'),'utf8'),'unchanged');
 } finally {f.close();}
});

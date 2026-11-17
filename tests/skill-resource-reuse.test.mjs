import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const load = relative => import(pathToFileURL(path.join(root, relative)));
const {DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession} = await load('core/coding-agent/dist/index.js');
const {default:registerLensResources} = await load('agent/extensions/pi-lens/fork-resources.ts');

test('Lens resource discovery reuses unchanged skill metadata while observing follow-up topology and file changes', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-skill-reuse-'));
  const agentDir = path.join(cwd, 'agent'), catalogueDir = path.join(cwd, 'catalogue');
  fs.mkdirSync(agentDir);
  fs.mkdirSync(catalogueDir);
  t.after(() => fs.rmSync(cwd, {recursive:true,force:true}));
  const text=(name,description)=>`---\nname: ${name}\ndescription: ${description}\n---\n# Guide\n`;
  const skillPath=name=>{
    const dir=path.join(catalogueDir,name);
    fs.mkdirSync(dir);
    return path.join(dir,'SKILL.md');
  };
  const put=(name,description)=>{
    const file=skillPath(name);
    fs.writeFileSync(file,text(name,description));
    return file;
  };
  const stable=put('stable','Unchanged metadata.');
  const rewrite=put('rewrite','Previous metadata.');
  const fixedMtime=1_700_000_000;
  fs.utimesSync(rewrite,fixedMtime,fixedMtime);
  const deleted=put('deleted','Remove before extension discovery.');
  const ignored=put('ignored','Ignore before extension discovery.');
  const linked=skillPath('linked');
  const before=path.join(cwd,'before.md'), after=path.join(cwd,'after.md');
  fs.writeFileSync(before,text('linked','Previous referent.'));
  fs.writeFileSync(after,text('linked','Replaced referent.'));
  fs.symlinkSync(before,linked);
  const opens=new Map([stable,rewrite,deleted,ignored,linked].map(file=>[file,0]));
  const original=fs.openSync;
  fs.openSync=(file,...args)=>{
    if(opens.has(file))opens.set(file,opens.get(file)+1);
    return original(file,...args);
  };
  syncBuiltinESMExports();

  let session;
  try {
    const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
    const loader=new DefaultResourceLoader({
      cwd,agentDir,settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,
      noThemes:true,additionalSkillPaths:[catalogueDir],extensionFactories:[registerLensResources],
    });
    await loader.reload();
    assert.deepEqual([...opens.values()],[1,1,1,1,1]);

    const old=fs.statSync(rewrite,{bigint:true});
    fs.writeFileSync(rewrite,text('rewrite','Modified metadata.'));
    fs.utimesSync(rewrite,fixedMtime,fixedMtime);
    const revised=fs.statSync(rewrite,{bigint:true});
    assert.equal(revised.size,old.size);
    assert.equal(revised.mtimeNs,old.mtimeNs);
    assert.notEqual(revised.ctimeNs,old.ctimeNs);
    fs.unlinkSync(linked);
    fs.symlinkSync(after,linked);
    fs.unlinkSync(deleted);
    fs.writeFileSync(path.join(catalogueDir,'.ignore'),'ignored/\n');

    const model={id:'fixture',name:'Fixture',provider:'fixture',api:'openai-completions',
      baseUrl:'https://fixture.invalid',input:['text'],reasoning:false,contextWindow:65536,maxTokens:4096,
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
    const modelRuntime={getModel:()=>model,getAvailable:()=>[model],hasConfiguredAuth:()=>false,isUsingSubscription:()=>false,
      getAuth:async()=>({auth:{}}),streamSimple(){throw Error('No provider work belongs in this fixture');}};
    ({session}=await createAgentSession({cwd,agentDir,model,modelRuntime,settingsManager,resourceLoader:loader,
      sessionManager:SessionManager.inMemory(cwd),noTools:'all',thinkingLevel:'off'}));
    await session.bindExtensions({mode:'rpc'});

    const catalogue=new Map(loader.getSkills().skills.map(skill=>[skill.name,skill]));
    assert.equal(catalogue.size,7);
    assert.equal(catalogue.get('stable')?.description,'Unchanged metadata.');
    assert.equal(catalogue.get('rewrite')?.description,'Modified metadata.');
    assert.equal(catalogue.get('linked')?.description,'Replaced referent.');
    assert.ok(!catalogue.has('deleted')&&!catalogue.has('ignored'));
    assert.ok(catalogue.has('pi-lens-lsp-navigation'));
    assert.deepEqual([...opens.values()],[1,2,1,1,2]);

    await loader.reload();
    assert.deepEqual([...opens.values()],[2,3,1,1,3], 'an explicit reload must read a fresh catalog');
  } finally {
    session?.dispose();
    fs.openSync=original;
    syncBuiltinESMExports();
  }
});

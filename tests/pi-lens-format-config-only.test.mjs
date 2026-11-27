import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {parseExpressionAt} from 'acorn';

// A trial repo without any formatter config had its quote style rewritten by the
// default biome run after the model's edit. Formatting an opinionated style
// (biome, prettier, ruff, black ...) now needs a config the project chose.
// The bundle is one file, so shipped sources are evaluated with injected collaborators.
const bundle=fs.readFileSync(new URL('../agent/extensions/pi-lens/dist/index.js',import.meta.url),'utf8');
function declaration(name) {
  const marker=[`async function ${name}(`,`function ${name}(`].map(needle=>bundle.indexOf(needle)).filter(at=>at>=0).sort((a,b)=>a-b)[0];
  assert.ok(marker!==undefined,`shipped function ${name} exists`);
  return bundle.slice(marker,parseExpressionAt(bundle,marker,{ecmaVersion:'latest'}).end);
}
function assignment(name) {
  const at=bundle.indexOf(`${name} = `);
  assert.ok(at>=0,`shipped ${name} exists`);
  const start=at+name.length+3;
  return `var ${name} = ${bundle.slice(start,parseExpressionAt(bundle,start,{ecmaVersion:'latest'}).end)};`;
}

const exts={biome:['.js','.css'],prettier:['.js','.md','.yaml','.css'],oxfmt:['.js'],ruff:['.py'],black:['.py'],gofmt:['.go'],shfmt:['.sh']};
function formatterNamesFor(dir,file) {
  const has=(...names)=>names.some(n=>fs.existsSync(path.join(dir,n)));
  const checks=new Map([
    ['biome',()=>has('biome.json','biome.jsonc')],
    ['prettier',()=>has('.prettierrc','.prettierrc.json','prettier.config.js')],
    ['oxfmt',()=>false],
    ['ruff',()=>has('ruff.toml')],
    ['black',()=>false],
  ]);
  const all=Object.entries(exts).map(([name,extensions])=>({
    name,extensions,
    // Every tool is installed, as it is after pi-lens auto-installed it; dependency-only detection must not decide.
    detect:async()=>name==='prettier'||name==='gofmt'||checks.has(name)&&checks.get(name)(),
  }));
  const context=vm.createContext({
    path144:path,fs101:fs,path44:path,Map,Set,Promise,
    ALL_FORMATTERS:all,EXPLICIT_FORMATTER_CONFIG_CHECKS:checks,
    FILENAME_FORMATTER_BASENAMES:new Set(),FORMATTER_POLICY_BY_FILENAME:new Map(),
    detectionCache:new Map(),probedCommandsStorage:{run:(s,f)=>f()},whichTransientCommands:new Set(),
    normalizeMapKey:x=>x,resetWhichLatches(){},logLatency(){},logExtension(){},
    findUp:async()=>[],FORMATTER_CONFIG_FILES:[],FORMATTERS_WITH_EXPLICIT_CONFIG_CHECK:new Set(['biome','prettier','oxfmt','ruff','black']),compareOrdinal:(a,b)=>a<b?-1:1,
  });
  vm.runInContext([
    assignment('FORMATTER_POLICY_BY_EXTENSION'),assignment('AUTO_INSTALLABLE_DEFAULT_FORMATTERS'),
    ...['getFormatterPolicyForExtension','getFormatterPolicyForFile','getSmartDefaultFormatterName','getAutoInstallToolIdForFormatter','hasExplicitFormatterConfig','detectCandidate','formatterConfigSignature','getFormattersForFile'].map(declaration),
    'this.api={getFormattersForFile};',
  ].join('\n'),context);
  return context.api.getFormattersForFile(path.join(dir,file),dir).then(list=>[...list].map(f=>f.name));
}

async function inTempProject(files,fn) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lens-fmt-'));
  try {
    for (const [name,content] of Object.entries(files)) fs.writeFileSync(path.join(dir,name),content);
    return await fn(dir);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}

test('a project without formatter config gets no style-imposing formatter',async()=>{
  await inTempProject({'cli.js':"'use strict';\n",'README.md':'* a\n','app.py':'x=1\n','a.yaml':'a: 1\n','package.json':'{"devDependencies":{"prettier":"3"}}'},async dir=>{
    for (const file of ['cli.js','README.md','app.py','a.yaml']) assert.deepEqual(await formatterNamesFor(dir,file),[],file);
  });
});

test('a project formatter config selects its formatter',async()=>{
  await inTempProject({'cli.js':'x\n','.prettierrc':'{}'},async dir=>assert.deepEqual(await formatterNamesFor(dir,'cli.js'),['prettier']));
  await inTempProject({'cli.js':'x\n','biome.json':'{}'},async dir=>assert.deepEqual(await formatterNamesFor(dir,'cli.js'),['biome']));
  await inTempProject({'app.py':'x\n','ruff.toml':''},async dir=>assert.deepEqual(await formatterNamesFor(dir,'app.py'),['ruff']));
  await inTempProject({'README.md':'x\n','.prettierrc':'{}'},async dir=>assert.deepEqual(await formatterNamesFor(dir,'README.md'),['prettier']));
});

test('canonical formatters without style options still run unconfigured',async()=>{
  await inTempProject({'main.go':'package main\n'},async dir=>assert.deepEqual(await formatterNamesFor(dir,'main.go'),['gofmt']));
});

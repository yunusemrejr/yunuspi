import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-lens/semantic-radar/extract.mjs')));
const load=p=>import(pathToFileURL(path.join(agent,'extensions/pi-lens/semantic-radar',p)));
const {parserFor,extractFunctions}=await load('extract.mjs');
const {scorePair,SemanticIndex}=await load('index.mjs');
const {rankCandidates,neuralRankerStatus}=await load('neural-ranker.mjs');
const src='function Save({form}) { return <button aria-label="Save" onClick={form.save}>{form.title} Save</button>; }';
async function fingerprint(source,extension='.tsx') {
  const parser=await parserFor(extension),tree=parser.parse(source);
  try {assert.equal(tree.rootNode.hasError,false);return extractFunctions(tree.rootNode,source)[0];}finally{tree.delete();}
}
test('component contract drift remains visible and cannot acquire learned reuse confidence',async()=>{
  assert.equal(neuralRankerStatus().available,true,'exercise the installed learned model');
  const a=await fingerprint(src),rename=await fingerprint(src.replace('function Save','function Submit'));
  assert.equal(a.uiContractHash,rename.uiContractHash,'function name is not a UI contract');
  for(const changed of [src.replaceAll('button','div'),src.replace('onClick','onMouseEnter'),src.replace('aria-label','data-label'),src.replace(' Save</',' Delete</'),src.replace('"Save"','"Delete"')]) {
    const b=await fingerprint(changed),pair=scorePair(a,b);
    assert.notEqual(a.uiContractHash,b.uiContractHash);assert.notEqual(pair.tier,'lexical');assert.match(pair.evidence.join('\n'),/JSX.*differs/);
    const candidates=[{...b,...pair},{...rename,...scorePair(a,rename)}];
    const baseline=rankCandidates(a,candidates,{mode:'off'}),learned=rankCandidates(a,candidates,{mode:'on'});
    assert.deepEqual(learned,baseline,'contract drift abstains for its tier without dropping candidates');
  }
  const plain=await fingerprint('function check(value) { return value.ok ? value.result : null; }','.ts');assert.equal(plain.uiContractHash,undefined);
});
test('JSX evidence survives persisted index reload; old or corrupt contract caches rebuild',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jsx-radar-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=await fingerprint(src),index=new SemanticIndex(dir);index.upsertFile('Save.tsx','digest',1,[a]);index.save();
  const reloaded=await SemanticIndex.load(dir);assert.equal(reloaded.files['Save.tsx'].funcs[0].uiContractHash,a.uiContractHash);
  const cache=path.join(dir,'semantic-radar-index.json'),disk=JSON.parse(fs.readFileSync(cache,'utf8'));
  disk.files['Save.tsx'].funcs[0].uiContractHash='invalid';fs.writeFileSync(cache,JSON.stringify(disk));assert.deepEqual((await SemanticIndex.load(dir)).files,{});
  disk.version=5;disk.files['Save.tsx'].funcs[0].uiContractHash=a.uiContractHash;fs.writeFileSync(cache,JSON.stringify(disk));assert.deepEqual((await SemanticIndex.load(dir)).files,{});
});

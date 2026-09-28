import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJiti} from 'jiti';

const jiti=createJiti(import.meta.dirname);
const {analyzeStructure}=await jiti.import('../agent/extensions/lib/code-structure.ts');
const {codeQuality}=await jiti.import('../agent/extensions/lib/code-quality.ts');
const file=(p,source)=>({path:p,source});

test('import cycles, orphans, hotspots and large files come from the import graph',()=>{
 const files=[
  file('src/index.ts',"import { a } from './a.js';\nimport './util';\n"),
  file('src/a.ts',"import { b } from './b.js';\nexport const a = 1;\n"),
  file('src/b.ts',"import { a } from './a.js';\nexport const b = 2;\n"),
  file('src/util/index.ts',"export const u = 1;\n"),
  file('src/dead.ts',"export const dead = 1;\n"),
  file('src/big.ts',Array.from({length:700},(_,i)=>`export const v${i} = ${i};`).join('\n')),
  file('src/main.test.ts',"import './dead';\n"),
 ];
 const report=analyzeStructure(files);
 assert.deepEqual(report.cycles,[{files:['src/a.ts','src/b.ts'],size:2}]);
 assert.ok(report.orphans.includes('src/big.ts'));
 assert.ok(!report.orphans.includes('src/dead.ts'),'a test that imports a module keeps it referenced');
 assert.ok(!report.orphans.includes('src/index.ts'),'entry points are never orphans');
 assert.ok(!report.orphans.includes('src/util/index.ts'),'directory imports resolve to index files');
 assert.deepEqual(report.large,[{file:'src/big.ts',lines:700}]);
 assert.equal(report.fanIn[0].importers,2,'a.ts and b.ts import each other; both count');
});

test('type-only imports form no runtime cycle',()=>{
 const report=analyzeStructure([file('a.ts',"import type { B } from './b.js';\nexport type A = B;\n"),file('b.ts',"import { A } from './a.js';\nexport type B = A;\nexport const b = 1;\n")]);
 assert.deepEqual(report.cycles,[]);
});

test('comments and strings do not create edges; self imports are cycles',()=>{
 const report=analyzeStructure([
  file('a.ts',"// import './b'\n/* import './b' */\nconst x = \"import './b'\";\n"),
  file('b.ts',"export {};\n"),
  file('c.ts',"import './c';\n"),
 ]);
 assert.equal(report.edges,1,'only the self import counts');
 assert.deepEqual(report.cycles,[{files:['c.ts'],size:1}]);
});

test('python packages resolve absolute and relative imports',()=>{
 const report=analyzeStructure([
  file('pkg/__init__.py',''),
  file('pkg/a.py','from .b import x\nimport pkg.c\n'),
  file('pkg/b.py','from . import a\nfrom pkg.a import y\n'),
  file('pkg/c.py','import os\n'),
 ]);
 assert.deepEqual(report.cycles,[{files:['pkg/a.py','pkg/b.py'],size:2}]);
 assert.ok(!report.orphans.includes('pkg/c.py'));
});

test('dependency drift compares bare imports with package.json',()=>{
 const files=[file('src/x.ts',"import fs from 'node:fs';\nimport path from 'path';\nimport z from 'zod';\nimport { q } from '@scope/pkg/deep';\nimport t from '@/alias';\nimport r from 'react';\n")];
 const manifest={dependencies:{react:'1',lodash:'4'},devDependencies:{'@types/node':'1'}};
 const report=analyzeStructure(files,manifest);
 assert.deepEqual(report.dependencies.undeclared,['@scope/pkg','zod']);
 assert.deepEqual(report.dependencies.unused,['lodash']);
 assert.equal(analyzeStructure(files,manifest,false).dependencies,undefined,'a partial scope cannot judge unused packages');
});

test('code_quality structure runs through the real collector',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'structure-'));
 try{
  fs.mkdirSync(path.join(dir,'src'));
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'demo',dependencies:{left:'1'}}));
  fs.writeFileSync(path.join(dir,'src/a.js'),"const b = require('./b');\nmodule.exports = b;\n");
  fs.writeFileSync(path.join(dir,'src/b.js'),"const a = require('./a');\nmodule.exports = a;\n");
  const result=await codeQuality({operation:'structure'},dir);
  assert.deepEqual(result.cycles,[{files:['src/a.js','src/b.js'],size:2}]);
  assert.deepEqual(result.dependencies.unused,['left']);
  assert.equal(result.scope.files,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

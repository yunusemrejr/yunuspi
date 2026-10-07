import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunkCode, indexFile } from '../agent/extensions/lib/project-memory-index.ts';
import { openProjectStore } from '../agent/extensions/lib/project-vector-store.ts';

test('dense source lines finish chunking and preserve every line after shrinking a window', () => {
  // Isolate the synchronous chunker so a regression cannot park the test runner.
  const script = `
    import { chunkCode } from './agent/extensions/lib/project-memory-index.ts';
    const lines = Array.from({length:100}, (_, i) => 'line' + i + 'x'.repeat(600));
    const chunks = chunkCode(lines.join('\\n'));
    const covered = new Set(chunks.flatMap(chunk => Array.from({length:chunk.end-chunk.start+1}, (_, i) => chunk.start+i)));
    console.log(JSON.stringify({covered:covered.size, chunks:chunks.length}));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 5000, maxBuffer: 8192,
    env: {...process.env, PI_LOCAL_LM: 'off', PI_NEEDLE_DISK_CACHE: 'off'},
  });
  assert.equal(run.error, undefined, `chunking failed to settle: ${run.error?.code}`);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.covered, 100);
  assert.ok(result.chunks <= 64, 'dense source must fit the existing file insertion budget without mostly repeated fragments');
});

test('code windows advance, retain exact line spans, and cover varied dense sources', () => {
  let seed = 71;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 80; i++) {
    const lines = Array.from({length: 1 + next() % 160}, (_, index) => `${index} ${'ç'.repeat(16 + next() % 1600)}`);
    const windowLines = 1 + next() % 90, overlapLines = next() % 60, maxChars = 1 + next() % 8000;
    const chunks = chunkCode(lines.join('\n'), {windowLines, overlapLines, maxChars});
    const covered = new Set();
    let previous = 0, prior;
    for (const chunk of chunks) {
      assert.ok(chunk.start > previous && chunk.end >= chunk.start && chunk.end <= lines.length);
      if (prior) assert.ok(prior.end - chunk.start + 1 <= Math.floor((prior.end - prior.start + 1) / 2), 'overlap must fit the actual preceding window');
      assert.equal(chunk.text, lines.slice(chunk.start - 1, chunk.end).join('\n'));
      for (let line = chunk.start; line <= chunk.end; line++) covered.add(line);
      previous = chunk.start;
      prior = chunk;
    }
    assert.equal(covered.size, lines.length, `source ${i} lost lines`);
  }
});

test('invalid code-window controls fail before starting a nonprogressing scan', () => {
  for (const options of [{windowLines:0}, {windowLines:-1}, {windowLines:NaN}, {overlapLines:-1}, {maxChars:Infinity}]) {
    assert.throws(() => chunkCode('a source line long enough to index', options), RangeError);
  }
});

test('a bounded file reindex retains unchanged evidence moved beyond the insertion budget', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'memory-source-budget-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store = openProjectStore(path.join(dir,'memory.sqlite'),{projectId:'source-budget'});
  t.after(()=>store.close());
  const paragraphs = Array.from({length:64},(_,i)=>`Architecture paragraph ${i} retains a distinct repository design decision.`);
  const input = {path:'docs/design.md',content:paragraphs.join('\n\n')};
  await indexFile(store,store.projectId,input);
  const tail = store.getChunksByPath(input.path,200).find(chunk=>chunk.text===paragraphs.at(-1));
  const prefix = Array.from({length:35},(_,i)=>`New preface paragraph ${i} records the source indexing boundary.`).join('\n\n');
  const result = await indexFile(store,store.projectId,{...input,content:prefix+'\n\n'+input.content});
  const current = store.getChunk(tail.id);
  assert.equal(current.valid_until,null,'an insertion budget cannot declare still-present source evidence obsolete');
  assert.ok(current.source_start>tail.source_start,'retained evidence still tracks its observed line location');
  assert.ok(store.sourceManifest(input.path,'architecture').includes(tail.id));
  assert.equal(result.truncated,true,'omitted new chunks must be visible to callers');
  assert.equal(result.indexedChunks,64);
  assert.equal(result.totalChunks,99);
  // Once the actual source removes it, the next complete index retires it.
  await indexFile(store,store.projectId,{...input,content:paragraphs[0]});
  assert.notEqual(store.getChunk(tail.id).valid_until,null);
});

test('temporary and workspace memory roots keep tree protection while individual notes remain writable', async t => {
  const {assessShellMutation,isPathProtected} = await import('../agent/extensions/filesystem-safety.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'memory-root-policy-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const memory = path.join(dir,'private-notes');
  fs.mkdirSync(path.join(memory,'projects'),{recursive:true});
  const previous = process.env.PI_MEMORY_DIR;
  process.env.PI_MEMORY_DIR = memory;
  t.after(()=>{if(previous===undefined)delete process.env.PI_MEMORY_DIR;else process.env.PI_MEMORY_DIR=previous;});
  for (const cwd of [dir,path.join(dir,'project')]) {
    fs.mkdirSync(cwd,{recursive:true});
    for (const command of [`rm -rf ${memory}`,`rm -rf ${memory}/projects`,`rm -f ${memory}/*`,`rm -rf ${dir}`]) {
      assert.equal(assessShellMutation(command,cwd)?.level,'block',command);
    }
    assert.equal(assessShellMutation(`echo note >> ${memory}/daily.md`,cwd)?.level,undefined);
    assert.equal(assessShellMutation(`cp ${cwd}/note.md ${memory}/projects/note.md`,cwd)?.level,undefined);
    assert.equal(isPathProtected(memory,cwd),true);
    assert.equal(isPathProtected(path.join(memory,'daily.md'),cwd),false);
    assert.equal(assessShellMutation(`rm -rf ${cwd}/build`,cwd)?.level,undefined,'normal project cleanup retains its authority');
  }
  const alias = path.join(dir,'notes-link');
  fs.symlinkSync(memory,alias,'dir');
  assert.equal(assessShellMutation(`rm -rf ${alias}`,dir)?.level,undefined,'unlinking a leaf symlink does not delete memory');
  assert.equal(assessShellMutation(`rm -rf ${alias}/`,dir)?.level,'block','following a directory link retains the target protection');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needleMemoryEmbedder, embeddingWindows, poolVectors, MEMORY_EMBED_CHARS } from '../agent/extensions/lib/project-memory-embedder.ts';
import { openProjectStore } from '../agent/extensions/lib/project-vector-store.ts';
import { atomizeParent, buildAtomInputs, embedderCoverage, indexFile, ATOM_HARD_SPLIT_CHARS } from '../agent/extensions/lib/project-memory-index.ts';

// A stand-in for the Needle worker that reads only the first 512 characters of
// each input, exactly like the real runtime, and fingerprints what it read.
const SHARED = Symbol.for('yunus-pi.needle-runtime.v1');
const LIMIT = 512;
const seen = [];
const fakeHandle = {
  warmup() {},
  async embed(texts) {
    seen.push(...texts);
    const vectors = texts.map((text) => {
      const vec = new Array(8).fill(0);
      for (const word of text.slice(0, LIMIT).toLowerCase().match(/[a-z]+/g) ?? []) {
        let h = 0;
        for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % 8;
        vec[h] += 1;
      }
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
    return { ok: true, value: { vectors } };
  },
};
const install = (t) => {
  const previous = globalThis[SHARED];
  globalThis[SHARED] = fakeHandle;
  seen.length = 0;
  t.after(() => { if (previous === undefined) delete globalThis[SHARED]; else globalThis[SHARED] = previous; });
};

test('windows cover every character and pooled vectors stay unit length', () => {
  const text = Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ');
  const windows = embeddingWindows(text, 200);
  assert.ok(windows.every((w) => w.length <= 200));
  assert.equal(windows.join(''), text);
  const pooled = poolVectors([[1, 0], [0, 1]]);
  assert.ok(Math.abs(Math.hypot(...pooled) - 1) < 1e-9);
  assert.deepEqual(poolVectors([[0.6, 0.8]]), [0.6, 0.8]);
});

test('the Needle adapter feeds the model every window of a long text, not just its head', async (t) => {
  install(t);
  const embedder = needleMemoryEmbedder();
  const head = 'alpha '.repeat(100);
  const tail = 'zeta '.repeat(100);
  const [short, long] = await embedder.embed(['alpha alpha', head + tail]);
  assert.ok(seen.some((text) => text.includes('zeta')), 'tail text reached the model');
  assert.equal(short.length, long.length);
  const queryZeta = (await embedder.embed(['zeta zeta zeta']))[0];
  const queryAlpha = (await embedder.embed(['alpha alpha alpha']))[0];
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  assert.ok(dot(long, queryZeta) > 0.2, 'the pooled vector responds to a tail-only query');
  assert.ok(dot(long, queryAlpha) > 0, 'and still to the head');
});

test('atoms sized for a truncating backend keep every character inside its coverage', () => {
  const embedder = needleMemoryEmbedder();
  assert.equal(embedderCoverage(embedder), 512);
  assert.equal(embedderCoverage({ id: 'remote', embed: async () => null }), undefined);
  const block = (name) => `function ${name}() {\n${'  doSomething(argument);\n'.repeat(30)}}\n`; // ~760 chars, below the 1600 hard split
  const source = [block('first'), block('second'), block('third')].join('\n');
  const wide = buildAtomInputs('c1', { title: 'Title', text: source, start: 1 }, { kind: 'code' });
  assert.ok(wide.some((atom) => atom.text.length > 512), 'default sizing leaves atoms beyond the local window');
  const fit = buildAtomInputs('c1', { title: 'Title', text: source, start: 1 }, { kind: 'code', coverage: 512 });
  for (const atom of fit) assert.ok((atom.ordinal === 0 ? 'Title\n'.length : 0) + atom.text.length <= 512, `atom ${atom.ordinal} fits (${atom.text.length})`);
  assert.equal(fit.map((atom) => atom.text).join('').replace(/\s+/g, ''), wide.map((atom) => atom.text).join('').replace(/\s+/g, ''), 'no text is lost by sizing');
  assert.ok(atomizeParent(source, 'code', 800, ATOM_HARD_SPLIT_CHARS).length < fit.length);
});

test('indexFile with a local embedder stores atoms the local model can read in full', async (t) => {
  install(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-coverage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openProjectStore(path.join(dir, 'memory.sqlite'), { projectId: 'prj_cov' });
  t.after(() => store.close());
  const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} explains topic${i} in enough words to matter. `.repeat(8)).join('\n\n');
  const embedder = needleMemoryEmbedder();
  const result = await indexFile(store, 'prj_cov', { path: 'docs/long.md', content: `# Long\n\n${paragraphs}` }, { embedder });
  assert.ok(result.inserted >= 1);
  for (const id of result.ids) for (const atom of store.getAtoms(id)) {
    assert.ok(atom.text.length + (atom.title ? atom.title.length + 1 : 0) <= 512 + 8, `atom ${atom.id} fits the local window (${atom.text.length})`);
  }
  assert.ok(MEMORY_EMBED_CHARS >= 1760, 'remote input budget still covers a default-sized atom plus title');
});

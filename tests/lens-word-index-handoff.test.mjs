import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parseExpressionAt } from 'acorn';

// Exercise the bundled fork's actual lease owner with a controlled snapshot
// publication. No real project or background worker is needed to reproduce
// the initial-miss -> completed-build transition.
const source = fs.readFileSync(new URL('../agent/extensions/pi-lens/dist/index.js', import.meta.url), 'utf8');
const start = source.indexOf('function acquireWarmWordIndex(');
const node = parseExpressionAt(source, start, { ecmaVersion: 'latest' });

test('a missing warm index observes a later build without replacing concurrent leases', () => {
  let published, loads = 0;
  const entries = new Map();
  const acquire = vm.runInNewContext(`(${source.slice(start, node.end)})`, {
    path180: path, warmWordIndexes: entries, Date,
    loadProjectSnapshot: () => { loads++; return { wordIndex: published }; },
    deserializeWordIndex: value => value,
    scheduleWarmWordIndexIdleEviction() {}, enforceWarmWordIndexLruCap() {},
  });
  const first = acquire('/fixture/project');
  assert.equal(first.index, undefined);
  const entry = entries.get('/fixture/project');
  published = { forward: new Map([['source.cpp', 1]]), docCount: 1 };
  const second = acquire('/fixture/project');
  assert.equal(second.index, published);
  assert.equal(entries.get('/fixture/project'), entry);
  assert.equal(entry.leases, 2);
  first.release(); first.release();
  assert.equal(entry.leases, 1);
  second.release();
  const third = acquire('/fixture/project');
  assert.equal(third.index, published);
  assert.equal(loads, 2, 'successful warm queries should not reload the snapshot');
  third.release();
  assert.equal(entry.leases, 0);
});

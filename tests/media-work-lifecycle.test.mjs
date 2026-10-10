import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.join(root, '..', 'agent'), path.resolve(root, '..'), path.resolve(root, '../..')].find(dir => existsSync(path.join(dir, 'extensions/lib/media-process.ts')));
const load = file => import(pathToFileURL(path.join(agent, 'extensions/lib', file)));
const { mediaMap } = await load('media-process.ts');

test('media workers cancel siblings, stop dequeuing, settle cleanup and retain the first cause', async () => {
  const cause = new Error('frame decode failed'), started = [], settled = [];
  let fail;
  const failed = new Promise((_resolve, reject) => { fail = reject; });
  const running = mediaMap(Array.from({ length: 12 }, (_, i) => i), async (item, _index, signal) => {
    started.push(item);
    if (item === 0) { await failed; return item; }
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => setImmediate(resolve));
    settled.push(item);
    signal.throwIfAborted();
    return item;
  });
  fail(cause);
  await assert.rejects(running, error => error === cause);
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.deepEqual(settled.sort(), [1, 2, 3], 'all writers settled before rejection/cleanup');
});

test('media workers preserve ordered output and propagate parent cancellation', async () => {
  let active = 0, peak = 0;
  const result = await mediaMap([3, 1, 2, 0, 4], async (item, index) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return `${index}:${item}`;
  }, undefined, 2);
  assert.deepEqual(result, ['0:3', '1:1', '2:2', '3:0', '4:4']);
  assert.equal(peak, 2);
  const controller = new AbortController();
  const cancelled = mediaMap([0, 1, 2], async (_item, _index, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
  }, controller.signal);
  controller.abort(new Error('parent stopped'));
  await assert.rejects(cancelled, /parent stopped/);
  let work = 0;
  await assert.rejects(mediaMap([1], async () => work++, controller.signal), /parent stopped/);
  assert.equal(work, 0);
});

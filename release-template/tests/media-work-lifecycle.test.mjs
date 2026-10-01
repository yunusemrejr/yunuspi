import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.join(root, '..', 'agent'), path.resolve(root, '..'), path.resolve(root, '../..')].find(dir => existsSync(path.join(dir, 'extensions/lib/media-process.ts')));
const load = file => import(pathToFileURL(path.join(agent, 'extensions/lib', file)));
const { mediaMap } = await load('media-process.ts');
const { mediaPipeline } = await load('media-pipeline.ts');
const score = { bpm: 120, beats: 4, tracks: [{ notes: [{ pitch: 60, start: 0, duration: 4 }] }] };

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

test('invalid media pipelines allocate no output or score synthesis before source preflight', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-work-lifecycle-'));
  const events = [], watcher = watch(dir, (_event, name) => events.push(name));
  try {
    for (const params of [
      { score, tracks: [{ path: 'missing.wav' }] },
      { score, ducking: true },
      { score, clips: [{ path: 'missing.mp4', duration: 1 }], width: 65 },
    ]) await assert.rejects(mediaPipeline(params, dir));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, [], 'preflight must finish before any score/output directory is created');
    assert.deepEqual(await fs.readdir(dir), []);
  } finally { watcher.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('preflight includes the generated score in the aggregate loop-buffer budget', async t => {
  if (spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status !== 0) {
    if (process.env.PI_REQUIRE_MEDIA_TEST === '1') assert.fail('ffprobe is required');
    t.skip('ffprobe unavailable'); return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-loop-budget-'));
  // A sparse finalized PCM WAV supplies metadata without synthesizing audio.
  const dataBytes = 120 * 48000 * 2, header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(96000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  const source = path.join(dir, 'source.wav');
  await fs.writeFile(source, header); await fs.truncate(source, 44 + dataBytes);
  const events = [], watcher = watch(dir, (_event, name) => events.push(name));
  try {
    await assert.rejects(mediaPipeline({
      duration: 120, score: { bpm: 120, beats: 240, tracks: [{ notes: [{ pitch: 60, start: 0, duration: 240 }] }] },
      tracks: [{ path: source, loop: true }, { path: source, loop: true }],
    }, dir), /Loop buffers exceed 128 MiB/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, [], 'score synthesis must not start before the total work budget is validated');
    assert.deepEqual(await fs.readdir(dir), ['source.wav']);
  } finally { watcher.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

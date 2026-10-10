import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => syncFs.existsSync(path.join(dir, 'extensions/media-tools.ts')));
const { audioMix } = await import(pathToFileURL(path.join(agent, 'extensions/lib/media-timeline.ts')));

test('real audio mix offsets, bounded peaks and cancellation', { timeout: 90000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-timeline-'));
  try {
    try { await exec('ffmpeg', ['-version']); }
    catch (error) { if (process.env.PI_REQUIRE_MEDIA_TEST === '1') throw error; t.skip('FFmpeg unavailable'); return; }
    const sound = path.join(dir, 'tone.wav');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', '-c:a', 'pcm_s16le', sound]);
    const hashSources = () => Promise.all([sound].map(async file => createHash('sha256').update(await fs.readFile(file)).digest('hex')));
    const sourceHashes = await hashSources();
    const mixed = await audioMix({ duration: 1.5, tracks: [{ path: sound, at: 0.25, duration: 1, gain: 2, pan: -0.5, fadeIn: 0.1, fadeOut: 0.1, highpass: 100, lowpass: 5000, delayMs: 80 }, { path: sound, at: 0.5, duration: 0.5, gain: 0.5, pan: 0.5 }] }, dir);
    assert.equal(mixed.decodeVerified, true);
    assert.equal(mixed.output.streams[0].sample_rate, '48000');
    assert.equal(mixed.output.streams[0].channels, 2);
    const { stdout: pcm } = await exec('ffmpeg', ['-v', 'error', '-i', mixed.artifact.path, '-f', 's16le', '-ac', '2', '-'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    let early = 0, middle = 0, peak = 0;
    for (let i = 0; i < pcm.length / 4; i++) {
      const value = Math.abs(pcm.readInt16LE(i * 4)); peak = Math.max(peak, value);
      if (i < 0.20 * 48000) early += value;
      if (i > 0.35 * 48000 && i < 0.65 * 48000) middle += value;
    }
    assert.equal(early, 0, 'timeline offset remains silent before audio starts');
    assert.ok(middle > 100000 && peak <= 31200, 'sound is present and sample peaks bounded');
    await assert.rejects(audioMix({ tracks: [{ path: sound, filter: 'movie=/private' }] }, dir), /Unknown/);
    await assert.rejects(audioMix({ tracks: [{ path: 'https://example.invalid/audio' }] }, dir), /local filesystem/);
    await assert.rejects(audioMix({ duration: 1, tracks: [{ path: sound, at: 0.5, duration: 1 }] }, dir), /timeline duration/);
    await assert.rejects(audioMix({ duration: 1, tracks: [{ path: sound, highpass: 1000, lowpass: 500 }] }, dir), /below/);
    const before = await fs.readdir(dir);
    const stopped = new AbortController();
    const watcher = syncFs.watch(dir, (_event, name) => { if (name?.startsWith('media-') && !before.includes(name)) stopped.abort(); });
    try { await assert.rejects(audioMix({ duration: 1, tracks: [{ path: sound }] }, dir, stopped.signal), /cancel|abort/i); }
    finally { watcher.close(); }
    assert.deepEqual(await fs.readdir(dir), before, 'in-flight FFmpeg cancellation cleans its fresh output');
    assert.deepEqual(await hashSources(), sourceHashes, 'all source bytes preserved');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateToolArguments } from '@yunuspi/ai';
import { assertSameBytes } from './bytes.mjs';
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => syncFs.existsSync(path.join(dir, 'extensions/media-tools.ts')));
const source = file => pathToFileURL(path.join(agent, 'extensions/lib', file));
const { audioMix } = await import(source('media-timeline.ts'));
const { default: register } = await import(pathToFileURL(path.join(agent, 'extensions/media-tools.ts')));
const pcm = async file => (await exec('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '2', '-ar', '48000', '-'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })).stdout;
const rms = (samples, from, to, channel = 0) => {
  let energy = 0, count = 0;
  for (let i = Math.round(from * 48000); i < Math.round(to * 48000) && i * 4 + 3 < samples.length; i++) { const sample = samples.readInt16LE(i * 4 + channel * 2); energy += sample * sample; count++; }
  return Math.sqrt(energy / count);
};

test('audio_mix schema rejects unknown roles and excessive speed', () => {
  const tools = new Map(); register({ registerTool: definition => tools.set(definition.name, definition) });
  const validate = (name, args) => validateToolArguments(tools.get(name), { type: 'toolCall', id: 'schema', name, arguments: args });
  assert.throws(() => validate('audio_mix', { tracks: [{ path: 'voice.wav', role: 'song' }] }));
  assert.throws(() => validate('audio_mix', { tracks: [{ path: 'voice.wav', speed: 4 }] }));
});

test('real sound pipeline loops beds, ducks from voice, preserves pitch and measures mastering', { timeout: 90_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-pipeline-'));
  try {
    try { await exec('ffmpeg', ['-version']); } catch (error) { if (process.env.PI_REQUIRE_MEDIA_TEST === '1') throw error; t.skip('FFmpeg unavailable'); return; }
    const music = path.join(dir, 'music.wav'), voice = path.join(dir, 'voice.wav'), silence = path.join(dir, 'silent.wav');
    for (const [file, filter] of [[music, 'sine=frequency=220:duration=0.5'], [voice, 'sine=frequency=1000:duration=1'], [silence, 'anullsrc=r=48000:cl=stereo:d=1']]) await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', filter, '-c:a', 'pcm_s16le', file]);
    const tracks = [{ path: music, role: 'music', loop: true, duration: 4, pan: -1 }, { path: voice, role: 'voice', at: 1, duration: 1, pan: 1, gain: 3 }];
    const ducked = await audioMix({ tracks, duration: 4 }, dir);
    const plain = await audioMix({ tracks, duration: 4, ducking: false }, dir);
    const duckSamples = await pcm(ducked.artifact.path), plainSamples = await pcm(plain.artifact.path);
    assert.equal(duckSamples.length, 4 * 48000 * 4, 'timeline covers all four seconds');
    assert.ok(rms(duckSamples, 1.3, 1.8) < rms(plainSamples, 1.3, 1.8) / 3, 'music signal is attenuated while voice is active');
    assert.ok(rms(duckSamples, 3.5, 3.9) > rms(plainSamples, 3.5, 3.9) * 0.9, 'music recovers after voice and continues beyond its original half-second');
    assert.ok(rms(duckSamples, 1.3, 1.8, 1) > 2000, 'voice remains audible');
    // A shared live sidechain branch was intermittently starved on FFmpeg 8.
    // Verify repeatable sample output, not just a single successful decode.
    for (let repeat = 0; repeat < 2; repeat++) {
      const again = await audioMix({ tracks, duration: 4 }, dir);
      assertSameBytes(await pcm(again.artifact.path), duckSamples, 'repeatable keyed compression and exact timeline length');
    }
    const sped = await audioMix({ tracks: [{ path: voice, duration: 0.5, speed: 2, denoise: 0 }], duration: 0.5 }, dir);
    const spedSamples = await pcm(sped.artifact.path); let crossings = 0;
    for (let i = 4800; i < 19200; i++) if (spedSamples.readInt16LE((i - 1) * 4) <= 0 && spedSamples.readInt16LE(i * 4) > 0) crossings++;
    assert.ok(crossings >= 295 && crossings <= 305, `tempo changes preserve 1000Hz pitch (${crossings}/0.3s)`);
    const cleaned = await audioMix({ tracks: [{ path: voice, duration: 1, denoise: 6 }], duration: 1, targetLufs: -16 }, dir);
    assert.equal(cleaned.loudness.normalized, true);
    assert.ok(Math.abs(cleaned.loudness.after.integratedLufs + 16) < 0.5);
    assert.ok(cleaned.loudness.after.truePeakDbtp <= -1.5);
    const silent = await audioMix({ tracks: [{ path: silence, duration: 1 }], duration: 1, targetLufs: -16 }, dir);
    assert.equal(silent.loudness.normalized, false); assert.equal(silent.loudness.after.integratedLufs, null); assert.match(silent.loudness.skipped, /silent/);
    await assert.rejects(audioMix({ tracks: [{ path: voice, loop: 'yes' }] }, dir), /boolean/);
    await assert.rejects(audioMix({ tracks: [{ path: voice, role: 'voice' }], ducking: true }, dir), /both voice and music/);
    await assert.rejects(audioMix({ tracks: [{ path: voice, role: 'voice' }], ducking: { typo: 1 } }, dir), /Unknown ducking/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

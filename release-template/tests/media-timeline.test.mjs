import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateToolArguments } from '@yunuspi/ai';
import { fileURLToPath, pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => syncFs.existsSync(path.join(dir, 'extensions/media-tools.ts')));
const { audioMix, videoCompose, VIDEO_TRANSITIONS } = await import(pathToFileURL(path.join(agent, 'extensions/lib/media-timeline.ts')));
const { default: register } = await import(pathToFileURL(path.join(agent, 'extensions/media-tools.ts')));

test('media tools retain their existing surface and expose four focused studio operations', () => {
  const tools = new Map(); register({ registerTool: def => tools.set(def.name, def) });
  for (const name of ['media_info', 'video_frames', 'image_ocr', 'audio_analyze', 'media_edit', 'music_compose', 'scene_create', 'scene_render', 'video_compose', 'audio_mix']) assert.ok(tools.has(name));
  assert.equal(tools.size, 10);
  const validate = (name, args) => validateToolArguments(tools.get(name), { type: 'toolCall', id: 'schema', name, arguments: args });
  assert.doesNotThrow(() => validate('video_compose', { clips: [{ path: 'clip.mp4', duration: 1 / 60 }], fps: 60 }));
  assert.equal(VIDEO_TRANSITIONS.length, 16);
  for (const transition of VIDEO_TRANSITIONS) assert.doesNotThrow(() => validate('video_compose', { clips: [{ path: 'clip.mp4', duration: 1 }], transition }), transition);
  assert.throws(() => validate('video_compose', { clips: [{ path: 'clip.mp4', duration: 1 }], transition: 'zoomin' }));
  assert.doesNotThrow(() => validate('scene_create', { scene: { objects: [{ id: 'box' }], tracks: [{ target: 'box', keys: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [1, 0, 0] }] }] } }));
  for (const object of [{ id: 'box', scale: [0, 1, 1] }, { id: 'box', position: [101, 0, 0] }]) {
    assert.throws(() => validate('scene_create', { scene: { objects: [object] } }));
  }
});

test('real timeline normalizes clips, overlaps transitions, mixes audio offsets and validates outputs', { timeout: 90000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-timeline-'));
  try {
    try { await exec('ffmpeg', ['-version']); }
    catch (error) { if (process.env.PI_REQUIRE_MEDIA_TEST === '1') throw error; t.skip('FFmpeg unavailable'); return; }
    const first = path.join(dir, 'red.mp4'), second = path.join(dir, 'blue.mp4'), sound = path.join(dir, 'tone.wav');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x96:r=12:d=1', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', first]);
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x160:r=12:d=1', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', second]);
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', '-c:a', 'pcm_s16le', sound]);
    const hashSources = () => Promise.all([first, second, sound].map(async file => createHash('sha256').update(await fs.readFile(file)).digest('hex')));
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
    const params = { clips: [{ path: first, duration: 1 }, { path: second, duration: 1 }], transition: 'fade', transitionDuration: 0.25, width: 160, height: 96, fps: 12, audio: [{ path: sound, at: 0.5, duration: 1, gain: 0.2 }] };
    const video = await videoCompose(params, dir);
    assert.equal(video.decodeVerified, true);
    assert.equal(video.duration, 1.75);
    assert.ok(Math.abs(Number(video.output.format.duration) - 1.75) < 0.1);
    assert.ok(video.output.streams.some(s => s.codec_type === 'audio'));
    const frame = async time => (await exec('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', video.artifact.path, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' })).stdout;
    const red = await frame(0.1), blue = await frame(1.5);
    assert.ok(red[0] > red[2] + 100 && blue[2] > blue[0] + 40, 'decoded timeline contains both clips in order');
    for (const transition of VIDEO_TRANSITIONS) {
      const rendered = await videoCompose({ ...params, transition, audio: [], includeClipAudio: false }, dir);
      assert.ok(!rendered.output.streams.some(s => s.codec_type === 'audio'), transition);
    }
    const fractional = await videoCompose({ clips: Array.from({ length: 8 }, (_, i) => ({ path: i === 7 ? second : first, duration: 0.1 })), width: 160, height: 96, fps: 24, includeClipAudio: false, audio: [{ path: sound, duration: 0.8 }] }, dir);
    assert.equal(fractional.duration, 19 / 24, 'absolute boundaries keep total rounding within half a frame');
    assert.ok(Math.abs(Number(fractional.output.format.duration) - fractional.duration) < 0.01);
    assert.equal(fractional.clips.reduce((sum, clip) => sum + clip.frames, 0), 19);
    const { stdout: finalPixel } = await exec('ffmpeg', ['-v', 'error', '-ss', String(18 / 24), '-i', fractional.artifact.path, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
    assert.ok(finalPixel[2] > finalPixel[0] + 40, 'fractional rounding must not truncate away the final blue clip');
    const fractionalFade = await videoCompose({ clips: [{ path: first, duration: 0.7 }, { path: second, duration: 0.7 }], transition: 'fade', transitionDuration: 0.2, width: 160, height: 96, fps: 12, includeClipAudio: false }, dir);
    assert.equal(fractionalFade.clips[1].at, 6 / 12);
    assert.equal(fractionalFade.clips[1].transitionDuration, 2 / 12);
    assert.ok(Math.abs(Number(fractionalFade.output.format.duration) - fractionalFade.duration) < 0.01);
    const anamorphic = path.join(dir, 'anamorphic.mp4');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=96x96:r=12:d=1', '-vf', 'setsar=2/1', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', anamorphic]);
    const square = await videoCompose({ clips: [{ path: anamorphic, duration: 1 }], width: 160, height: 160, fps: 12 }, dir);
    assert.equal(square.output.streams[0].sample_aspect_ratio, '1:1');
    const { stdout: aspectPixels } = await exec('ffmpeg', ['-v', 'error', '-i', square.artifact.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
    const pixel = (x,y) => aspectPixels.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3);
    assert.ok(pixel(80, 20)[0] < 10 && pixel(80, 140)[0] < 10, 'display aspect receives top/bottom letterboxing');
    assert.ok(pixel(10, 80)[0] > 200 && pixel(150, 80)[0] > 200, 'non-square source pixels fill the display width');
    await assert.rejects(videoCompose({ ...params, transition: 'zoomin' }, dir), /transition must be/);
    await assert.rejects(videoCompose({ ...params, transitionDuration: 0.75 }, dir), /half/);
    await assert.rejects(videoCompose({ ...params, clips: [{ path: first, start: 0.5, duration: 1 }] }, dir), /source duration/);
    await assert.rejects(videoCompose({ ...params, width: 161 }, dir), /even/);
    await assert.rejects(audioMix({ tracks: [{ path: sound, filter: 'movie=/private' }] }, dir), /Unknown/);
    await assert.rejects(audioMix({ tracks: [{ path: 'https://example.invalid/audio' }] }, dir), /local filesystem/);
    await assert.rejects(audioMix({ duration: 1, tracks: [{ path: sound, at: 0.5, duration: 1 }] }, dir), /timeline duration/);
    await assert.rejects(audioMix({ duration: 1, tracks: [{ path: sound, highpass: 1000, lowpass: 500 }] }, dir), /below/);
    const before = await fs.readdir(dir), controller = new AbortController(); controller.abort();
    await assert.rejects(videoCompose(params, dir, controller.signal));
    assert.deepEqual(await fs.readdir(dir), before);
    const stopped = new AbortController();
    const watcher = syncFs.watch(dir, (_event, name) => { if (name?.startsWith('media-') && !before.includes(name)) stopped.abort(); });
    try { await assert.rejects(audioMix({ duration: 1, tracks: [{ path: sound }] }, dir, stopped.signal), /cancel|abort/i); }
    finally { watcher.close(); }
    assert.deepEqual(await fs.readdir(dir), before, 'in-flight FFmpeg cancellation cleans its fresh output');
    assert.deepEqual(await hashSources(), sourceHashes, 'all source bytes preserved');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

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
import { assertSameBytes, assertDifferentBytes } from './bytes.mjs';
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => syncFs.existsSync(path.join(dir, 'extensions/media-tools.ts')));
const source = file => pathToFileURL(path.join(agent, 'extensions/lib', file));
const { mediaPipeline, planMediaPipeline } = await import(source('media-pipeline.ts'));
const { audioMix } = await import(source('media-timeline.ts'));
const { composeMusic } = await import(source('music-score.ts'));
const { captionTrack, validateVideoSpec, videoProject } = await import(source('video-studio.ts'));
const { default: register, audioAnalyze } = await import(pathToFileURL(path.join(agent, 'extensions/media-tools.ts')));
const score = { bpm: 120, beats: 4, tracks: [{ notes: [{ pitch: 57, start: 0, duration: 4 }] }] };
const pcm = async file => (await exec('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '2', '-ar', '48000', '-'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })).stdout;
const rms = (samples, from, to, channel = 0) => {
  let energy = 0, count = 0;
  for (let i = Math.round(from * 48000); i < Math.round(to * 48000) && i * 4 + 3 < samples.length; i++) { const sample = samples.readInt16LE(i * 4 + channel * 2); energy += sample * sample; count++; }
  return Math.sqrt(energy / count);
};

test('media pipeline chooses only relevant stages and validates before work', () => {
  assert.deepEqual(planMediaPipeline({ score }).stages, ['compose_score', 'mix_audio', 'measure_delivery_audio']);
  assert.equal(planMediaPipeline({ tracks: [{ path: 'voice.wav' }] }).mode, 'audio');
  assert.deepEqual(planMediaPipeline({ animation: 'scene.json' }).stages, ['render_animation']);
  assert.equal(planMediaPipeline({ clips: [{ path: 'clip.mp4', duration: 1 }] }).mode, 'video');
  assert.throws(() => planMediaPipeline({}), /needs a score or tracks/);
  assert.throws(() => planMediaPipeline({ animation: 'scene.json', clips: [] }), /clips accepts/);
  assert.throws(() => planMediaPipeline({ animation: 'scene.json', clips: [{ path: 'a', duration: 1 }] }), /not both/);
  assert.throws(() => planMediaPipeline({ score, duration: NaN }), /duration/);
  assert.throws(() => planMediaPipeline({ score, tracks: Array.from({ length: 8 }, () => ({ path: 'a' })) }), /at most 8/);
  assert.throws(() => planMediaPipeline({ animation: 'scene.json', targetLufs: -16 }), /requires audio/);
  assert.throws(() => planMediaPipeline({ score, script: 'anything' }), /Unknown pipeline/);
  const tools = new Map(); register({ registerTool: definition => tools.set(definition.name, definition) });
  const validate = (name, args) => validateToolArguments(tools.get(name), { type: 'toolCall', id: 'schema', name, arguments: args });
  assert.doesNotThrow(() => validate('media_pipeline', { score, targetLufs: -16, tracks: [{ path: 'voice.wav', role: 'voice', speed: 1.2, denoise: 6 }] }));
  assert.throws(() => validate('audio_mix', { tracks: [{ path: 'voice.wav', role: 'song' }] }));
  assert.throws(() => validate('audio_mix', { tracks: [{ path: 'voice.wav', speed: 4 }] }));
});

test('sidecar subtitles retain the measured word boundaries used by burned captions', () => {
  const scene = { id: 'a', component: 'A', seconds: 6, start: 0, end: 6, narration: 'One two three four', narrationOffset: 0.4, narrationSeconds: 4, narrationWords: [{ w: 'One', s: 0.8, e: 1 }, { w: 'two', s: 1.2, e: 1.4 }, { w: 'three', s: 2.5, e: 2.7 }, { w: 'four', s: 3, e: 3.2 }] };
  const track = captionTrack({ captions: { maxWords: 2 } }, [scene]);
  assert.ok(Math.abs(track[0].start - 1.2) < 0.0001);
  assert.ok(Math.abs(track[0].end - 1.8) < 0.0001);
  assert.ok(Math.abs(track[1].start - 2.9) < 0.0001);
  assert.ok(Math.abs(track[1].end - 3.6) < 0.0001);
  const stale = captionTrack({ captions: { maxWords: 2 } }, [{ ...scene, narration: 'Changed text here now' }]);
  assert.equal(stale[0].start, 0.4, 'changed text uses the same estimated fallback as burned captions');
});

test('malformed audio/timing in video.json returns actionable findings without throwing', () => {
  const spec = { fps: 30, width: 1920, height: 1080, audio: { sfx: {} }, scenes: [{ id: 'a', component: 'A', seconds: 4, cues: [], cueWords: 'reveal', narration: 'One two', narrationSeconds: 2, narrationWords: [{ w: 'One', s: 1, e: 0.5 }, { w: 'two', s: 0.4, e: 2 }] }] };
  const messages = validateVideoSpec(spec, new Set(['A']), () => true).issues.map(issue => issue.message).join('\n');
  for (const expected of [/audio.sfx must be an array/, /cues must be an object/, /cueWords must be an object/, /timings must be finite, ordered/]) assert.match(messages, expected);
  const invalid = structuredClone(spec); invalid.scenes[0].cues = { invalid: NaN }; invalid.scenes[0].energy = Infinity; invalid.audio.sfx = [{ src: 'x.wav', at: NaN }];
  const finite = validateVideoSpec(invalid, new Set(['A']), () => true).issues.map(issue => issue.message).join('\n');
  assert.match(finite, /cue "invalid" must be inside/); assert.match(finite, /energy must be/); assert.match(finite, /outside the timeline/);
});

test('project checks retain structural findings when a scene is null', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-project-malformed-'));
  try {
    await fs.writeFile(path.join(dir, 'video.json'), JSON.stringify({ fps: 30, width: 1920, height: 1080, scenes: [null] }));
    const result = await videoProject({ dir, action: 'check' }, dir);
    assert.equal(result.ok, false); assert.match(result.issues.map(issue => issue.message).join('\n'), /scene id/);
    await fs.writeFile(path.join(dir, 'video.json'), 'null');
    await assert.rejects(videoProject({ dir, action: 'check' }, dir), /video.json must be an object/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('real sound pipeline loops beds, ducks from voice, preserves pitch and measures mastering', { timeout: 90_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-pipeline-'));
  try {
    try { await exec('ffmpeg', ['-version']); } catch (error) { if (process.env.PI_REQUIRE_MEDIA_TEST === '1') throw error; t.skip('FFmpeg unavailable'); return; }
    const music = path.join(dir, 'music.wav'), voice = path.join(dir, 'voice.wav'), silence = path.join(dir, 'silent.wav'), clip = path.join(dir, 'clip.mp4');
    for (const [file, filter] of [[music, 'sine=frequency=220:duration=0.5'], [voice, 'sine=frequency=1000:duration=1'], [silence, 'anullsrc=r=48000:cl=stereo:d=1']]) await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', filter, '-c:a', 'pcm_s16le', file]);
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x96:r=12:d=2', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', clip]);
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
    const pipeline = await mediaPipeline({ score, duration: 2, tracks: [{ path: voice, role: 'voice', at: 0.5, duration: 1 }], targetLufs: -16 }, dir);
    assert.equal(pipeline.pipeline, 'audio'); assert.equal(pipeline.decodeVerified, true); assert.equal(pipeline.score.files.length, 3);
    assert.equal(pipeline.automatedChecks.loudnessWithinTarget, true);
    assert.deepEqual(pipeline.stages.map(stage => stage.name), ['compose_score', 'mix_audio', 'measure_delivery_audio']);
    const video = await mediaPipeline({ clips: [{ path: clip, duration: 2 }], score, tracks: [{ path: voice, role: 'voice', at: 0.5, duration: 1 }], width: 160, height: 96, fps: 12, targetLufs: -16 }, dir);
    assert.equal(video.pipeline, 'video'); assert.equal(video.decodeVerified, true); assert.equal(video.duration, 2); assert.equal(video.automatedChecks.loudnessWithinTarget, true);
    assert.ok(video.audio.truePeakDbtp <= -1);
    assert.ok((await fs.readFile(path.join(path.dirname(path.dirname(video.artifact.path)), 'pipeline.json'), 'utf8')).includes('compose_video'));
    const before = await fs.readdir(dir);
    await assert.rejects(mediaPipeline({ score, tracks: [{ path: 'missing.wav' }] }, dir), /ENOENT/);
    assert.deepEqual(await fs.readdir(dir), before, 'failure removes score plus all dependent intermediates');
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(mediaPipeline({ score }, dir, stopped.signal));
    assert.deepEqual(await fs.readdir(dir), before, 'cancelled pipeline leaves no output');
    await assert.rejects(audioMix({ tracks: [{ path: voice, loop: 'yes' }] }, dir), /boolean/);
    await assert.rejects(audioMix({ tracks: [{ path: voice, role: 'voice' }], ducking: true }, dir), /both voice and music/);
    await assert.rejects(audioMix({ tracks: [{ path: voice, role: 'voice' }], ducking: { typo: 1 } }, dir), /Unknown ducking/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('batched score/edit pipeline preserves direct-chain output and exposes elapsed work', { timeout: 30_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-pipeline-compare-'));
  try {
    try { await exec('ffmpeg', ['-version']); } catch (error) { if (process.env.PI_REQUIRE_MEDIA_TEST === '1') throw error; t.skip('FFmpeg unavailable'); return; }
    const at = performance.now();
    const made = await composeMusic({ score }, dir);
    const direct = await audioMix({ duration: 2, tracks: [{ path: made.files.find(file => file.path.endsWith('.wav')).path, role: 'music', gain: 0.3, loop: true }] }, dir);
    const analysis = await audioAnalyze({ path: direct.artifact.path, duration: 2 }, dir);
    const measurements = { integratedLufs: analysis.integratedLufs, truePeakDbtp: analysis.truePeakDbtp, loudnessRangeLu: analysis.loudnessRangeLu };
    const directMs = Math.round(performance.now() - at);
    const batched = await mediaPipeline({ score }, dir);
    assertSameBytes(await fs.readFile(batched.artifact.path), await fs.readFile(direct.artifact.path), 'one-call pipeline retains identical sample output');
    assert.deepEqual(batched.audio, measurements);
    assert.equal(batched.stages.length, 3);
    assert.ok(batched.elapsedMs >= 0);
    const directResponseBytes = [made, direct, analysis].reduce((bytes, response) => bytes + Buffer.byteLength(JSON.stringify(response)), 0);
    const batchedResponseBytes = Buffer.byteLength(JSON.stringify(batched));
    assert.ok(batchedResponseBytes < directResponseBytes, 'batch receipt eliminates repeated stream/source context');
    t.diagnostic(JSON.stringify({ directModelToolCalls: 3, batchedModelToolCalls: 1, directProcessingMs: directMs, batchedProcessingMs: batched.elapsedMs, directResponseBytes, batchedResponseBytes, waveformBytesEqual: true, loudnessEqual: true, tokenUsage: 'not measured: local deterministic tool benchmark' }));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('animation pipeline renders one scene with score audio and delivery evidence', { timeout: 120_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-pipeline-animation-'));
  try {
    const animation = path.join(dir, 'scene.json');
    await fs.writeFile(animation, JSON.stringify({ width: 160, height: 96, duration: 1, fps: 6, objects: [{ id: 'box', geometry: 'box' }], tracks: [{ target: 'box', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 1.5, 0] }] }] }));
    let result;
    try { result = await mediaPipeline({ animation, score, targetLufs: -16 }, dir); }
    catch (error) { if (process.env.PI_REQUIRE_MEDIA_TEST !== '1' && /Executable doesn't exist|not installed or not on PATH|distribution.*not found/i.test(error.message)) { t.skip('Media prerequisites unavailable'); return; } throw error; }
    assert.equal(result.pipeline, 'animation'); assert.equal(result.duration, 1); assert.equal(result.decodeVerified, true);
    assert.deepEqual(result.stages.map(stage => stage.name), ['compose_score', 'mix_audio', 'render_animation', 'measure_delivery_audio']);
    assert.equal(result.samples.length, 3);
    assertDifferentBytes(await fs.readFile(result.samples[0].path), await fs.readFile(result.samples[1].path), 'animation changes actual WebGL pixels');
    assert.ok(result.audio.integratedLufs !== null); assert.equal(result.automatedChecks.loudnessWithinTarget, true);
    assert.equal(result.automatedChecks.truePeakWithinCeiling, true);
    assert.deepEqual(result.mastering.after, result.audio, 'mastering receipt measures the final AAC encoding');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

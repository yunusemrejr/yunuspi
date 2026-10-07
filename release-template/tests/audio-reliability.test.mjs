// Authored scores and local encodes; provider fixtures never make paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => syncFs.existsSync(path.join(dir, 'extensions/lib/music-score.ts')));
const load = file => import(pathToFileURL(path.join(agent, 'extensions/lib', file)).href);
const music = await load('music-score.ts'), eleven = await load('elevenlabs.ts'), sync = await load('media-sync.ts');
const video = await load('video-studio.ts');
const exec = promisify(execFile);
const env = { ELEVENLABS_API_KEY: 'TEST_audio_recovery_fixture_only', ELEVENLABS_VOICE_ID: 'fixtureVoice' };
async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-reliability-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function alignment(text) {
  const characters = Array.from(text);
  return { characters, character_start_times_seconds: characters.map((_, i) => i / characters.length), character_end_times_seconds: characters.map((_, i) => (i + 1) / characters.length) };
}
async function fixtureAudio(dir) {
  const file = path.join(dir, 'fixture.mp3');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-c:a', 'libmp3lame', file]);
  return fs.readFile(file);
}
function midiConductor(bytes) {
  const ppq = bytes.readUInt16BE(12), end = 22 + bytes.readUInt32BE(18);
  let i = 22, tick = 0, tempo;
  while (i < end) {
    let delta = 0, value;
    do { value = bytes[i++]; delta = delta * 128 + (value & 127); } while (value & 128);
    tick += delta;
    assert.equal(bytes[i++], 255);
    const kind = bytes[i++], length = bytes[i++];
    if (kind === 81) tempo = bytes.readUIntBE(i, 3);
    i += length;
  }
  return { seconds: tick / ppq * tempo / 1e6, tempo };
}

test('fractional BPM and MIDI tick endings agree with actual WAV sample count', async t => {
  const dir = await workspace(t);
  const result = await music.composeMusic({ backend: 'oscillator', score: { bpm: 137.123, beats: 7.004, tracks: [{ notes: [{ pitch: 69, start: 1.0007, duration: 1.0003 }] }] } }, dir);
  const midi = await fs.readFile(result.files.find(file => file.path.endsWith('.mid')).path);
  const wav = await fs.readFile(result.files.find(file => file.path.endsWith('.wav')).path);
  const clock = midiConductor(midi), samples = (wav.length - 44) / 2;
  assert.equal(samples, Math.ceil(clock.seconds * 44100));
  assert.equal(result.seconds, clock.seconds);
  const score = JSON.parse(await fs.readFile(result.files.find(file => file.path.endsWith('.json')).path, 'utf8'));
  assert.equal(score.midiTempoMicroseconds, clock.tempo);
  const start = Math.round(score.tracks[0].notes[0].start * clock.tempo / 1e6 * 44100);
  for (let i = 0; i <= start; i++) assert.equal(wav.readInt16LE(44 + i * 2), 0, 'leading rest and zero attack remain silent');
});

test('optimized auditions preserve harmonic cutoff and PCM fidelity across waveform and register', async t => {
  const dir = await workspace(t);
  for (const waveform of ['sine', 'triangle', 'square', 'saw']) for (const pitch of [36, 69, 127]) {
    const result = await music.composeMusic({ backend: 'oscillator', score: { bpm: 120, beats: 1, tracks: [{ waveform, notes: [{ pitch, start: 0, duration: 1, velocity: 90 }] }] } }, dir);
    const bytes = await fs.readFile(result.files.find(file => file.path.endsWith('.wav')).path);
    const count = (bytes.length - 44) / 2, frequency = 440 * 2 ** ((pitch - 69) / 12);
    assert.equal(bytes.readUInt16LE(22), 1);
    assert.equal(result.previewGain, 1);
    let error = 0;
    for (let i = 0; i < count; i += 11) {
      const envelope = Math.max(0, Math.min(1, i / (44100 * .008), (count - 1 - i) / (44100 * .025)));
      const reference = Math.fround(music.oscillator(waveform, 2 * Math.PI * frequency * i / 44100, frequency) * envelope * 90 / 127 * .18);
      error = Math.max(error, Math.abs(bytes.readInt16LE(44 + i * 2) - Math.round(reference * 32767)));
    }
    assert.ok(error <= 1, `${waveform} at MIDI ${pitch} differs by ${error} PCM values`);
  }
});

test('a cancellation scheduled during one long note stops before allocating output', async t => {
  const dir = await workspace(t), stop = new AbortController();
  const pending = music.composeMusic({ backend: 'oscillator', score: { bpm: 60, beats: 120, tracks: [{ waveform: 'saw', notes: [{ pitch: 36, start: 0, duration: 120 }] }] } }, dir, stop.signal);
  setImmediate(() => stop.abort(new Error('stop long audition')));
  await assert.rejects(pending, /stop long audition/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('percussion planning preserves exact route selection and rejects ambiguous drum channels', () => {
  const score = { bpm: 120, beats: 4, tracks: [{ percussion: true, notes: [{ pitch: 36, start: 0, duration: .1 }] }] };
  assert.throws(() => music.planScoreRender({ score, backend: 'oscillator' }, {}), /Percussion requires/);
  assert.throws(() => music.planScoreRender({ score }, {}), /Percussion requires/);
  const plan = music.planScoreRender({ score }, { YUNUSPI_SOUNDFONT: '/tmp/authored-fixture.sf2' });
  assert.equal(plan.backend, 'soundfont'); assert.equal(plan.soundfont, '/tmp/authored-fixture.sf2');
  assert.throws(() => music.validateScore({ ...score, tracks: [...score.tracks, ...score.tracks] }), /one percussion track/);
  assert.throws(() => music.validateScore({ ...score, tracks: [{ ...score.tracks[0], percussion: 'true' }] }), /percussion must/);
});

test('SoundFont drum kits and melodic instruments use separate MIDI channels and actual timbres', { timeout: 60000 }, async t => {
  const bank = '/usr/share/sounds/sf2/TimGM6mb.sf2';
  let available = syncFs.existsSync(bank);
  if (available) available = (await exec('python3', ['-I', '-c', 'import ctypes.util; print(bool(ctypes.util.find_library("fluidsynth")))'])).stdout.trim() === 'True';
  if (!available) { if (process.env.PI_REQUIRE_SOUNDFONT_TEST === '1') assert.fail('SoundFont required'); t.skip('Optional SoundFont prerequisite'); return; }
  const dir = await workspace(t);
  const score = { bpm: 120, beats: 3, tracks: [{ program: 0, notes: [{ pitch: 60, start: 1, duration: 1 }] }, { percussion: true, notes: [{ pitch: 36, start: 1, duration: .1 }, { pitch: 38, start: 2, duration: .1 }] }] };
  const result = await music.composeMusic({ score, backend: 'soundfont', soundfont: bank, releaseTail: .5 }, dir);
  const midi = await fs.readFile(result.files.find(file => file.path.endsWith('.mid')).path);
  assert.ok(midi.includes(Buffer.from([0x90, 60, 90])), 'melody uses channel 1');
  assert.ok(midi.includes(Buffer.from([0x99, 36, 90])), 'kit uses GM channel 10');
  const wav = await fs.readFile(result.files.find(file => file.path.endsWith('.wav')).path);
  assert.equal(wav.readUInt16LE(22), 2); assert.equal(result.seconds, 2);
  let firstEnergy = 0, hitEnergy = 0;
  for (let i = 0; i < 44100; i++) {
    const value = wav.readInt16LE(44 + i * 4);
    if (i < 44100 * .45) firstEnergy += value * value;
    else if (i > 44100 * .52 && i < 44100 * .65) hitEnergy += value * value;
  }
  assert.equal(firstEnergy, 0); assert.ok(hitEnergy > 0);
  assert.equal(result.soundfont.sha256.length, 64);
});

test('character alignment retains Unicode and scales to long scripts without prefix joins', () => {
  const text = '🍋 crème\tİstanbul. '.repeat(4000);
  const result = eleven.characterWords(alignment(text), text);
  assert.equal(result.length, 12000);
  assert.equal(result.map(word => word.w).join(' '), text.trim().replace(/\s+/gu, ' '));
  const invalid = alignment('One two'); invalid.character_end_times_seconds[0] = .8;
  assert.throws(() => eleven.characterWords(invalid, 'One two'), /Invalid/);
  assert.throws(() => eleven.splitSpeech('a'.repeat(201), 100), /token exceeds chunkChars/);
  const tabs = 'Hello\tworld\t'.repeat(30);
  assert.equal(eleven.splitSpeech(tabs, 100).join(''), tabs);
});

test('cloud narration style changes real voice settings and preserves explicit overrides', () => {
  const calm = eleven.speechRequest({ style: 'calm' }, 'Hello.', env).body.voice_settings;
  const energetic = eleven.speechRequest({ style: 'energetic' }, 'Hello.', env).body.voice_settings;
  assert.ok(calm.stability > energetic.stability); assert.ok(calm.style < energetic.style);
  const exact = eleven.speechRequest({ style: 'energetic', stability: .8, expressiveness: .05 }, 'Hello.', env).body.voice_settings;
  assert.equal(exact.stability, .8); assert.equal(exact.style, .05);
  assert.throws(() => eleven.speechRequest({ style: 'unknown' }, 'Hello.', env), /style must/);
});

test('a saved paid response survives cancellation and resumes without a second request', async t => {
  const dir = await workspace(t), bytes = await fixtureAudio(dir), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const cache = path.join(dir, 'speech'); await fs.mkdir(cache);
  const stop = new AbortController(); let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    const body = JSON.parse(options.body);
    return Response.json({ audio_base64: bytes.toString('base64'), alignment: alignment(body.text) }, { headers: { 'request-id': 'fixture-paid-once', 'character-cost': '12' } });
  };
  const watcher = syncFs.watch(cache, (_event, file) => {
    if (file?.endsWith('.response.json') && syncFs.existsSync(path.join(cache, file))) stop.abort();
  });
  t.after(() => watcher.close());
  await assert.rejects(eleven.elevenSpeech({ text: 'Hello world.' }, cache, stop.signal, undefined, env), /abort|cancel/i);
  watcher.close();
  assert.equal(requests, 1);
  assert.ok((await fs.readdir(cache)).some(file => file.endsWith('.response.json')));
  const result = await eleven.elevenSpeech({ text: 'Hello world.' }, cache, undefined, undefined, env);
  assert.equal(requests, 1, 'validation recovery must not repay');
  assert.equal(result.receipts[0].recovered, true); assert.equal(result.receipts[0].reused, true);
  assert.equal(result.words.map(word => word.w).join(' '), 'Hello world.');
  assert.ok(Math.abs(result.seconds - 1.2) < .001);
  const files = await fs.readdir(cache);
  assert.equal(files.some(file => file.startsWith('pcm-') || file.endsWith('.tmp') || file.endsWith('.response.json')), false);
  for (const file of files.filter(file => file.endsWith('.json'))) assert.equal((await fs.readFile(path.join(cache, file), 'utf8')).includes(env.ELEVENLABS_API_KEY), false);
});

test('corrupt completed speech receipts fail without initiating paid regeneration', async t => {
  const dir = await workspace(t), bytes = await fixtureAudio(dir), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = async (_url, options) => { requests++; const body = JSON.parse(options.body); return Response.json({ audio_base64: bytes.toString('base64'), alignment: alignment(body.text) }); };
  const cache = path.join(dir, 'speech');
  await eleven.elevenSpeech({ text: 'Hello world.' }, cache, undefined, undefined, env);
  const receipt = (await fs.readdir(cache)).find(file => /^speech-[a-f0-9]{64}\.json$/.test(file));
  await fs.writeFile(path.join(cache, receipt), JSON.stringify({ words: 'invalid' }));
  await assert.rejects(eleven.elevenSpeech({ text: 'Hello world.' }, cache, undefined, undefined, env), /checkpoint is incomplete or corrupt/);
  assert.equal(requests, 1);
});

test('unknown speech submissions remain inspectable and refuse a repeated paid call', async t => {
  const dir = await workspace(t), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error('Fixture connection lost after dispatch'); };
  const cache = path.join(dir, 'speech');
  await assert.rejects(eleven.elevenSpeech({ text: 'Hello world.' }, cache, undefined, undefined, env), error => error.submissionOutcomeUnknown === true && error.retainedSpeechCache === cache);
  const submission = (await fs.readdir(cache)).find(file => file.endsWith('.submission.json'));
  assert.equal(JSON.parse(await fs.readFile(path.join(cache, submission), 'utf8')).status, 'unknown');
  await assert.rejects(eleven.elevenSpeech({ text: 'Hello world.' }, cache, undefined, undefined, env), /no repeat paid request/);
  assert.equal(requests, 1);
});

test('a production failure after completed speech exposes the reusable cache', async t => {
  const dir = await workspace(t), bytes = await fixtureAudio(dir), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = async (_url, options) => { requests++; const body = JSON.parse(options.body); return Response.json({ audio_base64: bytes.toString('base64'), alignment: alignment(body.text) }); };
  const cache = path.join(dir, 'speech');
  await eleven.elevenSpeech({ text: 'Hello world.' }, cache, undefined, undefined, env);
  const failure = await eleven.retainedSpeechError(cache, Error('Later mastering stage failed'));
  assert.equal(failure.retainedSpeechCache, cache); assert.equal(failure.submissionOutcomeUnknown, undefined);
  assert.match(failure.message, /Later mastering stage failed/);
  const resumed = await eleven.elevenSpeech({ text: 'Hello world.' }, cache, undefined, undefined, env);
  assert.equal(resumed.receipts[0].reused, true); assert.equal(requests, 1);
  assert.equal(await eleven.retainedSpeechError(dir, Error('No paid state')), undefined);
});

test('public narration recovery preserves the saved request and never submits missing chunks', async t => {
  const dir = await workspace(t), bytes = await fixtureAudio(dir), original = globalThis.fetch, prior = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = env.ELEVENLABS_API_KEY;
  t.after(() => { globalThis.fetch = original; if (prior === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = prior; });
  let requests = 0;
  globalThis.fetch = async (_url, options) => { requests++; const body = JSON.parse(options.body); return Response.json({ audio_base64: bytes.toString('base64'), alignment: alignment(body.text) }); };
  const cache = path.join(dir, 'speech');
  const made = await eleven.elevenSpeech({ text: 'Hello world.', style: 'calm', previousText: 'Earlier context.', nextText: 'Later context.' }, cache, undefined, undefined, env);
  const originalBytes = await fs.readFile(made.raw);
  globalThis.fetch = async () => { requests++; throw Error('Recovery must never fetch'); };
  const recovered = await video.narrationTts({ action: 'recover', dir: cache }, dir);
  assert.equal(requests, 1); assert.equal(recovered.recovery, 'cached responses only; no provider request');
  assert.deepEqual(await fs.readFile(recovered.artifact.path), originalBytes);
  assert.notEqual(recovered.raw, made.raw, 'recovery preserves previously returned files');
  assert.equal(recovered.voiceId, 'fixtureVoice'); assert.equal(recovered.decodeVerified, true);
  assert.match(await fs.readFile(recovered.captions.srt, 'utf8'), /Hello world\./);
  const encoded = (await fs.readdir(cache)).find(file => file.endsWith('.mp3'));
  await fs.rm(path.join(cache, encoded));
  await assert.rejects(video.narrationTts({ action: 'recover', dir: cache }, dir), /recovery never submits paid work/);
  assert.equal(requests, 1);
});

test('public recovery enforces its workspace and replaces linked scratch and caption files safely', async t => {
  const dir = await workspace(t), external = await workspace(t), bytes = await fixtureAudio(dir);
  const original = globalThis.fetch, prior = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = env.ELEVENLABS_API_KEY;
  t.after(() => { globalThis.fetch = original; if (prior === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = prior; });
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++; const body = JSON.parse(options.body);
    return Response.json({ audio_base64: bytes.toString('base64'), alignment: alignment(body.text) });
  };
  const cache = path.join(dir, 'speech');
  await eleven.elevenSpeech({ text: 'Hello world. '.repeat(12), chunkChars: 100 }, cache, undefined, undefined, env);
  assert.equal(requests, 2);
  globalThis.fetch = async () => { requests++; throw Error('Recovery must never fetch'); };
  await assert.rejects(video.narrationTts({ action: 'recover', dir: cache }, external), /inside the current workspace/);
  await fs.symlink(cache, path.join(external, 'cache-alias'));
  await assert.rejects(video.narrationTts({ action: 'recover', dir: 'cache-alias' }, external), /inside the current workspace/);
  const sentinels = ['speech-parts.txt', 'captions.srt', 'captions.vtt'];
  for (const name of sentinels) {
    const target = path.join(external, name);
    await fs.writeFile(target, 'Existing unrelated file must remain intact.\n');
    await fs.rm(path.join(cache, name), { force: true });
    await fs.symlink(target, path.join(cache, name));
  }
  const recovered = await video.narrationTts({ action: 'recover', dir: cache }, dir);
  assert.equal(recovered.receipts.length, 2); assert.equal(requests, 2);
  for (const name of sentinels) assert.equal(await fs.readFile(path.join(external, name), 'utf8'), 'Existing unrelated file must remain intact.\n');
  assert.equal((await fs.lstat(recovered.captions.srt)).isSymbolicLink(), false);
  assert.equal((await fs.lstat(recovered.captions.vtt)).isSymbolicLink(), false);
  await assert.rejects(fs.lstat(path.join(cache, 'speech-parts.txt')), { code: 'ENOENT' });
});

test('generated audio destinations are checked before payment and failed validation retains bytes', async t => {
  const dir = await workspace(t), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('fixture-invalid-audio', { headers: { 'request-id': 'fixture-invalid-paid-once' } }); };
  await assert.rejects(eleven.audioGenerate({ kind: 'sfx', prompt: 'Authored fixture', outputDir: '/does-not-exist' }, dir, undefined, env), /workspace|exist|directory/);
  assert.equal(requests, 0);
  let artifact;
  await assert.rejects(eleven.audioGenerate({ kind: 'sfx', prompt: 'Authored fixture' }, dir, undefined, env), error => { artifact = error.retainedAudioArtifact; return Boolean(artifact); });
  assert.equal(requests, 1); assert.equal(await fs.readFile(artifact, 'utf8'), 'fixture-invalid-audio');
  const receipt = JSON.parse(await fs.readFile(path.join(path.dirname(artifact), 'generation.json'), 'utf8'));
  assert.equal(receipt.decodeVerified, false); assert.equal(receipt.status, 'failed_validation');
});

test('an uncertain generated-audio submission retains its request without claiming a decoded artifact', async t => {
  const dir = await workspace(t), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { throw Error('Fixture transport lost'); };
  let submission;
  await assert.rejects(eleven.audioGenerate({ kind: 'music', prompt: 'Authored fixture' }, dir, undefined, env), error => { submission = error.retainedAudioSubmission; return Boolean(submission); });
  const receipt = JSON.parse(await fs.readFile(submission, 'utf8'));
  assert.equal(receipt.status, 'unknown'); assert.equal(receipt.decodeVerified, false);
  assert.equal(syncFs.existsSync(path.join(path.dirname(submission), 'generated.mp3')), false);
});

test('sync refuses ambiguous scene identities and nonfinite narration metadata', () => {
  const spec = { fps: 24, scenes: [{ id: 'one', seconds: 1, narrationSeconds: .5 }] };
  assert.throws(() => sync.auditMediaSync({ ...spec, scenes: [...spec.scenes, ...spec.scenes] }), /unique/);
  assert.throws(() => sync.auditMediaSync({ scenes: [null] }), /unique/);
  for (const duration of [NaN, Infinity, -1, '0.5']) assert.throws(() => sync.auditMediaSync({ ...spec, scenes: [{ ...spec.scenes[0], narrationSeconds: duration }] }), /narrationSeconds/);
  assert.throws(() => sync.auditMediaSync({ ...spec, scenes: [{ ...spec.scenes[0], cueLead: NaN }] }), /cueLead/);
  assert.equal(sync.auditMediaSync({ ...spec, scenes: [{ id: 'constructor', seconds: 1 }] }).ok, true);
  assert.equal(sync.auditMediaSync({ ...spec, scenes: [{ id: 'silent', seconds: 1, narrationSeconds: 0 }] }).ok, true);
  assert.throws(() => sync.musicGrid({ bpm: 120, times: [1], unit: 'unknown' }), /unit must/);
});

test('delivery sync compares relative video duration and still detects real audio drift', async t => {
  const dir = await workspace(t), file = path.join(dir, 'shifted.mp4');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-output_ts_offset', '5', file]);
  const timeline = { fps: 24, scenes: [{ id: 'one', seconds: 1 }] };
  const result = await sync.mediaSync({ timeline, path: file }, dir);
  assert.equal(result.ok, true);
  assert.ok(result.delivery.presentationStartSeconds > 4);
  assert.ok(Math.abs(result.delivery.timelineDeltaFrames) <= 1);
  const short = await sync.mediaSync({ timeline: { ...timeline, scenes: [{ id: 'one', seconds: .5 }] }, path: file }, dir);
  assert.equal(short.ok, false);
  assert.ok(short.issues.some(issue => issue.code === 'delivery-boundary-drift'));
});

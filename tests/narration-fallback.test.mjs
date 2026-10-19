// Authored fixtures only. ElevenLabs HTTP and the Piper worker are doubles; encodes and probes run locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => syncFs.existsSync(path.join(p, 'extensions/lib/elevenlabs.ts')));
const video = await import(pathToFileURL(path.join(agent, 'extensions/lib/video-studio.ts')).href);
const KEY = 'TEST_narration_fallback_fixture_only', VOICE = 'en_US-ryan-high';
const SENTENCE = 'Piper is not installed; narration_tts action:install sets it up for a local fallback.';
const ENV_KEYS = ['ELEVENLABS_API_KEY', 'PI_ELEVENLABS_API_KEY', 'XI_API_KEY', 'PI_CODING_AGENT_DIR'];

function setEnv(t, values) {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of ENV_KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
}
async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'narration-fallback-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixtures(dir) {
  const wav = path.join(dir, 'fixture.wav'), mp3 = path.join(dir, 'fixture.mp3');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5:sample_rate=22050', wav]);
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=480:duration=1.2', '-c:a', 'libmp3lame', mp3]);
  return { wav, mp3: await fs.readFile(mp3) };
}
/** A fake Piper worker: the venv "python" is a Node script that copies a fixture WAV per scene and prints the worker's result line. */
async function installPiper(dir, wav) {
  const home = path.join(dir, 'agent'), piper = path.join(home, 'local-models', 'piper');
  await fs.mkdir(path.join(piper, 'venv', 'bin'), { recursive: true });
  await fs.mkdir(path.join(piper, 'voices'), { recursive: true });
  for (const file of video.PIPER_VOICES[VOICE].files) await fs.writeFile(path.join(piper, 'voices', file.name), '');
  const script = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const WAV = ${JSON.stringify(wav)};
const request = JSON.parse(fs.readFileSync(process.argv.at(-1), 'utf8'));
const scenes = request.scenes.map(scene => {
  const raw = path.join(request.outDir, scene.id + '.raw.wav');
  fs.copyFileSync(WAV, raw);
  return { id: scene.id, raw, exact: false, words: scene.display.split(' ').map((w, i) => ({ w, s: i * 0.3, e: i * 0.3 + 0.25 })) };
});
console.log('NARRATE_RESULT ' + JSON.stringify({ scenes, aligned: false }));
`;
  await fs.writeFile(path.join(piper, 'venv', 'bin', 'python'), script, { mode: 0o755 });
  return home;
}
function alignment(text) {
  const chars = Array.from(text), n = chars.length;
  return { characters: chars, character_start_times_seconds: chars.map((_, i) => i / n), character_end_times_seconds: chars.map((_, i) => (i + 1) / n) };
}
const failure = status => () => new Response(JSON.stringify({ detail: 'fixture' }), { status, headers: { 'content-type': 'application/json' } });
const speech = mp3 => body => Response.json({ audio_base64: mp3.toString('base64'), alignment: alignment(body.text) });
/** Replies are consumed in order; an unexpected provider call fails the test. */
function mockFetch(t) {
  const original = globalThis.fetch, calls = [], queue = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const reply = queue.shift();
    if (!reply) throw new Error('unexpected ElevenLabs call');
    return reply(calls.at(-1));
  };
  t.after(() => { globalThis.fetch = original; });
  return { calls, reply: (...replies) => queue.push(...replies) };
}

test('explicit ElevenLabs keeps the provider error and never falls back to Piper', async t => {
  const dir = await workspace(t), { wav } = await fixtures(dir);
  setEnv(t, { PI_CODING_AGENT_DIR: await installPiper(dir, wav), ELEVENLABS_API_KEY: KEY });
  const m = mockFetch(t); m.reply(failure(401));
  await assert.rejects(video.narrationTts({ action: 'speak', text: 'Hello there.', backend: 'elevenlabs' }, dir),
    err => /HTTP 401/.test(err.message) && !err.message.includes('Piper'));
  assert.equal(m.calls.length, 1);
});

test('automatic ElevenLabs 401, 402, 403 and 429 fall back to Piper after exactly one attempt', async t => {
  const dir = await workspace(t), { wav } = await fixtures(dir);
  setEnv(t, { PI_CODING_AGENT_DIR: await installPiper(dir, wav), ELEVENLABS_API_KEY: KEY });
  const m = mockFetch(t);
  for (const status of [401, 402, 403, 429]) {
    m.reply(failure(status));
    const work = await workspace(t), before = m.calls.length, result = await video.narrationTts({ action: 'speak', text: 'Hello there.' }, work);
    assert.equal(m.calls.length - before, 1, 'one ElevenLabs attempt per request');
    assert.equal(result.backend, 'piper');
    assert.equal(result.voice, VOICE);
    assert.deepEqual(result.fallbackFrom, { backend: 'elevenlabs', status, reason: `ElevenLabs returned HTTP ${status}` });
    assert.match(result.note, new RegExp(`^ElevenLabs returned HTTP ${status}, so this narration used the local Piper voice ${VOICE}; `));
    if (status === 401) assert.match(result.note, /; configure a valid ELEVENLABS_API_KEY to use ElevenLabs\. /);
    assert.ok(result.seconds > 0 && result.artifact);
  }
  assert.equal(m.calls.length, 4, 'four requests, each one attempt, no retry loop');
});

test('without Piper the automatic ElevenLabs failure is rethrown once with the install sentence', async t => {
  const dir = await workspace(t);
  setEnv(t, { PI_CODING_AGENT_DIR: path.join(dir, 'no-piper-here'), ELEVENLABS_API_KEY: KEY });
  const m = mockFetch(t); m.reply(failure(401));
  await assert.rejects(video.narrationTts({ action: 'speak', text: 'Hello there.' }, dir),
    err => err.message.includes('HTTP 401') && err.message.endsWith(SENTENCE));
  assert.equal(m.calls.length, 1);
});

test('bad requests and retained paid speech keep the provider error even when Piper is installed', async t => {
  const dir = await workspace(t), { wav, mp3 } = await fixtures(dir);
  setEnv(t, { PI_CODING_AGENT_DIR: await installPiper(dir, wav), ELEVENLABS_API_KEY: KEY });
  const m = mockFetch(t); m.reply(failure(400));
  await assert.rejects(video.narrationTts({ action: 'speak', text: 'Hello there.' }, dir), err => /HTTP 400/.test(err.message) && !err.message.includes('Piper'));
  assert.equal(m.calls.length, 1);
  const long = 'This authored sentence finishes cleanly. '.repeat(6);
  m.reply(speech(mp3), failure(429));
  await assert.rejects(video.narrationTts({ action: 'speak', text: long, chunkChars: 100 }, dir),
    err => /HTTP 429/.test(err.message) && /checkpoints retained/.test(err.message) && !err.message.includes('Piper'));
  assert.equal(m.calls.length, 3, 'the paid first chunk is kept for recovery, not replaced by Piper');
});

test('a pre-connect network failure falls back to Piper after one attempt', async t => {
  const dir = await workspace(t), { wav } = await fixtures(dir);
  setEnv(t, { PI_CODING_AGENT_DIR: await installPiper(dir, wav), ELEVENLABS_API_KEY: KEY });
  const m = mockFetch(t);
  m.reply(() => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); });
  const result = await video.narrationTts({ action: 'speak', text: 'Hello there.' }, dir);
  assert.equal(m.calls.length, 1);
  assert.deepEqual(result.fallbackFrom, { backend: 'elevenlabs', reason: 'ElevenLabs could not be reached (ECONNREFUSED)' });
  assert.equal(result.backend, 'piper');
});

test('automatic route without an ElevenLabs key speaks with Piper and makes no provider call', async t => {
  const dir = await workspace(t), { wav } = await fixtures(dir);
  setEnv(t, { PI_CODING_AGENT_DIR: await installPiper(dir, wav) });
  const m = mockFetch(t);
  const result = await video.narrationTts({ action: 'speak', text: 'Hello there.', voiceId: 'fixtureVoice' }, dir);
  assert.equal(m.calls.length, 0);
  assert.deepEqual(result.fallbackFrom, { backend: 'elevenlabs', reason: 'ElevenLabs is not configured' });
  assert.match(result.note, /^ElevenLabs is not configured, so this narration used the local Piper voice en_US-ryan-high; set ELEVENLABS_API_KEY to use ElevenLabs\. /);
});


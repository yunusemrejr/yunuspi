// Local audio encoding and inert provider fixtures; no paid generation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => existsSync(path.join(dir, 'extensions/lib/media-pipeline.ts')));
const { mediaPipeline } = await import(pathToFileURL(path.join(agent, 'extensions/lib/media-pipeline.ts')));
const { run } = await import(pathToFileURL(path.join(agent, 'extensions/lib/media-process.ts')));
const score = { bpm: 120, beats: 1, tracks: [{ notes: [{ pitch: 60, start: 0, duration: 1 }] }] };
async function workspace(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-recovery-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const original = globalThis.fetch, keys = ['ELEVENLABS_API_KEY', 'YUNUSPI_SOUNDFONT'], prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.ELEVENLABS_API_KEY = 'TEST_pipeline_retention_fixture'; delete process.env.YUNUSPI_SOUNDFONT;
  t.after(() => { globalThis.fetch = original; for (const key of keys) if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; });
  return cwd;
}
const narration = { backend: 'elevenlabs', text: 'Hello world.' };

test('invalid score renderer is rejected before narration payment or output allocation', async t => {
  const cwd = await workspace(t);
  let requests = 0; globalThis.fetch = async () => { requests++; throw Error('Paid dispatch must not occur'); };
  const percussion = { ...score, tracks: [{ ...score.tracks[0], percussion: true }] };
  await assert.rejects(mediaPipeline({ narration, score: percussion, scoreRender: { backend: 'oscillator' } }, cwd), /Percussion requires/);
  await assert.rejects(mediaPipeline({ narration, score, scoreRender: { backend: 'soundfont', soundfont: 'missing.sf2' } }, cwd), /ENOENT/);
  assert.equal(requests, 0); assert.deepEqual(await fs.readdir(cwd), []);
});

test('a later pipeline failure retains paid narration and its public track reuse works without payment', { timeout: 30_000 }, async t => {
  const cwd = await workspace(t), mp3 = path.join(cwd, 'authored.mp3');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-c:a', 'libmp3lame', mp3]);
  const bytes = await fs.readFile(mp3);
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++; const { text } = JSON.parse(options.body), characters = Array.from(text);
    return Response.json({ audio_base64: bytes.toString('base64'), alignment: { characters,
      character_start_times_seconds: characters.map((_, i) => i / characters.length), character_end_times_seconds: characters.map((_, i) => (i + 1) / characters.length) } });
  };
  let receiptPath;
  await assert.rejects(mediaPipeline({ narration, score, duration: .25 }, cwd), error => {
    assert.match(error.message, /exceeds the 0.25s timeline/); receiptPath = error.pipelineRecovery; return Boolean(receiptPath && error.retainedSpeechCache);
  });
  assert.equal(requests, 1);
  const recovery = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(recovery.submissionOutcomeUnknown, false);
  assert.deepEqual(recovery.completedStages.map(stage => stage.name), ['synthesize_narration']);
  assert.ok(existsSync(recovery.narration.artifact.path));
  assert.ok((await fs.readdir(recovery.retainedSpeechCache)).some(file => /^speech-.*\.mp3$/.test(file)));
  assert.doesNotMatch(JSON.stringify(recovery), /TEST_pipeline_retention_fixture/);
  const reused = await mediaPipeline({ duration: 1.5, tracks: [{ path: recovery.narration.artifact.path, role: 'voice' }] }, cwd);
  assert.equal(reused.decodeVerified, true); assert.equal(requests, 1);
});

test('unknown speech submission survives parent pipeline cleanup with an honest recovery receipt', async t => {
  const cwd = await workspace(t); let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error('Fixture connection lost after dispatch'); };
  let receiptPath;
  await assert.rejects(mediaPipeline({ narration, score }, cwd), error => {
    receiptPath = error.pipelineRecovery; assert.equal(error.submissionOutcomeUnknown, true); return Boolean(receiptPath);
  });
  const recovery = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(requests, 1); assert.equal(recovery.submissionOutcomeUnknown, true);
  assert.equal(recovery.narration, undefined); assert.deepEqual(recovery.completedStages, []);
  const checkpoints = await fs.readdir(recovery.retainedSpeechCache);
  assert.ok(checkpoints.some(file => file.endsWith('.submission.json')));
  assert.equal(checkpoints.some(file => file.endsWith('.mp3')), false);
  assert.match(recovery.reuse, /provider history before regeneration/);
});

// Authored fixtures only. Cloud responses are mocked; media is actually
// decoded/encoded locally. Paid-service sound quality is not inferred here.
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
const load = p => import(pathToFileURL(path.join(agent, p)).href);
const eleven = await load('extensions/lib/elevenlabs.ts'), segments = await load('extensions/lib/video-segments.ts');
const browser = await load('extensions/lib/video-browser.ts'), video = await load('extensions/lib/video-studio.ts');
const media = await load('extensions/lib/media-process.ts'), guarded = await load('extensions/lib/guarded-process.ts');
const env = { ELEVENLABS_API_KEY: 'TEST_audio_fixture_only', ELEVENLABS_VOICE_ID: 'fixtureVoice' };
const workspace = async t => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-production-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };
const audioFixture = async dir => {
  const file = path.join(dir, 'fixture.mp3');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=480:duration=2:sample_rate=48000', '-c:a', 'libmp3lame', file]);
  return fs.readFile(file);
};
const alignment = text => ({ characters: Array.from(text), character_start_times_seconds: Array.from(text, (_, i) => i / Array.from(text).length * 1.8), character_end_times_seconds: Array.from(text, (_, i) => (i + 1) / Array.from(text).length * 1.8) });

test('provider choice is independent of the LLM, preserves explicit Piper and never silently substitutes', () => {
  assert.equal(eleven.narrationBackend({}, env), 'elevenlabs');
  assert.equal(eleven.narrationBackend({}, {}), 'piper');
  assert.equal(eleven.narrationBackend({ voice: 'en_US-ryan-high' }, env), 'piper');
  assert.equal(eleven.narrationBackend({ backend: 'piper' }, env), 'piper');
  assert.throws(() => eleven.narrationBackend({ backend: 'elevenlabs', voice: 'en_US-ryan-high' }, env), /voiceId/);
  assert.throws(() => eleven.narrationBackend({ backend: 'piper', model: 'eleven_v3' }, env), /require/);
  const request = eleven.speechRequest({ model: 'eleven_v3', voiceId: 'chosenVoice', speed: 1.1 }, 'Hello.', env);
  assert.equal(request.voiceId, 'chosenVoice'); assert.equal(request.body.model_id, 'eleven_v3');
  assert.throws(() => eleven.speechRequest({ speed: 1.5 }, 'Hello.', env), /speed/);
  assert.equal(JSON.stringify(eleven.elevenStatus(env)).includes(env.ELEVENLABS_API_KEY), false);
});

test('long scripts keep every Unicode character and reject mismatched or invalid provider alignments', () => {
  const text = '  A sentence with 🍋 and crème.\n Another sentence with punctuation! '.repeat(200);
  const chunks = eleven.splitSpeech(text, 100);
  assert.equal(chunks.join(''), text); assert.ok(chunks.every(c => c.length <= 100));
  assert.ok(chunks.every(c => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(c)));
  const words = eleven.characterWords(alignment('  Hello 🍋 world.  '), '  Hello 🍋 world.  ');
  assert.deepEqual(words.map(w => w.w), ['Hello', '🍋', 'world.']);
  assert.throws(() => eleven.characterWords(alignment('Hello'), 'Other'), /does not match/);
  const bad = alignment('Hello'); bad.character_end_times_seconds[2] = -1;
  assert.throws(() => eleven.characterWords(bad, 'Hello'), /Invalid/);
  assert.deepEqual(video.displayWordTiming('GPU works.', [{ w: 'G', s: 0, e: .1 }, { w: 'P', s: .1, e: .2 }, { w: 'U', s: .2, e: .3 }, { w: 'works.', s: .3, e: .6 }], [3, 1]), [{ w: 'GPU', s: 0, e: .3 }, { w: 'works.', s: .3, e: .6 }]);
});

test('paid narration chunks resume after provider failure, stitch PCM clocks and disclose reuse', async t => {
  const dir = await workspace(t), bytes = await audioFixture(dir), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const text = ('This authored sentence has a complete ending. ').repeat(5), parts = eleven.splitSpeech(text, 100), requests = [];
  let fail = true;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url: String(url), body });
    assert.equal(options.redirect, 'error'); assert.equal(options.headers['xi-api-key'], env.ELEVENLABS_API_KEY);
    if (fail && requests.length === 2) return Response.json({ error: env.ELEVENLABS_API_KEY }, { status: 503 });
    return Response.json({ audio_base64: bytes.toString('base64'), alignment: alignment(body.text) }, { headers: { 'request-id': `fixture-${requests.length}`, 'character-cost': String(body.text.length) } });
  };
  const cache = path.join(dir, 'speech');
  await assert.rejects(eleven.elevenSpeech({ text, chunkChars: 100 }, cache, undefined, undefined, env), /HTTP 503/);
  assert.equal(requests.length, 2, 'failed paid calls are never retried');
  fail = false;
  const result = await eleven.elevenSpeech({ text, chunkChars: 100 }, cache, undefined, undefined, env);
  assert.equal(result.receipts[0].reused, true); assert.equal(requests.length, parts.length + 1);
  assert.ok(requests[0].body.next_text); assert.ok(requests.at(-1).body.previous_text);
  assert.equal(result.words.map(w => w.w).join(' '), text.trim());
  assert.ok(Math.abs(result.seconds - parts.length * 2) < .01, 'PCM seams exclude MP3 container padding');
  assert.ok(Math.abs(result.words.filter(w => w.w === 'This')[2].s - 2) < .01);
  const cached = await eleven.elevenSpeech({ text, chunkChars: 100 }, cache, undefined, undefined, env);
  assert.ok(cached.receipts.every(r => r.reused)); assert.equal(requests.length, parts.length + 1);
  const files = await fs.readdir(cache);
  for (const name of files.filter(n => n.endsWith('.json'))) assert.equal((await fs.readFile(path.join(cache, name), 'utf8')).includes(env.ELEVENLABS_API_KEY), false);
});

test('music generation measures the actual file and refuses an invalid duration before paid work', async t => {
  const dir = await workspace(t), bytes = await audioFixture(dir), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    const body = JSON.parse(options.body); assert.equal(body.force_instrumental, true); assert.equal(body.music_length_ms, 3000);
    return new Response(bytes, { headers: { 'song-id': 'fixture-song' } });
  };
  const music = await eleven.audioGenerate({ kind: 'music', prompt: 'Authored instrumental fixture', seconds: 3 }, dir, undefined, env);
  assert.equal(music.decodeVerified, true); assert.ok(music.seconds < 2.1); assert.equal(music.requestedSeconds, 3);
  await assert.rejects(eleven.audioGenerate({ kind: 'music', prompt: 'Fixture', seconds: 1000 }, dir, undefined, env), /seconds/);
  assert.equal(calls, 1, 'invalid duration never reaches the paid provider');
});

test('segment checkpoints survive failures, corrupted parts re-render, and assembled audio is encoded once', async t => {
  const dir = await workspace(t); await fs.mkdir(path.join(dir, 'out')); await fs.writeFile(path.join(dir, 'video.json'), '{}');
  const calls = []; let fail = true;
  const renderer = async (_, request) => {
    calls.push(request.range);
    if (fail && request.range[0] === 30) throw Error('Fixture interruption');
    const output = path.join(request.outDir, 'segment.mkv'), seconds = (request.range[1] - request.range[0] + 1) / 30;
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=480:duration=${seconds}:sample_rate=48000`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', output]);
    return { output };
  };
  const spec = { fps: 30 }, params = { segmentSeconds: 1, maxSegments: 1 }, request = { outDir: path.join(dir, 'out'), scale: 1 };
  const first = await segments.renderSegments(params, dir, spec, 91, request, renderer);
  assert.equal(first.complete, false); assert.equal(first.completedSegments, 1);
  await assert.rejects(segments.renderSegments(params, dir, spec, 91, request, renderer), /Fixture interruption/);
  fail = false;
  const second = await segments.renderSegments(params, dir, spec, 91, request, renderer);
  assert.equal(second.reusedSegments, 1); assert.equal(second.completedSegments, 2);
  const cache = path.dirname(second.cache); await fs.writeFile(path.join(cache, 'part-000000.mkv'), 'CORRUPT');
  const repair = await segments.renderSegments(params, dir, spec, 91, request, renderer);
  assert.equal(repair.complete, false); assert.equal(repair.completedSegments, 2);
  let final;
  for (let i = 0; i < 3; i++) { final = await segments.renderSegments(params, dir, spec, 91, request, renderer); if (final.complete) break; }
  assert.equal(final.complete, true); assert.match(final.audioSeams, /one final AAC/);
  const info = await media.probe(final.output);
  const counted = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', final.output]);
  assert.equal(counted.stdout.trim(), '91');
  assert.ok(Math.abs(Number(info.format.duration) - 91 / 30) < 1 / 30);
  await exec('ffmpeg', ['-v', 'error', '-xerror', '-i', final.output, '-f', 'null', '-']);
  const pcm = await exec('ffmpeg', ['-v', 'error', '-i', final.output, '-vn', '-f', 's16le', '-ac', '1', '-ar', '48000', '-'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
  for (const cut of [1, 2, 3]) {
    const start = Math.round((cut - .01) * 48000), end = Math.round((cut + .01) * 48000); let energy = 0;
    for (let i = start; i < end; i++) energy += pcm.stdout.readInt16LE(i * 2) ** 2;
    assert.ok(Math.sqrt(energy / (end - start)) > 1500, `no encoder-padding silence at ${cut}s`);
  }
});

test('isolated render workers do not inherit provider credentials', async t => {
  const cwd = await workspace(t);
  const original = process.env.YUNUSPI_FIXTURE_SECRET; process.env.YUNUSPI_FIXTURE_SECRET = 'fixture-value';
  t.after(() => { if (original === undefined) delete process.env.YUNUSPI_FIXTURE_SECRET; else process.env.YUNUSPI_FIXTURE_SECRET = original; });
  const result = await guarded.runGuarded(process.execPath, ['-e', 'process.stdout.write(String(Boolean(process.env.YUNUSPI_FIXTURE_SECRET)))'], { cwd, timeoutMs: 5000, guard: false, replaceEnv: true, env: { PATH: process.env.PATH } });
  assert.equal(result.stdout, 'false');
});

test('browser take preflight rejects unsafe URLs, ambiguous schedules and invalid coordinates', () => {
  assert.throws(() => browser.planBrowserTake({ url: 'file:///tmp/page.html' }), /HTTP/);
  const credentialUrl = new URL('https://example.com'); credentialUrl.username = 'fixture-user'; credentialUrl.password = 'TEST_fixture_only';
  assert.throws(() => browser.planBrowserTake({ url: credentialUrl.href }), /credentials/);
  assert.throws(() => browser.planBrowserTake({ url: 'https://example.com', seconds: 2, steps: [{ action: 'click', at: 3, x: 0, y: 0 }] }), /step.at/);
  assert.throws(() => browser.planBrowserTake({ url: 'https://example.com', steps: [{ action: 'move', x: 5000, y: 0 }] }), /step.x/);
});

test('real browser take outside maintenance scope retains Chromium sandbox and captures observed state changes', { timeout: 60000 }, async t => {
  const root = await workspace(t), cwd = path.join(root, 'a-project-with-a-long-output-directory-name', 'capture');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(cwd, 'demo.html'), '<!doctype html><style>body{margin:0;background:#234;color:white;font:28px sans-serif}button{margin:50px;padding:20px}#result{margin:50px}</style><button id="go" onclick="document.body.style.background=\'#b54\';document.getElementById(\'result\').textContent=\'Visible result\'">Show result</button><p id="result">Ready</p>');
  let result;
  const params = { path: 'demo.html', seconds: 2, fps: 15, width: 640, height: 360, steps: [{ action: 'click', selector: '#go', at: .2, duration: .3 }, { action: 'wait_text', text: 'Visible result', at: 1 }] };
  try {
    const moduleUrl = pathToFileURL(path.join(agent, 'extensions/lib/video-browser.ts')).href;
    const script = `const {videoBrowser}=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(await videoBrowser(${JSON.stringify(params)},process.cwd())));`;
    const captured = await exec(process.execPath, ['--input-type=module', '-e', script], { cwd, env: { ...process.env, PI_HARNESS_MUTATION_DENIED: '1' }, timeout: 50000 });
    result = JSON.parse(captured.stdout);
  }
  catch (error) { if (process.env.PI_BROWSER_REQUIRE === '1' || !/Executable doesn't exist|not installed|Distribution.*not found|browserType.launch/.test(error.message)) throw error; t.skip(error.message); return; }
  assert.equal(result.decodeVerified, true); assert.equal(result.frames, 30); assert.ok(result.capturedFrames > 5);
  const events = JSON.parse(await fs.readFile(result.events, 'utf8'));
  const click = events.eventLog.find(e => e.kind === 'click'); assert.ok(click.t >= .4 && click.t < 1);
  assert.ok(events.eventLog.some(e => e.kind === 'text-visible')); assert.equal(events.sourceFrames.length, 30);
  assert.ok(events.sourceFrames.slice(1).every((f, i) => f.sourceT >= events.sourceFrames[i].sourceT));
  const frames = await exec('ffmpeg', ['-v', 'error', '-i', result.artifact.path, '-vf', 'select=eq(n\\,0)+eq(n\\,29)', '-vsync', '0', '-f', 'framemd5', '-']);
  const hashes = frames.stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
  assert.equal(hashes.length, 2); assert.notEqual(hashes[0], hashes[1], 'the delivered take contains the actual UI state change');
});

// Authored browser and encoded media fixtures; no external accounts/providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => syncFs.existsSync(path.join(p, 'extensions/lib/video-segments.ts')));
const load = p => import(pathToFileURL(path.join(agent, p)).href);
const segments = await load('extensions/lib/video-segments.ts');
const browser = await load('extensions/lib/video-browser.ts');
const { resampleBrowserFrames } = await load('scripts/video-browser.mjs');
const { run } = await load('extensions/lib/media-process.ts');
const workspace = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-delivery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
};
function unavailable(t, error) {
  if (process.env.PI_BROWSER_REQUIRE === '1' || !/Executable doesn't exist|not installed/i.test(error.message)) throw error;
  t.skip('Optional browser prerequisite unavailable');
}
async function part(request, options = {}) {
  const file = path.join(request.outDir, 'segment.mkv');
  const seconds = (request.range[1] - request.range[0] + 1) / (options.clock ?? 30);
  const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=' + (options.size ?? '160x90') + ':rate=' + (options.fps ?? 30) + ':duration=' + seconds];
  if (!options.noAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=480:sample_rate=48000:duration=' + (options.audioSeconds ?? seconds));
  if (options.dropFrame) args.push('-vf', "select='not(eq(n,10))'", '-fps_mode', 'passthrough');
  if (options.fullRange) args.push('-color_range', 'pc');
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', file);
  await run('ffmpeg', args); return { output: file };
}
async function project(t) {
  const dir = await workspace(t); await fs.mkdir(path.join(dir, 'out'));
  await fs.writeFile(path.join(dir, 'video.json'), '{}');
  return { dir, params: { segmentSeconds: 1, maxSegments: 1 }, request: { outDir: path.join(dir, 'out'), scale: 1 }, spec: { fps: 30 } };
}

test('browser schedules reject guaranteed sequential overruns before creating output', async t => {
  const dir = await workspace(t), params = { path: 'demo.html', seconds: 2, steps: [
    { action: 'move', at: 0, x: 10, y: 10, duration: 1.4 },
    { action: 'scroll', at: .1, dy: 80, duration: .7 },
  ] };
  await assert.rejects(browser.videoBrowser(params, dir), /cannot finish/);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.throws(() => browser.planBrowserTake({ url: 'https://example.com', seconds: 1, steps: [{ action: 'type', text: 'A'.repeat(26) }] }), /cannot finish/);
  assert.doesNotThrow(() => browser.planBrowserTake({ url: 'https://example.com', seconds: 1, steps: [{ action: 'type', text: '🍋'.repeat(20) }] }));
});

test('constant-frame resampling retains observed bytes and timestamps with one inode per source', async t => {
  const dir = await workspace(t), a = path.join(dir, 'a.jpg'), b = path.join(dir, 'b.jpg'), out = path.join(dir, 'frames');
  await fs.mkdir(out); await fs.writeFile(a, 'first authored frame'); await fs.writeFile(b, 'second authored frame');
  const result = await resampleBrowserFrames([{ timestamp: 100.4, file: b }, { timestamp: 99.99, file: a }], 1, 10, 100, out);
  assert.equal(result.frames, 10); assert.equal(result.resampling.uniqueSourceFrames, 2);
  assert.deepEqual(result.sources.map(s => s.sourceT.toFixed(2)), ['-0.01', '-0.01', '-0.01', '-0.01', '0.40', '0.40', '0.40', '0.40', '0.40', '0.40']);
  const first = await fs.stat(path.join(out, 'frame-000000.jpg'));
  assert.equal(first.ino, (await fs.stat(a)).ino); assert.equal(first.nlink, 5);
  assert.equal((await fs.stat(path.join(out, 'frame-000009.jpg'))).ino, (await fs.stat(b)).ino);
  const sizeA = (await fs.stat(a)).size, sizeB = (await fs.stat(b)).size;
  assert.equal(result.resampling.storedFrameBytes, sizeA + sizeB);
  assert.equal(result.resampling.copyBytesAvoided, sizeA * 3 + sizeB * 5);
  await fs.rm(a); await fs.rm(b);
  assert.equal(await fs.readFile(path.join(out, 'frame-000000.jpg'), 'utf8'), 'first authored frame');
  assert.equal(await fs.readFile(path.join(out, 'frame-000009.jpg'), 'utf8'), 'second authored frame');
  await assert.rejects(resampleBrowserFrames([{ timestamp: NaN, file: a }], 1, 10, 100, out), /clock/);
});

test('browser resampling falls back exclusively on unsupported links and reports actual stored bytes', async t => {
  const nativeLink = fs.link;
  for (const [allowed, code] of [[0, 'EOPNOTSUPP'], [2, 'EMLINK']]) {
    const dir = await workspace(t), raw = path.join(dir, 'raw.jpg'), out = path.join(dir, 'frames');
    await fs.mkdir(out); await fs.writeFile(raw, 'observed source frame');
    const size = (await fs.stat(raw)).size; let attempts = 0, result;
    fs.link = async (...args) => {
      if (attempts++ < allowed) return nativeLink(...args);
      throw Object.assign(Error('Injected filesystem link limitation'), { code });
    };
    try { result = await resampleBrowserFrames([{ timestamp: 0, file: raw }], 1, 4, 0, out); }
    finally { fs.link = nativeLink; }
    assert.equal(attempts, allowed + 1, 'unsupported links are attempted once, then the take continues');
    assert.equal(result.resampling.method, allowed ? 'mixed' : 'copies');
    assert.equal(result.resampling.linkedFrames, allowed); assert.equal(result.resampling.copiedFrames, 4 - allowed);
    assert.equal(result.resampling.uniqueSourceFrames, 1);
    assert.equal(result.resampling.storedFrameBytes, size * (4 - allowed + (allowed ? 1 : 0)));
    assert.equal(result.resampling.copyBytesAvoided, allowed ? size : 0);
    await assert.rejects(resampleBrowserFrames([{ timestamp: 0, file: raw }], 1, 4, 0, out), /EEXIST/);
    await fs.rm(raw);
    const inodes = new Set();
    for (let i = 0; i < 4; i++) {
      const file = path.join(out, 'frame-' + String(i).padStart(6, '0') + '.jpg');
      assert.equal(await fs.readFile(file, 'utf8'), 'observed source frame'); inodes.add((await fs.stat(file)).ino);
    }
    assert.equal(inodes.size, 4 - allowed + (allowed ? 1 : 0));
  }
});

test('browser response waits scope text to the requested element, including delayed insertion', { timeout: 90_000 }, async t => {
  for (const existing of [true, false]) {
    const dir = await workspace(t), file = path.join(dir, 'demo.html');
    await fs.writeFile(file, '<!doctype html><style>body{font:22px sans-serif}button{padding:12px}</style><p>Complete</p>' +
      (existing ? '<p id="response">Working</p>' : '<div id="result"></div>') +
      '<button id="go" onclick="setTimeout(() => {' +
      (existing ? "document.getElementById('response').textContent='Complete'" : "document.getElementById('result').innerHTML='<p id=response>Complete</p>'") +
      '}, 700)">Begin</button>');
    let take;
    try { take = await browser.videoBrowser({ path: file, seconds: 3, fps: 12, width: 640, height: 360, steps: [
      { action: 'click', selector: '#go', at: .15, duration: .15 },
      { action: 'wait_text', selector: '#response', text: 'Complete', at: .4 },
    ] }, dir); } catch (error) { unavailable(t, error); return; }
    const receipt = JSON.parse(await fs.readFile(take.events, 'utf8'));
    const click = receipt.eventLog.find(e => e.kind === 'click'), response = receipt.eventLog.find(e => e.kind === 'text-visible');
    assert.ok(response.t - click.t >= .65, 'matching text elsewhere must not approve the delayed response');
    assert.equal(response.selector, '#response'); assert.equal(take.frames, 36); assert.equal(take.decodeVerified, true);
    assert.equal(take.resampling.method, 'hardlinks');
    assert.ok(receipt.sourceFrames.every(s => s.sourceT <= s.t + .001), 'delivery uses observed source frames without future-frame lookahead');
  }
});

test('covered browser targets cannot activate a different control and offscreen text cannot approve a take', { timeout: 90_000 }, async t => {
  const dir = await workspace(t); let wrongClicks = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/wrong') { wrongClicks++; res.end('Recorded'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><style>button{position:absolute;left:20px;top:20px;width:120px;height:60px}#cover{z-index:2}</style><button id="go">Intended</button><button id="cover" onclick="fetch(\'/wrong\')">Wrong</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  try {
    await assert.rejects(browser.videoBrowser({ url: 'http://127.0.0.1:' + server.address().port, seconds: 2, fps: 10, width: 320, height: 180,
      steps: [{ action: 'click', selector: '#go', at: .1, duration: .2 }] }, dir), /covered/);
    assert.equal(wrongClicks, 0); assert.deepEqual(await fs.readdir(dir), []);
    await fs.writeFile(path.join(dir, 'offscreen.html'), '<!doctype html><p style="position:absolute;top:1000px">Complete</p>');
    await assert.rejects(browser.videoBrowser({ path: 'offscreen.html', seconds: 2, fps: 10, width: 320, height: 180,
      steps: [{ action: 'wait_text', text: 'Complete', at: .1 }] }, dir), /outside the viewport/);
    assert.deepEqual(await fs.readdir(dir), ['offscreen.html']);
  } catch (error) { unavailable(t, error); }
});

test('segment validation rejects wrong cadence, missing decoded frames and incomplete audio before checkpointing', { timeout: 60_000 }, async t => {
  for (const [options, failure] of [[{ fps: 15 }, /frame rate/], [{ dropFrame: true }, /Decoded frame count 29/], [{ noAudio: true }, /PCM audio/], [{ audioSeconds: .5 }, /audio does not fill/]]) {
    const { dir, params, request, spec } = await project(t);
    await assert.rejects(segments.renderSegments(params, dir, spec, 30, request, (_, req) => part(req, options)), failure);
    assert.deepEqual(await fs.readdir(request.outDir), []);
    const cache = path.join(dir, '.video-cache', (await fs.readdir(path.join(dir, '.video-cache')))[0]);
    assert.equal((await fs.readdir(cache)).some(name => name.endsWith('.mkv')), false, 'invalid bytes must not become a resumable part');
  }
});

test('segments adopt valid legacy checkpoints, reject incompatible streams and preserve existing final deliveries', { timeout: 60_000 }, async t => {
  const { dir, params, request, spec } = await project(t); let mismatch = true; const calls = [];
  const renderer = async (_, req) => { calls.push(req.range); return part(req, req.range[0] && mismatch ? { size: '320x180' } : {}); };
  const first = await segments.renderSegments(params, dir, spec, 60, request, renderer);
  await assert.rejects(segments.renderSegments(params, dir, spec, 60, request, renderer), /incompatible/);
  const manifest = JSON.parse(await fs.readFile(first.cache, 'utf8')); delete manifest.parts[0].verification;
  await fs.writeFile(first.cache, JSON.stringify(manifest)); mismatch = false;
  const final = await segments.renderSegments(params, dir, spec, 60, request, renderer);
  assert.equal(final.complete, true); assert.equal(final.reusedSegments, 1); assert.equal(final.verification.frames, 60); assert.equal(final.decodeVerified, true);
  assert.deepEqual(calls, [[0, 29], [30, 59], [30, 59]], 'valid legacy frames are adopted without rendering them again');
  const before = await segments.fileDigest(final.output);
  await assert.rejects(segments.renderSegments(params, dir, spec, 60, request, renderer), /EEXIST/);
  assert.equal(await segments.fileDigest(final.output), before);
  assert.deepEqual(await fs.readdir(request.outDir), ['final.mp4'], 'unpublished assembly files must be cleaned');
  // A prior renderer may have checkpointed decodable but incompatible parts.
  // Repair that cache in place instead of asking for an impossible retry.
  const legacyDir = path.join(dir, 'legacy'); await fs.mkdir(legacyDir);
  const bad = await part({ outDir: legacyDir, range: [30, 59] }, { size: '320x180' });
  const cachedPart = path.join(path.dirname(first.cache), 'part-000001.mkv');
  await fs.rename(bad.output, cachedPart);
  const stale = JSON.parse(await fs.readFile(first.cache, 'utf8'));
  stale.parts[1].sha256 = await segments.fileDigest(cachedPart); delete stale.parts[1].verification;
  await fs.writeFile(first.cache, JSON.stringify(stale));
  const repairedOut = path.join(dir, 'repaired'); await fs.mkdir(repairedOut);
  const repaired = await segments.renderSegments(params, dir, spec, 60, { ...request, outDir: repairedOut }, renderer);
  assert.equal(repaired.reusedSegments, 1); assert.equal(repaired.renderedSegments, 1);
  assert.equal(repaired.verification.width, 160); assert.equal(await segments.fileDigest(final.output), before);
});

test('full-range H.264 4:2:0 from JPEG renderers retains its color range through assembly', { timeout: 60_000 }, async t => {
  const { dir, params, request, spec } = await project(t);
  const final = await segments.renderSegments(params, dir, spec, 30, request, (_, req) => part(req, { fullRange: true }));
  assert.equal(final.verification.pixelFormat, 'yuvj420p'); assert.equal(final.verification.colorRange, 'pc');
  assert.equal(final.verification.frames, 30); assert.equal(final.decodeVerified, true);
});

test('segment dimensions follow the requested composition scale', { timeout: 60_000 }, async t => {
  const { dir, params, request } = await project(t), spec = { fps: 30, width: 320, height: 180 };
  await assert.rejects(segments.renderSegments(params, dir, spec, 30, request, (_, req) => part(req)), /dimensions/);
  const final = await segments.renderSegments(params, dir, spec, 30, { ...request, scale: .5 }, (_, req) => part(req));
  assert.equal(final.verification.width, 160); assert.equal(final.verification.height, 90);
});

test('24fps assembly restores exact frame ticks and preserves every decoded source picture', { timeout: 60_000 }, async t => {
  const { dir, request } = await project(t), spec = { fps: 24 };
  const final = await segments.renderSegments({ segmentSeconds: 3, maxSegments: 3 }, dir, spec, 204, request,
    (_, req) => part(req, { clock: 24, fps: 24 }));
  const packets = async file => JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_packets', '-show_streams', '-show_entries', 'stream=avg_frame_rate,duration:packet=pts_time,duration_time',
    '-of', 'json', file])).stdout);
  const delivered = await packets(final.output);
  assert.equal(delivered.streams[0].avg_frame_rate, '24/1'); assert.equal(Number(delivered.streams[0].duration), 8.5);
  const ordered = delivered.packets.map(packet => Number(packet.pts_time)).sort((a, b) => a - b);
  assert.equal(ordered.length, 204);
  assert.ok(ordered.every((pts, i) => Math.abs(pts - i / 24) < 0.000001), 'every displayed frame lies on the global output clock');
  // Container conversion can insert H.264 parameter sets into packets.
  // Compare actual decoded picture bytes instead of packet packaging.
  const pictures = async file => (await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'framemd5', '-'])).stdout
    .split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
  const originals = [];
  for (let i = 0; i < 3; i++) originals.push(...await pictures(path.join(path.dirname(final.cache), 'part-' + String(i).padStart(6, '0') + '.mkv')));
  assert.deepEqual(await pictures(final.output), originals, 'clock correction must preserve every decoded source picture');
});

test('a source edit during an incomplete render cannot poison the original source cache', { timeout: 60_000 }, async t => {
  const { dir, params, request, spec } = await project(t), source = path.join(dir, 'video.json');
  await fs.writeFile(source, '{"title":"AAAA"}'); let mutate = true;
  const renderer = async (_, req) => {
    const output = await part(req); if (mutate) await fs.writeFile(source, '{"title":"BBBB"}'); return output;
  };
  await assert.rejects(segments.renderSegments(params, dir, spec, 60, request, renderer), /Project changed while rendering a segment/);
  const cache = path.join(dir, '.video-cache', (await fs.readdir(path.join(dir, '.video-cache')))[0]);
  assert.equal((await fs.readdir(cache)).some(name => name.endsWith('.mkv')), false);
  mutate = false; await fs.writeFile(source, '{"title":"AAAA"}');
  const resumed = await segments.renderSegments(params, dir, spec, 60, request, renderer);
  assert.equal(resumed.complete, false); assert.equal(resumed.reusedSegments, 0); assert.equal(resumed.renderedSegments, 1);
});

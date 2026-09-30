// Authored, deterministic local fixtures; no downloaded binary assets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..'),path.resolve(root,'../agent')].find(p => syncFs.existsSync(path.join(p, 'extensions/lib/gltf-inspect.ts')));
const load = p => import(pathToFileURL(path.join(agent, p)).href);
const { inspectGltf, parseGltf, stageGltfBundle } = await load('extensions/lib/gltf-inspect.ts');
const { registerAsset, inspectAsset, readRegistry } = await load('extensions/lib/asset-registry.ts');
const { videoMotion, analyzeDecodedMotion } = await load('extensions/lib/video-motion.ts');
const { videoAssets } = await load('extensions/lib/video-assets.ts');
const { videoProject } = await load('extensions/lib/video-studio.ts');
const { motionInspectRun } = await load('extensions/lib/motion-inspect.ts');
const temporary = async fn => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-preflight-')); try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); } };
function fixture() {
  const bytes = Buffer.alloc(76);
  [0, 0, 0, 2, 0, 0, 0, 3, 0].forEach((n, i) => bytes.writeFloatLE(n, i * 4));
  [0, 1, 2].forEach((n, i) => bytes.writeUInt16LE(n, 36 + i * 2));
  [0, 1.5].forEach((n, i) => bytes.writeFloatLE(n, 44 + i * 4));
  [0, 0, 0, 1, 0, 0].forEach((n, i) => bytes.writeFloatLE(n, 52 + i * 4));
  const document = { asset: { version: '2.0' }, buffers: [{ uri: 'geometry.bin', byteLength: bytes.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }, { buffer: 0, byteOffset: 44, byteLength: 8 }, { buffer: 0, byteOffset: 52, byteLength: 24 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-99, -99, -99], max: [99, 99, 99] }, { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }, { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR' }, { bufferView: 3, componentType: 5126, count: 2, type: 'VEC3' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0, animations: [{ name: 'translation', samplers: [{ input: 2, output: 3 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }] };
  return { bytes, document };
}
const put = async (dir, doc = fixture().document, bytes = fixture().bytes) => { await fs.writeFile(path.join(dir, 'model.gltf'), JSON.stringify(doc)); await fs.writeFile(path.join(dir, 'geometry.bin'), bytes); return path.join(dir, 'model.gltf'); };
function glb(document, bin) {
  document = structuredClone(document); delete document.buffers[0].uri;
  const json = Buffer.from(JSON.stringify(document)), padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const out = Buffer.alloc(12 + 8 + padded.length + 8 + bin.length);
  out.writeUInt32LE(0x46546c67); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8); out.writeUInt32LE(padded.length, 12); out.writeUInt32LE(0x4e4f534a, 16); padded.copy(out, 20);
  const at = 20 + padded.length; out.writeUInt32LE(bin.length, at); out.writeUInt32LE(0x004e4942, at + 4); bin.copy(out, at + 8); return out;
}

test('glTF and GLB inspection reads actual positions/timing and caches provenance in the existing registry', async () => temporary(async dir => {
  const file = await put(dir), model = await inspectAsset({ path: file }, dir);
  assert.deepEqual(model.meshLocalBounds, [{ mesh: 0, min: [0, 0, 0], max: [2, 3, 0] }], 'bounds come from bytes, not untrusted accessor min/max');
  assert.equal(model.animationClips[0].durationSeconds, 1.5);
  assert.equal(model.counts.triangles, 1); assert.equal(model.resourceCount, 1); assert.equal(model.boundsComplete, true);
  assert.ok(Buffer.byteLength(JSON.stringify(model)) < 5000, 'small asset preflight receipt stays below 5KB');
  const registered = await registerAsset({ path: file, description: 'authored triangular prop', sourceUrl: 'https://example.com/prop', creator: 'Fixture author', license: 'CC0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' }, dir);
  assert.equal(registered.record.model.counts.triangles, 1);
  const stored = await readRegistry(dir); assert.equal(stored.assets[0].creator, 'Fixture author'); assert.equal(stored.assets[0].sourceUrl, 'https://example.com/prop');
  const { document, bytes } = fixture(); await fs.writeFile(path.join(dir, 'model.glb'), glb(document, bytes));
  const binary = await inspectGltf(path.join(dir, 'model.glb')); assert.equal(binary.resourceCount, 0); assert.deepEqual(binary.meshLocalBounds, model.meshLocalBounds);
  const staged = await stageGltfBundle(file, path.join(dir, 'copied'));
  assert.deepEqual(staged.report.meshLocalBounds, model.meshLocalBounds); assert.equal((await fs.stat(path.join(dir, 'copied/geometry.bin'))).size, 76);
  await assert.rejects(stageGltfBundle(file, path.join(dir, 'copied')), /EEXIST/);
}));

test('glTF rejects malformed chunks, missing/escaping resources, oversized work, invalid indices and node cycles', async () => temporary(async dir => {
  const { bytes, document } = fixture(); const file = await put(dir);
  assert.throws(() => parseGltf(Buffer.from('bad'), true), /GLB/);
  const badGlb = glb(document, bytes); badGlb.writeUInt32LE(0, 8); assert.throws(() => parseGltf(badGlb, true), /declared length/);
  const cases = [
    d => { d.bufferViews[0].byteLength = 1000; }, d => { d.accessors[0].count = 2_000_001; },
    d => { d.buffers[0].uri = 'https://example.com/x.bin'; }, d => { d.buffers[0].uri = '../outside.bin'; },
    d => { d.buffers[0].uri = '%2e%2e/outside.bin'; }, d => { d.buffers[0].uri = 'missing.bin'; },
    d => { d.nodes[0].children = [0]; }, d => { d.nodes[0].translation = [Infinity, 0, 0]; },
    d => { d.animations[0].channels[0].target.node = 99; }, d => { d.accessors[0].byteOffset = 1; },
  ];
  for (const mutate of cases) { const d = structuredClone(document); mutate(d); await put(dir, d); await assert.rejects(inspectGltf(file)); }
  const changed = Buffer.from(bytes); changed.writeUInt16LE(99, 36); await put(dir, document, changed); await assert.rejects(inspectGltf(file), /index exceeds/);
  changed.writeUInt16LE(0, 36); changed.writeFloatLE(NaN, 0); await put(dir, document, changed); await assert.rejects(inspectGltf(file), /nonfinite/);
  const times = Buffer.from(bytes); times.writeFloatLE(0, 48); await put(dir, document, times); await assert.rejects(inspectGltf(file), /strictly increasing/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-model-'));
  try { await fs.writeFile(path.join(outside, 'geometry.bin'), bytes); await fs.rm(path.join(dir, 'geometry.bin')); await fs.symlink(path.join(outside, 'geometry.bin'), path.join(dir, 'geometry.bin')); await fs.writeFile(file, JSON.stringify(document)); await assert.rejects(inspectGltf(file), /symlink escapes/); } finally { await fs.rm(outside, { recursive: true, force: true }); }
  const controller = new AbortController(); controller.abort(); await assert.rejects(inspectGltf(file, controller.signal));
}));

test('video model import preserves glTF dependencies, provenance and existing files', async () => temporary(async dir => {
  const source = await put(dir); await videoProject({ action: 'init', dir: 'video', title: 'Fixture', intent: 'personal', width: 160, height: 96, fps: 6 }, dir);
  const result = await videoAssets({ action: 'import', dir: 'video', path: source, name: 'triangle', creator: 'Fixture author', license: 'CC0', page: 'https://example.com/fixture' }, dir);
  assert.equal(result.kind, 'model'); assert.equal(result.model.rendered, false); assert.equal(result.model.counts.triangles, 1);
  assert.ok(result.file.startsWith('assets/models/triangle/')); assert.ok(result.assetId);
  assert.ok(syncFs.existsSync(path.join(dir, 'video/public/assets/models/triangle/geometry.bin')));
  const stored = await readRegistry(dir); assert.equal(stored.assets[0].creator, 'Fixture author');
  await assert.rejects(videoAssets({ action: 'import', dir: 'video', path: source, name: 'triangle', license: 'CC0' }, dir), /EEXIST/);
  const malformed = structuredClone(fixture().document); malformed.buffers[0].uri = 'missing.bin'; await fs.writeFile(source, JSON.stringify(malformed));
  await assert.rejects(videoAssets({ action: 'import', dir: 'video', path: source, name: 'bad', license: 'CC0' }, dir), /Missing glTF resource/);
  assert.equal(syncFs.existsSync(path.join(dir, 'video/public/assets/models/bad')), false, 'failed preflight does not leave a staged bundle');
}));

const hasFfmpeg = await exec('ffmpeg', ['-version']).then(() => true, () => false);
test('motion checks every actually rendered video frame, timing, intentional holds and loop boundary with compact receipts', { skip: !hasFfmpeg, timeout: 120000 }, async () => temporary(async dir => {
  const file = path.join(dir, 'moving.mp4');
  await exec('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=128x96:rate=10', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', file]);
  const result = await videoMotion({ path: file, duration: 2, expectedFps: 10, loop: true }, dir);
  assert.equal(result.frames, 20); assert.equal(result.proxyBytes, 20 * 4096); assert.equal(result.blocking, 0); assert.equal(result.timing.estimatedFps, 10); assert.ok(result.pixelChange.medianMeanDelta > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 5000, '20 decoded frames produce a sub-5KB receipt');
  const wrongClock = await videoMotion({ path: file, expectedFps: 30 }, dir); assert.ok(wrongClock.findings.some(f => f.id === 'frame-rate' && f.severity === 'FAIL'));
  const still = path.join(dir, 'still.mp4'); await exec('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=blue:duration=1:size=128x96:rate=10', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', still]);
  const held = await videoMotion({ path: still, duration: 1 }, dir); assert.equal(held.pixelChange.duplicateFrames, 9); assert.equal(held.blocking, 0); assert.ok(held.pixelChange.holds.length);
  await assert.rejects(videoMotion({ path: file, duration: 31 }, dir), /duration/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(videoMotion({ path: file }, dir, controller.signal));
}));

test('timestamp and loop evidence distinguish a bad boundary from normal adjacent motion', () => {
  const pixels = Buffer.concat([Buffer.alloc(4096, 0), Buffer.alloc(4096, 1), Buffer.alloc(4096, 2), Buffer.alloc(4096, 100)]);
  const result = analyzeDecodedMotion([0, .1, .2, .6], pixels, { loop: true, expectedFps: 10 });
  assert.equal(result.timing.irregularIntervals, 1); assert.ok(result.findings.some(f => f.id === 'loop-boundary')); assert.equal(result.blocking, 1);
  assert.throws(() => analyzeDecodedMotion([0, .1], Buffer.alloc(1)), /matching/);
});

test('actual CSS frames verify reduced-motion changes and known-period endpoint parity', { timeout: 120000 }, async t => temporary(async dir => {
  const { renderCapture } = await load('scripts/render-capture.mjs');
  const capture = (p, dest, cwd, signal) => renderCapture({ ...p, source: path.resolve(cwd, p.source), output: 'image' }, dest, signal);
  const source = path.join(dir, 'motion.html');
  const html = reduce => `<!doctype html><style>body{margin:0;background:#000}.orb{width:70px;height:70px;background:#fff;animation:move 1s infinite linear}@keyframes move{from{transform:translateX(0)}to{transform:translateX(100px)}}${reduce ? '@media(prefers-reduced-motion:reduce){.orb{animation:none;transform:translateX(50px)}}' : ''}</style><div class="orb"></div>`;
  await fs.writeFile(source, html(false));
  let moving;
  try { moving = await motionInspectRun({ source, width: 200, height: 200, durationMs: 600, samples: 2 }, dir, undefined, capture); }
  catch (error) { if (process.env.PI_REQUIRE_MEDIA_TEST !== '1' && /Executable doesn't exist|distribution.*not found|not installed/i.test(error.message)) { t.skip('Browser unavailable'); return; } throw error; }
  assert.ok(moving.reducedPixels.meanDelta > .4); assert.ok(moving.findings.some(f => f.id === 'reduced-motion-moving-loop' && f.severity === 'FAIL'));
  assert.equal(moving.loopBoundary.periodMs, 1000, 'endpoint check uses the actual period, not requested duration 600ms');
  assert.ok(!moving.findings.some(f => f.id === 'loop-seam'));
  await fs.writeFile(source, html(true));
  const calm = await motionInspectRun({ source, width: 200, height: 200, durationMs: 600, samples: 2 }, dir, undefined, capture);
  assert.equal(calm.reducedPixels.meanDelta, 0); assert.equal(calm.blocking, 0); assert.equal(calm.reducedPass, 'checked');
  assert.ok(Buffer.byteLength(JSON.stringify(calm)) < 7000, 'rendered motion report stays below 7KB');
  await fs.writeFile(source, html(false).replace('</style>', '@media(prefers-reduced-motion:reduce){.orb{animation-play-state:paused}}</style>'));
  const paused = await motionInspectRun({ source, width: 200, height: 200, durationMs: 600, samples: 2 }, dir, undefined, capture);
  assert.equal(paused.blocking, 0, 'forced seek movement does not turn an actually paused alternative into a failure');
}));


test('actual VFR timestamps remain visible and high-frame windows fail at the work bound', { skip: !hasFfmpeg, timeout: 120000 }, async () => temporary(async dir => {
  const variable = path.join(dir, 'variable.mp4');
  await exec('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=10', '-vf', 'setpts=if(lt(N\\,10)\\,N\\,2*N-10)/(10*TB)', '-fps_mode', 'vfr', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', variable]);
  const report = await videoMotion({ path: variable, duration: 3, expectedFps: 10 }, dir);
  assert.equal(report.frames, 20); assert.ok(report.timing.irregularIntervals >= 8); assert.ok(report.timing.largestGaps[0].seconds >= .19);
  const fast = path.join(dir, 'fast.mp4');
  await exec('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=red:duration=16:size=64x64:rate=120', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', fast]);
  await assert.rejects(videoMotion({ path: fast, duration: 16 }, dir), /exceeds 1800 frames/);
}));

test('glTF JSON/file budgets and compressed-loader limits are explicit', async () => temporary(async dir => {
  const file = path.join(dir, 'oversized.gltf'); await fs.writeFile(file, ' '.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(inspectGltf(file), /at most 2 MiB/);
  const { document, bytes } = fixture(); document.extensionsRequired = ['KHR_draco_mesh_compression'];
  document.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } };
  delete document.accessors[0].bufferView;
  const compressed = await put(dir, document, bytes); const report = await inspectGltf(compressed);
  assert.equal(report.boundsComplete, false); assert.equal(report.meshLocalBounds.length, 0); assert.ok(report.warnings.some(s => s.includes('plain GLTFLoader')));
}));


test('model deduplication includes resource fingerprints rather than only the glTF JSON', async () => temporary(async dir => {
  const file = await put(dir); const first = await registerAsset({ path: file }, dir);
  const bytes = fixture().bytes; bytes.writeFloatLE(4, 12); await fs.writeFile(path.join(dir, 'geometry.bin'), bytes);
  const changed = await registerAsset({ path: file }, dir); assert.equal(changed.duplicateOf, null); assert.notEqual(changed.record.hash, first.record.hash);
  assert.equal((await readRegistry(dir)).assets.length, 2);
}));


test('authored GLB fixture loads through the existing Three.js GLTFLoader and produces real WebGL geometry pixels', { timeout: 60000 }, async t => temporary(async dir => {
  const require = createRequire(path.join(agent, 'npm/package.json'));
  const { chromium } = require('playwright'), build = path.dirname(require.resolve('three'));
  const { document, bytes } = fixture(), binary = glb(document, bytes);
  const file = path.join(dir, 'render.glb'); await fs.writeFile(file, binary); const preflight = await inspectGltf(file);
  const modules = new Map([
    ['/three.module.js', await fs.readFile(path.join(build, 'three.module.js'))],
    ['/three.core.js', await fs.readFile(path.join(build, 'three.core.js'))],
    ['/loaders/GLTFLoader.js', await fs.readFile(path.join(build, '../examples/jsm/loaders/GLTFLoader.js'))],
    ['/utils/BufferGeometryUtils.js', await fs.readFile(path.join(build, '../examples/jsm/utils/BufferGeometryUtils.js'))],
    ['/model.glb', binary],
  ]);
  const html = `<!doctype html><body style="margin:0"><script type="importmap">{"imports":{"three":"/three.module.js"}}</script><script type="module">
    import * as THREE from 'three'; import {GLTFLoader} from '/loaders/GLTFLoader.js';
    new GLTFLoader().load('/model.glb', gltf => {
      const renderer = new THREE.WebGLRenderer({preserveDrawingBuffer:true}); renderer.setSize(160,96); renderer.outputColorSpace=THREE.SRGBColorSpace; document.body.append(renderer.domElement);
      const scene=new THREE.Scene(); scene.background=new THREE.Color('#101010'); scene.add(gltf.scene);
      gltf.scene.traverse(o => {if(o.isMesh) o.material=new THREE.MeshBasicMaterial({color:'#ff7733',side:THREE.DoubleSide});});
      const camera=new THREE.PerspectiveCamera(45,160/96,.1,100); camera.position.set(1,1.5,6); camera.lookAt(1,1.5,0); renderer.render(scene,camera);
      const gl=renderer.getContext(), pixels=new Uint8Array(160*96*4); gl.readPixels(0,0,160,96,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      let visible=0; for(let i=0;i<pixels.length;i+=4) if(pixels[i]>200&&pixels[i+1]>40&&pixels[i+1]<170&&pixels[i+2]<100) visible++;
      window.evidence={triangles:renderer.info.render.triangles,calls:renderer.info.render.calls,visiblePixels:visible};
    },undefined,error => {window.failure=String(error);});
  </script>`;
  let browser;
  try {
    try { browser = await chromium.launch({ channel: process.env.PI_RENDER_BROWSER_CHANNEL ?? 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=swiftshader'] }); }
    catch (error) { if (process.env.PI_REQUIRE_MEDIA_TEST !== '1' && /Executable doesn't exist|distribution.*not found|not installed/i.test(error.message)) { t.skip('Browser unavailable'); return; } throw error; }
    const context = await browser.newContext({ viewport: { width: 160, height: 96 }, serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.hostname !== 'fixture.invalid') return route.abort(); if (url.pathname === '/') return route.fulfill({status:200,contentType:'text/html',body:html}); const body=modules.get(url.pathname); return body ? route.fulfill({status:200,contentType:url.pathname.endsWith('.glb')?'model/gltf-binary':'text/javascript',body}) : route.abort(); });
    const page=await context.newPage(); await page.goto('http://fixture.invalid/'); await page.waitForFunction(() => window.evidence || window.failure);
    assert.equal(await page.evaluate(() => window.failure), undefined);
    const rendered=await page.evaluate(() => window.evidence); assert.equal(rendered.triangles, preflight.counts.triangles); assert.equal(rendered.calls, 1); assert.ok(rendered.visiblePixels>100, 'glTF geometry paints actual framebuffer pixels');
    const poster=await page.locator('canvas').screenshot(); assert.equal(poster.readUInt32BE(16),160); assert.equal(poster.readUInt32BE(20),96);
  } finally { await browser?.close(); }
}));

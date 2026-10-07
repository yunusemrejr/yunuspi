// Inert authored fixtures and mocked provider bytes; no paid generation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => existsSync(path.join(dir, 'extensions/lib/svg-render.ts')));
const load = file => import(pathToFileURL(path.join(agent, 'extensions/lib', file)));
const { prepareSvgSource, svgRender, svgDiagnosticCollector } = await load('svg-render.ts');
const { imageGenerateRun, imageEditRun } = await load('image-generate.ts');
const { encodeImage, decodeImage } = await load('design-studio.ts');
const { mediaPipeline } = await load('media-pipeline.ts');
const { run } = await load('media-process.ts');
const workspace = async t => { const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'media-creative-reliability-')); t.after(() => fs.rm(cwd, { recursive: true, force: true })); return cwd; };
const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path id="shape" fill="#2255aa" d="M8 8L32 8L32 32Z"/></svg>';
const score = { bpm: 120, beats: 2, tracks: [{ notes: [{ pitch: 57, start: 0, duration: 2 }] }] };
const env = { PI_IMAGE_BACKEND: 'openai-compatible', PI_IMAGE_API_URL: 'https://fixture.invalid/v1', PI_IMAGE_API_KEY: 'TEST_fixture_only', PI_IMAGE_MODEL: 'fixture/image' };
const picture = () => encodeImage({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(255) }, 'png');

test('SVG diagnostics preserve late distinct findings without repeating every frame', () => {
  const collector = svgDiagnosticCollector();
  const diagnostic = { cssAnimations: 0, smilAnimations: 0, programmaticTracks: 1, ownerCollisions: [], clippingApproximate: true };
  for (let frame = 0; frame < 300; frame++) collector.add(frame, { ...diagnostic, time: frame / 30, clipped: ['first'] });
  collector.add(300, { ...diagnostic, time: 10, clipped: ['late'] });
  const result = collector.result();
  assert.equal(result.diagnostics.length, 2); assert.equal(result.diagnosticsTruncated, false);
  assert.equal(result.diagnostics[0].observations, 300); assert.equal(result.diagnostics[0].lastFrame, 299);
  assert.deepEqual(result.diagnostics[1].clipped, ['late']);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1000, 'repeated diagnostics keep a compact response');
  const bounded = svgDiagnosticCollector(1); bounded.add(0, { ...diagnostic, time: 0, clipped: [] }); bounded.add(1, { ...diagnostic, time: 1, clipped: ['late'] });
  assert.equal(bounded.result().diagnosticsTruncated, true); assert.equal(bounded.result().omittedDiagnosticObservations, 1);
});

test('SVG XML and namespace errors fail preflight before pipeline synthesis allocates outputs', async t => {
  const cwd = await workspace(t);
  const invalid = [
    source.replace('<path', '<text>R&D</text><path'),
    source.replace('http://www.w3.org/2000/svg', 'urn:wrong'),
    source.replace('<path', '<g xmlns="urn:wrong"/><path'),
    source.replace('<path', '<prefix:rect/><path'),
    source.replace('<path', '<text>&undefined;</text><path'),
  ];
  for (const svg of invalid) {
    await assert.rejects(prepareSvgSource({ svg }, cwd), /XML|namespace/i);
    await fs.writeFile(path.join(cwd, 'scene.svg'), svg);
    await assert.rejects(mediaPipeline({ animation: 'scene.svg', score }, cwd), /XML|namespace/i);
    assert.deepEqual(await fs.readdir(cwd), ['scene.svg']);
  }
  await prepareSvgSource({ svg: source.replace('<path', '<text>A &amp; B</text><path') }, cwd);
  await prepareSvgSource({ svg: source.replace('<path', '<style><![CDATA[path{fill:#336699}]]></style><path') }, cwd);
});

test('SVG tracks reject ignored transforms, malformed paths and multiple animation owners', async t => {
  const cwd = await workspace(t);
  const track = (property, first, last) => ({ target: 'shape', property, keys: [{ time: 0, value: first }, { time: 1, value: last }] });
  for (const [property, first, last, error] of [
    ['transform', 'spin(0)', 'spin(90)', /affine/],
    ['transform', 'matrix(1 0 0 1 0)', 'matrix(1 0 0 1 2)', /affine/],
    ['transform', ',translate(1)', ',translate(2)', /affine/],
    ['transform', 'translate(1),', 'translate(2),', /affine/],
    ['transform', 'translate(1),,rotate(2)', 'translate(2),,rotate(3)', /affine/],
    ['d', 'M0 0C2 2', 'M1 1C3 3', /valid path/],
    ['d', 'L0 0L2 2', 'L1 1L3 3', /moveto/],
    ['d', 'M8 8L56,,56', 'M8 8L48,,48', /valid path/],
    ['d', 'M8 8L,56 56', 'M8 8L,48 48', /valid path/],
    ['d', 'M8 8L56 56,', 'M8 8L48 48,', /valid path/],
  ]) await assert.rejects(prepareSvgSource({ svg: source, tracks: [track(property, first, last)] }, cwd), error);
  for (const svg of [
    source.replace('/></svg>', '><animate attributeName="transform" from="translate(0)" to="translate(1)" dur="1s"/></path></svg>'),
    source.replace('</svg>', '<animate href="#shape" attributeName="transform" from="translate(0)" to="translate(1)" dur="1s"/></svg>'),
    source.replace('/></svg>', '><animateMotion path="M0 0L2 2" dur="1s"/></path></svg>'),
  ]) await assert.rejects(prepareSvgSource({ svg, tracks: [track('transform', 'translate(0)', 'translate(1)')] }, cwd), /owner collision/);
  await prepareSvgSource({ svg: source, tracks: [track('transform', 'translate(0 0) rotate(0)', 'translate(10 2) rotate(90)')] }, cwd);
  await prepareSvgSource({ svg: source, tracks: [track('d', 'M0 0C0 4 4 4 4 0Z', 'M2 0C2 4 6 4 6 0Z')] }, cwd);
});

test('received image bytes survive cancellation after provider completion with usage and recovery', async t => {
  const cwd = await workspace(t), bytes = await picture(), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ data: [{ b64_json: bytes.toString('base64') }], usage: { input_tokens: 10, output_tokens: 4, cost: .01 } }); };
  for (const mode of ['generate', 'edit']) {
    const controller = new AbortController(), statuses = [];
    const runtime = { onUsage: (_usage, status) => { statuses.push(status); if (status === 'completed') controller.abort(new Error('Fixture cancelled after response')); } };
    await fs.writeFile(path.join(cwd, 'reference.png'), bytes);
    const operation = mode === 'generate'
      ? imageGenerateRun({ prompt: 'Authored fixture' }, cwd, controller.signal, undefined, env, runtime)
      : imageEditRun({ path: 'reference.png', prompt: 'Authored fixture edit' }, cwd, controller.signal, undefined, env, runtime);
    await assert.rejects(operation, /Decoded image retained.*do not repeat generation/s);
    assert.deepEqual(statuses, ['pending', 'completed'], 'provider completed even though local completion was interrupted');
  }
  assert.equal(calls, 2, 'one request per explicitly requested take');
  const dirs = (await fs.readdir(path.join(cwd, '.pi/assets'))).filter(name => name.startsWith('gen-'));
  assert.equal(dirs.length, 2);
  for (const dir of dirs) {
    const recovery = JSON.parse(await fs.readFile(path.join(cwd, '.pi/assets', dir, 'recovery.json')));
    assert.equal(recovery.decodeVerified, true); assert.equal(recovery.registration, 'unverified');
    assert.equal(recovery.usage.cost.total, .01);
    assert.deepEqual(await fs.readFile(path.join(cwd, recovery.file)), bytes);
    assert.doesNotMatch(JSON.stringify(recovery), /TEST_fixture_only/);
  }
});

test('corrupt generated bytes retain an honest decode-unverified recovery receipt', async t => {
  const cwd = await workspace(t), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  globalThis.fetch = async () => Response.json({ data: [{ b64_json: bytes.toString('base64') }] });
  await assert.rejects(imageGenerateRun({ prompt: 'Authored fixture' }, cwd, undefined, undefined, env), /Generated bytes retained/);
  const dir = (await fs.readdir(path.join(cwd, '.pi/assets'))).find(name => name.startsWith('gen-'));
  const recovery = JSON.parse(await fs.readFile(path.join(cwd, '.pi/assets', dir, 'recovery.json')));
  assert.equal(recovery.decodeVerified, false);
  assert.deepEqual(await fs.readFile(path.join(cwd, recovery.file)), bytes);
  assert.equal(existsSync(path.join(cwd, '.pi/assets/registry.json')), false);
});

test('invalid edit masks never silently submit an unmasked paid edit', async t => {
  const cwd = await workspace(t), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  await fs.writeFile(path.join(cwd, 'reference.png'), await picture());
  let calls = 0; globalThis.fetch = async () => { calls++; throw Error('Must not submit'); };
  for (const mask of [null, false, 0, '', ' ']) await assert.rejects(imageEditRun({ path: 'reference.png', mask, prompt: 'Change masked region' }, cwd, undefined, undefined, env), /mask must/);
  assert.equal(calls, 0);
});

test('media child abort waits for process closure before caller cleanup', { timeout: 10_000 }, async t => {
  const cwd = await workspace(t), pidFile = path.join(cwd, 'pid'), controller = new AbortController();
  const program = 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);';
  const pending = run(process.execPath, ['-e', program, pidFile], controller.signal);
  const observed = new Promise((resolve, reject) => {
    const watcher = watch(cwd, async (_event, name) => {
      if (name !== 'pid') return;
      try { const pid = Number(await fs.readFile(pidFile, 'utf8')); if (pid > 0) { watcher.close(); resolve(pid); } }
      catch (error) { watcher.close(); reject(error); }
    });
    t.after(() => watcher.close());
  });
  const pid = await observed; controller.abort();
  await assert.rejects(pending, /cancel/i);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'child is reaped before media cleanup begins');
  const success = await run(process.execPath, ['-e', 'process.stdout.write("ok"); process.stderr.write("note")']);
  assert.deepEqual(success, { stdout: 'ok', stderr: 'note' });
  await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("fixture failure"); process.exit(2)']), /fixture failure/);
});

test('a concurrent source edit cannot change the preflighted animation/audio clock', { timeout: 120_000 }, async t => {
  const cwd = await workspace(t), file = path.join(cwd, 'scene.json');
  const scene = { width: 160, height: 96, duration: 1, fps: 6, objects: [{ id: 'box', geometry: 'box' }], tracks: [{ target: 'box', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 1.5, 0] }] }] };
  await fs.writeFile(file, JSON.stringify(scene));
  let mutation, changed = false;
  const watcher = watch(cwd, (_event, name) => { if (!changed && name?.startsWith('media-')) { changed = true; mutation = fs.writeFile(file, JSON.stringify({ ...scene, duration: 2 })); } });
  t.after(() => watcher.close());
  let result;
  try { result = await mediaPipeline({ animation: file, score }, cwd); }
  catch (error) { if (process.env.PI_REQUIRE_MEDIA_TEST !== '1' && /Executable doesn't exist|browser.*not found|not installed|distribution.*not found/i.test(error.message)) { t.skip(error.message); return; } throw error; }
  await mutation;
  assert.equal(changed, true); assert.equal(JSON.parse(await fs.readFile(file)).duration, 2);
  assert.equal(result.duration, 1); assert.equal(result.decodeVerified, true);
  assert.equal(JSON.parse(await fs.readFile(result.visual.snapshot)).duration, 1);
  assert.equal(result.visual.source, file); assert.match(result.visual.sourceHash, /^[a-f0-9]{64}$/);
  assert.ok(result.visual.motion); assert.equal(result.samples.length, 3);
});

test('SVG pipelines retain review evidence and reject CSS/data-track owner collisions', { timeout: 120_000 }, async t => {
  const cwd = await workspace(t), file = path.join(cwd, 'scene.svg'); await fs.writeFile(file, source);
  let result;
  try { result = await mediaPipeline({ animation: file, duration: 1, width: 64, height: 64, fps: 6, animationTracks: [{ target: 'shape', property: 'transform', keys: [{ time: 0, value: 'translate(0)' }, { time: 1, value: 'translate(24)' }] }] }, cwd); }
  catch (error) { if (process.env.PI_REQUIRE_MEDIA_TEST !== '1' && /Executable doesn't exist|browser.*not found|not installed|distribution.*not found/i.test(error.message)) { t.skip(error.message); return; } throw error; }
  assert.ok(result.visual.contactSheet.bytes > 0); assert.ok(result.visual.diagnostics.length > 0); assert.ok(result.visual.motion);
  const first = await decodeImage(await fs.readFile(result.samples[0].path)), last = await decodeImage(await fs.readFile(result.samples.at(-1).path));
  assert.notDeepEqual(first.data, last.data, 'valid transforms change actual rendered pixels');
  const collision = source.replace('<path', '<style>@keyframes width{from{stroke-width:1}to{stroke-width:4}}#shape{stroke:#ff0000;animation:width 1s linear forwards}</style><path');
  await assert.rejects(svgRender({ svg: collision, width: 64, height: 64, duration: 1, tracks: [{ target: 'shape', property: 'stroke-width', keys: [{ time: 0, value: 1 }, { time: 1, value: 4 }] }] }, cwd), /owner collision/);
});

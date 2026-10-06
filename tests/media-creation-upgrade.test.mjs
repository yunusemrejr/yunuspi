// Authored local fixtures and mocked provider responses; no downloaded media.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => syncFs.existsSync(path.join(p, 'extensions/lib/svg-render.ts')));
const load = p => import(pathToFileURL(path.join(agent, p)).href);
const design = await load('extensions/lib/design-studio.ts');
const image = await load('extensions/lib/image-generate.ts');
const convert = await load('extensions/lib/image-convert.ts');
const vision = await load('extensions/lib/image-understand.ts');
const svg = await load('extensions/lib/svg-render.ts');
const blender = await load('extensions/lib/blender-studio.ts');
const video = await load('extensions/lib/video-studio.ts');
const pipeline = await load('extensions/lib/media-pipeline.ts');
const workspace = async t => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-creation-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };
const picture = async (width = 16, height = 8, alpha = 255, color = [240, 20, 20]) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...color, alpha], i * 4);
  return design.encodeImage({ width, height, data }, 'png');
};
const env = { PI_IMAGE_BACKEND: 'openai-compatible', PI_IMAGE_API_URL: 'https://fixture.invalid/v1', PI_IMAGE_API_KEY: 'TEST_media_fixture_only', PI_IMAGE_MODEL: 'gpt-image-1.5' };
const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle id="ball" cx="8" cy="20" r="4" fill="#ff0000"><animate attributeName="cx" from="8" to="56" dur="1s" fill="freeze"/></circle><rect id="box" x="4" y="40" width="8" height="8" fill="#0000ff"/></svg>';
const tracks = [{ target: 'box', property: 'x', keys: [{ time: 0, value: 4 }, { time: 1, value: 52 }] }];

test('GPT Image requests keep exact models and reject unsupported or contradictory settings', () => {
  const brief = image.buildGenerationBrief(undefined, { prompt: 'Authored test plate' });
  const request = image.buildImageRequest(brief, { model: 'gpt-image-1.5', transparent: true, format: 'webp', compression: 80, inputFidelity: 'high' });
  assert.equal(Object.hasOwn(request, 'response_format'), false);
  assert.equal(request.output_format, 'webp'); assert.equal(request.output_compression, 80);
  assert.throws(() => image.buildImageRequest(brief, { model: 'gpt-image-1.5', seed: 1 }), /does not support seed/);
  assert.throws(() => image.buildImageRequest(brief, { model: 'gpt-image-2', inputFidelity: 'high' }), /does not accept/);
  assert.throws(() => image.buildImageRequest(brief, { model: 'gpt-image-1-mini', inputFidelity: 'high' }), /only low/);
  assert.throws(() => image.buildImageRequest(brief, { model: 'gpt-image-1.5', transparent: true, format: 'jpeg' }), /Transparent output/);
  assert.throws(() => image.buildImageRequest(brief, { model: 'other', compression: 80 }), /requires format/);
  assert.equal(image.imageBackendEnvironment(env, false, 'gpt-image-2').PI_IMAGE_MODEL, 'gpt-image-2');
  assert.throws(() => image.imageBackendEnvironment(env, false, ''), /nonempty exact/);
  assert.deepEqual(image.routerImageOptions({ size: '1024x1024', response_format: 'b64_json' }, { aspectRatio: '16:9', resolution: '2K' }, true), { aspect_ratio: '16:9', resolution: '2K' });
  assert.throws(() => image.routerImageOptions({}, { aspectRatio: '16:9', size: '1024x1024' }, true), /conflicting/);
  const billed = image.imageUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 }, cost: .05296 });
  assert.equal(billed.input, 80); assert.equal(billed.cacheRead, 20); assert.equal(billed.cacheReadReported, true);
  assert.equal(billed.cost.total, .05296); assert.equal(billed.cost.source, 'provider-reported');
  assert.equal(image.imageUsage({ input_tokens: 12, output_tokens: 8 }).cost, undefined);
});

test('native Images API discovery, references and failure accounting work without paid retries', async t => {
  const cwd = await workspace(t), original = globalThis.fetch, bytes = await picture();
  t.after(() => { globalThis.fetch = original; });
  await fs.writeFile(path.join(cwd, 'ref.png'), bytes);
  const requests = [], usage = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : undefined });
    return Response.json(String(url).endsWith('/images/models') ? { data: [{ id: 'fixture/capable-image', supported_parameters: ['input_references'] }] } : { data: [{ b64_json: bytes.toString('base64') }], usage: { total_tokens: 7 } });
  };
  const router = { ...env, PI_IMAGE_BACKEND: 'openrouter', PI_IMAGE_MODEL: 'fixture/default' };
  const status = await image.imageBackendStatus(router, false, { refresh: true });
  assert.equal(status.availableModels[0].id, 'fixture/capable-image');
  const result = await image.imageEditRun({ references: ['ref.png', 'ref.png'], transport: 'images', model: 'fixture/capable-image', prompt: 'Keep the two subjects' }, cwd, undefined, undefined, router, { onUsage: (u, s) => usage.push({ u, s }) });
  assert.equal(requests[1].body.model, 'fixture/capable-image');
  assert.equal(requests[1].body.input_references.length, 2);
  assert.match(requests[1].body.input_references[0].image_url.url, /^data:image\/png;base64,/);
  assert.equal(Object.hasOwn(requests[1].body, 'response_format'), false);
  assert.equal(result.decodeVerified, true);
  assert.deepEqual(usage.map(u => u.s), ['pending', 'completed']);
  globalThis.fetch = async () => Response.json({ error: 'Fixture failure' }, { status: 503 });
  await assert.rejects(image.imageGenerateRun({ prompt: 'Test' }, cwd, undefined, undefined, env, { onUsage: (u, s) => usage.push({ u, s }) }), /503/);
  assert.deepEqual(usage.slice(-2).map(u => u.s), ['pending', 'failed']);
  assert.equal(usage.at(-1).u, undefined);
});

test('masked edits validate alpha and dimensions before upload; GPT multipart excludes response_format', async t => {
  const cwd = await workspace(t), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  await fs.writeFile(path.join(cwd, 'ref.png'), await picture());
  await fs.writeFile(path.join(cwd, 'opaque.png'), await picture());
  await fs.writeFile(path.join(cwd, 'wrong.png'), await picture(8, 8, 0));
  let calls = 0;
  globalThis.fetch = async (_, options) => {
    calls++; assert.equal(options.body.has('response_format'), false);
    assert.equal(options.body.getAll('image[]').length, 2);
    assert.equal(options.body.get('input_fidelity'), 'high');
    return Response.json({ data: [{ b64_json: (await picture()).toString('base64') }] });
  };
  const params = { path: 'ref.png', prompt: 'Change just the masked region' };
  await assert.rejects(image.imageEditRun({ ...params, mask: 'opaque.png' }, cwd, undefined, undefined, env), /no fully transparent/);
  await assert.rejects(image.imageEditRun({ ...params, mask: 'wrong.png' }, cwd, undefined, undefined, env), /dimensions must match/);
  assert.equal(calls, 0); assert.equal(syncFs.existsSync(path.join(cwd, '.pi')), false);
  await fs.writeFile(path.join(cwd, 'mask.png'), await picture(16, 8, 0));
  await image.imageEditRun({ references: ['ref.png', 'ref.png'], mask: 'mask.png', inputFidelity: 'high', prompt: 'Keep identity' }, cwd, undefined, undefined, env);
  assert.equal(calls, 1);
});

test('conversion preserves originals, transparent framing, rotation and explicit JPEG matte', async t => {
  const cwd = await workspace(t), bytes = await picture(16, 8, 128);
  await fs.writeFile(path.join(cwd, 'ref.png'), bytes);
  const result = await convert.imageConvert({ path: 'ref.png', width: 16, height: 16 }, cwd);
  const decoded = await design.decodeImage(await fs.readFile(result.files[0].path));
  assert.equal(decoded.data[3], 0, 'contain padding preserves alpha');
  assert.equal(decoded.data[(8 * 16 + 8) * 4 + 3], 128);
  const jpeg = await convert.imageConvert({ path: 'ref.png', format: 'jpg', rotate: 90, background: '#000000' }, cwd);
  assert.equal(jpeg.files[0].width, 8); assert.equal(jpeg.files[0].height, 16); assert.equal(jpeg.files[0].alpha, false);
  const rgb = await design.decodeImage(await fs.readFile(jpeg.files[0].path));
  assert.ok(rgb.data[0] > 105 && rgb.data[0] < 135); assert.equal(rgb.data[3], 255);
  assert.deepEqual(await fs.readFile(path.join(cwd, 'ref.png')), bytes);
  const stretched = await convert.imageConvert({ path: 'ref.png', width: 8, height: 16, fit: 'stretch' }, cwd);
  assert.equal(stretched.files[0].width, 8); assert.equal(stretched.files[0].height, 16);
});

test('conversion preflights whole batches and distinguishes chunk metadata from compressed pixel strings', async t => {
  const cwd = await workspace(t); await fs.writeFile(path.join(cwd, 'ref.png'), await picture());
  await assert.rejects(convert.imageConvert({ paths: ['ref.png', 'missing.png'] }, cwd));
  assert.equal(syncFs.existsSync(path.join(cwd, '.pi')), false);
  assert.throws(() => convert.conversionPlan({ width: 4096, height: 4096 }, { width: 1, height: 1 }), /16M/);
  const png = Buffer.alloc(28); png.writeUInt32BE(8, 8); png.write('IDAT', 12); png.write('acTL', 16);
  assert.equal(convert.animatedRaster(png, 'png'), false);
  png.write('acTL', 12); assert.equal(convert.animatedRaster(png, 'png'), true);
  const pixels = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) };
  assert.deepEqual([...convert.orientPixels(pixels, 90).data], [...pixels.data]);
  assert.deepEqual([...convert.orientPixels(pixels, 0, true).data].slice(0, 4), [0, 0, 255, 255]);
});

test('EXIF orientation cannot change crop axes or reported attachment dimensions', async t => {
  const cwd = await workspace(t);
  const data = new Uint8Array(16 * 8 * 4).fill(255), jpeg = await design.encodeImage({ width: 16, height: 8, data }, 'jpg');
  const exif = Buffer.alloc(32); exif.write('Exif', 0); exif.write('II', 6); exif.writeUInt16LE(42, 8); exif.writeUInt32LE(8, 10); exif.writeUInt16LE(1, 14); exif.writeUInt16LE(0x0112, 16); exif.writeUInt16LE(3, 18); exif.writeUInt32LE(1, 20); exif.writeUInt16LE(6, 24);
  const marker = Buffer.from([255, 225, 0, 34]), bytes = Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)]);
  await fs.writeFile(path.join(cwd, 'oriented.jpg'), bytes);
  const decoded = await design.decodeImage(bytes);
  assert.equal(decoded.width, 16); assert.equal(decoded.height, 8);
  const attachments = await vision.prepareVisionImages({ path: 'oriented.jpg', region: { x: 8, y: 0, width: 8, height: 8 } }, cwd);
  assert.equal(attachments[0].source.original.width, 16); assert.equal(attachments[0].source.sent.width, 8);
});

test('vision uses current provider registry, thinking and real cropped attachments without session switching', async t => {
  const cwd = await workspace(t); await fs.writeFile(path.join(cwd, 'ref.png'), await picture());
  const model = { provider: 'fixture', id: 'vision', input: ['text', 'image'], maxTokens: 4096 };
  const usage = [], calls = [];
  const ctx = { model, thinkingLevel: 'high', modelRegistry: { completeSimple: async (...args) => { calls.push(args); return { stopReason: 'stop', content: [{ type: 'text', text: 'Visible red rectangle.' }], usage: { totalTokens: 12 } }; } } };
  const result = await vision.imageUnderstand({ path: 'ref.png', prompt: 'Describe visible evidence', region: { x: 4, y: 0, width: 8, height: 8 } }, cwd, undefined, ctx, { onUsage: (_, s) => usage.push(s) });
  assert.equal(calls[0][0], model); assert.equal(calls[0][2].reasoning, 'high'); assert.equal(ctx.model, model);
  const attachment = calls[0][1].messages[0].content.find(c => c.type === 'image');
  const pixels = await design.decodeImage(Buffer.from(attachment.data, 'base64'));
  assert.equal(pixels.sourceWidth, 8); assert.equal(result.images[0].original.width, 16);
  assert.deepEqual(usage, ['pending', 'completed']);
  assert.throws(() => vision.visionModel({}, { model: { ...model, input: ['text'] } }), /does not accept images/);
  await assert.rejects(vision.imageUnderstand({ path: 'ref.png', prompt: 'Describe', region: { x: -1, y: 0, width: 8, height: 8 } }, cwd, undefined, ctx), /inside the source/);
  assert.equal(calls.length, 1);
});

test('SVG tracks validate topology, ownership, timing, alpha delivery and safe source before export', async t => {
  const cwd = await workspace(t);
  assert.equal(svg.sampleSvgValue([{ time: 0, value: '#000000' }, { time: 1, value: '#ffffff' }], .5), '#808080');
  assert.equal(svg.sampleSvgValue([{ time: 0, value: 'translate(0 0)', ease: 'hold' }, { time: 1, value: 'translate(20 4)' }], .5), 'translate(0 0)');
  await assert.rejects(svg.prepareSvgSource({ svg: source, tracks: [{ ...tracks[0], target: 'missing' }] }, cwd), /existing element id/);
  await assert.rejects(svg.prepareSvgSource({ svg: source, tracks: [{ target: 'box', property: 'd', keys: [{ time: 0, value: 'M0 0L4 4' }, { time: 1, value: 'M0 0C1 1 4 4 5 5' }] }] }, cwd), /topology/);
  await assert.rejects(svg.prepareSvgSource({ svg: source, tracks: [{ ...tracks[0], property: 'width', keys: [{ time: 0, value: -1 }, { time: 1, value: 1 }] }] }, cwd), /negative/);
  await assert.rejects(svg.svgRender({ svg: source.replace('<circle', '<script>bad()</script><circle') }, cwd), /preflight/);
  assert.throws(() => svg.planSvgRender({ mode: 'video', background: 'transparent' }), /no alpha/);
  assert.equal(syncFs.existsSync(path.join(cwd, '.pi')), false);
});

test('real SVG frames synchronize CSS, SMIL and data tracks; export encodes a verified timeline', { timeout: 90000 }, async t => {
  const cwd = await workspace(t);
  const cssSource = source.replace('<circle', '<style>@keyframes dim{from{opacity:1}to{opacity:.25}}#box{animation:dim 1s linear forwards}</style><circle');
  let result;
  try { result = await svg.svgRender({ svg: cssSource, tracks, width: 64, height: 64, duration: 1, times: [0, .5, 1] }, cwd); }
  catch (e) { if (process.env.PI_BROWSER_REQUIRE !== '1' && /browser|chromium|chrome|executable|sandbox/i.test(e.message)) { t.skip(e.message); return; } throw e; }
  const a = await design.decodeImage(await fs.readFile(result.samples[0].path)), b = await design.decodeImage(await fs.readFile(result.samples[1].path));
  const red = (img, x) => img.data[(20 * 64 + x) * 4] > 240 && img.data[(20 * 64 + x) * 4 + 1] < 30;
  assert.equal(red(a, 8), true); assert.equal(red(b, 32), true); assert.equal(red(b, 8), false);
  assert.equal(result.diagnostics[0].smilAnimations, 1); assert.equal(result.diagnostics[0].programmaticTracks, 1); assert.ok(result.diagnostics[0].cssAnimations > 0);
  const animation = await svg.svgRender({ svg: source, tracks, width: 64, height: 64, duration: 1, fps: 6, mode: 'video' }, cwd);
  assert.equal(animation.frames, 6); assert.equal(animation.duration, 1); assert.equal(animation.decodeVerified, true); assert.ok(animation.motion);
});

test('nonconsecutive Blender images preserve source timeline and explicit fps retimes samples', async t => {
  const cwd = await workspace(t);
  const files = [];
  for (const [i, frame] of [1, 3, 5].entries()) { const file = path.join(cwd, `original-${frame}.png`); await fs.writeFile(file, await picture(64, 64, 255, [i * 100, 20, 20])); files.push({ frame, path: file }); }
  const output = path.join(cwd, 'encoded'); await fs.mkdir(output);
  const result = await blender.assembleSequence(output, files, { fps: 10, crf: 18, stem: 'frame', video: true });
  assert.equal(result.videoError, undefined); assert.equal(result.decodeVerified, true);
  assert.equal(result.sequence.frames, 5); assert.equal(result.sequence.seconds, .5);
  assert.equal(blender.sequenceTiming(files, 10, true).frames, 3);
  assert.throws(() => blender.frameList({ frames: [1, 1] }, 1), /duplicate/i);
  assert.throws(() => blender.frameList({ from: 1, to: 3, step: 0 }, 1), /step/);
  assert.throws(() => blender.sequenceTiming([...files].reverse(), 10), /increasing/);
  for (const file of files) assert.ok((await fs.stat(file.path)).size > 0);
});

test('Blender layered actions expose keyframe channels and evaluated world motion at fractional fps', { timeout: 90000 }, async t => {
  const binary = blender.blenderBinary(); if (!binary) { t.skip('Blender not installed; local probe runs when available'); return; }
  const cwd = await workspace(t), script = path.join(cwd, 'fixture.py'), blend = path.join(cwd, 'fixture.blend');
  await fs.writeFile(script, `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()\no=bpy.context.object\no.name='MovingCube'\no.location.x=0\no.keyframe_insert(data_path='location',frame=1)\no.location.x=4\no.keyframe_insert(data_path='location',frame=5)\ns=bpy.context.scene\ns.render.fps=30\ns.render.fps_base=1.001\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})\n`);
  await exec(binary, ['--background', '--factory-startup', '--threads', '2', '--python', script], { timeout: 60000, maxBuffer: 1000000 });
  const result = await blender.blenderInspect({ blend, frames: [1, 5] }, cwd);
  const cube = result.objects.find(o => o.name === 'MovingCube');
  assert.equal(cube.animation.curves, 3); assert.equal(cube.animation.keys, 6);
  assert.ok(Math.abs(result.render.fps - 30 / 1.001) < .00001);
  assert.equal(result.animationSamples[0].objects.find(o => o.name === 'MovingCube').worldMatrix[0][3], 0);
  assert.equal(result.animationSamples[1].objects.find(o => o.name === 'MovingCube').worldMatrix[0][3], 4);
});

test('standalone local narration creates captions and combines SVG, voice and music; overruns reject', { timeout: 120000 }, async t => {
  try { video.planNarration({ text: 'We move.' }); } catch (e) { if (/not installed/.test(e.message)) { t.skip(e.message); return; } throw e; }
  const cwd = await workspace(t), speech = await video.narrationSpeak({ text: 'We move.' }, cwd);
  assert.ok(speech.seconds > 0); assert.match(await fs.readFile(speech.captions.srt, 'utf8'), /-->/);
  assert.match(await fs.readFile(speech.captions.vtt, 'utf8'), /^WEBVTT/);
  await fs.writeFile(path.join(cwd, 'scene.svg'), source);
  const result = await pipeline.mediaPipeline({ animation: 'scene.svg', duration: 3, width: 64, height: 64, fps: 6, narration: { text: 'We move.' }, score: { bpm: 120, beats: 2, tracks: [{ notes: [{ pitch: 57, start: 0, duration: 2 }] }] }, targetLufs: -16 }, cwd);
  assert.equal(result.decodeVerified, true); assert.ok(result.narration); assert.ok(result.audio);
  assert.equal(result.ducking.ratio, 6); assert.ok(result.stages.some(s => s.name === 'synthesize_narration'));
  await assert.rejects(pipeline.mediaPipeline({ animation: 'scene.svg', duration: .1, width: 64, height: 64, fps: 6, narration: { text: 'This speech cannot fit in a fraction of a second.' } }, cwd), /exceeds.*timeline/);
});

test('media tools are discovered for concrete tasks and hooks require appropriate evidence', async () => {
  const { selectTaskPipelines, automaticPipelineTools } = await load('extensions/lib/task-pipelines.ts');
  const selected = selectTaskPipelines({ prompt: 'Generate an image and convert it to WebP' });
  assert.ok(selected.ids.includes('image-media'));
  const tools = automaticPipelineTools(selected, { prompt: 'Generate an image and convert it to WebP' });
  assert.ok(tools.includes('image_generate')); assert.ok(tools.includes('image_convert')); assert.equal(tools.includes('project_tests'), false);
  const { matchHook } = await load('extensions/lib/session-hooks.ts');
  assert.match(matchHook('image_convert', {}, false)?.line ?? '', /alpha|crop/);
  assert.match(matchHook('svg_render', {}, false)?.line ?? '', /clock|playback/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => syncFs.existsSync(path.join(dir, 'extensions/media-tools.ts')));
const { sceneCreate, sceneRender } = await import(pathToFileURL(path.join(agent, 'extensions/lib/scene-studio.ts')));
const { validateScene, scenePreset, sampleKeys } = await import(pathToFileURL(path.join(agent, 'scripts/scene-model.mjs')));
const { composeMusic } = await import(pathToFileURL(path.join(agent, 'extensions/lib/music-score.ts')));
const fingerprint = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');

test('scene validation bounds work, rejects executable input and keeps hierarchies/keyframes unambiguous', () => {
  const preset = scenePreset('kinetic');
  assert.ok(preset.objects.length > 10 && preset.tracks.length > 8);
  assert.deepEqual(validateScene(preset), preset);
  for (const style of ['studio', 'clay', 'toon', 'wireframe']) assert.equal(scenePreset('orbital', style).style, style);
  const keys = [{ time: 0, value: [0, 0, 0], ease: 'smooth' }, { time: 2, value: [2, 4, 6] }];
  assert.deepEqual(sampleKeys(keys, 1), [1, 2, 3]);
  assert.deepEqual(sampleKeys(keys, -1), [0, 0, 0]);
  assert.deepEqual(sampleKeys(keys, 3), [2, 4, 6]);
  assert.equal(sampleKeys([{ time: 0, value: 20, ease: 'hold' }, { time: 1, value: 40 }], 0.99), 20);
  for (const change of [
    { script: 'fetch("http://example.invalid")' }, { version: 2 }, { width: 1919 }, { duration: 30, fps: 60 }, { width: 1920, height: 1080, duration: 30 },
    { objects: [{ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }] }, { objects: [{ id: 'a', geometry: 'script' }] },
    { objects: [{ id: 'a', texture: 'file:///private' }] }, { objects: [{ id: 'a', scale: [0, 1, 1] }] },
    { tracks: [{ target: 'missing', keys }] }, { tracks: [{ target: 'hero', keys: [{ time: 1, value: [1, 1, 1] }, { time: 1, value: [2, 2, 2] }] }] },
    { camera: { fov: Infinity } }, { lights: [{ type: 'point', intensity: NaN }] },
  ]) assert.throws(() => validateScene({ ...preset, ...change }));
});

test('scene authoring escapes HTML, preserves editable data and bundles the local licensed renderer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-authoring-'));
  try {
    const scene = scenePreset('sculpture', 'clay'); scene.title = '</script><script>window.compromised=true</script>';
    const result = await sceneCreate({ scene }, dir);
    const html = await fs.readFile(result.preview.path, 'utf8');
    assert.ok(html.includes('data:text/javascript;base64,'));
    assert.ok(html.includes("connect-src 'none'"));
    assert.match(html, /Permission is hereby granted, free of charge/);
    assert.ok(!html.includes(scene.title));
    assert.equal(JSON.parse(await fs.readFile(result.scene.path, 'utf8')).title, scene.title);
    assert.match(await fs.readFile(path.join(path.dirname(result.scene.path), 'THREE-LICENSE.txt'), 'utf8'), /MIT License/);
    assert.equal(result.rendered, false);
    await assert.rejects(sceneCreate({ outputDir: os.tmpdir() }, dir), /inside the current workspace/);
    await assert.rejects(sceneCreate({ scene, preset: 'orbital' }, dir), /not both/);
    const huge = path.join(dir, 'huge.json');
    await fs.writeFile(huge, ' '.repeat(256 * 1024 + 1));
    await assert.rejects(sceneRender({ path: huge }, dir), /256 KiB/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('actual 3D renderer produces deterministic frames, changing geometry pixels and audiovisual MP4', { timeout: 120000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-render-test-'));
  try {
    const scene = scenePreset('sculpture');
    scene.width = 160; scene.height = 96; scene.fps = 6; scene.duration = 1;
    scene.tracks = scene.tracks.map(track => ({ ...track, keys: track.keys.map(key => ({ ...key, time: key.time / 6 })) }));
    const source = await sceneCreate({ scene }, dir);
    const music = await composeMusic({ score: { bpm: 120, beats: 1, tracks: [{ notes: [{ pitch: 69, start: 0, duration: 1 }] }] } }, dir);
    let rendered;
    try { rendered = await sceneRender({ path: source.scene.path, audio: music.files.find(f => f.path.endsWith('.wav')).path }, dir); }
    catch (error) {
      if (process.env.PI_REQUIRE_MEDIA_TEST !== '1' && /Executable doesn't exist|not installed or not on PATH|distribution.*not found/i.test(error.message)) { t.skip('Media prerequisites unavailable; PI_REQUIRE_MEDIA_TEST=1 requires actual render'); return; }
      throw error;
    }
    assert.equal(rendered.frames, 6);
    assert.equal(rendered.decodeVerified, true);
    assert.equal(rendered.output.streams.find(s => s.codec_type === 'video').width, 160);
    assert.ok(rendered.output.streams.some(s => s.codec_type === 'audio'));
    assert.equal(rendered.metrics.threeRevision, '180');
    assert.ok(rendered.metrics.triangles > 1000 && rendered.metrics.calls > 1);
    assert.notEqual(await fingerprint(rendered.samples[0].path), await fingerprint(rendered.samples[1].path), 'animation changes actual rendered pixels');
    const repeated = await sceneRender({ path: source.scene.path, mode: 'frame', time: 0 }, dir);
    assert.equal(await fingerprint(repeated.poster.path), await fingerprint(rendered.poster.path), 'absolute-time rendering is stable on the same renderer');
    const { stdout: pixels } = await exec('ffmpeg', ['-v', 'error', '-i', rendered.poster.path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    const colors = new Set(); for (let i = 0; i < pixels.length; i += 3) colors.add(pixels.readUIntBE(i, 3));
    assert.ok(colors.size > 300, `nonblank shaded 3D frame has ${colors.size} colors`);
    const { stdout: samples } = await exec('ffmpeg', ['-v', 'error', '-i', rendered.video.path, '-vn', '-ac', '1', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    let peak = 0; for (let i = 0; i < samples.length; i += 2) peak = Math.max(peak, Math.abs(samples.readInt16LE(i)));
    assert.ok(peak > 1000, 'encoded audio contains actual sound');
    for (const style of ['clay', 'toon', 'wireframe']) {
      const changed = { ...scene, style }; const created = await sceneCreate({ scene: changed }, dir);
      const frame = await sceneRender({ path: created.scene.path, mode: 'frame', time: 0.25 }, dir);
      assert.ok(frame.metrics.calls > 1);
    }
    if (process.env.PI_STUDIO_CAPTURE) {
      await fs.mkdir(process.env.PI_STUDIO_CAPTURE, { recursive: true });
      await fs.copyFile(rendered.poster.path, path.join(process.env.PI_STUDIO_CAPTURE, 'poster.png'));
      await fs.copyFile(rendered.video.path, path.join(process.env.PI_STUDIO_CAPTURE, 'scene.mp4'));
      await fs.copyFile(rendered.samples[1].path, path.join(process.env.PI_STUDIO_CAPTURE, 'middle.png'));
    }
    const before = await fs.readdir(dir), controller = new AbortController();
    controller.abort();
    await assert.rejects(sceneRender({ path: source.scene.path }, dir, controller.signal));
    assert.deepEqual(await fs.readdir(dir), before, 'aborted admission leaves no output');
    const stopped = new AbortController();
    const watcher = syncFs.watch(dir, (_event, name) => { if (name?.startsWith('media-') && !before.includes(name)) stopped.abort(); });
    try { await assert.rejects(sceneRender({ path: source.scene.path }, dir, stopped.signal), /cancelled|abort/i); }
    finally { watcher.close(); }
    assert.deepEqual(await fs.readdir(dir), before, 'in-flight cancellation cleans its fresh output');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

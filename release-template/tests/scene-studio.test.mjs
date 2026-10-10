import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => existsSync(path.join(dir, 'scripts/scene-model.mjs')));
const { validateScene, scenePreset, sampleKeys } = await import(pathToFileURL(path.join(agent, 'scripts/scene-model.mjs')));

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

test('key-visual scenes validate glass, spot, beam, gradient and post fields strictly', () => {
  const scene = scenePreset('keyvisual');
  assert.equal(scene.style, 'luminous');
  assert.deepEqual(validateScene(scene), scene);
  assert.ok(scene.objects.some(o => o.geometry === 'arch' && o.material === 'glass'));
  assert.ok(scene.lights.some(l => l.type === 'spot' && l.target && l.penumbra > 0));
  assert.equal(scene.beams.length, 1);
  assert.ok(scene.post.grain > 0 && scene.post.vignette > 0 && scene.post.bloom > 0);
  for (const change of [
    { post: { bloom: 3 } }, { post: { shader: 'x' } }, { beams: [{ from: [0, 0, 0], to: [0, 0, 0] }] },
    { beams: Array.from({ length: 5 }, () => ({ from: [0, 1, 0], to: [1, 0, 0] })) },
    { backgroundGradient: { from: 'red' } }, { softShadows: 99 },
    { objects: [{ id: 'a', material: 'lava' }] }, { objects: [{ id: 'a', geometry: 'arch', tube: 2 }] },
    { lights: [{ type: 'spot', angle: 3 }] },
  ]) assert.throws(() => validateScene({ ...scene, ...change }), JSON.stringify(change));
});

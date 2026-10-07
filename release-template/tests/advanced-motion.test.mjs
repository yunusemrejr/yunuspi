import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateShotScene, validateCameraPath } from '../agent/extensions/lib/shot-scene.ts';
import { planShot, videoShot } from '../agent/extensions/lib/video-shot.ts';
import { blenderBinary, blenderRun, blenderInspect } from '../agent/extensions/lib/blender-studio.ts';
import { audioSynthStandalone } from '../agent/extensions/lib/video-studio.ts';

test('advanced motion rejects malformed cameras, excessive arrays and nonfinite render work before rendering', () => {
  assert.throws(() => validateCameraPath([{ t: 0, position: [0,0,0], target: [0,0,0] }, { t: 1, position: [0,-2,0], target: [0,0,0] }], 1), /must differ/);
  assert.throws(() => validateShotScene({ objects: [{ id: 'card', shape: 'image' }] }, 2), /asset path/);
  assert.throws(() => validateShotScene({ objects: [{ id: 'card', shape: 'image', path: 'x.png', instances: { count: 128, stagger: 1 } }] }, 2), /stagger/);
  assert.throws(() => validateShotScene({ objects: [{ id: 'phone', shape: 'phone', instances: { count: 2 } }] }, 2), /complex rigs/);
  assert.throws(() => planShot({ width: NaN }, {}), /width/);
  assert.throws(() => planShot({ rig: 'path' }, {}), /cameraPath/);
  assert.throws(() => planShot({ mode: 'final', width: 8192, height: 8192, seconds: 10, fps: 30, samples: 256 }, { fps: 30 }), /maxRenderWork/);
  assert.ok(planShot({ seconds: 1, width: 192, height: 108 }, {}).pixelSamples > 0);
});

test('native image cards share geometry and retain staggered animation, camera lens keys and alpha', { skip: !blenderBinary(), timeout: 120000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'advanced-motion-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'public')); await fs.writeFile(path.join(dir, 'video.json'), JSON.stringify({ width: 192, height: 108, fps: 4 }));
  const png = path.join(dir, 'card.png');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=green:s=64x40','-frames:v','1','-threads','1',png]);
  const params = { dir, name: 'cards', mode: 'final', seconds: 1, fps: 4, width: 192, height: 108, samples: 4, shadow: 'none', scene: { objects: [{ id: 'card', shape: 'image', path: png, instances: { count: 3, layout: 'line', spacing: [1.4,0,0], stagger: .1 }, motion: [{ t: 0, position: [-1.4,0,0], rotation: [0,0,-8], ease: 'backOut' }, { t: .7, position: [-1.4,0,.3], rotation: [0,0,8] }] }] }, cameraPath: [{ t: 0, position: [0,-6,1], target: [0,0,0], lensMm: 35 }, { t: 1, position: [1,-5,1.2], target: [0,0,.2], lensMm: 42 }] };
  const planned = await videoShot({ ...params, action: 'plan' }, dir);
  assert.equal(planned.generationCostUsd, 0);
  await assert.rejects(fs.stat(path.join(dir, 'public', 'shots')), /ENOENT/);
  const made = await videoShot(params, dir);
  assert.equal(made.frames, 4); assert.equal(made.alpha, true); assert.equal(made.rig, 'path');
  const blend = path.join(dir, 'blender', 'cards.blend'), inspected = await blenderInspect({ blend, frames: [1,4] }, dir);
  assert.ok(inspected.objects.find(row => row.name === 'card-instance-1-rig').animation.keys > 0);
  const result = await blenderRun({ blend, code: `import bpy,json\nprint('YUNUSPI_RESULT '+json.dumps({'users':bpy.data.objects['card'].data.users,'lensKeys':bpy.data.objects['YP_Camera'].data.animation_data is not None}))` }, dir);
  assert.equal(result.result.users, 3); assert.equal(result.result.lensKeys, true);
  assert.ok(made.contactSheet);
});

test('standalone selected local music and SFX produce decoded audio with no API call', { timeout: 60000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-audio-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const previous = globalThis.fetch; globalThis.fetch = () => { throw Error('Local audio must not call a generation API'); }; t.after(() => { globalThis.fetch = previous; });
  const sound = await audioSynthStandalone({ kind: 'sfx', sfxType: 'chime', seconds: .3 }, dir);
  assert.equal(sound.provider, 'local'); assert.equal(sound.generationCostUsd, 0); assert.equal(sound.decodeVerified, true);
  const music = await audioSynthStandalone({ kind: 'music', style: 'focused', seconds: 1, seed: 4 }, dir);
  assert.equal(music.decodeVerified, true); assert.ok(music.seconds >= 1);
});

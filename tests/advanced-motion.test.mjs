import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { audioSynthStandalone } from '../agent/extensions/lib/video-studio.ts';

test('standalone selected local music and SFX produce decoded audio with no API call', { timeout: 60000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-audio-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const previous = globalThis.fetch; globalThis.fetch = () => { throw Error('Local audio must not call a generation API'); }; t.after(() => { globalThis.fetch = previous; });
  const sound = await audioSynthStandalone({ kind: 'sfx', sfxType: 'chime', seconds: .3 }, dir);
  assert.equal(sound.provider, 'local'); assert.equal(sound.generationCostUsd, 0); assert.equal(sound.decodeVerified, true);
  const music = await audioSynthStandalone({ kind: 'music', style: 'focused', seconds: 1, seed: 4 }, dir);
  assert.equal(music.decodeVerified, true); assert.ok(music.seconds >= 1);
});

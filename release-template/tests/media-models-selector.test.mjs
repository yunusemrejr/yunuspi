import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsManager } from '../core/coding-agent/src/core/settings-manager.js';
import { builtinMediaModels, fetchMediaModels, normalizeMediaModels } from '../core/coding-agent/src/core/media-models.js';
import { ScopedModelsSelectorComponent } from '../core/coding-agent/src/modes/interactive/components/scoped-models-selector.js';
import { initTheme } from '../core/coding-agent/src/modes/interactive/theme/theme.js';
import { setKeybindings } from '@yunuspi/tui';
import { InteractiveMode } from '../core/coding-agent/src/modes/interactive/interactive-mode.js';
import { KeybindingsManager } from '../core/coding-agent/src/core/keybindings.js';
import { selectedMediaParams, imageCapabilityIssues, quoteImageEndpoint, quoteVideoModel, videoCapabilityIssues, costLimit } from '../agent/extensions/lib/media-model-routing.ts';

test('media selector keyboard choices and save never alter LLM cycling or unsaved LLM edits', () => {
  initTheme('dark', false);
  setKeybindings(new KeybindingsManager());
  const calls = { llm: 0, save: 0, media: [], mediaSave: [] };
  const picker = new ScopedModelsSelectorComponent({ allModels: [{ provider: 'test', id: 'llm', name: 'Test LLM' }], enabledModelIds: null }, {
    onChange: () => calls.llm++, onPersist: () => calls.save++, onCancel() {}, onMediaChange: value => calls.media.push(value), onMediaPersist: value => calls.mediaSave.push(value),
  });
  picker.handleInput('\r'); assert.equal(calls.llm, 1);
  picker.handleInput('\t'); picker.handleInput('\r');
  assert.equal(calls.llm, 1); assert.deepEqual(calls.media.at(-1), { image: 'openrouter/auto' });
  picker.handleInput('\u0013'); assert.equal(calls.save, 0); assert.equal(calls.mediaSave.length, 1);
  picker.handleInput('\u001b[Z'); assert.equal(picker.isDirty, true);
  picker.handleInput('\t'); picker.handleInput('\t'); picker.handleInput('\r');
  assert.equal(calls.media.at(-1).video, 'local/native');
  picker.handleInput('\t'); picker.handleInput('\r');
  assert.equal(calls.media.at(-1).speech, 'local/piper');
  assert.match(picker.render(100).join('\n'), /Piper local speech/);
  picker.getSearchInput().setValue('music_v2_5'); picker.refresh(); picker.handleInput('\r');
  assert.equal(calls.media.at(-1).music, 'elevenlabs/music_v2_5');
  assert.equal(calls.llm, 1);
});

test('session media preferences survive other settings writes and persist only on explicit save', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-settings-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const agent = path.join(dir, 'agent'); await fs.mkdir(agent);
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'test', defaultModel: 'llm', defaultThinkingLevel: 'ultra' }));
  const settings = SettingsManager.create(dir, agent, { projectTrusted: false });
  settings.setMediaModels({ image: 'openrouter/auto', speech: 'local/piper' });
  settings.setEnabledModels(['test/llm']); await settings.flush();
  assert.equal(settings.getMediaModels().image, 'openrouter/auto');
  let stored = JSON.parse(await fs.readFile(path.join(agent, 'settings.json'), 'utf8'));
  assert.equal(stored.mediaModels, undefined); assert.equal(stored.defaultThinkingLevel, 'ultra');
  settings.setMediaModels(settings.getMediaModels(), true); await settings.flush();
  stored = JSON.parse(await fs.readFile(path.join(agent, 'settings.json'), 'utf8'));
  assert.deepEqual(stored.mediaModels, { image: 'openrouter/auto', speech: 'local/piper' });
  assert.equal(stored.defaultModel, 'llm');
  const clone = settings.getMediaModels(); clone.speech = 'elevenlabs/eleven_v3';
  assert.equal(settings.getMediaModels().speech, 'local/piper');
});

test('catalogs use bounded public reads, preserve capabilities, and fail on overflow or cancellation', async () => {
  const calls = [];
  const rows = await fetchMediaModels('image', { fetchImpl: async (url, options) => { calls.push([url, options]); return Response.json({ data: [{ id: 'vendor/image', name: 'Image', architecture: { input_modalities: ['image','text'] }, supported_parameters: { background: { type: 'enum', values: ['transparent'] } } }] }); } });
  assert.equal(rows[0].id, 'openrouter/vendor/image'); assert.ok(rows[0].capabilities.supported_parameters.background);
  assert.equal(calls[0][1].headers, undefined); assert.equal(calls[0][1].redirect, 'error');
  await assert.rejects(fetchMediaModels('video', { fetchImpl: async () => new Response('x', { headers: { 'content-length': 3 * 1024 * 1024 } }) }), /2 MiB/);
  const stop = new AbortController(); stop.abort();
  await assert.rejects(fetchMediaModels('video', { signal: stop.signal, fetchImpl: async () => { throw Error('must not fetch'); } }), /abort/i);
  assert.deepEqual(normalizeMediaModels({ image: 'openrouter/auto', token: 'secret', video: 'https://invalid', speech: [] }), { image: 'openrouter/auto' });
  assert.ok(builtinMediaModels().some(row => row.kind === 'music' && row.id === 'local/procedural'));
});

test('media parameter precedence preserves explicit providers and independent local audio defaults', () => {
  assert.deepEqual(selectedMediaParams({ model: 'openrouter/vendor/image' }, 'image', { image: 'openrouter/other/model' }), { model: 'vendor/image', mediaProvider: 'openrouter', transport: 'images' });
  assert.equal(selectedMediaParams({ model: 'vendor/exact' }, 'image', { image: 'openrouter/auto' }).model, 'vendor/exact');
  assert.deepEqual(selectedMediaParams({}, 'speech', { speech: 'local/piper' }), { backend: 'piper', model: undefined });
  assert.equal(selectedMediaParams({ backend: 'piper', voice: 'amy' }, 'speech', { speech: 'elevenlabs/eleven_v3' }).backend, 'piper');
  assert.equal(selectedMediaParams({ voiceId: 'chosen-voice' }, 'speech', { speech: 'elevenlabs/eleven_v3' }).model, 'eleven_v3');
  assert.throws(() => selectedMediaParams({ model: 'openrouter/unrelated' }, 'speech'), /supported speech/);
  assert.equal(selectedMediaParams({}, 'music', { music: 'elevenlabs/music_v2_5' }).model, 'music_v2_5');
});

test('quotes keep unknown billing unknown and include image variants, references, resolution and audio', () => {
  assert.equal(quoteImageEndpoint({ pricing: [{ billable: 'output_image', unit: 'image', cost_usd: .02 }, { billable: 'output_image', unit: 'image', cost_usd: .04, variant: '4k' }, { billable: 'input_reference', unit: 'image', cost_usd: .01 }] }, 2), .06);
  assert.equal(quoteImageEndpoint({ pricing: [{ billable: 'output_image', unit: 'token', cost_usd: .00001 }] }), null);
  assert.ok(imageCapabilityIssues({ supported_parameters: { input_references: { min: 1, max: 2 } } }, { transparent: true }, 0).length >= 2);
  assert.equal(quoteVideoModel({ pricing_skus: { cents_per_video_output_second_720p: '3', cents_per_image_input: '1', cents_per_video_output_second_1080p: '14' } }, { seconds: 4, resolution: '720p', firstFrame: 'frame.png', generateAudio: false }), .13);
  assert.equal(quoteVideoModel({ pricing_skus: { duration_seconds_without_audio_720p: '.03', duration_seconds_with_audio_720p: '.05' } }, { seconds: 4, resolution: '720p', generateAudio: false }), .12);
  assert.equal(quoteVideoModel({ pricing_skus: { video_tokens: '.00001' } }, { seconds: 4, resolution: '720p' }), null);
  assert.ok(videoCapabilityIssues({ id: 'v', supported_durations: [4], supported_resolutions: ['720p'], supported_aspect_ratios: ['16:9'] }, { seconds: 4, resolution: '720p', aspectRatio: '16:9', lastFrame: 'x' }).includes('last frame'));
  for (const value of [0, -1, NaN, Infinity, '2']) assert.throws(() => costLimit(value, 1), /maxCostUsd/);
});


test('interactive /models refreshes media within its selector and ignores late results after close', async t => {
  initTheme('dark', false); setKeybindings(new KeybindingsManager());
  const previous = globalThis.fetch, offline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  t.after(() => { globalThis.fetch = previous; if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline; });
  const calls = []; let renders = 0, llmRefreshes = 0, selection;
  globalThis.fetch = async url => { calls.push(url); return Response.json({ data: [{ id: 'vendor/fresh', name: 'Fresh catalog model' }] }); };
  const mode = Object.create(InteractiveMode.prototype);
  const session = { scopedModels: [], modelRuntime: { getAvailableSnapshot: () => [], refresh: async () => { llmRefreshes++; return { errors: new Map() }; } } };
  Object.defineProperty(mode, 'session', { value: session });
  Object.defineProperty(mode, 'settingsManager', { value: { getEnabledModels: () => undefined, getMediaModels: () => ({ video: 'local/native' }), setMediaModels() {} } });
  Object.assign(mode, {
    ui: { requestRender() { renders++; } }, updateAvailableProviderCount() {}, showStatus() {},
    showSelector(build) { selection = build(() => {}); },
  });
  mode.showModelsSelector();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(llmRefreshes, 1); assert.equal(calls.length, 2);
  selection.component.handleInput('\t');
  assert.match(selection.component.render(100).join('\n'), /Fresh catalog model/);
  const before = renders; selection.dispose();
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(renders, before);
});

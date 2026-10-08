import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createReadToolDefinition } from '../core/coding-agent/src/core/tools/read.js';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => existsSync(path.join(p, 'extensions/lib/blender-studio.ts')));
const load = p => import(pathToFileURL(path.join(agent, p)).href);
const { classifyExecution } = await load('extensions/lib/adaptive-execution.ts');
const { planAssistance } = await load('extensions/pi-subagents/src/runs/shared/assistance-plan.ts');
const { blenderInspectionView, blenderInspect, blenderRun, blenderBinary } = await load('extensions/lib/blender-studio.ts');
const { default: registerBlender } = await load('extensions/blender-studio.ts');
const { videoReviewRouting } = await load('extensions/lib/video-production-flow.ts');
const { audioGenerate } = await load('extensions/lib/elevenlabs.ts');
const { selectTaskPipelines, buildPipelineContext, createPipelineLedger } = await load('extensions/lib/task-pipelines.ts');
const production = 'Remake the music video from scratch in Blender. Compose a soundtrack and animate moving clouds. Acceptance must be checked, not only asserted.';
async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const scene = () => ({ render: { camera: 'Camera', engine: 'BLENDER_EEVEE_NEXT' }, counts: { objects: 400 },
  objects: Array.from({ length: 400 }, (_, i) => ({ name: `Rain${i}`, type: 'MESH', inScene: true, dimensions: [1, 2, 3], animation: { action: 'Fall', curves: 12, keys: 24, channels: Array.from({ length: 12 }, (_, n) => ({ path: 'location', index: n, keys: [[1, 0], [97, 1]] })) } })),
  materialDetails: [{ name: 'Glass', shader: { surfaces: [{ inputs: { Roughness: { default: .12 } } }] } }], sceneLights: ['Key'], warnings: [] });

test('creative production is not demoted by incidental scope words or generated goal acceptance', () => {
  for (const prefix of ['', 'Just ', 'Only ']) {
    const p = classifyExecution({ task: prefix + production });
    assert.equal(p.tier, 'complex'); assert.equal(p.assistance.mode, 'swarm');
    const plan = planAssistance(prefix + production, true, p);
    assert.equal(plan.roles.length, 3);
    assert.match(plan.roles[0], /hero-frame proof/); assert.match(plan.roles[1], /musical arrangement/); assert.match(plan.roles[2], /periodic endpoints/);
    assert.equal(plan.maxCostUsd, .03);
  }
  assert.equal(classifyExecution({ task: 'Just change the animation duration from 2 to 3 seconds in one file' }).tier, 'direct');
  assert.equal(planAssistance(production + ' Do not spawn helpers.').mode, 'none');
  assert.equal(classifyExecution({ task: 'Read README.md\n> Remake the music video in Blender and animate clouds' }).tier, 'direct');
  assert.equal(planAssistance('Create a video showing the process').mode, 'subagent', 'creative verbs enter the useful-work gate');
});

test('small pipeline budgets retain early Blender proof and the text-only vision handoff', () => {
  const selection = selectTaskPipelines({ prompt: production });
  const text = buildPipelineContext(selection, createPipelineLedger(), { scope: 'task', revision: 'fixture', maxChars: 2400 });
  assert.ok(text.length <= 2400); assert.match(text, /Before long renders/); assert.match(text, /blender_render preview/); assert.match(text, /image_understand/);
});

test('large Blender evidence is bounded, pageable, precise and explicit about omitted detail', () => {
  const full = scene(), before = JSON.stringify(full);
  const summary = blenderInspectionView(full);
  assert.ok(before.length > 200000); assert.ok(JSON.stringify(summary).length < 16000);
  assert.equal(summary.coverage.complete, false); assert.equal(summary.coverage.omittedObjects, 388);
  assert.equal(summary.objects[0].animation.keys, 24); assert.equal(summary.objects[0].animation.curves, 12);
  const page = blenderInspectionView(full, { view: 'objects', offset: 12, limit: 3 });
  assert.deepEqual(page.rows.map(r => r.name), ['Rain12', 'Rain13', 'Rain14']); assert.equal(page.page.nextOffset, 15);
  const material = blenderInspectionView(full, { view: 'materials', names: ['Glass'] });
  assert.equal(material.rows[0].shader.surfaces[0].inputs.Roughness.default, .12);
  full.objects[0].animation.channels = Array.from({ length: 2000 }, () => ({ keys: [[1, 0], [2, 1]] }));
  const dense = blenderInspectionView(full, { view: 'animation', names: ['Rain0'] });
  assert.ok(JSON.stringify(dense).length < 16000); assert.equal(dense.rows[0].detailOmitted, true); assert.equal(dense.rows[0].jsonPointer, '/data/objects/0');
  assert.equal(blenderInspectionView(full, { view: 'full' }), full);
  for (const params of [{ view: 'unknown' }, { limit: 0 }, { offset: -1 }, { names: [7] }]) assert.throws(() => blenderInspectionView(full, params));
});

test('cached inspection pages reuse exact blend bytes and reject stale source without launching Blender', async t => {
  const dir = await workspace(t), blend = path.join(dir, 'fixture.blend'), report = path.join(dir, 'inspection.json');
  await fs.writeFile(blend, 'fixture-bytes');
  await fs.writeFile(report, JSON.stringify({ version: 1, blend, blendSha256: createHash('sha256').update('fixture-bytes').digest('hex'), data: scene() }));
  const page = await blenderInspect({ blend, inspectionReport: report, view: 'objects', names: ['Rain399'] }, dir);
  assert.equal(page.reused, true); assert.equal(page.rows[0].name, 'Rain399');
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(blenderInspect({ blend, inspectionReport: report }, dir, stopped.signal), { name: 'AbortError' });
  await assert.rejects(blenderInspect({ blend, inspectionReport: report, frames: [1] }, dir), /cannot change scene/);
  await fs.writeFile(blend, 'changed-source');
  await assert.rejects(blenderInspect({ blend, inspectionReport: report }, dir), /current blend bytes/);
});

test('a single Blender still offers vision review and read does not pretend a text-only model saw pixels', async t => {
  const dir = await workspace(t), frame = path.join(dir, 'hero.png');
  await fs.writeFile(frame, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1EAAAAASUVORK5CYII=', 'base64'));
  const route = videoReviewRouting({ files: [{ path: frame }], video: '/fixture/clip.mp4' }, false);
  assert.deepEqual(route.analyze.parameters.paths, [frame]); assert.equal(route.playback, '/fixture/clip.mp4');
  assert.equal(route.analyze.parameters.provider, undefined); assert.equal(videoReviewRouting({ files: [{ path: frame }] }, true), undefined);
  const tool = createReadToolDefinition(dir, { autoResizeImages: false });
  const read = await tool.execute('fixture', { path: frame }, undefined, undefined, { cwd: dir, model: { input: ['text'] } });
  const text = read.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  assert.match(text, /appearance remains unreviewed/); assert.match(text, /image_understand/); assert.ok(text.includes(JSON.stringify([frame])));
  const visual = await tool.execute('fixture', { path: frame }, undefined, undefined, { cwd: dir, model: { input: ['text', 'image'] } });
  assert.ok(visual.content.some(b => b.type === 'image')); assert.ok(!visual.content.some(b => b.type === 'text' && /appearance remains unreviewed/.test(b.text)));
});

test('missing audio authentication makes no request, output folder or uncertain paid receipt', async t => {
  const dir = await workspace(t), original = globalThis.fetch;
  let requests = 0; globalThis.fetch = async () => { requests++; throw Error('must not submit'); };
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(audioGenerate({ kind: 'sfx', prompt: 'Soft rain' }, dir, undefined, {}), error => {
    assert.equal(error.submissionNotSent, true); assert.equal(error.retainedAudioSubmission, undefined);
    assert.match(error.message, /not submitted/); return true;
  });
  assert.equal(requests, 0); assert.deepEqual(await fs.readdir(dir), []);
});

test('real Blender reports retain complete evidence and native previews respect model image capabilities', { skip: !blenderBinary() || process.env.YUNUSPI_SKIP_BLENDER_RENDER === '1', timeout: 180000 }, async t => {
  const dir = await workspace(t), blend = path.join(dir, 'scene.blend');
  await blenderRun({ code: `import bpy\nfor i in range(256):\n obj=bpy.data.objects.new('Rain'+str(i),None);bpy.context.scene.collection.objects.link(obj);obj.location=(i,0,0)\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})` }, dir);
  const inspected = await blenderInspect({ blend }, dir);
  assert.ok(JSON.stringify(inspected).length < 16000); assert.equal(inspected.coverage.complete, false);
  const report = JSON.parse(await fs.readFile(inspected.inspectionReport, 'utf8'));
  assert.equal(report.data.objects.length, 259);
  const detail = await blenderInspect({ blend, inspectionReport: inspected.inspectionReport, view: 'objects', names: ['Rain255'] }, dir);
  assert.equal(detail.reused, true); assert.equal(detail.rows[0].name, 'Rain255');
  const tools = []; registerBlender({ registerTool: tool => tools.push(tool) });
  const render = tools.find(tool => tool.name === 'blender_render'), args = { blend, mode: 'still', width: 64, height: 36, engine: 'WORKBENCH' };
  const text = await render.execute('text-proof', args, undefined, undefined, { cwd: dir, model: { input: ['text'] } });
  assert.equal(text.details.visualReview.state, 'needs-vision'); assert.ok(!text.content.some(c => c.type === 'image'));
  assert.deepEqual(text.details.visualReview.analyze.parameters.paths, [text.details.files[0].path]);
  const visual = await render.execute('vision-proof', args, undefined, undefined, { cwd: dir, model: { input: ['text', 'image'] } });
  assert.equal(visual.details.visualReview, undefined); assert.ok(visual.content.some(c => c.type === 'image' && c.mimeType === 'image/png'));
});

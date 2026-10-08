import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateToolArguments } from '@yunuspi/ai';
const repo = path.resolve(import.meta.dirname, '..');
const agent = [path.join(repo, 'agent'), path.resolve(repo, '..')].find(p => existsSync(path.join(p, 'extensions/lib/video-studio.ts')));
const source = file => pathToFileURL(path.join(agent, file)).href;
const { planVideoReview, productionPlan, productionFindings, videoReviewRouting } = await import(source('extensions/lib/video-production-flow.ts'));
const { videoProject, renderedLayoutFindings } = await import(source('extensions/lib/video-studio.ts'));
const { default: register } = await import(source('extensions/video-studio.ts'));

const project = (seconds = 6) => {
  const spec = { fps: 24, width: 640, height: 360, scenes: [
    { id: 'opening', component: 'TitleCard', seconds: 2 },
    { id: 'mechanism', component: 'StudioScene', seconds, beat: { role: 'explain', claim: 'Work moves through a queue', visualAction: 'A token follows the same route into the output' },
      cues: { arrive: 1, resolve: seconds - .4 }, props: { layers: [{ kind: 'path', motion: { cue: 'arrive', keys: [{ t: 1 }, { t: seconds - .4 }] } }] } },
    { id: 'end', component: 'OutroScene', seconds: 2 },
  ] };
  let start = 0;
  const scenes = spec.scenes.map(s => { const result = { ...s, start, end: start + s.seconds }; start = result.end; return result; });
  return { spec, scenes, seconds: start, issues: [] };
};

test('proof selection follows the mechanism; samples both sides of cuts and late cues on delivered frames', () => {
  const p = project(), before = JSON.stringify(p);
  const plan = planVideoReview(p.spec, p.scenes);
  assert.equal(plan.scene, 'mechanism');
  const frames = plan.frames.map(f => f.frame);
  for (const f of [47, 48, 49, 190, 191, 192, 181, 182, 183]) assert.ok(frames.includes(f), `critical frame ${f}`);
  assert.ok(frames.length <= 24);
  assert.equal(plan.coverage.fullScenePlayback, true);
  assert.equal(plan.coverage.fullFilmReviewed, false);
  assert.equal(JSON.stringify(p), before, 'plans never edit the timeline');
});

test('long and dense scenes disclose omitted evidence and keep playback bounded; explicit absolute ranges are exact', () => {
  const p = project(200);
  p.spec.scenes[1].cues = Object.fromEntries(Array.from({ length: 100 }, (_, n) => ['c' + n, n + 1]));
  p.spec.scenes[1].cues.arrive = 1;
  const plan = planVideoReview(p.spec, p.scenes);
  assert.ok(plan.frames.length <= 24);
  assert.ok(plan.coverage.omittedCandidates > 0);
  assert.equal(plan.coverage.fullScenePlayback, false);
  assert.ok(plan.coverage.playbackSeconds <= 12);
  assert.deepEqual(planVideoReview(p.spec, p.scenes, { scene: 'mechanism', from: 10, to: 12 }).range, [240, 287]);
  for (const args of [{ from: 1 }, { from: NaN, to: 5 }, { from: 5, to: 4 }, { from: 0, to: 14 }, { scene: 'unknown' }])
    assert.throws(() => planVideoReview(p.spec, p.scenes, args));
});

test('plans use actual prerequisites and preserve explicit job flows without claiming readiness', () => {
  const p = project();
  assert.equal(productionPlan(p, '/film', {}, false).next[0].parameters.action, 'install');
  for (const flow of ['promo', 'explainer', 'walkthrough', 'longform', 'loop']) {
    const result = productionPlan(p, '/film', { flow }, true);
    assert.equal(result.flow, flow); assert.equal(result.flowBasis, 'authored');
    assert.equal(result.next[0].parameters.mode, 'review');
    assert.equal(result.next[0].parameters.scene, 'mechanism');
    assert.equal(result.deliveryReady, undefined);
  }
  assert.equal(productionPlan(project(200), '/film', { phase: 'final' }, true).next[1].parameters.mode, 'segments');
  const unvoiced = project(); unvoiced.scenes[1].narration = 'A queue makes the work visible.';
  assert.equal(productionPlan(unvoiced, '/film', { phase: 'final' }, true).next[0].parameters.action, 'check');
  p.issues.push({ severity: 'error', scene: 'mechanism', message: 'missing media' });
  assert.equal(productionPlan(p, '/film', {}, true).next[0].parameters.action, 'check');
  assert.throws(() => productionPlan(p, '/film', { flow: 'made-up' }, true), /flow/);
  assert.throws(() => productionPlan(p, '/film', { phase: 'done' }, true), /phase/);
  assert.equal(productionPlan(project(), '/film', { phase: 'delivery' }, true).next.length, 0);
  assert.equal(productionPlan(project(), '/film', { phase: 'delivery', path: '/film/final.mp4', flow: 'loop' }, true).next[1].parameters.loop, true);
});

test('authored beats flag unseen arguments without banning intentional typography or breaking old projects', () => {
  assert.deepEqual(productionFindings({ scenes: [{ id: 'old', component: 'Custom' }] }), []);
  const p = project(), raw = p.spec.scenes[1];
  raw.props.layers = [{ kind: 'text', motion: { enter: 'fade' } }];
  assert.equal(productionFindings(p.spec)[0].severity, 'warn');
  raw.beat.role = 'hook'; assert.deepEqual(productionFindings(p.spec), []);
  raw.beat.role = 'explain'; raw.props.layers[0].motion.keys = [{ t: 1 }, { t: 2 }];
  assert.deepEqual(productionFindings(p.spec), []);
  raw.beat.visualAction = ''; assert.equal(productionFindings(p.spec)[0].severity, 'error');
});

test('public project tools retain beat contracts and plans remain read-only; invalid beats cannot replace a storyboard', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-flow-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'film');
  await videoProject({ dir, action: 'init', flow: 'promo', title: 'Measured work', install: false, intent: 'personal', width: 640, height: 360 }, root);
  const beat = { role: 'explain', claim: 'A value changes', visualAction: 'The counter rises to show the new total' };
  await videoProject({ dir, action: 'compose', scenes: [{ id: 'counter', seconds: 3, beat, layers: [{ id: 'count', kind: 'counter', value: { from: 0, to: 4 }, box: [.2, .2, .6, .6] }] }] }, root);
  const file = path.join(dir, 'video.json'), before = await fs.readFile(file, 'utf8');
  const result = await videoProject({ dir, action: 'plan' }, root);
  assert.equal(result.flow, 'promo'); assert.equal(result.representative.scene, 'counter');
  assert.deepEqual(JSON.parse(before).scenes[0].beat, beat);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await assert.rejects(videoProject({ dir, action: 'compose', scenes: [{ id: 'bad', seconds: 2, headline: 'Invalid', beat: { ...beat, visualAction: '' } }] }, root), /beat needs/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const tools = new Map(); register({ registerTool: d => tools.set(d.name, d) });
  const validate = (name, arguments_) => validateToolArguments(tools.get(name), { type: 'toolCall', id: 'check', name, arguments: arguments_ });
  assert.doesNotThrow(() => validate('video_project', { dir, action: 'plan', flow: 'walkthrough', phase: 'proof' }));
  assert.doesNotThrow(() => validate('video_render', { dir, mode: 'review', scene: 'counter' }));
  assert.throws(() => validate('video_project', { dir, action: 'plan', flow: 'invalid' }));
});

test('one browser owns stills plus playback and closes on discovery, still or playback failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-runner-owner-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/index.ts'), ''); await fs.writeFile(path.join(root, 'package.json'), '{}');
  for (const name of ['renderer', 'bundler']) {
    const dir = path.join(root, 'node_modules/@remotion', name); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@remotion/' + name, type: 'module', main: 'index.js' }));
  }
  await fs.writeFile(path.join(root, 'node_modules/@remotion/bundler/index.js'), `import fs from 'node:fs'; export async function bundle(p){fs.writeFileSync(p.outDir+'/index.html','ok');}`);
  await fs.writeFile(path.join(root, 'node_modules/@remotion/renderer/index.js'), `
    import fs from 'node:fs';
    const record = x => fs.appendFileSync(process.env.VIDEO_FLOW_LOG, JSON.stringify(x)+'\\n');
    let instance;
    export async function openBrowser(name, opts){record({event:'open',name,scale:opts.forceDeviceScaleFactor});instance={close:async()=>record({event:'close'})};return instance;}
    export async function selectComposition(p){if(p.puppeteerInstance!==instance)throw Error('different browser');record({event:'select'});if(process.env.VIDEO_FLOW_FAIL==='select')throw Error('select failure');return {id:'Main',fps:24,width:640,height:360,durationInFrames:100};}
    export async function renderStill(p){if(p.puppeteerInstance!==instance)throw Error('different browser');record({event:'still',frame:p.frame,scale:p.scale,review:p.inputProps.reviewLayout});if(process.env.VIDEO_FLOW_FAIL==='still')throw Error('still failure');fs.writeFileSync(p.output,'pixels');}
    export async function renderMedia(p){if(p.puppeteerInstance!==instance)throw Error('different browser');record({event:'media',scale:p.scale,range:p.frameRange,review:p.inputProps.reviewLayout??false});if(process.env.VIDEO_FLOW_FAIL==='media')throw Error('media failure');fs.writeFileSync(p.outputLocation,'movie');}
  `);
  for (const failure of ['', 'select', 'still', 'media']) {
    const log = path.join(root, 'events'), request = path.join(root, 'request.json');
    await fs.writeFile(log, '');
    await fs.writeFile(request, JSON.stringify({ project: root, outDir: path.join(root, 'out'), mode: 'review', composition: 'Main', frames: [1, 24], range: [0, 48], scale: .5, stillScale: 1 }));
    const run = spawnSync(process.execPath, [path.join(agent, 'scripts/video-render.mjs'), request], { env: { ...process.env, VIDEO_FLOW_LOG: log, VIDEO_FLOW_FAIL: failure }, encoding: 'utf8' });
    const events = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.event === 'open').length, 1);
    assert.equal(events.at(-1).event, 'close');
    assert.equal(run.status, failure ? 1 : 0, run.stdout + run.stderr);
    if (!failure) {
      assert.ok(events.filter(e => e.event === 'still').every(e => e.scale === 1 && e.review));
      assert.equal(events.find(e => e.event === 'media').scale, .5);
      assert.equal(events.find(e => e.event === 'media').review, false);
      const result = JSON.parse(run.stdout.split('\n').find(l => l.startsWith('VIDEO_RENDER_RESULT ')).slice(20));
      assert.equal(result.stills.length, 2); assert.equal(result.browserLaunches, 1); assert.ok(result.output.endsWith('/review.mp4'));
    }
  }
});

test('text-only review routing discovers vision without spending or changing the selected main model', () => {
  const evidence = { contactSheet: '/film/sheet.png', detailFrame: '/film/detail.png', output: '/film/review.mp4' };
  assert.equal(videoReviewRouting(evidence, true), undefined);
  const route = videoReviewRouting(evidence, false);
  assert.equal(route.next.tool, 'image_understand');
  assert.equal(route.next.parameters.action, 'models');
  assert.deepEqual(route.analyze.parameters.paths, [evidence.contactSheet, evidence.detailFrame]);
  assert.equal(route.analyze.parameters.model, undefined);
  assert.equal(route.analyze.parameters.provider, undefined);
  assert.match(route.analyze.requires, /main session model stays unchanged/);
});

test('repeated layout defects stay compact while retaining late overflows and worst size', () => {
  const layout = Array.from({length:24}, (_, frame) => ({scene:'mechanism',deliveredFrame:frame,text:[{id:'label',size:22-frame/10,overflow:frame===23}]}));
  const findings = renderedLayoutFindings(layout);
  assert.equal(findings.length, 2);
  const small = findings.find(i => i.severity === 'warn'), overflow = findings.find(i => i.severity === 'error');
  assert.equal(small.observations, 24); assert.equal(small.minimumSize, 19.7);
  assert.equal(small.firstFrame, 0); assert.equal(small.lastFrame, 23);
  assert.equal(overflow.firstFrame, 23); assert.equal(overflow.observations, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.join(root, '..', 'agent'), path.resolve(root, '..'), path.resolve(root, '../..')].find(dir => fs.existsSync(path.join(dir, 'extensions/session-hooks.ts')));
const load = file => import(pathToFileURL(path.join(agent, 'extensions', file)));
const { selectTaskPipelines, automaticPipelineTools, createPipelineLedger, recordPipelineEvidence } = await load('lib/task-pipelines.ts');
const { testDiagnostics } = await load('lib/assurance-output.ts');
const hooksLib = await load('lib/session-hooks.ts');
const { matchHook } = hooksLib;
const { default: registerHooks } = await load('session-hooks.ts');
const { intentBundleTools } = await load('lib/tool-discovery.ts');

test('creative tasks select relevant pipelines and require playback, listening or pixels', () => {
  for (const [prompt, id, stage, kind] of [
    ['Edit a video with narration and a soundtrack', 'video', 'video-playback', 'playback'],
    ['Create music and mix the audio tracks', 'audio', 'audio-listening', 'listening'],
    ['Create an SVG illustration and icon set', 'svg-art', 'art-pixels', 'pixels'],
  ]) {
    const selection = selectTaskPipelines({ prompt });
    assert.ok(selection.ids.includes(id), prompt);
    assert.deepEqual(selection.stages.find(row => row.id === stage).evidenceKinds, [kind]);
    assert.ok(!automaticPipelineTools(selection, { prompt }).includes('code_quality'), 'media work should not stage an unrelated code audit');
    const ledger = createPipelineLedger(), coordinate = { scope: 'fixture', revision: 'content:1', status: 'passed', source: 'native:fixture' };
    for (const row of selection.stages.slice(0, selection.stages.findIndex(row => row.id === stage)))
      recordPipelineEvidence(ledger, { ...coordinate, stageId: row.id, evidenceKind: row.evidenceKinds[0] }, selection);
    assert.throws(() => recordPipelineEvidence(ledger, { ...coordinate, stageId: stage, evidenceKind: 'execution' }, selection), /requires/);
    assert.equal(recordPipelineEvidence(ledger, { ...coordinate, stageId: stage, evidenceKind: kind }, selection).recorded, true);
  }
  assert.deepEqual(selectTaskPipelines({ prompt: 'Explain how SVG transforms work' }).ids, []);
  assert.deepEqual(selectTaskPipelines({ prompt: 'Create a soundtrack without tools' }).ids, []);
  assert.ok(!selectTaskPipelines({ prompt: 'Improve audio editing', files: ['node_modules/fixture/video.mp4'] }).ids.includes('video'));
});

test('debugging keeps reproduction before repair and exposes source navigation tools', () => {
  const prompt = 'Debug the parser crash and reproduce the failing input';
  const selection = selectTaskPipelines({ prompt });
  assert.ok(selection.ids.includes('debugging'));
  assert.ok(selection.stages.find(row => row.id === 'implementation').dependsOn.includes('debug-reproduction'));
  for (const tool of ['project_tests', 'symbol_search', 'context_slice']) assert.ok(automaticPipelineTools(selection, { prompt }).includes(tool));
  assert.ok(!selectTaskPipelines({ prompt: 'Write a comment explaining the debugger' }).ids.includes('debugging'));
});

test('audio intents stage tools that can perform the requested operation', () => {
  assert.ok(intentBundleTools('Denoise the audio track').includes('audio_mix'));
  assert.ok(!intentBundleTools('Denoise the audio track').includes('media_edit'), 'media_edit has no denoise operation');
  assert.ok(intentBundleTools('Time-stretch the music track').includes('audio_mix'));
  assert.ok(intentBundleTools('Create a sound effect for the transition').includes('audio_synth'));
  assert.ok(intentBundleTools('Normalize the audio').includes('media_edit'));
  assert.ok(!intentBundleTools('Do not normalize audio; inspect the source instead').includes('media_edit'));
});

test('web-answer, mailbox, marketing, API and browser-action intents stage their tools on turn one', () => {
  const staged = (prompt, ...names) => { const got = intentBundleTools(prompt); for (const name of names) assert.ok(got.includes(name), `${name} for: ${prompt}`); };
  staged('Research the top five competitors of this product and compare their pricing pages.', 'web_search', 'fetch_content');
  staged('Find out what the latest Node.js LTS version is and what changed.', 'web_search', 'fetch_content');
  staged('Make this site more SEO-optimized with topic clusters for long-tail queries.', 'web_probe', 'web_search', 'fetch_content');
  staged('Check my inbox for replies and draft follow-up emails to the ones who have not answered.', 'agentmail_messages', 'agentmail_send');
  staged('Promote the new release on Reddit and Hacker News and write the posts.', 'web_search', 'browser_session');
  staged('Call the GitHub REST API to list the open issues of this repository.', 'http_request');
  staged('Log in to the admin panel and fill out the settings form.', 'browser_session');
  const quiet = /^(?:web_search|fetch_content|agentmail_\w+|http_request|browser_session)$/;
  for (const prompt of ['Fix the null pointer in the login handler.', 'Research the codebase structure and explain how auth works.', 'Fix the login form validation.', 'Refactor the email parser module.', 'Add a unit test for the newsletter formatter.', 'Do not search the web; use the files provided.'])
    assert.deepEqual(intentBundleTools(prompt).filter(name => quiet.test(name)), [], prompt);
});

test('diagnostics preserve the first actual failure in the middle of long runner output', () => {
  for (const failure of ['not ok 14 - parser accepts invalid input', 'Traceback (most recent call last):', 'FAIL src/parser.test.ts', 'error[E0308]: mismatched types', 'AssertionError: expected two records', 'java.lang.IllegalStateException: missing payload', 'src/parser.c:18:4: error: incompatible types']) {
    const output = 'runner header\n' + 'successful check\n'.repeat(150) + '\n'.repeat(1000) + '\x1b[31m' + failure + '\x1b[0m\n  at parse (src/parser.ts:18:4)\n' + 'cleanup and summary\n'.repeat(150);
    const diagnostic = testDiagnostics(output);
    assert.ok(diagnostic.text.includes(failure), failure);
    assert.ok(diagnostic.text.includes('src/parser.ts:18:4'));
    assert.ok(diagnostic.text.length <= 1400);
    assert.equal(diagnostic.omitted, true);
  }
});

test('UI edits receive render guidance, read-only creative actions stay quiet, and all media failures recover', () => {
  assert.equal(matchHook('edit', { path: 'src/Screen.tsx' })?.key, 'ui-first-render');
  for (const action of ['get', 'brief', 'status', 'clear']) assert.equal(matchHook('creative_direct', { action }), null);
  assert.equal(matchHook('creative_direct', { action: 'set' })?.key, 'creative-direction-loop');
  assert.equal(matchHook('video_project', { action: 'install' }), null);
  assert.equal(matchHook('narration_tts', { action: 'status' }), null);
  assert.equal(matchHook('visual_review', { action: 'status' }), null);
  assert.equal(matchHook('svg_inspect', {}, true)?.key, 'creative-recover');
  for (const name of ['audio_mix', 'music_compose', 'media_pipeline', 'video_compose', 'video_render', 'narration_tts', 'audio_synth'])
    assert.equal(matchHook(name, {}, true)?.key, 'media-recover', name);
});

test('hook result ownership prevents an unrelated result from consuming queued guidance', () => {
  const handlers = new Map();
  registerHooks({ on: (name, fn) => handlers.set(name, fn), events: { emit() {} } });
  const call = handlers.get('tool_call'), result = handlers.get('tool_result');
  call({ toolCallId: 'same-id', toolName: 'audio_mix', input: {} });
  assert.equal(result({ toolCallId: 'same-id', toolName: 'read', content: [], isError: false }, {}), undefined);
  const owned = result({ toolCallId: 'same-id', toolName: 'audio_mix', content: [], isError: false }, {});
  assert.ok(owned?.content.some(row => row.text?.startsWith('[session-hooks]')));
  assert.equal(result({ toolCallId: 'same-id', toolName: 'audio_mix', content: [], isError: false }, {}), undefined);
  call({ toolCallId: 'late', toolName: 'media_pipeline', input: {} });
  handlers.get('session_switch')();
  assert.equal(result({ toolCallId: 'late', toolName: 'media_pipeline', content: [], isError: false }, {}), undefined);
});

test('a missing path reported by an extension tool or bash gets the nearest-folder hint core tools give', () => {
  const { missingPathFromError, CORE_PATH_HINT_TOOLS } = hooksLib;
  assert.equal(missingPathFromError('/tmp/x/blender/scripts/tide.py does not exist'), '/tmp/x/blender/scripts/tide.py');
  assert.equal(missingPathFromError("ENOENT: no such file or directory, open 'out/a.png'"), 'out/a.png');
  assert.equal(missingPathFromError("[Errno 2] No such file or directory: 'data/in.csv'"), 'data/in.csv');
  assert.equal(missingPathFromError("ls: cannot access 'docs/x': No such file or directory"), 'docs/x');
  assert.equal(missingPathFromError('cat: notes/todo.md: No such file or directory'), 'notes/todo.md');
  assert.equal(missingPathFromError('Nearest existing directory: /tmp\n/tmp/a/b does not exist'), undefined, 'an annotated error is left alone');
  assert.equal(missingPathFromError('the session does not exist'), undefined, 'prose is not a path');
  assert.ok(CORE_PATH_HINT_TOOLS.has('read') && !CORE_PATH_HINT_TOOLS.has('blender_run'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-path-hint-'));
  try {
    fs.mkdirSync(path.join(dir, 'tide', 'blender', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tide', 'blender', 'scripts', 'tide-gauge.py'), '');
    const handlers = new Map();
    registerHooks({ on: (name, fn) => handlers.set(name, fn), events: { emit() {} } });
    const call = handlers.get('tool_call'), result = handlers.get('tool_result');
    const missing = path.join(dir, 'blender', 'scripts', 'tide-gauge.py');
    const event = { toolCallId: 'b1', toolName: 'blender_run', input: {}, isError: true, content: [{ type: 'text', text: `${missing} does not exist` }] };
    call(event);
    const out = result(event, { cwd: dir });
    const texts = out.content.map(row => row.text);
    assert.match(texts[1], /Nearest existing directory: /);
    assert.match(texts[1], /tide\/blender\/scripts\/tide-gauge\.py/, 'the same file found elsewhere is suggested');
    assert.ok(texts.at(-1).startsWith('[session-hooks]'), 'the recovery line still follows');
    const repeat = { ...event, toolCallId: 'b2' };
    call(repeat);
    assert.equal(result(repeat, { cwd: dir }).content.length, 2, 'the hint repeats per error; the one-time recovery line does not');
    const core = { toolCallId: 'r1', toolName: 'read', input: {}, isError: true, content: [{ type: 'text', text: `${missing} does not exist` }] };
    call(core);
    assert.equal(result(core, { cwd: dir }), undefined, 'core tools carry their own hint');
    const present = { toolCallId: 'b3', toolName: 'bash', input: { command: 'cat x' }, isError: true, content: [{ type: 'text', text: `cat: ${path.join(dir, 'tide')}: No such file or directory` }] };
    call(present);
    assert.equal(result(present, { cwd: dir }), undefined, 'a path that exists now gets no hint');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('offline hook compatibility checks retain the current completion acknowledgement contract', () => {
  const output = execFileSync(process.execPath, [path.join(agent, 'scripts/compatibility/hook-lifecycle-integrity-test.mjs')], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, PI_LOCAL_LM: 'off' },
  });
  assert.match(output, /PASS SDK\/CLI hook cancellation/);
});

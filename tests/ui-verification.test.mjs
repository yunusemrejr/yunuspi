import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import registerArt from '../agent/extensions/art-direction.ts';
import registerRender from '../agent/extensions/render-and-wait.ts';
import registerDesign from '../agent/extensions/design-studio.ts';
import { collectVerificationReceipts } from '../agent/extensions/lib/continuation-notice.ts';

const good = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Customer contact</title><style>
html,body{margin:0;background:#f4f6f8;color:#14223a;font:16px/1.5 Arial}main{max-width:68rem;margin:auto;padding:24px;display:grid;gap:24px}h1{font-size:32px;line-height:1.2;margin:0}form{display:grid;gap:12px;max-width:32rem}input,button{box-sizing:border-box;font:inherit;min-height:44px;width:100%;padding:8px 12px}button{background:#173c68;color:white;border:0}input:focus-visible,button:focus-visible{outline:3px solid #175fa7;outline-offset:3px}@media(min-width:700px){main{grid-template-columns:1fr 1fr;align-items:start}}@media(prefers-reduced-motion:reduce){*{animation:none!important}}
</style><main><header><h1>Customer contact</h1><p>Save the email address used for order updates.</p></header><form onsubmit="event.preventDefault();document.querySelector('#result').textContent='Contact saved'"><label for="email">Email address</label><input id="email" type="email" required><button>Save contact</button><p id="result" role="status"></p></form></main>`;
const bad = `<!doctype html><title>Broken contact</title><style>html,body{margin:0;background:white;color:black;font:16px Arial}main{min-width:760px}.low{color:#aaa}button{width:16px;height:16px}</style><main><h1>Contact</h1><p class="low">Order updates</p><img src="/missing.png"><button></button><svg aria-hidden="true" width="24" height="24"><use href="#missing"/><path id="duplicate" d="M0 0h4v4z"/><path id="duplicate" d="M8 0h4v4z"/></svg></main><script>throw Error('fixture-render-failure')</script>`;

async function fixture(t, input = ['text']) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'yunus-ui-check-'));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = path.join(cwd, 'agent');
  await fs.writeFile(path.join(cwd, 'index.html'), good);
  const server = createServer(async (request, response) => {
    if (request.url === '/missing.png') { response.writeHead(404); response.end(); return; }
    if (request.url === '/redirect') { response.writeHead(302, { location: 'http://workspace.localhost/index.html?from=redirect' }); response.end(); return; }
    if (request.url === '/steer') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Steer</title><script>opener.location = "http://workspace.localhost/index.html?from=popup";</script>'); return; }
    if (request.url === '/saved') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Saved contact</title><p id="result" role="status">Contact saved</p>'); return; }
    response.writeHead(200, { 'content-type': 'text/html' }); response.end(request.url === '/broken' ? bad : await fs.readFile(path.join(cwd, 'index.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tools = new Map(), handlers = new Map(), events = new Map(), messages = [], entries = [];
  const pi = { registerTool: tool => tools.set(tool.name, tool), on: (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    appendEntry: (type, data) => entries.push({ type, data }), sendMessage: async message => messages.push(message),
    events: { on: (name, fn) => { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); }, emit: (name, data) => { for (const fn of events.get(name) ?? []) void fn(data); entries.push({ type: name, data }); } } };
  const ctx = { cwd, model: { input }, sessionManager: { getSessionId: () => 'ui-fixture' }, hasPendingMessages: () => false };
  registerArt(pi); registerRender(pi); registerDesign(pi);
  const fire = async (name, event, context = ctx) => { let result; for (const fn of handlers.get(name) ?? []) result = await fn(event, context) ?? result; return result; };
  await fire('session_start', {});
  let id = 0;
  const run = async (name, args) => { const toolCallId = `call-${++id}`; await fire('tool_call', { toolCallId, toolName: name, input: args }); const result = await tools.get(name).execute(toolCallId, args, undefined, undefined, ctx); await fire('tool_result', { toolCallId, toolName: name, input: args, ...result, isError: false }); return result; };
  const change = async (file, content) => { await fs.writeFile(path.join(cwd, file), content); const toolCallId = `write-${++id}`; await fire('tool_call', { toolCallId, toolName: 'write', input: { path: file, content } }); await fire('tool_result', { toolCallId, toolName: 'write', input: { path: file, content }, isError: false, content: [] }); };
  t.after(async () => { await fire('session_shutdown', {}); await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await fs.rm(cwd, { recursive: true, force: true }); });
  return { cwd, ctx, fire, run, change, messages, entries, tools, emit: pi.events.emit, url: `http://127.0.0.1:${server.address().port}/` };
}

test('real responsive captures expose broken native controls, assets, contrast and runtime evidence', { timeout: 150000 }, async t => {
  const f = await fixture(t);
  const result = (await f.run('ui_explore', { source: f.url + 'broken' })).details;
  assert.equal(result.status, 'fail'); assert.deepEqual(result.coverage.widths, [320, 390, 834, 1440]);
  assert.ok(result.cells[0].dom.scopeOverflowPx >= 400);
  assert.equal(result.cells[0].dom.missingAlt, 1); assert.equal(result.cells[0].dom.brokenImages, 1);
  assert.equal(result.cells[0].dom.controls, 1); assert.equal(result.cells[0].dom.unnamedControls, 1);
  assert.ok(result.cells[0].design.contrast.belowThreshold > 0);
  assert.equal(result.cells[0].design.svg.unresolvedRefs, 1); assert.equal(result.cells[0].design.svg.duplicateIds, 1);
  assert.ok(result.cells.some(cell => cell.errors.includes('page script error (message omitted)')));
  assert.ok(result.preview); assert.equal(result.coverage.visualJudgment, 'pending');
  assert.ok((await fs.stat(path.resolve(f.cwd, result.preview))).size > 0);
});

test('native tools enforce current visual provenance and actual keyboard/state checks without skills', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  await f.change('index.html', good);
  assert.ok(f.entries.some(entry => entry.type === 'adaptive-pipeline-selection' && entry.data.names.includes('ui_explore')));
  const first = await f.fire('context', { messages: [{ role: 'user', content: 'Improve the contact page' }] });
  assert.ok(first.messages.some(m => m.customType === 'creative-verification-context'));
  await f.fire('agent_settled', {}); await f.fire('agent_settled', {}); await f.fire('agent_settled', {});
  assert.equal(f.messages.length, 2, 'automatic verification follows up without an endless loop');
  const matrix = await f.run('ui_explore', { source: f.url, entrypoint: 'index.html', states: ['default', 'reduced-motion'] });
  assert.equal(matrix.details.status, 'measured'); assert.ok(matrix.details.cells.every(c => c.design.motion.reducedMotion === (c.state === 'reduced-motion')));
  const matrixSummary = JSON.parse(matrix.content.find(part => part.type === 'text').text);
  assert.deepEqual(matrixSummary.coverage, matrix.details.coverage);
  assert.deepEqual(matrixSummary.findings, matrix.details.findings);
  assert.deepEqual(matrixSummary.cells[0].errors ?? [], matrix.details.cells[0].errors, 'a capture with no errors carries no empty list');
  assert.equal(matrixSummary.cells[0].typography, undefined);
  assert.equal(matrixSummary.cells[0].design?.typography ?? matrixSummary.shared.design?.typography, undefined);
  assert.equal(matrixSummary.shared.dom.documentType, 'text/html', 'what every capture shares is stated once');
  assert.ok(matrixSummary.cells.every(cell => cell.viewport && cell.file && cell.ok === true));
  assert.ok(JSON.stringify(matrixSummary).length < JSON.stringify(matrix.details).length / 3, 'the reply is a fraction of the saved report');
  const savedMatrix = JSON.parse(await fs.readFile(path.resolve(f.cwd, matrix.details.report), 'utf8'));
  assert.deepEqual(savedMatrix.cells, matrix.details.cells, 'the saved report retains full measurements');
  const rendered = await f.run('visual_review', { action: 'run', source: f.url, entrypoint: 'index.html' });
  const review = rendered.details;
  const summary = JSON.parse(rendered.content.find(part => part.type === 'text').text);
  assert.ok(summary.report.endsWith('review.json'));
  assert.deepEqual(summary.sections, review.sections, 'all rubric sections and their evidence remain on the wire');
  assert.equal(summary.design.typography, undefined);
  assert.ok(review.design.typography.length > 0, 'native consumers retain the full measurements');
  assert.ok(review.runId); assert.ok(review.dom.controls >= 2);
  assert.equal(rendered.content.some(c => c.type === 'image'), false);
  const verdict = review.sections.map(section => ({ id: section.id, verdict: 'PASS', evidence: [`${section.id}: inspected the current contact form, responsive captures and keyboard task.`] }));
  await assert.rejects(f.run('visual_review', { action: 'record', source: f.url, runId: review.runId, verdict }), /delivered pixels/);
  const parentModel = f.ctx.model;
  const vision = { id: 'fixture-vision', provider: 'fixture', input: ['text', 'image'], maxTokens: 2048 };
  let visionCalls = 0;
  f.ctx.modelRegistry = {
    find: (provider, model) => provider === vision.provider && model === vision.id ? vision : undefined,
    getApiKeyAndHeaders: async () => ({ apiKey: ['synthetic', 'fixture'].join('-') }),
    completeSimple: async (model, context) => {
      visionCalls++; assert.equal(model.id, vision.id);
      assert.equal(context.messages[0].content.filter(part => part.type === 'image').length, 2);
      return { content: [{ type: 'text', text: 'The supplied capture and responsive sheet contain the customer form. Main content remains legible in the narrow column; desktop places the form beside the heading. This fixture transport tests provenance, not aesthetic capability.' }], stopReason: 'stop' };
    },
  };
  // Vision runs on the session model and no other: a text-only session cannot look, and says so.
  const images = { paths: [review.file, matrix.details.preview], prompt: 'Inspect the current page and every responsive cell.' };
  await assert.rejects(f.run('image_understand', images), /does not accept images/);
  assert.equal(visionCalls, 0, 'a text-only session model never reaches a transport');
  f.ctx.model = vision;
  const observed = await f.run('image_understand', images);
  assert.equal(observed.details.images.length, 2); assert.equal(visionCalls, 1);
  assert.equal(f.ctx.model, vision, 'the session model is used and left unchanged');
  f.ctx.model = parentModel;
  assert.equal(matrix.details.previewOrder.length, 8, 'all captured states reach the responsive contact sheet');
  assert.ok(matrix.details.previewOrder.some(cell => cell.state === 'reduced-motion' && cell.row === 1));
  const browser = await f.run('browser_session', { action: 'open', url: f.url });
  const session = browser.details.session;
  try {
    await f.run('browser_session', { action: 'press', session, key: 'Tab' });
    await f.run('browser_session', { action: 'fill', session, selector: '#email', text: 'contact@example.com' });
    await f.run('browser_session', { action: 'click', session, selector: 'button' });
    const checked = await f.run('browser_session', { action: 'verify', session, selector: '#result', text: 'Contact saved' });
    assert.equal(checked.details.verification.matches, true);
  } finally { await f.run('browser_session', { action: 'close', session }); }
  await assert.rejects(f.run('visual_review', { action: 'record', runId: 'unknown-run', verdict }), /matching visual_review run/);
  await assert.rejects(f.run('visual_review', { action: 'record', source: f.url + 'wrong', runId: review.runId, verdict }), /matching/);
  const recorded = await f.run('visual_review', { action: 'record', runId: review.runId, verdict });
  assert.equal(recorded.details.recorded.source, f.url, 'runId alone recovers the exact reviewed source');
  assert.deepEqual((await f.run('visual_review', { action: 'status' })).details.gaps, []);
  assert.deepEqual(collectVerificationReceipts(10, f.ctx.sessionManager), []);
  await f.change('style.css', 'body{color:#aaa}');
  await assert.rejects(f.run('visual_review', { action: 'record', source: f.url, runId: review.runId, verdict }), /dependencies changed/);
  assert.ok((await f.run('visual_review', { action: 'status' })).details.gaps.length > 0);
  const detailed = await f.run('ui_explore', { source: f.url, viewports: ['mobile'], detail: true });
  const full = JSON.parse(detailed.content.find(part => part.type === 'text').text);
  assert.deepEqual(full.cells, detailed.details.cells, 'detail:true exposes the saved measurements inline');
  assert.ok(full.cells[0].design.typography.length > 0);
});

test('saved SVG gets automatic structural review and session switches cannot consume old tool results', async t => {
  const f = await fixture(t);
  await f.change('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><use href="#missing"/></svg>');
  assert.ok(f.entries.some(entry => entry.type === 'creative-svg-auto-v1'));
  assert.ok((await f.run('visual_review', { action: 'status' })).details.gaps.some(line => line.includes('SVG geometry')));
  await f.fire('tool_call', { toolCallId: 'late', toolName: 'write', input: { path: 'index.html', content: good } });
  const other = { ...f.ctx, sessionManager: { getSessionId: () => 'different-session' } };
  await f.fire('session_switch', {}, other);
  await f.fire('tool_result', { toolCallId: 'late', toolName: 'write', content: [], isError: false }, other);
  assert.deepEqual(collectVerificationReceipts(10, other.sessionManager), []);
});

test('an in-flight capture cannot reinstall an old session continuation after a switch', async t => {
  const f = await fixture(t);
  await f.change('index.html', good);
  const pending = f.tools.get('visual_review').execute('late-capture', { action: 'run', source: f.url }, undefined, undefined, f.ctx);
  const rejected = assert.rejects(pending, /session changed/);
  const other = { ...f.ctx, sessionManager: { getSessionId: () => 'new-session' } };
  await f.fire('session_switch', {}, other);
  await rejected;
  assert.deepEqual(collectVerificationReceipts(10, other.sessionManager), []);
  const status = await f.tools.get('visual_review').execute('new-status', { action: 'status' }, undefined, undefined, other);
  assert.deepEqual(status.details.gaps, []);
});

test('native shell observations settle before completion even when the event bus does not await listeners', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'shell-page.html'), good);
  f.emit('project-source-observed', { ctx: f.ctx, revision: 1, tree: 'shell-tree', complete: true, paths: ['shell-page.html'] });
  await f.fire('agent_settled', {});
  assert.equal(f.messages.length, 1);
  assert.ok(f.messages[0].content.includes('shell-page.html'));
  const gaps = (await f.run('visual_review', { action: 'status' })).details.gaps;
  assert.ok(gaps.some(line => line.startsWith('shell-page.html')));
});

test('browser task evidence follows a redirect in its own tab and retains private query-state identity', { timeout: 120000 }, async t => {
  const f = await fixture(t, ['text', 'image']);
  await f.change('index.html', good.replace("document.querySelector('#result').textContent='Contact saved'", "location.href='/saved'"));
  const source = f.url + '?screen=contact#form';
  await f.run('ui_explore', { source, entrypoint: 'index.html', viewports: ['narrow', 'desktop'] });
  const review = (await f.run('visual_review', { action: 'run', source, entrypoint: 'index.html' })).details;
  const verdict = review.sections.map(section => ({ id: section.id, verdict: 'PASS', evidence: [`${section.id}: current capture, responsive sheet and contact-task result inspected in the fixture.`] }));
  await f.run('visual_review', { action: 'record', source, runId: review.runId, verdict });
  const browser = (await f.run('browser_session', { action: 'open', url: source })).details;
  const session = browser.session, tab = browser.tab;
  try {
    assert.match(browser.pageIdentity, /^[a-f0-9]{64}$/); assert.equal(browser.url.includes('screen='), false);
    await f.run('browser_session', { action: 'press', session, key: 'Tab' });
    await f.run('browser_session', { action: 'new_tab', session, url: f.url + 'saved' });
    await f.run('browser_session', { action: 'verify', session, selector: '#result', text: 'Contact saved' });
    assert.ok((await f.run('visual_review', { action: 'status' })).details.gaps.some(line => line.includes('still needs a matching verify')), 'another tab cannot approve the contact task');
    await f.run('browser_session', { action: 'switch_tab', session, tab });
    await f.run('browser_session', { action: 'fill', session, selector: '#email', text: 'contact@example.com' });
    await f.run('browser_session', { action: 'press', session, key: 'Enter' });
    const checked = (await f.run('browser_session', { action: 'verify', session, selector: '#result', text: 'Contact saved' })).details;
    assert.equal(checked.verification.matches, true); assert.notEqual(checked.pageIdentity, browser.pageIdentity);
    assert.deepEqual((await f.run('visual_review', { action: 'status' })).details.gaps, []);
    await f.fire('input', { source: 'user', text: 'Update the README wording.' });
    f.emit('project-source-observed', { ctx: f.ctx, revision: 2, tree: 'documentation-tree', complete: true, paths: ['index.html'] });
    assert.deepEqual((await f.run('visual_review', { action: 'status' })).details.gaps, [], 'completed UI work does not reopen for an unrelated request');
    await f.change('index.html', good);
    assert.ok((await f.run('visual_review', { action: 'status' })).details.gaps.length > 0, 'a real subsequent UI change receives fresh checks');
  } finally { await f.run('browser_session', { action: 'close', session }); }
});

test('a file written while its page is being captured sends the capture back for another run', { timeout: 150000 }, async t => {
  const f = await fixture(t, ['text', 'image']);
  await fs.writeFile(path.join(f.cwd, 'late.js'), 'document.documentElement.dataset.late = "1"; fetch("data.json").catch(() => {});');
  await fs.writeFile(path.join(f.cwd, 'data.json'), '{"rows":1}');
  // The file's time says it was written after the capture began, as a write that lands mid-capture would.
  const ahead = new Date(Date.now() + 120000);
  await fs.utimes(path.join(f.cwd, 'late.js'), ahead, ahead);
  await f.change('index.html', good + '<script src="late.js"></script>');
  const stale = async () => (await f.run('visual_review', { action: 'status' })).details.gaps.some(line => line.includes('run ui_explore'));
  await f.run('ui_explore', { source: 'index.html', viewports: ['narrow', 'desktop'] });
  assert.equal(await stale(), true, 'the capture may not have seen the bytes now on disk');
  await f.run('ui_explore', { source: 'index.html', viewports: ['narrow', 'desktop'] });
  assert.equal(await stale(), false, 'the next capture is of the file as it now is');
  await fs.writeFile(path.join(f.cwd, 'data.json'), '{"rows":2}');
  assert.equal(await stale(), true, 'data the page asks for counts, though a capture serves no data files');
});

test('a workspace page opens by its path, and batched key presses and checks on it are interaction proof without a server', { timeout: 150000 }, async t => {
  const f = await fixture(t, ['text', 'image']);
  await fs.writeFile(path.join(f.cwd, 'app.js'), 'document.documentElement.dataset.app = "loaded";');
  await f.change('index.html', good + '<script src="app.js"></script>');
  await f.run('ui_explore', { source: 'index.html', viewports: ['narrow', 'desktop'] });
  const review = (await f.run('visual_review', { action: 'run', source: 'index.html' })).details;
  const verdict = review.sections.map(section => ({ id: section.id, verdict: 'PASS', evidence: [`${section.id}: current capture and responsive sheet of the contact form inspected in the fixture.`] }));
  await f.run('visual_review', { action: 'record', runId: review.runId, verdict });
  const gaps = async () => (await f.run('visual_review', { action: 'status' })).details.gaps;
  assert.ok((await gaps()).some(line => line.includes('key press') && line.includes('a matching verify')), 'the gap names both missing actions');
  const opened = (await f.run('browser_session', { action: 'open', url: 'index.html' })).details;
  const session = opened.session;
  try {
    assert.equal(opened.url, 'http://workspace.localhost/index.html');
    const own = (await f.run('browser_session', { action: 'evaluate', session, script: 'return document.documentElement.dataset.app' })).details;
    assert.equal(own.evaluation.text, '"loaded"', 'files beside the page are answered from the workspace');
    await fs.writeFile(path.join(f.cwd, '.env'), 'hidden'); await fs.writeFile(path.join(f.cwd, 'server.key'), 'hidden');
    const handed = (await f.run('browser_session', { action: 'evaluate', session, script: `return (await Promise.all(['app.js', '.env', 'server.key', 'absent.js'].map(async name => (await fetch(name)).status))).join(' ')` })).details;
    assert.equal(handed.evaluation.text, '"200 404 404 404"', 'hidden files and key material are not handed to a page');
    const resized = (await f.run('browser_session', { action: 'batch', session, steps: [{ action: 'viewport', width: 390, height: 800 }, { action: 'reload' }] })).details;
    assert.equal(resized.pageState.layout.viewportWidth, 390, 'a batch can resize and reload in one call');
    const misfit = await f.tools.get('browser_session').execute('misfit', { action: 'batch', session, steps: [{ action: 'viewport', viewport: { width: 390, height: 800 } }] }, undefined, undefined, f.ctx);
    assert.match(misfit.details.failure.reason, /^Viewport dimensions must be 240–2560 pixels/, 'a faulty step is answered with what is wrong with it');
    assert.match(misfit.content.map(part => part.text ?? '').join(''), /Viewport dimensions must be 240–2560 pixels/, 'and the model reads it');
    const unknown = await f.tools.get('browser_session').execute('unknown', { action: 'batch', session, steps: [{ action: 'screenshot' }] }, undefined, undefined, f.ctx);
    assert.match(unknown.details.failure.reason, /A batch takes navigate, reload, viewport/, 'an unsupported step lists what a batch takes');
    await f.run('browser_session', { action: 'press', session, key: 'Tab' });
    assert.ok((await gaps()).some(line => line.includes('a matching verify') && !line.includes('key press')), 'only the action still missing is named');
    const batch = (await f.run('browser_session', { action: 'batch', session, steps: [
      { action: 'fill', selector: '#email', text: 'contact@example.com' }, { action: 'press', key: 'Enter' },
      { action: 'verify', selector: '#result', text: 'Contact saved' } ] })).details;
    assert.equal(batch.batch.stepResults.at(-1).matches, true);
    assert.deepEqual(await gaps(), [], 'a matching verify inside a batch counts as it does alone');
    await fs.writeFile(path.join(f.cwd, 'LICENSE.txt'), 'A licence the page never asks for.');
    f.emit('project-source-observed', { ctx: f.ctx, revision: 11, tree: 'tree-11', complete: true, paths: [] });
    assert.deepEqual(await gaps(), [], 'a change to files the reviewed page never asked for leaves its evidence standing');
    await fs.writeFile(path.join(f.cwd, 'app.js'), 'document.documentElement.dataset.app = "changed";');
    assert.ok((await gaps()).length > 0, 'a changed file the page loads makes the evidence stale');
    const again = (await f.run('ui_explore', { source: opened.url, viewports: ['narrow', 'desktop'] })).details;
    assert.equal(again.source, 'index.html', 'the review tools read the browser URL of a workspace page as the file');
    const outside = await f.tools.get('browser_session').execute('outside', { action: 'navigate', session, url: '/etc/hostname' }, undefined, undefined, f.ctx);
    assert.equal(outside.details.failure.kind, 'invalid-url', 'a file outside the workspace does not open');
    const stray = await f.tools.get('browser_session').execute('stray', { action: 'batch', session, steps: [{ action: 'navigate', url: 'absent.html' }] }, undefined, undefined, f.ctx);
    assert.match(stray.details.failure.nextStep, /^batch step 1: Use an HTTP\(S\) URL/, 'a batch step that names no page is told what a page address is');
    await f.run('browser_session', { action: 'navigate', session, url: f.url });
    const foreign = (await f.run('browser_session', { action: 'evaluate', session, script: `return await new Promise(done => { const tag = document.createElement('script'); tag.src = 'http://workspace.localhost/app.js'; tag.onload = () => done('served'); tag.onerror = () => done('refused'); document.head.append(tag); })` })).details;
    assert.equal(foreign.evaluation.text, '"refused"', 'a page from elsewhere cannot pull workspace files through the origin');
    await f.run('browser_session', { action: 'evaluate', session, script: `setTimeout(() => { location.href = 'http://workspace.localhost/index.html?from=web'; }, 0); return true` });
    const gone = await f.tools.get('browser_session').execute('left', { action: 'wait', session, kind: 'function', script: `return !location.href.startsWith(${JSON.stringify(f.url)})`, timeoutMs: 5000 }, undefined, undefined, f.ctx);
    const sent = await f.tools.get('browser_session').execute('sent', { action: 'evaluate', session, script: 'return [location.href.startsWith("http://workspace.localhost/"), !!document.querySelector("#email")].join(" ")' }, undefined, undefined, f.ctx);
    assert.notEqual(sent.details?.evaluation?.text, '"true true"', 'nor send the tab to a workspace page');
    const back = (await f.run('browser_session', { action: 'navigate', session, url: 'index.html' })).details;
    assert.equal(back.url, 'http://workspace.localhost/index.html', 'the agent itself still opens it');
    const call = (id, params) => f.tools.get('browser_session').execute(id, { session, ...params }, undefined, undefined, f.ctx);
    const said = (...replies) => replies.some(reply => /refused/.test(reply?.details?.workspacePageRefused ?? ''));
    assert.ok(said(gone, sent, { details: back }), 'and the next reply says a move to a workspace page was refused');
    const redirected = await call('redirected', { action: 'navigate', url: f.url + 'redirect' });
    assert.equal(redirected.details.failure?.kind, 'unreachable', 'a redirect from another server to a workspace address reaches nothing, whatever listens on this machine');
    await f.run('browser_session', { action: 'navigate', session, url: 'index.html' });
    await f.run('browser_session', { action: 'evaluate', session, script: `window.open(${JSON.stringify(f.url + 'steer')}); return true` });
    const moved = await call('moved', { action: 'wait', kind: 'function', script: 'return !location.href.startsWith("http://workspace.localhost/")', timeoutMs: 5000 });
    const steered = await call('steered', { action: 'tabs' });
    assert.ok(said(moved, steered), 'a web page that a workspace page opened cannot steer it to a workspace page of its choosing');
    assert.ok(!steered.details.tabs.find(tab => tab.active).url.startsWith('http://workspace.localhost/'), 'the tab it tried to move shows no workspace page');
  } finally { await f.run('browser_session', { action: 'close', session }); }
});

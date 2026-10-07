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
  const rendered = await f.run('visual_review', { action: 'run', source: f.url, entrypoint: 'index.html' });
  const review = rendered.details;
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
  const observed = await f.run('image_understand', { paths: [review.file, matrix.details.preview], provider: vision.provider, model: vision.id, prompt: 'Inspect the current page and every responsive cell.' });
  assert.equal(observed.details.images.length, 2); assert.equal(visionCalls, 1);
  assert.equal(f.ctx.model, parentModel); assert.deepEqual(f.ctx.model.input, ['text']);
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
  await f.run('visual_review', { action: 'record', source: f.url, runId: review.runId, verdict });
  assert.deepEqual((await f.run('visual_review', { action: 'status' })).details.gaps, []);
  assert.deepEqual(collectVerificationReceipts(10, f.ctx.sessionManager), []);
  await f.change('style.css', 'body{color:#aaa}');
  await assert.rejects(f.run('visual_review', { action: 'record', source: f.url, runId: review.runId, verdict }), /dependencies changed/);
  assert.ok((await f.run('visual_review', { action: 'status' })).details.gaps.length > 0);
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
    assert.ok((await f.run('visual_review', { action: 'status' })).details.gaps.some(line => line.includes('user task')), 'another tab cannot approve the contact task');
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

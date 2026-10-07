import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import registerArt from '../agent/extensions/art-direction.ts';
import registerRender from '../agent/extensions/render-and-wait.ts';
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
    response.writeHead(200, { 'content-type': 'text/html' }); response.end(request.url === '/broken' ? bad : await fs.readFile(path.join(cwd, 'index.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tools = new Map(), handlers = new Map(), events = new Map(), messages = [], entries = [];
  const pi = { registerTool: tool => tools.set(tool.name, tool), on: (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    appendEntry: (type, data) => entries.push({ type, data }), sendMessage: async message => messages.push(message),
    events: { on: (name, fn) => { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); }, emit: (name, data) => { for (const fn of events.get(name) ?? []) void fn(data); entries.push({ type: name, data }); } } };
  const ctx = { cwd, model: { input }, sessionManager: { getSessionId: () => 'ui-fixture' }, hasPendingMessages: () => false };
  registerArt(pi); registerRender(pi);
  const fire = async (name, event, context = ctx) => { let result; for (const fn of handlers.get(name) ?? []) result = await fn(event, context) ?? result; return result; };
  await fire('session_start', {});
  let id = 0;
  const run = async (name, args) => { const toolCallId = `call-${++id}`; await fire('tool_call', { toolCallId, toolName: name, input: args }); const result = await tools.get(name).execute(toolCallId, args, undefined, undefined, ctx); await fire('tool_result', { toolCallId, toolName: name, input: args, ...result, isError: false }); return result; };
  const change = async (file, content) => { await fs.writeFile(path.join(cwd, file), content); const toolCallId = `write-${++id}`; await fire('tool_call', { toolCallId, toolName: 'write', input: { path: file, content } }); await fire('tool_result', { toolCallId, toolName: 'write', input: { path: file, content }, isError: false, content: [] }); };
  t.after(async () => { await fire('session_shutdown', {}); await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await fs.rm(cwd, { recursive: true, force: true }); });
  return { cwd, ctx, fire, run, change, messages, entries, tools, url: `http://127.0.0.1:${server.address().port}/` };
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
  f.ctx.model.input = ['text', 'image'];
  for (const image of [review.file, matrix.details.preview]) {
    const bytes = await fs.readFile(path.resolve(f.cwd, image));
    await f.fire('tool_call', { toolCallId: image, toolName: 'read', input: { path: image } });
    await f.fire('tool_result', { toolCallId: image, toolName: 'read', isError: false, content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] });
  }
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

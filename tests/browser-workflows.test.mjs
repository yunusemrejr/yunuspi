import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'extensions/lib/browser-session.ts')));
const { registerBrowserSession } = await import(pathToFileURL(path.join(agent, 'extensions/lib/browser-session.ts')));

test('browser workflows keep tab/ref ownership, recover asynchronous UI and request human answers', { timeout: 90000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-workflows-'));
  const fixture = `<!doctype html><title>Browser workflow fixture</title><style>body{font:18px sans-serif;padding:20px}button,input{font:inherit;margin:8px}</style>
    <h1>Workflow fixture</h1><label>Search<input id="search"></label><input type="password" value="SECRET_FIXTURE_PASSWORD">
    <textarea hidden>SECRET_HIDDEN_TEXT</textarea><label>Draft<textarea>SECRET_DRAFT_VALUE</textarea></label><div id="article">Rendered research alpha beta gamma</div>
    <button id="replace" onclick="this.outerHTML='<button id=replace onclick=window.wrong=true>Replacement</button>'">Replace me</button>
    <button id="popup" onclick="window.open('/popup')">Open detail</button>
    <button id="prompt" onclick="document.querySelector('#article').textContent=prompt('Fixture prompt')??'dismissed'">Prompt</button>
    <button id="slow" onclick="setTimeout(()=>{document.querySelector('#article').textContent='Asynchronous result';window.ready=true;history.pushState({},'', '/ready')},200)">Start async</button>
    <button id="captcha" onclick="document.querySelector('#article').textContent='Verify you are human';document.querySelector('#challenge').hidden=false">Show challenge</button>
    <label id="challenge" hidden>Challenge answer<input id="answer" oninput="if(this.value==='fixture answer'){document.querySelector('#article').textContent='Verified';document.querySelector('#challenge').hidden=true}"></label>
    <iframe id="embedded" src="/frame"></iframe><div id="shadow"></div>
    <script>const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});shadow.innerHTML='<button>Shadow action</button>';shadow.firstChild.onclick=event=>event.target.textContent='Shadow saved';</script>`;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/frame' ? '<button>Frame button</button>' : req.url === '/popup' ? '<h1>Popup detail</h1><script>console.error("Popup diagnostic")</script>' : fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let tool; const hooks = {};
  registerBrowserSession({ registerTool: value => tool = value, on: (name, fn) => hooks[name] = fn });
  const ctx = { cwd: scratch, model: { input: ['text', 'image'] }, sessionManager: { getSessionId: () => 'browser-workflow-fixture' } };
  const raw = (p, context = ctx, signal) => tool.execute('fixture', p, signal, undefined, context);
  let session;
  const call = async p => { const r = await raw({ session, ...p }); assert.notEqual(r.isError, true, JSON.stringify(r.details)); return r.details; };
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    let opened;
    try { opened = await raw({ action: 'open', url, visible: process.env.PI_BROWSER_VISIBLE === '1' }); }
    catch (error) { if (process.env.PI_BROWSER_REQUIRE === '1') throw error; t.skip('Chromium unavailable; PI_BROWSER_REQUIRE=1 makes it required'); return; }
    session = opened.details.session;
    const tab = opened.details.tab;
    const search = opened.details.targets.find(target => target.name === 'Search');
    assert.ok(search.ref);
    assert.doesNotMatch(JSON.stringify(opened), /SECRET_FIXTURE_PASSWORD|SECRET_HIDDEN_TEXT|SECRET_DRAFT_VALUE/);
    await call({ action: 'fill', ref: search.ref, text: 'typed through DOM reference' });
    assert.equal((await call({ action: 'verify', selector: '#search', text: 'typed through DOM reference' })).verification.matches, true);
    await call({ action: 'press', key: 'Control+A' });
    const fresh = await call({ action: 'snapshot' });
    const scoped = await call({ action: 'snapshot', ref: fresh.targets.find(row => row.name === 'Search').ref });
    assert.equal(scoped.targets.length, 1);
    const renamed = (await call({ action: 'snapshot' })).targets.find(row => row.name === 'Replace me').ref;
    await call({ action: 'evaluate', script: "document.querySelector('#replace').textContent='Changed meaning'; return true;" });
    assert.equal((await raw({ action: 'click', session, ref: renamed })).isError, true);
    await call({ action: 'evaluate', script: "document.querySelector('#replace').textContent='Replace me'; return true;" });
    const before = await call({ action: 'snapshot' });
    const replaced = before.targets.find(row => row.name === 'Replace me').ref;
    await call({ action: 'evaluate', script: "document.querySelector('#replace').outerHTML='<button id=replace onclick=window.wrong=true>Replacement</button>'; return true;" });
    const stale = await raw({ action: 'click', session, ref: replaced });
    assert.equal(stale.isError, true);
    assert.match(stale.details.failure.nextStep, /snapshot/);
    assert.equal(JSON.parse((await call({ action: 'evaluate', script: 'return !!window.wrong;' })).evaluation.text), false);
    const shadow = (await call({ action: 'snapshot' })).targets.find(row => row.name === 'Shadow action');
    await call({ action: 'click', ref: shadow.ref });
    assert.match((await call({ action: 'read' })).reading.text, /Shadow saved/);
    const frame = (await call({ action: 'snapshot' })).frames.find(frame => frame.url.endsWith('/frame')).frame;
    const inFrame = await call({ action: 'snapshot', frame });
    assert.ok(inFrame.targets.find(row => row.name === 'Frame button'));
    await call({ action: 'click', ref: inFrame.targets[0].ref });
    const marked = await call({ action: 'markers' });
    assert.ok(marked.output && marked.markers.length);
    if (process.env.PI_BROWSER_CAPTURE) fs.copyFileSync(marked.output, process.env.PI_BROWSER_CAPTURE);
    const marker = marked.markers.find(row => row.name === 'Search').id;
    await call({ action: 'fill', marker, text: 'marker input' });
    await call({ action: 'reload' });
    assert.equal((await raw({ action: 'click', session, marker })).isError, true);
    await call({ action: 'click', selector: '#popup' });
    const popup = (await call({ action: 'tabs' })).tabs.find(row => row.tab !== tab);
    assert.ok(popup);
    await call({ action: 'wait', tab: popup.tab, kind: 'text', text: 'Popup detail' });
    assert.ok((await call({ action: 'logs', tab: popup.tab, includeText: true })).logs.some(row => row.message === 'Popup diagnostic'));
    assert.ok(!(await call({ action: 'logs', tab, includeText: true })).logs.some(row => row.message === 'Popup diagnostic'));
    assert.equal((await raw({ action: 'inspect', session, tab: popup.tab, ref: search.ref })).isError, true);
    await call({ action: 'close_tab', tab: popup.tab });
    await call({ action: 'switch_tab', tab });
    await call({ action: 'dialog', mode: 'accept', text: 'supplied prompt answer' });
    await call({ action: 'click', selector: '#prompt' });
    assert.match((await call({ action: 'read', query: 'SUPPLIED PROMPT', maxChars: 100 })).reading.text, /supplied prompt answer/);
    await call({ action: 'click', selector: '#prompt' });
    assert.match((await call({ action: 'read' })).reading.text, /dismissed/);
    await call({ action: 'click', selector: '#slow' });
    await call({ action: 'wait', kind: 'function', script: 'return window.ready === true;', timeoutMs: 3000 });
    await call({ action: 'wait', kind: 'url', url: '**/ready' });
    await call({ action: 'wait', kind: 'text', text: 'Asynchronous result' });
    await call({ action: 'wait', kind: 'load', state: 'domcontentloaded' });
    const read = (await call({ action: 'read', maxChars: 100 })).reading;
    assert.equal(read.text.length, 100);
    assert.ok(read.hasMore);
    assert.doesNotMatch((await call({ action: "read" })).reading.text, /SECRET_DRAFT_VALUE|SECRET_HIDDEN_TEXT|SECRET_FIXTURE_PASSWORD/);
    assert.equal((await call({ action: 'read', offset: read.nextOffset, maxChars: 100 })).reading.offset, 100);
    assert.equal((await call({ action: 'read', query: 'absent fixture phrase' })).reading.found, false);
    const timed = await raw({ action: 'evaluate', session, timeoutMs: 100, script: 'await new Promise(()=>{});' });
    assert.equal(timed.isError, true);
    assert.equal(timed.details.failure.kind, 'timeout');
    assert.equal((await call({ action: 'evaluate', script: "return 'x'.repeat(3000000);", maxChars: 100 })).evaluation.text.length, 100);
    await call({ action: 'back' });
    await call({ action: 'forward' });
    const challenge = await call({ action: 'click', selector: '#captcha' });
    assert.equal(challenge.humanHelp.kind, 'verification');
    const relay = await raw({ action: 'request_help', session, reason: 'What answer is shown in this fixture?' });
    assert.equal(relay.details.humanHelp.status, 'awaiting_user');
    assert.equal(relay.details.lease.generation, challenge.lease.generation + 1, 'Parent-relayed help also renews the lease before returning the capture');
    let asked = false;
    const answer = await raw({ action: 'request_help', session, reason: 'What answer is shown in this fixture?' }, { ...ctx, hasUI: true, ui: { input: async (question, _, options) => { asked = true; assert.match(question, /Screenshot:/); assert.equal(options.timeout, 300000); const duplicate = await raw({ action: 'request_help', session, reason: 'Concurrent help' }); assert.equal(duplicate.details.humanHelp.status, 'awaiting_user'); return 'fixture answer'; } } });
    assert.ok(asked);
    assert.equal(answer.details.humanHelp.answer, 'fixture answer');
    await call({ action: 'fill', selector: '#answer', text: answer.details.humanHelp.answer });
    assert.equal((await call({ action: 'snapshot' })).humanHelp, null);
    const cancelled = await raw({ action: 'request_help', session, reason: 'Fixture cancellation' }, { ...ctx, hasUI: true, ui: { input: async () => undefined } });
    assert.equal(cancelled.details.humanHelp.status, 'cancelled');
    for (let n = 1; n < 8; n++) await call({ action: 'new_tab', url: url + '/popup' });
    assert.equal((await raw({ action: 'new_tab', session, url })).isError, true);
    for (const item of (await call({ action: 'tabs' })).tabs) await call({ action: 'close_tab', tab: item.tab });
    assert.deepEqual((await call({ action: 'tabs' })).tabs, []);
    await call({ action: 'new_tab', url });
    await call({ action: 'evaluate', script: "localStorage.setItem('tab-shared','yes'); return true;" });
    const shared = await call({ action: 'new_tab', url });
    assert.equal(JSON.parse((await call({ action: 'evaluate', tab: shared.tab, script: "return localStorage.getItem('tab-shared');" })).evaluation.text), 'yes');
    const session2 = (await raw({ action: 'open', url })).details.session;
    assert.equal(JSON.parse((await raw({ session: session2, action: 'evaluate', script: 'return localStorage.getItem("tab-shared");' })).details.evaluation.text), null);
    await call({ action: 'close' });
    assert.ok(!fs.existsSync(marked.output));
  } finally {
    await hooks.session_shutdown();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

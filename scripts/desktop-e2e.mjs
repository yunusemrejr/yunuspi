#!/usr/bin/env node
// Real Electron + owned RPC core, with an isolated loopback provider. No live
// credentials, inference services, private projects or user sessions are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { _electron } from 'playwright';
import { SessionStore } from '../desktop/session-store.mjs';
import { SessionManager } from '../core/coding-agent/dist/core/session-manager.js';
import { activePiProcesses } from '../agent/scripts/lib/active-core-processes.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-desktop-e2e-'));
const output = path.resolve(process.env.YUNUSPI_E2E_OUTPUT || path.join(os.tmpdir(), 'yunuspi-desktop-evidence'));
fs.mkdirSync(output, { recursive: true });
const agentDir = path.join(scratch, 'agent'), dataDir = path.join(scratch, 'desktop');
const alpha = path.join(scratch, 'project-alpha'), beta = path.join(scratch, 'project-beta');
for (const directory of [agentDir, alpha, beta, path.join(agentDir, 'extensions')]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(alpha, 'sample.txt'), 'The desktop tool fixture is readable.\n');
const requests = [];
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body), user = [...input.messages].reverse().find(m => m.role === 'user');
  const prompt = typeof user?.content === 'string' ? user.content : (user?.content ?? []).map(p => p.text || '').join('');
  requests.push(prompt);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = delta => res.write(`data: ${JSON.stringify({ id: 'synthetic-desktop', object: 'chat.completion.chunk', model: 'desktop-fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  const finish = reason => {
    res.write(`data: ${JSON.stringify({ id: 'synthetic-desktop', choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 25, completion_tokens: 30, total_tokens: 55 } })}\n\ndata: [DONE]\n\n`); res.end();
  };
  // A turn of several steps: narration and one read per request, the second read failing, then the answer.
  if (prompt.includes('STEPS')) {
    const ran = input.messages.slice(input.messages.map(m => m.role).lastIndexOf('user') + 1).filter(m => m.role === 'tool').length;
    const target = ['sample.txt', 'missing.txt', 'sample.txt'][ran];
    if (target) {
      chunk({ role: 'assistant', content: `Step ${ran + 1}: reading ${target}.` });
      chunk({ tool_calls: [{ index: 0, id: `desktop-step-${ran}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: path.join(alpha, target) }) } }] }); finish('tool_calls'); return;
    }
  }
  if (prompt.includes('TOOL') && input.messages.at(-1)?.role !== 'tool') {
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'desktop-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: path.join(alpha, 'sample.txt') }) } }] }); finish('tool_calls'); return;
  }
  const answer = `## Desktop verified\n\n${prompt}\n\n${input.messages.at(-1)?.role === 'tool' ? 'The desktop tool fixture is readable.' : 'A locally streamed response.'}\n\n\`\`\`js\nconst session = "independent";\n\`\`\`\n\n| Project | Status |\n| --- | --- |\n| Local | Ready |`;
  const pieces = answer.match(/.{1,12}/gs) || [];
  chunk({ role: 'assistant' });
  let index = 0;
  const timer = setInterval(() => { if (index < pieces.length) chunk({ content: pieces[index++] }); else { clearInterval(timer); finish('stop'); } }, prompt.includes('SLOW') ? 110 : 8);
  res.once('close', () => clearInterval(timer));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: [], skills: [], defaultProvider: 'desktop-example', defaultModel: 'desktop-fixture', defaultThinkingLevel: 'off', retry: { enabled: false } }));
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'desktop-example': { api: 'openai-completions', baseUrl, apiKey: 'synthetic-example-key', models: [{ id: 'desktop-fixture', name: 'Local fixture', contextWindow: 100_000, maxTokens: 2000, reasoning: true, thinkingLevelMap: { max: 'high', ultra: 'high' }, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
fs.writeFileSync(path.join(agentDir, 'extensions/desktop-fixture.ts'), `import {spawn} from 'node:child_process';
import fs from 'node:fs';
export default function(pi) {
  let job;
  pi.registerCommand('desktop-job', {description:'Synthetic background ownership coverage',handler:async()=>{
    job=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(path.join(scratch, 'job.pid'))},String(job.pid));
  }});
  pi.on('session_shutdown',()=>{job?.kill();});
  pi.registerCommand('desktop-timeout', {description:'Synthetic background dialog timeout',handler:async(_args,ctx)=>{
    await ctx.ui.confirm('Expiring background dialog','This local test expires.',{timeout:100});
  }});
  for (const name of ['desktop-boost', 'desktop-boost-two']) pi.registerCommand(name, {description:'Synthetic chainable boost', chainable:true, handler:async(args)=>{
    pi.sendMessage({customType:'desktop-boost',content:'Boost ran with '+name+' '+args,display:true},{triggerTurn:false});
  }});
  pi.registerCommand('goal', {description:'Synthetic goal command', chainable:true, handler:async(args)=>{
    pi.sendMessage({customType:'desktop-boost',content:'Goal ran with '+args,display:true},{triggerTurn:false});
  }});
  pi.registerCommand('desktop-hidden-shortcut', {description:'Synthetic shortcut the menus do not advertise', hidden:true, handler:async()=>{
    pi.sendMessage({customType:'desktop-boost',content:'Hidden shortcut ran',display:true},{triggerTurn:false});
  }});
  pi.registerCommand('desktop-notify', {description:'Synthetic long notice', handler:async(_args,ctx)=>{
    ctx.ui.notify('Long notice. '.repeat(160),'warning');
  }});
  pi.registerCommand('desktop-confirm', {description:'Synthetic dialog coverage', handler:async (_args,ctx)=>{
    const confirmed=await ctx.ui.confirm('Desktop confirmation','Approve the local test dialog?');
    pi.sendMessage({customType:'desktop-confirmation',content:confirmed?'Confirmed local dialog.':'Cancelled local dialog.',display:true},{triggerTurn:false});
  }});
}`);
const store = new SessionStore(dataDir), pa = store.addProject(alpha), pb = store.addProject(beta);
const first = store.create(pa.id), second = store.create(pa.id), third = store.create(pb.id), history = store.create(pa.id);
for (const [session, title] of [[first, 'Alpha one'], [second, 'Alpha two'], [third, 'Beta one'], [history, 'Long history']]) store.update(session.id, { title });
const manager = SessionManager.create(alpha, store.transcriptDirectory(history.id), { id: history.id });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
for (let index = 0; index < 90; index++) {
  manager.appendMessage({ role: 'user', content: `History request ${index}`, timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `History response ${index}\n\n${'Some measured history with enough content to scroll. '.repeat(10)}\n\n\`\`\`js\n${'x'.repeat(300)}\n\`\`\`` }], api: 'openai-completions', provider: 'desktop-example', model: 'desktop-fixture', stopReason: 'stop', usage, timestamp: Date.now() });
}
store.activate(first.id);
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', YUNUSPI_DESKTOP_DATA: dataDir, YUNUSPI_NODE_BINARY: process.execPath };
delete env.ELECTRON_RUN_AS_NODE; delete env.YUNUSPI_INITIAL_PROMPT;
const report = { platform: process.platform, checks: [], screenshots: [], bootMs: null, readyMs: null };
let electron, page;
const check = (name, detail) => { report.checks.push({ name, detail }); console.log(`PASS ${name}`); };
const started = performance.now();
try {
  electron = await _electron.launch({ args: [path.join(repo, 'desktop/main.mjs')], env, timeout: 30_000 });
  page = await electron.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#welcome h1'); report.bootMs = Math.round(performance.now() - started);
  await page.waitForFunction(() => !document.getElementById('prompt').disabled, { timeout: 60_000 }); report.readyMs = Math.round(performance.now() - started);
  assert.equal(await page.locator('#welcome .suggestions button').first().getAttribute('data-suggest'), 'goal');
  await page.screenshot({ path: path.join(output, 'desktop-welcome.png') }); report.screenshots.push('desktop-welcome.png');
  const opened = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(560, 640));
  await page.waitForTimeout(120);
  const narrow = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, right: Math.max(...[...document.querySelectorAll('#welcome .suggestions button')].map(node => node.getBoundingClientRect().right)) }));
  assert.ok(narrow.overflow <= 1 && narrow.right <= narrow.width, `welcome actions leave a ${narrow.width}px window (${Math.round(narrow.right)})`);
  await page.screenshot({ path: path.join(output, 'desktop-welcome-560.png') }); report.screenshots.push('desktop-welcome-560.png');
  await electron.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), opened);
  await page.waitForTimeout(120);
  check('the empty session opens on the rat and offers a goal first');
  const nativePid = await electron.evaluate(() => process.pid);
  assert.ok(activePiProcesses(path.join(repo, 'core/coding-agent')).includes(nativePid), 'the running Electron executable remains an owner without a core CLI parent');
  check('live Electron blocks updates without a CLI launch owner');
  const open = async id => { await page.locator(`[data-session-id="${id}"] .session-select`).click(); await page.waitForFunction(() => !document.getElementById('prompt').disabled); };
  const send = async message => { await page.locator('#prompt').fill(message); await page.locator('#send').click(); };
  const done = async () => page.waitForFunction(() => document.getElementById('stop').hidden, { timeout: 30_000 });
  await send('SLOW alpha-session-one');
  await page.waitForFunction(() => !document.getElementById('stop').hidden);
  await open(second.id); await send('alpha-session-two'); await done();
  assert.match(await page.locator('#messages').innerText(), /alpha-session-two/);
  assert.doesNotMatch(await page.locator('#messages').innerText(), /alpha-session-one/);
  await open(first.id); await done();
  assert.match(await page.locator('#messages').innerText(), /alpha-session-one/);
  assert.doesNotMatch(await page.locator('#messages').innerText(), /alpha-session-two/);
  check('same-project simultaneous streams remain independent');
  await page.locator('#prompt').fill('unsent alpha draft');
  await open(third.id); await send('beta-project-three'); await done();
  await open(first.id); assert.equal(await page.locator('#prompt').inputValue(), 'unsent alpha draft');
  check('multiple projects and per-session drafts survive switching');
  await page.evaluate(id => window.yunuspi.setThinking(id, 'max'), first.id);
  assert.equal(new SessionStore(dataDir).session(first.id).thinkingLevel, 'max');
  check('extended thinking selection persists without changing the selected model');
  await page.locator('#prompt').fill('TOOL read this fixture'); await page.locator('#send').click();
  await page.waitForSelector('.tool-card[data-status="done"]'); await done();
  await page.locator('.tool-card summary').last().click();
  assert.match(await page.locator('.tool-output').last().innerText(), /desktop tool fixture is readable/);
  check('real core tool execution expands in the GUI');
  // A turn of several steps folds into one block once it is done; the answer stays outside it.
  await send('STEPS over the fixture'); await done();
  const block = page.locator('.work').last();
  assert.equal(await block.getAttribute('data-state'), 'done');
  assert.equal(await block.getAttribute('data-open'), 'false', 'a finished turn of three steps is folded');
  assert.equal(await block.locator('.work-body').isVisible(), false);
  const headline = await block.locator('.work-head').innerText();
  assert.match(headline, /Worked/); assert.match(headline, /read 1 file/); assert.match(headline, /1 failed on the way/);
  await page.screenshot({ path: path.join(output, 'desktop-work-folded.png') }); report.screenshots.push('desktop-work-folded.png');
  assert.match(await page.locator('#messages > .message.assistant').last().innerText(), /Desktop verified/);
  assert.equal(await block.locator('.message.assistant').count(), 3, 'the narration of each step belongs to the block');
  await block.locator('.work-head').click();
  assert.equal(await block.getAttribute('data-open'), 'true');
  await block.locator('.work-head').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'desktop-work-open.png') }); report.screenshots.push('desktop-work-open.png');
  assert.equal(await block.locator('.tool-card').count(), 3);
  assert.equal(await block.locator('.tool-card[data-status="error"]').count(), 1);
  assert.match(await block.locator('.tool-card[data-status="error"] .tool-trouble').innerText(), /missing\.txt|ENOENT|not found|no such file/i, 'a failed step says what failed without being opened');
  assert.match(await block.locator('.tool-card').first().locator('.tool-title').innerText(), /^Read\s+.*sample\.txt/);
  check('a turn of several steps folds into one block that names what was done and what failed');
  // Coming back to a session already in memory draws each message once, and keeps the block as the user left it.
  await open(second.id); await open(first.id);
  assert.equal(await page.locator('#messages .message.user', { hasText: 'STEPS over the fixture' }).count(), 1);
  assert.equal(await page.locator('#messages .tool-card[data-status="error"]').count(), 1);
  assert.equal(await page.locator('.work').last().getAttribute('data-open'), 'true', 'the block stays open after switching sessions');
  check('re-opening a session shows its transcript once');
  const commandList = await page.evaluate(id => window.yunuspi.commands(id), first.id);
  assert.ok(commandList.commands.some(command => command.name === 'desktop-confirm'), 'fixture extension command must load');
  await send('/desktop-confirm');
  await page.waitForSelector('#dialog[open]');
  assert.equal(await page.locator('#dialog-title').innerText(), 'Desktop confirmation', await page.locator('#dialog').innerText());
  await page.locator('#prompt').evaluate(node => { node.value = 'newer draft during confirmation'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForSelector('#dialog:not([open])', { state: 'attached' });
  await page.waitForFunction(() => !document.getElementById('send').disabled);
  assert.equal(await page.locator('#prompt').inputValue(), 'newer draft during confirmation');
  await page.waitForTimeout(350);
  assert.match(new SessionStore(dataDir).session(first.id).draft, /newer draft/);
  check('extension dialogs work and preserve newer preflight drafts');
  await page.evaluate(id => window.yunuspi.prompt(id, '/desktop-timeout'), second.id);
  await open(second.id);
  assert.equal(await page.locator('#dialog').evaluate(node => node.open), false, 'expired background dialog must never reopen');
  await open(first.id);
  check('background dialog deadlines clear queued UI and suspension guards');
  await page.evaluate(id => window.yunuspi.prompt(id, '/desktop-job'), first.id);
  const jobPid = Number(fs.readFileSync(path.join(scratch, 'job.pid'), 'utf8'));
  await open(history.id);
  await page.waitForSelector('#load-earlier:not([hidden])');
  let gap = await page.locator('#conversation').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
  assert.ok(gap < 3, `initial history bottom gap ${gap}`);
  await page.locator('#conversation').evaluate(node => { node.scrollTop = 0; });
  await page.waitForTimeout(80);
  const anchor = await page.locator('.message').first().getAttribute('data-key');
  const before = (await page.locator(`[data-key="${anchor}"]`).boundingBox()).y;
  await page.locator('#load-earlier').click();
  await page.waitForFunction(() => !document.getElementById('load-earlier').disabled);
  const after = (await page.locator(`[data-key="${anchor}"]`).boundingBox()).y;
  assert.ok(Math.abs(after - before) < 3, `history anchor moved ${after - before}`);
  check('paged long history preserves its visible scroll anchor');
  await page.locator('#jump-bottom').click();
  await page.locator('#prompt').fill('A long draft\n'.repeat(35));
  gap = await page.locator('#conversation').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
  assert.ok(gap < 3, `composer resize moved pinned view ${gap}`);
  for (const [width, height] of [[1440, 900], [1000, 720], [560, 420]]) {
    await electron.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
    await page.waitForTimeout(120);
    const bounds = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, scrollHeight: document.getElementById('conversation').clientHeight, composer: document.getElementById('composer').getBoundingClientRect().toJSON() }));
    assert.ok(bounds.overflow <= 1, `horizontal document overflow at ${width}`);
    assert.ok(bounds.scrollHeight >= 100, `conversation is too short at ${width}`);
    assert.ok(bounds.composer.bottom <= height, 'composer is clipped');
    if (width === 560) {
      await page.locator('#workbench-toggle').click();
      assert.equal(await page.locator('#workbench').getAttribute('aria-modal'), 'true');
      for (let index = 0; index < 5; index++) { await page.keyboard.press('Tab'); assert.equal(await page.locator('#workbench').evaluate(node => node.contains(document.activeElement)), true); }
      await page.keyboard.press('Escape'); assert.equal(await page.locator('#main').evaluate(node => node.inert), false);
    }
    await page.screenshot({ path: path.join(output, `desktop-${width}.png`) }); report.screenshots.push(`desktop-${width}.png`);
  }
  check('wide, compact and short windows preserve composer and scrolling');
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 850));
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.locator('#prompt').fill(''); await page.screenshot({ path: path.join(output, 'desktop-dark.png') }); report.screenshots.push('desktop-dark.png');
  assert.equal(await page.locator('.working-mark i').first().evaluate(node => getComputedStyle(node).animationName), 'none');
  check('dark appearance and reduced motion render correctly');
  await page.evaluate(id => window.yunuspi.sessionAction(id, 'archive'), second.id);
  await page.locator('#archive-view').click();
  await page.locator(`[data-session-id="${second.id}"] .session-select`).click();
  await page.getByRole('button', { name: 'Restore session', exact: true }).click();
  assert.equal(new SessionStore(dataDir).session(second.id).state, 'closed');
  await page.locator('#archive-view').click(); await open(second.id);
  assert.match(await page.locator('#messages').innerText(), /alpha-session-two/);
  check('archive, restore and reopening retain the conversation');
  await page.locator('#prompt').fill('/desktop-b');
  await page.waitForSelector('#command-menu:not([hidden]) .command-option.boost', { timeout: 30_000 });
  assert.match(await page.locator('#command-menu .command-group').first().innerText(), /Standards/);
  assert.equal(await page.locator('#prompt').getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: path.join(output, 'desktop-command-menu.png') }); report.screenshots.push('desktop-command-menu.png');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#prompt').inputValue(), '/desktop-boost ');
  await page.keyboard.type('/desktop-boost-t');
  await page.waitForSelector('#command-menu:not([hidden]) .command-option.boost');
  assert.match(await page.locator('#command-menu').innerText(), /Joins \/desktop-boost/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#command-menu').isHidden(), true);
  await page.locator('#prompt').fill('/desktop-hidden');
  await page.waitForFunction(() => document.getElementById('command-menu').hidden);
  await page.locator('#prompt').fill('/');
  await page.waitForSelector('#command-menu:not([hidden]) .command-option');
  assert.doesNotMatch(await page.locator('#command-menu').innerText(), /desktop-hidden-shortcut/);
  assert.match(await page.locator('#command-menu .command-group').first().innerText(), /Commands/);
  assert.match(await page.locator('#command-menu .command-option').first().innerText(), /^\/goal\s/);
  await page.screenshot({ path: path.join(output, 'desktop-command-menu-open.png') }); report.screenshots.push('desktop-command-menu-open.png');
  await page.locator('#prompt').fill('');
  check('the slash menu opens on /goal, lists commands before optional standards, completes and chains them, and does not advertise hidden shortcuts');
  const requestsBeforeCommands = requests.length;
  await page.locator('#prompt').fill('/desktop-boost /desktop-boost-two go');
  await page.waitForFunction(() => document.querySelectorAll('#prompt-marks .command-token[data-kind="boost"]').length === 2 && /one goal for your task/.test(document.getElementById('command-lens').textContent));
  await page.locator('#prompt').fill('/desktop-boost /desktop-bost-two /notaboost go');
  await page.waitForFunction(() => document.querySelector('#prompt-marks .command-token[data-kind="near"]') && document.querySelector('#prompt-marks .command-token[data-kind="unknown"]')
    && /Did you mean \/desktop-boost-two/.test(document.getElementById('command-lens').textContent) && /\/notaboost is not a command/.test(document.getElementById('command-lens').textContent));
  await page.screenshot({ path: path.join(output, 'desktop-command-lens.png') }); report.screenshots.push('desktop-command-lens.png');
  await page.locator('#prompt').fill('/desktop-boost /desktop-bost-two go');
  check('the composer marks boosts, near misses and non-commands where they stand and says what Enter will do');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#dialog[open]');
  assert.match(await page.locator('#dialog-title').innerText(), /Did you mean \/desktop-boost-two\?/);
  await page.screenshot({ path: path.join(output, 'desktop-did-you-mean.png') }); report.screenshots.push('desktop-did-you-mean.png');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('messages').innerText.includes('Boost ran with desktop-boost /desktop-boost-two go'), null, { timeout: 30_000 });
  await page.locator('#prompt').fill('/nonsensecommand now');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /is not a command/.test(document.getElementById('toast').textContent));
  assert.equal(await page.locator('#prompt').inputValue(), '/nonsensecommand now', 'the draft stays for editing');
  await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
  await page.locator('#prompt').fill('/tre');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /\/tree works in the terminal app only/.test(document.getElementById('toast').textContent));
  assert.equal(await page.locator('#dialog').evaluate(node => node.open), false, 'a terminal-only command is explained, never offered as a correction to send');
  assert.equal(requests.length, requestsBeforeCommands, 'neither the corrected chain nor an unknown or terminal-only command reached the provider');
  await page.locator('#prompt').fill('');
  check('a near-miss command is offered back and Enter sends the correction; an unknown one is never sent');
  await page.evaluate(id => window.yunuspi.projectAction(id, 'archive'), pb.id);
  assert.equal(await page.locator('#session-list').innerText().then(text => text.includes('Beta one')), false);
  assert.equal(new SessionStore(dataDir).project(pb.id).archived, true);
  await page.locator('#archive-view').click();
  await page.getByRole('button', { name: `Restore project ${pb.name}` }).click();
  await page.waitForFunction(() => !document.getElementById('archive-count').textContent);
  await page.locator('#archive-view').click();
  assert.match(await page.locator('#session-list').innerText(), /Beta one/);
  assert.equal(new SessionStore(dataDir).project(pb.id).archived, undefined);
  check('a whole project archives out of the sidebar and restores with its sessions');
  await page.evaluate(id => window.yunuspi.sessionAction(id, 'close'), second.id);
  assert.equal(new SessionStore(dataDir).session(second.id).state, 'closed');
  check('closing a session stops its worker and retains its history');
  const residentBeforeBrowsing = (await page.evaluate(() => window.yunuspi.snapshot())).runtime.length;
  for (let index = 0; index < 7; index++) {
    const session = await page.evaluate(projectId => window.yunuspi.createSession(projectId), pa.id);
    await open(session.id);
  }
  const pooled = await page.evaluate(() => window.yunuspi.snapshot());
  assert.equal(pooled.runtime.length, residentBeforeBrowsing, 'browsing must not start or stop extension runtimes');
  process.kill(jobPid, 0);
  assert.ok(pooled.runtime.some(worker => worker.id === first.id), 'background work owner stays resident');
  await page.locator('#model-button').click();
  await page.waitForSelector('#dialog[open]', { timeout: 1000 });
  assert.match(await page.locator('#dialog-content').innerText(), /Starting this session|Search models/);
  await page.waitForSelector('#dialog-content .dialog-list button', { timeout: 60_000 });
  await page.locator('#dialog-content .dialog-search').fill('fixture');
  assert.match(await page.locator('#dialog-content').innerText(), /Local fixture/);
  await page.locator('#dialog-close').click();
  check('the model menu opens at once on a session whose runtime is still starting');
  await open(first.id); assert.match(await page.locator('#messages').innerText(), /TOOL read this fixture/);
  check('many histories browse without starting or stopping workers');
  await send('/desktop-notify');
  await page.waitForFunction(() => document.querySelector('#messages .message.notice[data-tone="warning"]')?.textContent.includes('Long notice.'));
  const covered = await page.evaluate(() => ['model-button', 'thinking-button', 'prompt', 'attach'].filter(id => {
    const rect = document.getElementById(id).getBoundingClientRect();
    return document.querySelector('#messages .message.notice')?.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  }));
  assert.deepEqual(covered, [], 'a notice must not cover composer controls');
  assert.equal(await page.locator('#toast').evaluate(node => node.hidden || !node.textContent.includes('Long notice')), true, 'extension notices stay in the transcript instead of a fading toast');
  check('extension notices stay readable in the transcript, clear of the composer');
  check('background jobs survive opening more histories');
  await page.locator('#settings').click();
  await page.locator('#provider-id').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.locator('#provider-key').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#dialog').evaluate(node => node.open), false);
  check('dialog keyboard focus and Escape close work');
  // Team models: each choice is written at once through the harness settings owner,
  // and comes back selected when Settings is opened again.
  const ready = () => page.waitForFunction(() => { const select = document.getElementById('team-legwork'); return select && !select.disabled; }, { timeout: 60_000 });
  await page.locator('#settings').click(); await ready();
  await page.locator('#team-helper').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'desktop-settings-team.png') }); report.screenshots.push('desktop-settings-team.png');
  await page.locator('#team-helper').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'team-legwork');
  const focusRing = await page.locator('#team-legwork').evaluate(node => { const style = getComputedStyle(node); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.equal(focusRing.style, 'solid', 'a focused dropdown shows the dialog focus ring');
  assert.ok(focusRing.width >= 1.5, `the focus ring is drawn (${focusRing.width}px)`);
  await page.screenshot({ path: path.join(output, 'desktop-settings-team-focus.png') }); report.screenshots.push('desktop-settings-team-focus.png');
  // The dropdowns answer the keyboard on their own: arrows pick, and the change is saved.
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.getElementById('team-legwork')?.dataset.saved !== 'inherit');
  assert.match(await page.locator('#team-legwork').inputValue(), /^[^/]+\/.+/, 'an arrow key picks a model and saves it');
  const teamWindow = await electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], size = window.getContentSize();
    window.setMinimumSize(360, 320); window.setContentSize(400, 700); return size;
  });
  await page.waitForTimeout(150);
  const fit = await page.evaluate(() => {
    const content = document.getElementById('dialog-content').getBoundingClientRect();
    const outside = [...document.querySelectorAll('.team-section select')].filter(select => {
      const box = select.getBoundingClientRect(); return box.left < content.left - 1 || box.right > content.right + 1;
    });
    return { width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, outside: outside.length };
  });
  assert.ok(fit.overflow <= 1 && fit.outside === 0, `the Team section fits a ${fit.width}px window without sideways scrolling`);
  await page.screenshot({ path: path.join(output, 'desktop-settings-team-narrow.png') }); report.screenshots.push('desktop-settings-team-narrow.png');
  await electron.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(560, 420); window.setContentSize(size[0], size[1]); }, teamWindow);
  await page.waitForTimeout(150);
  await page.locator('#team-legwork').selectOption('desktop-example/desktop-fixture');
  await page.waitForFunction(() => document.getElementById('team-legwork')?.dataset.saved === 'desktop-example/desktop-fixture');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#dialog').evaluate(node => node.open), false);
  await page.locator('#settings').click(); await ready();
  assert.equal(await page.locator('#team-legwork').inputValue(), 'desktop-example/desktop-fixture', 'the saved model stays selected after reopening Settings');
  assert.equal(await page.locator('#team-legwork option:checked').innerText(), 'desktop-example · desktop-fixture');
  await page.keyboard.press('Escape');
  const teamFile = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
  assert.equal(teamFile.team.legwork, 'desktop-example/desktop-fixture');
  assert.equal(teamFile.defaultProvider, 'desktop-example', 'writing a team role keeps the rest of the settings file');
  assert.equal(teamFile.retry.enabled, false);
  check('Team choices save at once, fit a narrow window and come back selected after reopening Settings');
  await electron.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.evaluate(id => window.yunuspi.sessionAction(id, 'delete'), second.id);
  assert.ok(!new SessionStore(dataDir).data.sessions.some(session => session.id === second.id));
  assert.ok(new SessionStore(dataDir).data.sessions.some(session => session.id === first.id));
  check('confirmed deletion removes only the selected session');
  const prefs = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.deepEqual(errors, []);
  report.memoryKiB = await electron.evaluate(({ app }) => app.getAppMetrics().reduce((total, process) => total + process.memory.workingSetSize, 0));
  check('sandboxed renderer has no Node access and no page errors');
  await open(first.id); await page.locator('#prompt').fill('final unsent draft before shutdown');
  const executable = await electron.evaluate(() => process.execPath);
  const secondLaunch = prompt => new Promise((resolve, reject) => {
    // Only the automation harness disables Chromium's OS sandbox, matching
    // Playwright's primary launch. The product launcher never sets this flag.
    const child = spawn(executable, ['--no-sandbox', path.join(repo, 'desktop/main.mjs')], { env: { ...env, YUNUSPI_OPEN_PROJECT: beta, YUNUSPI_INITIAL_PROMPT: prompt }, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(Error('Secondary launch did not hand off.')); }, 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Secondary launch exited ${code}`)); });
  });
  const countBefore = new SessionStore(dataDir).data.sessions.length;
  await secondLaunch('Forwarded project draft');
  await page.waitForFunction(() => document.getElementById('prompt').value === 'Forwarded project draft');
  assert.equal(new SessionStore(dataDir).session(first.id).draft, 'final unsent draft before shutdown');
  assert.equal(new SessionStore(dataDir).data.sessions.length, countBefore + 1);
  await secondLaunch('');
  assert.equal(new SessionStore(dataDir).data.sessions.length, countBefore + 1);
  check('secondary launches forward project drafts without replacing the existing session');
  // Release all workers through the real shutdown path, then verify saved state.
  const snapshot = await page.evaluate(() => window.yunuspi.snapshot());
  for (const runtime of snapshot.runtime) await page.evaluate(id => window.yunuspi.sessionAction(id, 'close'), runtime.id);
  await electron.close(); electron = null;
  const persisted = new SessionStore(dataDir); assert.equal(persisted.session(first.id).draft, 'final unsent draft before shutdown');
  check('worker shutdown and saved drafts survive desktop exit');
  report.requests = requests.length;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ bootMs: report.bootMs, readyMs: report.readyMs, checks: report.checks.length, output }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  report.error = error.stack; fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  throw error;
} finally {
  if (electron) await electron.evaluate(({ app }) => app.exit(1)).catch(() => {});
  try {
    const pid = Number(fs.readFileSync(path.join(scratch, 'job.pid'), 'utf8'));
    const owner = fs.readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, '');
    if (Number.isInteger(pid) && owner === alpha) process.kill(pid, 'SIGTERM');
  } catch { /* The real session shutdown normally reaps the fixture first. */ }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}

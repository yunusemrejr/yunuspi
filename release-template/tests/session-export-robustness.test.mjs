import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { exportFromFile, exportSessionToHtml } from '../core/coding-agent/src/core/export-html/index.js';
import { exportSessionToJsonl } from '../core/coding-agent/src/core/session-export.js';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';
import registerJsonExport from '../agent/extensions/session-export-json.ts';
import { buildSessionJsonExport } from '../agent/extensions/lib/session-export-json.ts';

const root = path.resolve(import.meta.dirname, '..');
const assets = path.join(root, 'core/coding-agent/src/core/export-html');
const header = { type: 'session', version: 3, id: 'synthetic-export', timestamp: '2026-09-20T12:00:00Z', cwd: '/tmp' };
const user = { type: 'message', id: 'u1', parentId: null, timestamp: header.timestamp, message: { role: 'user', content: 'Synthetic café 🙂' } };
const assistant = { type: 'message', id: 'a1', parentId: 'u1', timestamp: header.timestamp, message: { role: 'assistant', provider: 'test', model: 'fixture', content: [null, { type: 'text', text: 'Reply $&' }, { type: 'thinking', thinking: 'PRIVATE_TEST_THOUGHT' }] } };
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-export-'));
const loadHtmlData = html => JSON.parse(Buffer.from(html.match(/<script id="session-data"[^>]*>([^<]+)<\/script>/)[1], 'base64').toString('utf8'));

test('HTML export supports in-memory sessions, nested paths, Unicode and unmodified bundled scripts', async () => {
  const dir = temp();
  try {
    const sm = SessionManager.inMemory('/tmp', undefined, [header, user, assistant]);
    const output = path.join(dir, 'nested', 'conversation.html');
    assert.equal(await exportSessionToHtml(sm, undefined, output), output);
    const html = fs.readFileSync(output, 'utf8');
    for (const file of ['template.js', 'vendor/marked.min.js', 'vendor/highlight.min.js']) {
      assert.ok(html.includes(fs.readFileSync(path.join(assets, file), 'utf8')), `${file} must survive literal dollar substitutions`);
    }
    for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      if (!script[0].includes('id="session-data"')) new vm.Script(script[1]);
    }
    const data = loadHtmlData(html);
    assert.equal(data.entries[0].message.content[0].text, user.message.content);
    assert.equal(data.entries[1].message.content[0].text, 'Reply $&');
    assert.ok(!JSON.stringify(data).includes('PRIVATE_TEST_THOUGHT'));
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('standalone HTML export reads legacy sessions without migrating or initializing source files', async () => {
  const dir = temp();
  try {
    const source = path.join(dir, 'legacy.jsonl');
    const original = `${JSON.stringify({ ...header, version: 1 })}\n${JSON.stringify(user)}\n`;
    fs.writeFileSync(source, original);
    await exportFromFile(source, path.join(dir, 'legacy.html'));
    assert.equal(fs.readFileSync(source, 'utf8'), original);
    await assert.rejects(exportFromFile(source, source), /must not overwrite/);
    assert.equal(fs.readFileSync(source, 'utf8'), original);
    const empty = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    await assert.rejects(exportFromFile(empty, path.join(dir, 'empty.html')), /empty or invalid/);
    assert.equal(fs.readFileSync(empty, 'utf8'), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('JSONL exports do not truncate source sessions or symlink targets and replace existing exports privately', () => {
  const dir = temp();
  try {
    const source = path.join(dir, 'source.jsonl');
    fs.writeFileSync(source, 'original session');
    const sm = SessionManager.inMemory('/tmp', undefined, [header, user, assistant]);
    sm.getSessionFile = () => source;
    assert.throws(() => exportSessionToJsonl(sm, source), /must not overwrite/);
    const alias = path.join(dir, 'alias.jsonl');
    fs.symlinkSync(source, alias);
    assert.throws(() => exportSessionToJsonl(sm, alias), /must not overwrite/);
    const outside = path.join(dir, 'outside');
    fs.writeFileSync(outside, 'preserve target');
    const output = path.join(dir, 'out.jsonl');
    fs.symlinkSync(outside, output);
    exportSessionToJsonl(sm, output);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve target');
    assert.equal(fs.readFileSync(source, 'utf8'), 'original session');
    assert.equal(fs.lstatSync(output).isSymbolicLink(), false);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(dir).some(name => name.startsWith('.session-export-')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function jsonCommand(dir, branch = [user], retained = branch) {
  let handler;
  const notices = [];
  registerJsonExport({ registerCommand: (name, command) => { assert.equal(name, 'export-json'); handler = command.handler; } });
  const ctx = { cwd: dir, hasUI: true, ui: { notify: (...args) => notices.push(args) }, sessionManager: {
    getEntries: () => retained, getBranch: () => branch, getHeader: () => header,
    getSessionFile: () => null, getLeafId: () => branch.at(-1)?.id,
  } };
  return { handler, ctx, notices };
}

test('/export-json accepts quoted/escaped paths and preserves explicit branch/all scopes', async () => {
  const dir = temp();
  try {
    const fixture = jsonCommand(dir, [user], [user, assistant]);
    await fixture.handler('"nested folder/branch.json" --no-raw --min', fixture.ctx);
    const branch = JSON.parse(fs.readFileSync(path.join(dir, 'nested folder/branch.json'), 'utf8'));
    assert.equal(branch.events.length, 1);
    assert.equal(branch.events[0].raw, undefined);
    assert.equal(branch.session.scope, 'branch');
    await fixture.handler('all\\ entries.json --all', fixture.ctx);
    const all = JSON.parse(fs.readFileSync(path.join(dir, 'all entries.json'), 'utf8'));
    assert.equal(all.events.length, 2);
    assert.equal(all.events[1].raw.message.content[0], null);
    assert.equal(fs.statSync(path.join(dir, 'all entries.json')).mode & 0o777, 0o600);
    fixture.ctx.sessionManager.getBranch = () => { throw Error('branch unavailable'); };
    await fixture.handler('unexpected.json', fixture.ctx);
    assert.ok(!fs.existsSync(path.join(dir, 'unexpected.json')));
    assert.match(fixture.notices.at(-1)[0], /branch unavailable/);
    await fixture.handler('--all -- --dash.json', fixture.ctx);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '--dash.json'))).session.scope, 'all');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/export-json reports metadata/serialization/path failures without damaging prior outputs', async () => {
  const dir = temp();
  try {
    const fixture = jsonCommand(dir);
    const output = path.join(dir, 'existing.json');
    fs.writeFileSync(output, 'previous good export');
    await fixture.handler('"unclosed', fixture.ctx);
    assert.match(fixture.notices.at(-1)[0], /Unclosed quote/);
    fixture.ctx.sessionManager.getHeader = () => { throw Error('metadata unavailable'); };
    await fixture.handler('existing.json', fixture.ctx);
    assert.match(fixture.notices.at(-1)[0], /metadata unavailable/);
    fixture.ctx.sessionManager.getHeader = () => header;
    const circular = { type: 'custom', id: 'circle', data: {} }; circular.data.self = circular;
    fixture.ctx.sessionManager.getBranch = fixture.ctx.sessionManager.getEntries = () => [circular];
    await fixture.handler('existing.json', fixture.ctx);
    assert.match(fixture.notices.at(-1)[0], /circular/i);
    assert.equal(fs.readFileSync(output, 'utf8'), 'previous good export');
    fixture.ctx.sessionManager.getBranch = fixture.ctx.sessionManager.getEntries = () => [user];
    fixture.ctx.sessionManager.getSessionFile = () => output;
    await fixture.handler('existing.json', fixture.ctx);
    assert.match(fixture.notices.at(-1)[0], /must not overwrite/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'previous good export');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diagnostics export tolerates malformed retained rows and reserved dictionary keys', () => {
  const entries = [null, 7, assistant,
    { type: 'message', message: { role: 'assistant', content: {} } },
    { type: 'message', message: { role: 'toolResult', toolName: 'todo', details: { tasks: {} } } },
    { type: 'custom', customType: 'subagent-cost-v1', data: { results: {} } },
    { type: 'custom', customType: 'relevant-guidance', data: { read: {}, shown: [null] } },
    { type: 'custom', customType: 'model-config-v1', data: { route: '__proto__', thinking: 'high' } },
    { type: 'custom_message', customType: '__proto__', content: 'fixture signal' },
    { type: 'custom', customType: 'session-metrics-v1', data: { segment: 'fixture', hooks: { 'fixture:input': null } } },
  ];
  const report = buildSessionJsonExport({ header, scope: 'all', branch: [], retained: entries });
  assert.equal(report.events.length, entries.length);
  assert.equal(report.events[2].raw.message.content[0], null);
  assert.equal(report.summary.signals.__proto__, 1);
  assert.deepEqual(report.analytics.routes.find(row => row.route === '__proto__').thinkingLevels, ['high']);
});

function treeRuntime(entries) {
  const source = fs.readFileSync(path.join(assets, 'template.js'), 'utf8');
  const prefix = source.slice(0, source.indexOf('      // INITIALIZATION'));
  const data = Buffer.from(JSON.stringify({ header, entries, leafId: entries.at(-1)?.id })).toString('base64');
  const context = { atob, TextDecoder, Uint8Array, URLSearchParams, window: { location: { search: '' } }, document: {
    getElementById: () => ({ textContent: data }), querySelector: () => null,
  } };
  vm.runInNewContext(`${prefix}\nwindow.tree = {buildTree, flattenTree, buildActivePathIds, getPath, findNewestLeaf, findToolResult}; })();`, context, { timeout: 3000 });
  return context.window.tree;
}

test('export tree handles long sessions and cyclic parents without stack overflows or hangs', () => {
  const entries = Array.from({ length: 20000 }, (_, i) => ({ type: 'custom', id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: header.timestamp }));
  const tree = treeRuntime(entries);
  const active = tree.buildActivePathIds('e19999');
  assert.equal(active.size, entries.length);
  assert.equal(tree.getPath('e19999').length, entries.length);
  assert.equal(tree.flattenTree(tree.buildTree(), active).length, entries.length);
  assert.equal(tree.findNewestLeaf('e0'), 'e19999');
  const cyclic = treeRuntime([{ type: 'custom', id: 'a', parentId: 'b' }, { type: 'custom', id: 'b', parentId: 'a' }]);
  assert.equal(cyclic.getPath('a').length, 2);
  assert.equal(cyclic.buildActivePathIds('a').size, 2);
  assert.equal(cyclic.flattenTree(cyclic.buildTree(), new Set()).length, 2);
});

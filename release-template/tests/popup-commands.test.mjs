import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import registerSignals, { popupDir, sysPromptDir, writePopupFile } from '../agent/extensions/session-signals.ts';
import { openExternal } from '../agent/extensions/lib/project-intelligence/viewer.mjs';
import { AgentSession } from '../core/coding-agent/src/core/agent-session.js';

function fixture(t, hasUI = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-popup-commands-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(dir, 'agent');
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const commands = new Map(), notices = [], errors = [], modelCalls = [];
  const pi = { registerCommand: (name, command) => commands.set(name, command), on() {}, registerTool() {}, getCommands: () => [...commands].map(([name, command]) => ({ name, description: command.description })), sendMessage: value => modelCalls.push(value), sendUserMessage: value => modelCalls.push(value) };
  registerSignals(pi);
  const ctx = { hasUI, ui: { notify: (...args) => notices.push(args) }, sessionManager: { getSessionId: () => 'synthetic', getBranch: () => [], getEntries: () => [] }, thinkingLevel: 'high' };
  const session = { _extensionRunner: { getCommand: name => commands.get(name), createCommandContext: () => ctx, emitError: error => errors.push(error) } };
  return { dir, commands, notices, errors, modelCalls, ctx, dispatch: text => AgentSession.prototype._tryExecuteExtensionCommand.call(session, text) };
}

function fakeBrowser(t, outcome) {
  const launches = [];
  t.mock.method(childProcess, 'spawn', (command, args) => {
    launches.push({ command, args });
    const child = new EventEmitter(); child.unref = () => {};
    setImmediate(() => outcome(child, launches.length));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return launches;
}

test('all popup commands execute through dispatch, await completion, and save privately without a GUI', async t => {
  const f = fixture(t);
  const launches = fakeBrowser(t, child => child.emit('exit', 0, null));
  fs.mkdirSync(sysPromptDir(), { recursive: true });
  fs.writeFileSync(path.join(sysPromptDir(), 'synthetic.json'), JSON.stringify({ at: 'synthetic', system: 'Synthetic opening prompt', tools: [], toolCount: 0 }));
  for (const name of ['used', 'errors', 'commands', 'sys-prompt']) {
    assert.equal(await f.dispatch(`/${name}\t`), true);
    const file = path.join(popupDir(), `${name}-synthetic.html`);
    assert.match(fs.readFileSync(file, 'utf8'), /<!DOCTYPE html>/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(f.notices.at(-1)[0].includes(file));
    assert.match(f.notices.at(-1)[0], /saved/);
  }
  assert.deepEqual(launches, []); assert.deepEqual(f.errors, []); assert.deepEqual(f.modelCalls, []);
});

test('/used launches its popup and reports the file only after the browser accepts it', async t => {
  const f = fixture(t, true);
  const launches = fakeBrowser(t, child => child.emit('exit', 0, null));
  assert.equal(await f.dispatch('/used'), true);
  assert.equal(launches.length, 1);
  const url = pathToFileURL(path.join(popupDir(), 'used-synthetic.html')).href;
  assert.ok(launches[0].args.some(arg => arg.includes(url)));
  assert.match(f.notices.at(-1)[0], /opened/); assert.deepEqual(f.modelCalls, []);
});

test('popup storage failures notify and log once without a model prompt', async t => {
  const f = fixture(t);
  fs.writeFileSync(popupDir(), 'blocked directory');
  const key = Symbol.for('yunus-pi.health.v1'), prior = globalThis[key], events = [];
  globalThis[key] = (...args) => events.push(args);
  t.after(() => { if (prior === undefined) delete globalThis[key]; else globalThis[key] = prior; });
  assert.equal(await f.dispatch('/used'), true);
  assert.match(f.notices[0][0], /\/used failed/);
  assert.equal(f.notices[0][1], 'error'); assert.equal(events.length, 1);
  assert.equal(events[0][0], 'hook.error'); assert.deepEqual(f.modelCalls, []);
});

test('atomic popup replacement never follows a destination symlink and rejects traversal', t => {
  const f = fixture(t), outside = path.join(f.dir, 'outside');
  fs.mkdirSync(popupDir()); fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(popupDir(), 'used.html'));
  writePopupFile(popupDir(), 'used.html', '<html>new</html>');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.equal(fs.lstatSync(path.join(popupDir(), 'used.html')).isSymbolicLink(), false);
  assert.throws(() => writePopupFile(popupDir(), '../outside', 'bad'), /single path segment/);
  assert.deepEqual(fs.readdirSync(popupDir()), ['used.html']);
});

test('browser failures try another installed opener, while unsafe schemes never spawn', async t => {
  const launches = fakeBrowser(t, (child, attempt) => attempt === 1 ? child.emit('exit', null, 'SIGTERM') : child.emit('exit', 0, null));
  // Supply one detected browser on Linux independent of the test host.
  const originalExists = fs.existsSync;
  t.mock.method(fs, 'existsSync', file => file === '/usr/bin/google-chrome' || originalExists(file));
  syncBuiltinESMExports();
  assert.equal(await openExternal('file:///tmp/synthetic%20popup.html'), null);
  assert.ok(launches.length >= 2);
  const before = launches.length;
  assert.match(await openExternal('javascript:alert(1)'), /unsupported/);
  assert.equal(launches.length, before);
});

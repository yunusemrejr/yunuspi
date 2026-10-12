import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEventBus } from '../core/coding-agent/src/core/event-bus.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-rpc-controls-'));
process.env.PI_CODING_AGENT_DIR = path.join(dir, 'agent');
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(dir, 'runs');
process.env.PI_LOCAL_LM = 'off';
const { registerSlashCommands } = await import('../agent/extensions/pi-subagents/src/slash/slash-commands.ts');
const { openSubagentsAdmin } = await import('../agent/extensions/pi-subagents/src/slash/subagents-admin.ts');
const { registerPromptWorkflowCommands } = await import('../agent/extensions/pi-subagents/src/slash/prompt-workflows.ts');
const { DIRS } = await import('../agent/extensions/pi-subagents/src/shared/types.ts');
const { updateActiveRunIndex } = await import('../agent/extensions/pi-subagents/src/runs/background/active-run-index.ts');
const agentFile = path.join(dir, '.pi/agents/rpc-fixture.md');
fs.mkdirSync(path.dirname(agentFile), { recursive: true });
const definition = '---\nname: rpc-fixture\ndescription: Synthetic RPC control fixture\ntools: read\n---\nInspect only the supplied synthetic source.';
fs.writeFileSync(agentFile, definition);
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(select = async () => undefined) {
  const commands = new Map(), messages = [], requests = [], notices = [], events = createEventBus();
  const pi = { events, on() {}, registerShortcut() {},
    registerCommand: (name, command) => commands.set(name, command),
    sendMessage: message => messages.push(message),
  };
  const model = { provider: 'fixture', id: 'model', reasoning: true, input: ['text'], contextWindow: 32768, maxTokens: 8192 };
  const ctx = { cwd: dir, mode: 'rpc', hasUI: true, model, modelRegistry: { getAvailable: () => [model] },
    sessionManager: { getSessionId: () => 'owner', getSessionFile: () => undefined },
    ui: { select, notify: (...args) => notices.push(args), setStatus() {}, onTerminalInput: () => () => {},
      custom: async () => { throw Error('Terminal custom components cannot run in RPC'); },
    },
  };
  const registration = registerSlashCommands(pi, { baseCwd: dir, currentSessionId: 'owner' });
  events.on('subagent:slash:request', ({ requestId, params }) => {
    requests.push(params);
    events.emit('subagent:slash:started', { requestId });
    events.emit('subagent:slash:response', { requestId, isError: false, result: {
      content: [{ type: 'text', text: 'Native fixture result' }], details: { mode: 'single', results: [] },
    } });
  });
  return { pi, ctx, commands, messages, requests, notices, dispose: registration.dispose };
}

test('RPC agent model and thinking pickers use native dialogs and cancellation preserves definitions', async t => {
  for (const action of ['model', 'thinking']) {
    const selections = [], f = fixture(async (title, choices) => { selections.push({ title, choices }); });
    t.after(f.dispose);
    await openSubagentsAdmin(f.pi, f.ctx, `rpc-fixture ${action}`);
    assert.equal(selections.length, 1, action);
    assert.ok(selections[0].choices.length > 1, action);
    assert.equal(f.messages.length, 0, 'cancelling a picker does not claim an update');
    assert.equal(f.notices.length, 0);
    assert.equal(fs.readFileSync(agentFile, 'utf8'), definition);
  }
});

test('RPC agent discovery and opt-in details work with dialog-capable UI', async t => {
  const f = fixture(async (title, choices) => title === 'Select subagent' ? choices.find(value => value.startsWith('rpc-fixture ')) : 'Show details');
  t.after(f.dispose);
  await openSubagentsAdmin(f.pi, f.ctx, '');
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].display, true);
  assert.match(f.messages[0].content, /Agent: rpc-fixture \(project\)/);
});

test('RPC fleet commands return visible native results instead of opening terminal components', async t => {
  const f = fixture(); t.after(f.dispose);
  await f.commands.get('subagents-fleet').handler('', f.ctx);
  assert.deepEqual(f.requests, [{ action: 'status', view: 'fleet' }]);
  assert.equal(f.messages.at(-1).display, true, 'RPC has no TUI renderer to reveal hidden final results');
  assert.match(f.messages.at(-1).content, /Native fixture result/);
});

test('RPC stop picker targets only the selected current-session run and cancellation does nothing', async t => {
  const createRun = (id, sessionId) => {
    const runDir = path.join(DIRS.async, id); fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({ runId: id, sessionId, state: 'queued', mode: 'single', startedAt: Date.now(), lastUpdate: Date.now(), steps: [], cwd: dir }));
    updateActiveRunIndex(runDir, 'queued');
  };
  createRun('owned-first', 'owner'); createRun('owned-second', 'owner'); createRun('foreign-run', 'other-session');
  let choices;
  const f = fixture(async (_title, values) => { choices = values; return values.find(value => value.includes('owned-second')); });
  t.after(f.dispose);
  await f.commands.get('subagents-stop').handler('', f.ctx);
  assert.equal(choices.length, 2);
  assert.ok(choices.every(value => !value.includes('foreign-run')));
  assert.deepEqual(f.requests, [{ action: 'stop', id: 'owned-second' }]);
  const cancelled = fixture(); t.after(cancelled.dispose);
  await cancelled.commands.get('subagents-stop').handler('', cancelled.ctx);
  assert.equal(cancelled.requests.length, 0);
});

test('single prompt workflows launch native children with exact route, skills, arguments and context', async t => {
  const f = fixture(); t.after(f.dispose);
  const prompts = path.join(dir, '.pi/prompts'); fs.mkdirSync(prompts, { recursive: true });
  fs.writeFileSync(path.join(prompts, 'rpc-prompt.md'), '---\nsubagent: rpc-fixture\nmodel: fixture/exact:high\nskill: anatomy, coding-practices\nfork: true\ncwd: /tmp/fixture\n---\nInspect $1 then $2. Previous: {previous}');
  const launches = [];
  registerPromptWorkflowCommands({ pi: f.pi, run: async params => launches.push(params) });
  await f.commands.get('prompt-workflow').handler('rpc-prompt "quoted argument" second --bg', f.ctx);
  assert.deepEqual(launches, [{ agent: 'rpc-fixture', task: 'Inspect quoted argument then second. Previous: ',
    agentScope: 'both', model: 'fixture/exact:high', skill: ['anatomy', 'coding-practices'], context: 'fork', cwd: '/tmp/fixture', async: true }]);
  await f.commands.get('prompt-workflow').handler('rpc-prompt one two --fresh --subagent alternate', f.ctx);
  assert.equal(launches[1].agent, 'alternate');
  assert.equal(launches[1].context, 'fresh');
  assert.equal(launches[1].async, false);
  assert.equal(launches[1].workflowScript, undefined);
});

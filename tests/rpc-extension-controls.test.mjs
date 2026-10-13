import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';
import { createEventBus } from '../core/coding-agent/src/core/event-bus.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-rpc-extensions-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
const jiti = createJiti(import.meta.dirname);
const { showRpcReport } = await jiti.import('../agent/extensions/lib/rpc-report.ts');
const { registerSessionTelemetry } = await jiti.import('../agent/extensions/lib/session-telemetry.ts');
const { default: registerSignals } = await jiti.import('../agent/extensions/session-signals.ts');
const { default: registerBackground } = await jiti.import('../agent/extensions/pi-background-tasks/src/extension.ts');
after(() => process.once('beforeExit', () => fs.rmSync(root, { recursive: true, force: true })));

function fixture() {
  const commands = new Map(), tools = new Map(), hooks = new Map(), messages = [], notices = [];
  const pi = { events: createEventBus(), registerCommand: (name, command) => commands.set(name, command),
    registerTool: tool => tools.set(tool.name, tool), registerShortcut() {}, registerMessageRenderer() {}, appendEntry() {},
    on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    sendMessage: (message, options) => messages.push({ message, options }), getActiveTools: () => ['read'], getThinkingLevel: () => 'high',
  };
  const cwd = fs.mkdtempSync(path.join(root, 'case-'));
  const ctx = { cwd, mode: 'rpc', hasUI: true, isIdle: () => true, modelRegistry: { getAll: () => [] },
    model: { provider: 'fixture', id: 'model', contextWindow: 65536 },
    sessionManager: { getSessionId: () => 'owner', getEntries: () => [], getBranch: () => [] },
    ui: { custom: async () => { throw Error('RPC cannot render terminal custom components'); },
      select: async () => undefined, notify: (...args) => notices.push(args), setStatus() {}, setWidget() {} },
  };
  return { pi, ctx, commands, tools, hooks, messages, notices };
}

test('RPC reports are bounded, escape-free, visible, and excluded from model context and inference', () => {
  const f = fixture();
  showRpcReport(f.pi, 'Report', ['\x1b[31mline\x1b[0m', ...Array(250).fill('x'.repeat(1000)), 'final diagnostic']);
  assert.equal(f.messages.length, 1);
  const { message, options } = f.messages[0];
  assert.equal(message.display, true); assert.equal(message.excludeFromContext, true);
  assert.equal(options.triggerTurn, false);
  assert.doesNotMatch(message.content, /\x1b/); assert.match(message.content, /Report truncated/);
  assert.match(message.content, /final diagnostic/);
  assert.ok(message.content.length < 32_300);
});

test('RPC self, metrics and hook-audit commands return retained human-facing diagnostics', async () => {
  const f = fixture(); registerSignals(f.pi); registerSessionTelemetry(f.pi);
  for (const start of f.hooks.get('session_start') ?? []) await start({}, f.ctx);
  for (const name of ['self', 'metrics', 'hook-audit']) await f.commands.get(name).handler('', f.ctx);
  assert.equal(f.messages.length, 3);
  for (const { message, options } of f.messages) {
    assert.equal(message.excludeFromContext, true); assert.equal(message.display, true); assert.equal(options.triggerTurn, false);
  }
  assert.match(f.messages[0].message.content, /Session diagnostics/);
  assert.match(f.messages[1].message.content, /Session metrics/);
  assert.match(f.messages[2].message.content, /Hook execution ledger/);
  for (const shutdown of f.hooks.get('session_shutdown') ?? []) await shutdown({}, f.ctx);
});

test('RPC background manager stops only the selected owned task and preserves foreign jobs and cancelled actions', { timeout: 20_000 }, async t => {
  const f = fixture(); registerBackground(f.pi);
  t.after(async () => {
    for (const shutdown of f.hooks.get('session_shutdown') ?? []) await shutdown({}, f.ctx);
  });
  const command = "node -e 'console.log(\"RPC fixture\");setInterval(()=>{},1000)'";
  const start = async (id, ctx, name) => (await f.tools.get('bg_run').execute(id,
    { name, command, isAgent: false, notifyOnCompletion: false, triggerOnCompletion: false, timeoutSeconds: 15 }, undefined, undefined, ctx)).details.task;
  const owned = await start('owned-call', f.ctx, 'owned fixture');
  const otherCtx = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getSessionId: () => 'other-owner' } };
  const foreign = await start('foreign-call', otherCtx, 'foreign fixture');
  const selections = [];
  f.ctx.ui.select = async (title, choices) => { selections.push(choices); return title === 'Background tasks' ? choices.find(choice => choice.includes(owned.id)) : 'Stop task'; };
  await f.commands.get('tasks').handler('', f.ctx);
  assert.equal(selections[0].length, 1); assert.ok(selections[0][0].includes(owned.id));
  const status = async taskId => (await f.tools.get('bg_status').execute('status', { taskId })).details.tasks[0].status;
  assert.equal(await status(owned.id), 'killed'); assert.equal(await status(foreign.id), 'running');
  f.ctx.ui.select = async () => undefined;
  await f.commands.get('bg-tasks').handler('', f.ctx);
  await f.commands.get('tasks').handler(foreign.id, f.ctx);
  assert.match(f.notices.at(-1)[0], /belongs to another session/);
  assert.equal(await status(foreign.id), 'running');
  const next = await start('next-owned-call', f.ctx, 'cancelled fixture');
  await f.commands.get('tasks').handler(next.id, f.ctx);
  assert.equal(await status(next.id), 'running', 'cancelling the action picker cannot stop a task');
  f.ctx.ui.select = async () => 'Show command and output path';
  await f.commands.get('tasks').handler(next.id, f.ctx);
  assert.match(f.messages.at(-1).message.content, /Command: node -e/);
  assert.equal(f.messages.at(-1).message.excludeFromContext, true);
  assert.equal(f.messages.at(-1).options.triggerTurn, false);
  f.ctx.ui.select = async () => 'Run again';
  await f.commands.get('tasks').handler(next.id, f.ctx);
  assert.equal((await f.tools.get('bg_status').execute('status', {})).details.tasks.length, 3, 'an action not offered for a running task cannot launch a duplicate');
  await f.commands.get('tasks').handler(owned.id, f.ctx);
  const tasks = (await f.tools.get('bg_status').execute('status', {})).details.tasks;
  const rerun = tasks.find(task => ![owned.id, foreign.id, next.id].includes(task.id));
  assert.equal(rerun.command, command); assert.equal(rerun.isAgent, false); assert.equal(rerun.triggerOnCompletion, false);
  assert.match(rerun.outputPath, /owner-/); assert.equal(await status(foreign.id), 'running');
});

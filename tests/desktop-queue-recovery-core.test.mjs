import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Agent } from '../core/agent/src/agent.js';
import { AgentSession } from '../core/coding-agent/src/core/agent-session.js';
import { desktopInputPayload } from '../core/coding-agent/src/core/desktop-queue-recovery.js';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';

class QueueSession extends AgentSession {
  _installAgentToolHooks() {}
  _installAgentNextTurnRefresh() {}
  _buildRuntime() {}
}

const image = (data = 'YQ==') => ({ type: 'image', mimeType: 'image/png', data });

function fixture(t, inputHook) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-queue-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionManager = SessionManager.create(dir, dir);
  const agent = new Agent({ streamFn() { throw Error('queue fixture attempted a provider request'); } });
  const runner = {
    hasHandlers: event => event === 'input' && Boolean(inputHook),
    emitInput: inputHook,
    emit: async () => {},
    emitMessageEnd: async ({ message }) => ({ role: message.role, content: message.content, timestamp: message.timestamp }),
  };
  const session = new QueueSession({ agent, sessionManager, cwd: dir, extensionRunnerRef: { current: runner } });
  session._extensionRunner = runner;
  session._guardian = undefined;
  session._isAgentRunActive = true;
  const root = join(dir, '.queue-recovery');
  async function queue(text, images, kind, id = randomUUID(), recovered = false) {
    const desktopInput = { ...desktopInputPayload(text, images), id, recovered };
    await session.prompt(text, { source: 'rpc', expandPromptTemplates: false, images, streamingBehavior: kind, desktopInput });
    return { id, kind, text, images };
  }
  const manifest = id => JSON.parse(readFileSync(join(root, id, 'manifest.json'), 'utf8'));
  const item = (batch, id) => JSON.parse(readFileSync(join(root, batch, id + '.json'), 'utf8'));
  return { sessionManager, session, agent, root, queue, manifest, item };
}

test('desktop recovery preserves original image-only and mixed messages from the actual queue in delivery order', async t => {
  const f = fixture(t, async () => ({ action: 'transform', text: 'identical derived text', images: [] }));
  const followUp = await f.queue('', [image()], 'followUp');
  const steer = await f.queue('same user text', [image('Yg==')], 'steer');
  const peer = await f.queue('same user text', [image('Yw==')], 'followUp');
  await f.session._queueSteer('extension-authored text', [], {}, false);
  const selected = f.agent.createLoopConfig();
  assert.equal((await selected.getSteeringMessages()).length, 1);
  const batch = randomUUID();
  assert.deepEqual(f.session.recoverDesktopQueue(batch), { id: batch, count: 3 });
  assert.deepEqual(selected.consumePendingMessages(), []);
  assert.equal(f.agent.hasQueuedMessages(), false);
  const manifest = f.manifest(batch);
  assert.equal(manifest.sessionId, f.sessionManager.getSessionId());
  assert.deepEqual(manifest.entries, [steer, followUp, peer].map(entry => ({ id: entry.id, kind: entry.kind, preview: entry.text, imageCount: 1 })));
  for (const entry of [steer, followUp, peer]) assert.deepEqual(f.item(batch, entry.id), entry);
  assert.equal(statSync(join(f.root, batch, `${followUp.id}.json`)).mode & 0o777, 0o600);
  await f.queue('queued after original drain', [], 'steer');
  assert.deepEqual(f.session.recoverDesktopQueue(batch), { id: batch, count: 3 });
  assert.equal(f.agent.getQueuedMessages().steering.length, 1);
});

test('recovery records larger than one RPC frame publish with a small receipt', async t => {
  const f = fixture(t);
  const samples = Array.from({ length: 3 }, () => image('A'.repeat(11200000)));
  const originals = [];
  for (const sample of samples) originals.push(await f.queue('', [sample], 'followUp'));
  const id = randomUUID(), receipt = f.session.recoverDesktopQueue(id);
  assert.equal(receipt.count, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 100);
  const bytes = originals.reduce((sum, item) => sum + statSync(join(f.root, id, item.id + '.json')).size, 0);
  assert.ok(bytes > 32 * 1024 * 1024);
});

test('desktop recovery refusal keeps the exact messages queued for a subsequent close', async t => {
  const f = fixture(t);
  const message = await f.queue('', [image()], 'followUp');
  writeFileSync(f.root, 'not a directory', { mode: 0o600 });
  const id = randomUUID();
  assert.throws(() => f.session.recoverDesktopQueue(id), /Unsafe desktop input recovery directory/);
  assert.equal(f.agent.getQueuedMessages().followUp.length, 1);
  rmSync(f.root);
  assert.deepEqual(f.session.recoverDesktopQueue(id), { id, count: 1 });
  assert.deepEqual(f.item(id, message.id), message);
});

test('delivered recovered input is excluded from the queue and reconciles from persisted history', async t => {
  const f = fixture(t);
  const id = randomUUID();
  assert.equal(f.session.reserveDesktopInput(id), 'missing');
  assert.equal(f.session.reserveDesktopInput(id), 'pending');
  await f.queue('', [image()], 'followUp', id, true);
  let observed;
  await f.agent.runWithLifecycle(async signal => {
    const config = f.agent.createLoopConfig();
    await config.getFollowUpMessages();
    const [taken] = config.consumePendingMessages();
    const receipt = f.session.recoverDesktopQueue(randomUUID());
    observed = [receipt.count, f.session.desktopInputStatus(id), signal.aborted];
    await f.agent.processEvents({ type: 'message_start', message: taken });
    await f.agent.processEvents({ type: 'message_end', message: taken });
  });
  assert.deepEqual(observed, [0, 'pending', true]);
  const marker = join(f.root, '.delivered', id);
  assert.ok(statSync(marker).isFile());
  assert.equal(f.session.reserveDesktopInput(id), 'delivered');
  const reloaded = SessionManager.open(f.sessionManager.getSessionFile());
  assert.ok(reloaded.getEntries().some(entry => entry.type === 'message' && entry.message.desktopInputId === id));
  rmSync(marker);
  assert.equal(AgentSession.prototype.desktopInputStatus.call({ sessionManager: reloaded }, id), 'delivered');
  assert.ok(statSync(marker).isFile());
});

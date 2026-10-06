import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RpcClient } from '../core/coding-agent/src/modes/rpc/rpc-client.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-lifecycle-'));
const fixture = path.join(scratch, 'synthetic-agent.mjs');
fs.writeFileSync(fixture, `
import readline from 'node:readline';
const mode = process.env.SYNTHETIC_RPC_MODE;
for await (const line of readline.createInterface({input:process.stdin})) {
  const command=JSON.parse(line);
  if(mode==='hang') continue;
  const response={type:'response',id:command.id,command:command.type,success:!(mode==='reject'&&command.type==='prompt'),data:{isStreaming:false}};
  if(!response.success) response.error='synthetic prompt rejection';
  process.stdout.write(JSON.stringify(response)+'\\n');
  if(command.type==='prompt'&&response.success) process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
}
`);
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
async function clientFor(t, mode = 'normal') {
  const client = new RpcClient({ cliPath: fixture, cwd: scratch, env: { SYNTHETIC_RPC_MODE: mode } });
  t.after(() => client.stop());
  await client.start();
  return client;
}

test('RPC command responses and settled events still complete against a real child', async t => {
  const client = await clientFor(t);
  assert.equal((await client.getState()).isStreaming, false);
  assert.deepEqual(await client.promptAndWait('synthetic prompt'), [{ type: 'agent_settled' }]);
  assert.equal(client.eventListeners.length, 0);
  assert.equal(client.eventWaiters.size, 0);
});

test('a rejected RPC prompt disposes its event waiter and deadline immediately', async t => {
  const client = await clientFor(t, 'reject');
  await assert.rejects(client.promptAndWait('synthetic rejected prompt', undefined, 60_000), /synthetic prompt rejection/);
  assert.equal(client.eventListeners.length, 0);
  assert.equal(client.eventWaiters.size, 0);
  assert.equal((await client.getState()).isStreaming, false);
});

test('one settled event completes every waiter even when subscribers remove themselves or throw', { timeout: 10_000 }, async t => {
  const client = await clientFor(t);
  const off = client.onEvent(() => { throw Error('synthetic subscriber failure'); });
  const waiting = [client.waitForIdle(), client.waitForIdle(), client.collectEvents()];
  await client.prompt('synthetic prompt');
  assert.deepEqual(await Promise.all(waiting), [undefined, undefined, [{ type: 'agent_settled' }]]);
  off();
  assert.equal(client.eventListeners.length, 0);
});

test('stopping RPC rejects commands and event waits instead of leaving their timeouts alive', { timeout: 10_000 }, async t => {
  const client = await clientFor(t, 'hang');
  const checks = [assert.rejects(client.getState(), /Client stopped/), assert.rejects(client.waitForIdle(), /Client stopped/), assert.rejects(client.collectEvents(), /Client stopped/)];
  await client.stop();
  await Promise.all(checks);
  assert.equal(client.pendingRequests.size, 0);
  assert.equal(client.eventWaiters.size, 0);
  assert.equal(client.eventListeners.length, 0);
});

test('a signal-killed RPC process rejects event waits on exit', { timeout: 10_000 }, async t => {
  const client = await clientFor(t);
  const rejected = assert.rejects(client.waitForIdle(), /Agent process exited.*SIGKILL/);
  client.process.kill('SIGKILL');
  await rejected;
  assert.equal(client.eventWaiters.size, 0);
});

test('invalid event deadlines fail without attaching a listener', async t => {
  const client = await clientFor(t);
  for (const timeout of [NaN, Infinity, -1, 2_147_483_648]) await assert.rejects(client.collectEvents(timeout), /Invalid RPC wait timeout/);
  assert.equal(client.eventListeners.length, 0);
});

test('startup uses its owned CLI and node, retains bounded stderr, and detects signal exits', async () => {
  const spawn = childProcess.spawn, write = process.stderr.write;
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); return true; };
  let selected;
  childProcess.spawn = (binary, args) => { selected = { binary, args }; return child; };
  process.stderr.write = () => true;
  syncBuiltinESMExports();
  const client = new RpcClient();
  try {
    const starting = client.start();
    child.stderr.write('x'.repeat(1024 * 1024));
    const bytes = Buffer.from('🙂ç');
    child.stderr.write(bytes.subarray(0, 2)); child.stderr.write(bytes.subarray(2));
    assert.ok(client.getStderr().length <= 200_000);
    assert.ok(client.getStderr().endsWith('🙂ç'));
    assert.equal(selected.binary, process.execPath);
    assert.equal(selected.args[0], path.resolve(import.meta.dirname, '../core/coding-agent/src/cli.js'));
    child.kill();
    await assert.rejects(starting, /Agent process exited.*SIGTERM/);
    assert.equal(client.process, null, 'a failed startup can be retried');
  } finally {
    await client.stop();
    childProcess.spawn = spawn; process.stderr.write = write; syncBuiltinESMExports();
  }
});

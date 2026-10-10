import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(template, 'agent'), path.resolve(template, '..')].find(p => fs.existsSync(path.join(p, 'extensions/utility-tools.ts')));
const load = name => import(pathToFileURL(path.join(agent, 'extensions', name)));
const { UtilityClient } = await load('lib/utility-client.ts');
const { default: register } = await load('utility-tools.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-operations-'));
const client = new UtilityClient(root);
const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
async function call(name, args, isError = false) {
  const response = await client.call(name, args);
  assert.equal(response.isError, isError, JSON.stringify(response));
  assert.ok(Buffer.byteLength(response.content[0].text) <= 24576);
  return JSON.parse(response.content[0].text);
}
before(async () => {
  write('project/source/a.txt', 'one\nneedle in exact line\nthree\n');
  write('project/source/b.txt', 'needle again\n');
  write('project/.hidden.txt', 'needle hidden');
  write('project/node_modules/pkg/a.txt', 'needle dependency');
  write('project/binary.bin', Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  write('project/large.txt', 'x'.repeat(1024 * 1024 + 1));
  fs.symlinkSync('/etc', path.join(root, 'project/outside'));
  fs.symlinkSync(path.join(root, 'project/source'), path.join(root, 'project/inside-link'));
  await client.start();
});
after(() => { client.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('workspace content search is confined, bounded and source grounded with stable paging', async () => {
  const first = await call('workspace_search', { root: 'project', mode: 'content', query: 'needle', limit: 1 });
  assert.equal(first.items[0].path, 'project/source/a.txt');
  assert.equal(first.items[0].line, 2); assert.match(first.items[0].source_hash, /^[a-f0-9]{64}$/);
  assert.equal(first.scope.excluded.symlink, 2); assert.equal(first.scope.excluded.binary, 1); assert.equal(first.scope.excluded.oversized, 1);
  assert.equal(first.scan_complete, false); assert.equal(first.total, 2);
  const second = await call('workspace_search', { root: 'project', mode: 'content', query: 'needle', limit: 1, offset: first.next_offset, snapshot: first.snapshot });
  assert.equal(second.items[0].path, 'project/source/b.txt');
  await call('workspace_search', { root: 'project', mode: 'content', query: 'needle', offset: 1 }, true);
  write('project/source/b.txt', 'needle changed');
  assert.match((await call('workspace_search', { root: 'project', mode: 'content', query: 'needle', offset: 1, snapshot: first.snapshot }, true)).error, /Stale snapshot/);
  for (const root of ['../', '/etc', 'project/outside']) await call('workspace_search', { root, query: 'passwd' }, true);
});

test('folder, hidden opt-in, no-match and depth searches expose their actual scope', async () => {
  const folder = await call('workspace_search', { root: 'project', query: 'source', kind: 'directory' });
  assert.deepEqual(folder.items.map(x => x.path), ['project/source']);
  assert.equal((await call('workspace_search', { root: 'project', query: 'hidden', include_hidden: true })).total, 1);
  const none = await call('workspace_search', { root: 'project/source', query: 'missing', mode: 'content' });
  assert.equal(none.total, 0); assert.equal(none.scan_complete, true);
  const shallow = await call('workspace_search', { root: 'project', query: 'a.txt', max_depth: 0 });
  assert.equal(shallow.scan_complete, false); assert.equal(shallow.scope.excluded.depth, 1);
});

test('SSH plans return safe argv without evaluating config, authenticating or connecting', async () => {
  const plan = await call('ssh_plan', { host: 'server.example.test', user: 'deploy', port: 2222 });
  assert.equal(plan.executed, false); assert.equal(plan.config_read, false);
  assert.deepEqual(plan.argv.slice(0, 4), ['-F', '/dev/null', '-p', '2222']);
  for (const required of ['StrictHostKeyChecking=yes', 'UpdateHostKeys=no', 'PermitLocalCommand=no', 'ProxyCommand=none', 'ProxyJump=none', 'ForwardAgent=no', 'BatchMode=yes']) assert.ok(plan.argv.includes(required));
  assert.equal(plan.argv.at(-1), 'deploy@server.example.test');
  for (const host of ['-oProxyCommand=bad', 'server;touch bad', 'ssh://server', 'host/24']) await call('ssh_plan', { host, user: 'deploy', port: 22 }, true);
  await call('ssh_plan', { host: 'localhost', user: 'user@other', port: 22 }, true);
});

test('SSH banner probe is explicit-target, bounded, passive and cancellable through MCP', { timeout: 12000 }, async () => {
  let bytesSent = 0; const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('data', b => { bytesSent += b.length; }); socket.on('close', () => sockets.delete(socket)); socket.end('Notice\r\nSSH-2.0-Fixture_1.0\r\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await call('net_probe', { action: 'ssh', host: '127.0.0.1', port: server.address().port });
    assert.equal(result.ssh_identified, true); assert.equal(result.host_key_verified, false); assert.equal(result.authenticated, false); assert.equal(bytesSent, 0);
  } finally { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); }
  let connected;
  const arrived = new Promise(resolve => { connected = resolve; });
  const quiet = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); connected(); });
  await new Promise(resolve => quiet.listen(0, '127.0.0.1', resolve));
  try {
    const controller = new AbortController();
    const result = client.call('net_probe', { action: 'ssh', host: '127.0.0.1', port: quiet.address().port }, controller.signal);
    await arrived; controller.abort(); await assert.rejects(result, /cancelled/);
    assert.equal((await call('workspace_search', { root: 'project/source', query: 'txt' })).total, 2);
  } finally { for (const s of sockets) s.destroy(); await new Promise(resolve => quiet.close(resolve)); }
});

test('native utility tool adapter executes new tools through its real MCP process', async () => {
  const tools = new Map(), handlers = new Map();
  register({ registerTool: spec => tools.set(spec.name, spec), on: (name, callback) => handlers.set(name, callback) });
  try {
    const result = await tools.get('workspace_search').execute('native-fixture', { root: 'project/source', query: 'txt' }, undefined, undefined, { cwd: root });
    assert.equal(result.isError, false); assert.equal(JSON.parse(result.content[0].text).total, 2);
    for (const name of ['workspace_search', 'ssh_plan', 'net_probe', 'sqlite_probe']) assert.ok(tools.has(name));
  } finally { handlers.get('session_shutdown')(); }
});


test('accepted silent or malformed SSH peers retain TCP truth without claiming SSH identity', { timeout: 10000 }, async () => {
  for (const payload of [null, 'SSH-2.0-bad\x1b[31m\r\n', 'x'.repeat(4097)]) {
    const sockets = new Set();
    const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); if (payload !== null) socket.end(payload); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await call('net_probe', { action: 'ssh', host: '127.0.0.1', port: server.address().port });
      assert.equal(result.connected, true); assert.equal(result.ssh_identified, false);
      assert.equal(result.host_key_verified, false); assert.equal(result.authenticated, false);
      assert.equal(result.error, payload === null ? 'timeout' : payload.length > 4096 ? 'banner_limit' : 'invalid_ssh_banner');
    } finally { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); }
  }
});

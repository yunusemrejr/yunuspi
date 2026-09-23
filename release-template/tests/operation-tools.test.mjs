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
const message = (subject, body) => `From: Sender <sender@example.test>\r\nTo: reader@example.test\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
before(async () => {
  write('project/source/a.txt', 'one\nneedle in exact line\nthree\n');
  write('project/source/b.txt', 'needle again\n');
  write('project/.hidden.txt', 'needle hidden');
  write('project/node_modules/pkg/a.txt', 'needle dependency');
  write('project/binary.bin', Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  write('project/large.txt', 'x'.repeat(1024 * 1024 + 1));
  fs.symlinkSync('/etc', path.join(root, 'project/outside'));
  fs.symlinkSync(path.join(root, 'project/source'), path.join(root, 'project/inside-link'));
  write('mail/cur/one', message('=?UTF-8?B?Q2Fmw6kgcGxhbg==?=', 'A useful needle in email.'));
  write('mail/new/two', 'From: Other <other@example.test>\nSubject: Plain plan\nContent-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: quoted-printable\n\nA caf=E9 plan with needle.');
  write('archive.mbox', `From sender@example.test Thu Jan  1 00:00:00 2026\n${message('First plan', 'needle alpha')}\nFrom sender@example.test Thu Jan  1 00:01:00 2026\n${message('Second plan', 'needle beta')}\n`);
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

test('Maildir search decodes RFC encoded headers and MIME charset then reads exact hash', async () => {
  const first = await call('local_mail_search', { path: 'mail', format: 'maildir', query: 'plan', limit: 1 });
  assert.equal(first.items[0].subject, 'Café plan');
  const second = await call('local_mail_search', { path: 'mail', format: 'maildir', query: 'plan', limit: 1, offset: first.next_offset, snapshot: first.snapshot });
  assert.match(second.items[0].preview, /café/);
  const row = second.items[0];
  const readArgs = { path: 'mail', format: 'maildir', key: row.key, message_hash: row.message_hash, limit: 7 };
  const page = await call('local_mail_read', readArgs);
  assert.equal(page.body, 'A café '); assert.equal(page.next_offset, 7);
  assert.equal((await call('local_mail_read', { ...readArgs, offset: page.next_offset })).body, 'plan wi');
  write('mail/new/two', message('Changed', 'changed body'));
  assert.match((await call('local_mail_read', readArgs, true)).error, /Stale message hash/);
  await call('local_mail_search', { path: 'mail', format: 'maildir', query: 'plan', offset: 1, snapshot: first.snapshot }, true);
  await call('local_mail_read', { ...readArgs, key: '../project/source/a.txt' }, true);
});

test('mbox search and read retain exact byte provenance and reject stale source messages', async () => {
  const search = await call('local_mail_search', { path: 'archive.mbox', format: 'mbox', query: 'beta', field: 'body' });
  assert.equal(search.total, 1);
  const row = search.items[0]; assert.equal(row.key, '1');
  const read = await call('local_mail_read', { path: 'archive.mbox', format: 'mbox', key: row.key, message_hash: row.message_hash });
  assert.match(read.body, /needle beta/);
  assert.equal(read.provenance.message_index, 1);
  assert.ok(read.provenance.byte_end > read.provenance.byte_start);
  write('invalid.mbox', 'not a mailbox');
  await call('local_mail_search', { path: 'invalid.mbox', format: 'mbox', query: 'mail' }, true);
});

test('MIME body reading omits attachment content, converts HTML inertly and reports lossy decoding', async () => {
  write('mime/cur/multipart', 'From: a@example.test\nSubject: mixed\nContent-Type: multipart/mixed; boundary=boundary\n\n--boundary\nContent-Type: text/html; charset=utf-8\n\n<head><title>not body</title></head><p>Visible message</p><script>not script</script><img src="https://example.test/trap">\n--boundary\nContent-Type: text/plain\nContent-Disposition: attachment; filename=secret.txt\n\nATTACHMENT_SENTINEL\n--boundary--\n');
  fs.mkdirSync(path.join(root, 'mime/new'));
  const search = await call('local_mail_search', { path: 'mime', format: 'maildir', query: 'visible' });
  assert.equal(search.total, 1); assert.doesNotMatch(JSON.stringify(search), /ATTACHMENT_SENTINEL|not script|not body|example.test\/trap/);
  const read = await call('local_mail_read', { path: 'mime', format: 'maildir', key: search.items[0].key, message_hash: search.items[0].message_hash });
  assert.match(read.body_basis, /converted to text/); assert.match(read.body, /Visible message/);
  assert.equal((await call('local_mail_search', { path: 'mime', format: 'maildir', query: 'ATTACHMENT_SENTINEL' })).total, 0);
  write('mime/new/lossy', 'Subject: invalid\nContent-Type: text/plain; charset=nonexistent\n\nneedle');
  const lossy = await call('local_mail_search', { path: 'mime', format: 'maildir', query: 'needle' });
  assert.equal(lossy.scan_complete, false); assert.ok(lossy.items[0].warnings.includes('decoding_replacement'));
});

test('local mail rejects links, oversized messages and outside roots without account discovery', async () => {
  fs.symlinkSync('/etc/passwd', path.join(root, 'mail/cur/linked'));
  write('mail/new/large', 'x'.repeat(1024 * 1024 + 1));
  const search = await call('local_mail_search', { path: 'mail', format: 'maildir', query: 'needle' });
  assert.equal(search.scope.excluded.symlink, 1); assert.equal(search.scope.excluded.oversized, 1); assert.equal(search.scan_complete, false);
  await call('local_mail_read', { path: 'mail', format: 'maildir', key: 'cur/linked', message_hash: '0'.repeat(64) }, true);
  await call('local_mail_search', { path: '/etc', format: 'maildir', query: 'needle' }, true);
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
    for (const name of ['workspace_search', 'local_mail_search', 'local_mail_read', 'ssh_plan']) assert.ok(tools.has(name));
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

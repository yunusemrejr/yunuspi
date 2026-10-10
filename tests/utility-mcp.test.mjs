import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSameBytes } from "./bytes.mjs";
const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(template, 'agent'), path.resolve(template, '..')].find(p => fs.existsSync(path.join(p, 'extensions/utility-tools.ts')));
const mod = name => import(pathToFileURL(path.join(agent, 'extensions/lib', name)));
const { UtilityClient } = await mod('utility-client.ts');
const { TOOLS, UTILITY_CONCURRENCY } = await mod('utility-mcp/catalog.mjs');
const { netProbe } = await mod('utility-mcp/net.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-utility-test-'));
const client = new UtilityClient(root);
const write = (name, data) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data)); };
async function call(name, args, error = false) {
  const response = await client.call(name, args);
  assert.equal(response.isError, error, JSON.stringify(response));
  assert.ok(Buffer.byteLength(response.content[0].text) <= 24576);
  return JSON.parse(response.content[0].text);
}

before(async () => {
  write('package.json', { name: 'fixture', dependencies: { demo: '^2.0.0' } });
  write('node_modules/demo/package.json', { name: 'demo', version: '2.3.4', exports: { '.': { types: './index.d.ts', import: './index.mjs' } }, types: 'index.d.ts', bin: { demo: 'cli.js' }, peerDependencies: { peer: '^3' }, scripts: { install: 'THIS_MUST_NEVER_EXECUTE' } });
  write('node_modules/transitive/package.json', { name: 'transitive', version: '1.0.0' });
  write('package-lock.json', { lockfileVersion: 3, packages: { '': { name: 'fixture' }, 'node_modules/demo': { version: '2.3.4', resolved: 'https://registry.example/demo.tgz', integrity: 'sha512-fixture' }, 'node_modules/transitive': { version: '1.0.0' } } });
  execFileSync('python3', ['-c', `
import sqlite3, pathlib, zipfile, tarfile, io, shutil
p=pathlib.Path(${JSON.stringify(root)})
db=sqlite3.connect(p/'data.sqlite')
db.execute('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)')
db.executemany('INSERT INTO items(value) VALUES (?)', [('alpha',),('beta',),('gamma',)])
db.commit(); db.close()
db=sqlite3.connect(p/'writer.sqlite'); db.execute('PRAGMA journal_mode=WAL')
db.execute('CREATE TABLE recent(n)'); db.execute('INSERT INTO recent VALUES(42)'); db.commit()
shutil.copyfile(p/'writer.sqlite',p/'wal.sqlite'); shutil.copyfile(p/'writer.sqlite-wal',p/'wal.sqlite-wal'); db.close()
with zipfile.ZipFile(p/'bundle.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr('hello.txt','hello archive'); z.writestr('../escape.txt','unsafe'); z.writestr('binary.bin',b'\\x00\\xff'); z.writestr('big.txt','x'*17000)
with tarfile.open(p/'bundle.tar.gz','w:gz') as t:
 m=tarfile.TarInfo('hello.txt'); m.size=5; t.addfile(m,io.BytesIO(b'hello'))
 m=tarfile.TarInfo('link'); m.type=tarfile.SYMTYPE; m.linkname='/etc/passwd'; t.addfile(m)
`], { timeout: 5000 });
  await client.start();
});
after(() => { client.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('single MCP exposes all bounded read-only tool schemas', async () => {
  assert.deepEqual(TOOLS.map(t => t.name), ['workspace_search', 'ssh_plan', 'web_asset_check', 'sqlite_probe', 'package_probe', 'net_probe', 'archive_probe']);
  assert.equal(new Set(TOOLS.map(t => t.name)).size, TOOLS.length);
  for (const tool of TOOLS) assert.equal(tool.annotations.readOnlyHint, true);
  const first = client.child.pid;
  await call('package_probe', { package: 'demo' });
  assert.equal(client.child.pid, first, 'same MCP process is reused');
});
test('SQLite tables/schema/describe/query/explain, pagination and parameter binding', async () => {
  const bytes = fs.readFileSync(path.join(root, 'data.sqlite'));
  assert.deepEqual((await call('sqlite_probe', { path: 'data.sqlite', action: 'tables' })).rows, [['items', 'table']]);
  assert.match((await call('sqlite_probe', { path: 'data.sqlite', action: 'schema' })).rows[0][3], /CREATE TABLE/);
  assert.equal((await call('sqlite_probe', { path: 'data.sqlite', action: 'describe', table: 'items' })).columns[1].name, 'value');
  const args = { path: 'data.sqlite', action: 'query', sql: 'SELECT * FROM items ORDER BY id', limit: 1, offset: 1 };
  const a = await call('sqlite_probe', args), b = await call('sqlite_probe', args);
  assert.deepEqual(a.rows, [[2, 'beta']]); assert.equal(a.truncated, true); assert.equal(a.input_hash, b.input_hash);
  assert.deepEqual((await call('sqlite_probe', { path: 'data.sqlite', action: 'query', sql: 'SELECT value FROM items WHERE id=?', params: [3] })).rows, [['gamma']]);
  assert.ok((await call('sqlite_probe', { path: 'data.sqlite', action: 'explain', sql: 'SELECT * FROM items WHERE id=1' })).rows.length);
  assertSameBytes(fs.readFileSync(path.join(root, 'data.sqlite')), bytes);
  assert.equal((await call('sqlite_probe', { path: 'data.sqlite', action: 'query', sql: "SELECT datetime('now')" })).cacheable, false);
  assert.equal((await call('sqlite_probe', { path: 'data.sqlite', action: 'query', sql: 'PRAGMA database_list' })).rows[0][2], path.join(root, 'data.sqlite'));
});
test('SQLite rejects writes, ATTACH, unsafe PRAGMAs, functions and multiple statements', async () => {
  for (const sql of ['DELETE FROM items', 'WITH x AS (SELECT 1) DELETE FROM items', 'EXPLAIN DELETE FROM items', 'PRAGMA user_version=3', 'PRAGMA journal_mode=WAL', 'ATTACH DATABASE ":memory:" AS more', 'SELECT load_extension("x")', 'SELECT 1; DELETE FROM items']) {
    await call('sqlite_probe', { path: 'data.sqlite', action: 'query', sql }, true);
  }
  assert.equal((await call('sqlite_probe', { path: 'data.sqlite', action: 'query', sql: 'PRAGMA user_version' })).rows[0][0], 0);
  assert.equal((await call('sqlite_probe', { path: 'data.sqlite', action: 'query', sql: 'PRAGMA table_info(items)' })).rows.length, 2);
  assert.equal((await call('sqlite_probe', { path: 'data.sqlite', action: 'query', sql: 'SELECT * FROM pragma_table_info("items")' })).rows.length, 2);
});
test('SQLite snapshot includes WAL and never creates a workspace shm file', async () => {
  const before = fs.readdirSync(root).sort();
  assert.deepEqual((await call('sqlite_probe', { path: 'wal.sqlite', action: 'query', sql: 'SELECT * FROM recent' })).rows, [[42]]);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.ok(!fs.existsSync(path.join(root, 'wal.sqlite-shm')));
});
test('workspace escape, directories, missing files, bounds and invalid actions fail closed', async () => {
  fs.symlinkSync('/etc/passwd', path.join(root, 'outside'));
  for (const p of ['/etc/passwd', '../passwd', 'outside', '.', 'missing.sqlite']) await call('sqlite_probe', { path: p, action: 'tables' }, true);
  await call('sqlite_probe', { path: 'data.sqlite', action: 'query', sql: 'SELECT 1', limit: 201 }, true);
  await call('sqlite_probe', { path: 'data.sqlite', action: 'delete' }, true);
});
test('SQLite expensive recursion is interrupted and server remains usable', { timeout: 12000 }, async () => {
  const start = Date.now();
  await call('sqlite_probe', { path: 'data.sqlite', action: 'query', sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n' }, true);
  assert.ok(Date.now() - start < 7500);
  assert.deepEqual((await call('sqlite_probe', { path: 'data.sqlite', action: 'query', sql: 'SELECT 7' })).rows, [[7]]);
});
test('package probe reports installed metadata, direct/transitive and exact npm resolution', async () => {
  const value = await call('package_probe', { package: 'demo' });
  assert.equal(value.installed_version, '2.3.4'); assert.equal(value.relationship, 'direct');
  assert.equal(value.lockfile.status, 'exact-resolution'); assert.equal(value.lockfile.matches_installed_version, true);
  assert.equal(value.exports['.'].types, './index.d.ts'); assert.equal(value.scripts.install, 'THIS_MUST_NEVER_EXECUTE');
  assert.equal((await call('package_probe', { package: 'transitive' })).relationship, 'transitive');
  assert.equal((await call('package_probe', { package: 'missing' })).installed, false);
  await call('package_probe', { package: '../escape' }, true);
  write('node_modules/demo/package.json', { name: 'demo', version: '9.0.0' });
  const changed = await call('package_probe', { package: 'demo' });
  assert.equal(changed.lockfile.matches_installed_version, false); assert.notEqual(changed.input_hash, value.input_hash);
});
test('pnpm and Yarn lock candidates do not masquerade as exact installed resolutions', async () => {
  write('pnpm/package.json', { dependencies: { demo: '^1' } });
  write('pnpm/node_modules/demo/package.json', { name: 'demo', version: '1.2.0' });
  write('pnpm/pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      demo: {specifier: '^1', version: 1.2.0}\npackages:\n  demo@1.2.0:\n    resolution: {integrity: sha512-fixture}\n");
  assert.equal((await call('package_probe', { package: 'demo', project: 'pnpm' })).lockfile.status, 'exact-resolution');
  write('yarn/package.json', { dependencies: { demo: '^1' } });
  write('yarn/node_modules/demo/package.json', { name: 'demo', version: '1.2.0' });
  write('yarn/yarn.lock', '"demo@^1":\n  version "1.2.0"\n  resolved "https://registry.example/demo.tgz"\n');
  const yarn = await call('package_probe', { package: 'demo', project: 'yarn' });
  assert.equal(yarn.lockfile.resolution.version, '1.2.0');
});
test('ZIP/TAR list, stat, find and bounded text reads never extract members', async () => {
  assert.equal((await call('archive_probe', { path: 'bundle.zip', action: 'list' })).total, 4);
  assert.equal((await call('archive_probe', { path: 'bundle.zip', action: 'stat', member: 'hello.txt' })).size, 13);
  assert.equal((await call('archive_probe', { path: 'bundle.zip', action: 'find', pattern: '*.txt' })).total, 3);
  assert.equal((await call('archive_probe', { path: 'bundle.zip', action: 'read', member: 'hello.txt' })).text, 'hello archive');
  assert.equal((await call('archive_probe', { path: 'bundle.tar.gz', action: 'read', member: 'hello.txt' })).text, 'hello');
  for (const member of ['../escape.txt', 'binary.bin', 'big.txt']) await call('archive_probe', { path: 'bundle.zip', action: 'read', member }, true);
  await call('archive_probe', { path: 'bundle.tar.gz', action: 'read', member: 'link' }, true);
  assert.ok(!fs.existsSync(path.join(root, 'hello.txt')));
});
test('network accepts one local TCP endpoint, rejects ranges, and returns structured DNS', async () => {
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await call('net_probe', { action: 'tcp', host: '127.0.0.1', port: server.address().port });
    assert.equal(result.connected, true); assert.equal(result.cacheable, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
  for (const host of ['127.0.0.0/24', '*.example.com', 'https://example.com', 'host:123']) await call('net_probe', { action: 'tcp', host, port: 123 }, true);
  const original = dns.resolve;
  try { dns.resolve = async (host, type) => { assert.equal(host, 'fixture.test'); assert.equal(type, 'MX'); return [{ exchange: 'mx.fixture.test', priority: 10 }]; }; assert.equal((await netProbe({ action: 'dns', host: 'fixture.test', record_type: 'MX' })).records[0].priority, 10); }
  finally { dns.resolve = original; }
});
test('TLS returns certificate details and self-signed chain errors without HTTP traffic', async () => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'tls-key.pem'), '-out', path.join(root, 'tls-cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { timeout: 5000, stdio: 'ignore' });
  let bytes = 0;
  const server = tls.createServer({ key: fs.readFileSync(path.join(root, 'tls-key.pem')), cert: fs.readFileSync(path.join(root, 'tls-cert.pem')) }, socket => socket.on('data', data => { bytes += data.length; }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await call('net_probe', { action: 'tls', host: '127.0.0.1', port: server.address().port, servername: 'localhost' });
    assert.equal(result.connected, true); assert.equal(result.authorized, false); assert.equal(result.chain[0].subject.CN, 'localhost');
    assert.match(result.chain[0].san, /localhost/); assert.ok(result.chain_errors.length); assert.equal(bytes, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('server cancellation and crash recovery require no manual setup', async () => {
  const controller = new AbortController();
  const pending = client.call('sqlite_probe', { path: 'data.sqlite', action: 'query', sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n' }, controller.signal);
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, /cancelled/);
  const old = client.child;
  const exited = new Promise(resolve => old.once('exit', resolve)); old.kill('SIGKILL'); await exited;
  await call('package_probe', { package: 'demo' });
  assert.notEqual(client.child.pid, old.pid);
});
test('output remains valid JSON within cap for large results', async () => {
  const result = await call('sqlite_probe', { path: 'data.sqlite', action: 'query', sql: "SELECT printf('%.*c', 30000, 'x') AS big" });
  assert.equal(result.rows[0][0].truncated, true); assert.equal(result.rows[0][0].characters, 30000);
});
test('extension prewarms automatically and closes its MCP process at shutdown', async () => {
  const { default: extension } = await import(pathToFileURL(path.join(agent, 'extensions/utility-tools.ts')));
  const events = new Map(), registered = new Map();
  extension({ on: (name, fn) => events.set(name, fn), registerTool: t => registered.set(t.name, t) });
  // The owner also registers the local checks and code-context tools that subagents load through this file.
  for (const spec of TOOLS) assert.ok(registered.has(spec.name), spec.name);
  for (const name of ['math_check', 'value_convert', 'data_query', 'context_slice', 'symbol_expand', 'ast_diff']) assert.ok(registered.has(name), name);
  await events.get('session_start')({}, { cwd: root });
  try {
    const value = await registered.get('package_probe').execute('id', { package: 'demo' }, undefined, undefined, { cwd: root });
    assert.equal(value.isError, false);
    for (const spec of TOOLS) assert.ok(registered.get(spec.name).promptGuidelines.length);
  } finally { events.get('session_shutdown')(); }
});

// Deterministic interleaving: a finished worker can exit after an ID is reused.
function protocolFixture() {
  const workers = [], replies = [];
  class FakeWorker extends EventEmitter {
    constructor() { super(); this.stdout = this.stderr = {resume(){}}; workers.push(this); }
    terminate() { this.terminated = true; return Promise.resolve(0); }
  }
  const stdin = new EventEmitter(); stdin.destroy = () => {};
  const stdout = new EventEmitter(); stdout.write = text => replies.push(JSON.parse(text)); stdout.writableLength = 0;
  const source = fs.readFileSync(path.join(agent, 'extensions/lib/utility-mcp/server.mjs'), 'utf8')
    .replace(/^import .*;$/gm, '').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(agent, 'extensions/lib/utility-mcp/server.mjs')).href));
  const api = vm.runInNewContext(source + '\n;({dispatch,shutdown,jobs})', {fs, Worker: FakeWorker, TOOLS, UTILITY_CONCURRENCY, validate: (_name, args) => args, process: {argv:['node','server','--workspace',root],stdin,stdout,on(){}}, Buffer, URL, TextDecoder, setTimeout, clearTimeout});
  const send = (id, method, params = {}) => api.dispatch({jsonrpc:'2.0', ...(id === undefined ? {} : {id}), method, params});
  return {...api, workers, replies, send};
}
test('late worker callbacks cannot cancel a replacement request reusing its ID', () => {
  const fixture = protocolFixture();
  try {
    fixture.send(1, 'initialize'); fixture.send(undefined, 'notifications/initialized');
    fixture.send(2, 'tools/call', {name:'package_probe',arguments:{package:'demo'}});
    const old = fixture.workers[0]; old.emit('message', {content:[]});
    fixture.send(2, 'tools/call', {name:'package_probe',arguments:{package:'demo'}});
    const replacement = fixture.workers[1];
    old.emit('exit', 0);
    assert.equal(replacement.terminated, undefined, 'old exit must not kill the new worker');
    assert.equal(fixture.jobs.size, 1);
    replacement.emit('message', {content:[],isError:false});
    assert.equal(fixture.replies.at(-1).result.isError, false);
  } finally { fixture.shutdown(); }
});
test('invalid initialize params do not poison the next valid handshake', () => {
  const fixture = protocolFixture();
  try {
    assert.doesNotThrow(() => fixture.send(1, 'initialize', null));
    assert.equal(fixture.replies.at(-1).error.code, -32602);
    fixture.send(2, 'initialize');
    assert.equal(fixture.replies.at(-1).result.serverInfo.name, 'yunuspi-utility-mcp');
  } finally { fixture.shutdown(); }
});

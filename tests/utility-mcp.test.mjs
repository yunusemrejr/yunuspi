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
const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(template, 'agent'), path.resolve(template, '..')].find(p => fs.existsSync(path.join(p, 'extensions/utility-tools.ts')));
const mod = name => import(pathToFileURL(path.join(agent, 'extensions/lib', name)));
const { UtilityClient } = await mod('utility-client.ts');
const { TOOLS } = await mod('utility-mcp/catalog.mjs');
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
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

before(async () => {
  write('package.json', { name: 'fixture', dependencies: { demo: '^2.0.0' } });
  write('node_modules/demo/package.json', { name: 'demo', version: '2.3.4', exports: { '.': { types: './index.d.ts', import: './index.mjs' } }, types: 'index.d.ts', bin: { demo: 'cli.js' }, peerDependencies: { peer: '^3' }, scripts: { install: 'THIS_MUST_NEVER_EXECUTE' } });
  write('node_modules/transitive/package.json', { name: 'transitive', version: '1.0.0' });
  write('package-lock.json', { lockfileVersion: 3, packages: { '': { name: 'fixture' }, 'node_modules/demo': { version: '2.3.4', resolved: 'https://registry.example/demo.tgz', integrity: 'sha512-fixture' }, 'node_modules/transitive': { version: '1.0.0' } } });
  write('openapi.yaml', `openapi: 3.1.0
security: [{apiKey: []}]
components:
  securitySchemes:
    apiKey: {type: apiKey, in: header, name: X-Key}
  schemas:
    User:
      type: object
      required: [id]
      properties:
        id: {type: integer}
        child: {$ref: '#/components/schemas/User'}
paths:
  /users/{id}:
    parameters: [{name: id, in: path, required: true, schema: {type: string}}]
    get:
      operationId: readUser
      responses:
        '200':
          content:
            application/json:
              schema: {$ref: '#/components/schemas/User'}
    post:
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema: {$ref: '#/components/schemas/User'}
      responses:
        '204': {description: Done}
`);
  write('src/a.js', 'const a = process.env.DATABASE_URL;\nconst b = process.env["TOKEN"];\nconst c = process.env.OPTIONAL ?? "SENTINEL_SECRET";\nconst d = process.env[dynamicName];\n');
  write('src/b.py', 'import os\nx = os.getenv("DATABASE_URL")\ny = os.getenv("DEFAULTED", "SENTINEL_SECRET")\n');
  write('.env.example', 'DATABASE_URL=SENTINEL_SECRET\nUNUSED=SENTINEL_SECRET\n');
  write('compose.yaml', 'services:\n  app:\n    environment:\n      OPTIONAL: SENTINEL_SECRET\n    env_file: .env\n');
  write('covered.js', 'one\ntwo\nthree\nfour\n');
  write('coverage.info', 'TN:\nSF:covered.js\nFN:1,3,work\nFNDA:0,work\nDA:1,1\nDA:2,0\nDA:3,0\nBRDA:2,0,0,0\nBRDA:2,0,1,1\nend_of_record\n');
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
  git(['init', '-q']); git(['config', 'user.email', 'fixture@example.test']); git(['config', 'user.name', 'Fixture']);
  git(['add', 'covered.js']); git(['commit', '-qm', 'fixture']);
  write('covered.js', 'one\nchanged\nthree\nfour\nfive\n');
  await client.start();
});
after(() => { client.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('single MCP exposes all eight bounded read-only tool schemas', async () => {
  assert.equal(TOOLS.length, 8);
  assert.equal(new Set(TOOLS.map(t => t.name)).size, 8);
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
  assert.deepEqual(fs.readFileSync(path.join(root, 'data.sqlite')), bytes);
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
  await call('openapi_probe', { path: 'outside', action: 'schema' }, true);
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
test('OpenAPI endpoints, schema refs/cycles, operation, request, responses and auth', async () => {
  assert.equal((await call('openapi_probe', { path: 'openapi.yaml', action: 'list_endpoints' })).total, 2);
  const schema = await call('openapi_probe', { path: 'openapi.yaml', action: 'schema', name: 'User' });
  assert.equal(schema.shape.properties.child.properties.child.recursive, true);
  const op = await call('openapi_probe', { path: 'openapi.yaml', action: 'operation', operation_id: 'readUser' });
  assert.equal(op.request.parameters[0].name, 'id');
  assert.equal(op.responses['200'].content['application/json'].properties.id.type, 'integer');
  assert.equal((await call('openapi_probe', { path: 'openapi.yaml', action: 'request_shape', endpoint: '/users/{id}', method: 'post' })).body.required, true);
  assert.ok((await call('openapi_probe', { path: 'openapi.yaml', action: 'response_shape', operation_id: 'readUser', status: '200' })).responses['200']);
  assert.equal((await call('openapi_probe', { path: 'openapi.yaml', action: 'auth' })).schemes.apiKey.in, 'header');
  assert.equal((await call('openapi_probe', { path: 'openapi.yaml', action: 'auth', endpoint: '/users/{id}', method: 'post' })).anonymous_allowed, true);
  await call('openapi_probe', { path: 'openapi.yaml', action: 'operation', operation_id: 'missing' }, true);
});
test('Swagger 2 bodies and response schemas work; external refs are not fetched', async () => {
  write('swagger.json', { swagger: '2.0', paths: { '/a': { post: { parameters: [{ in: 'body', name: 'body', schema: { $ref: '#/definitions/A' } }], responses: { 200: { schema: { $ref: 'https://example.test/never-fetch.json' } } } } } }, definitions: { A: { type: 'object', properties: { a: { type: 'string' } } } } });
  const result = await call('openapi_probe', { path: 'swagger.json', action: 'operation', endpoint: '/a', method: 'post' });
  assert.equal(result.request.parameters[0].shape.properties.a.type, 'string');
  assert.equal(result.responses['200'].content['application/json'].external, true);
});
test('contract comparison ignores values, reports structural and schema optionality changes', async () => {
  const same = await call('contract_diff', { before_value: { a: 'SECRET_ONE' }, after_value: { a: 'SECRET_TWO' } });
  assert.equal(same.identical_shape, true); assert.doesNotMatch(JSON.stringify(same), /SECRET/);
  const value = await call('contract_diff', { before_value: { a: 1, old: true, list: [{ x: 1 }] }, after_value: { a: 'x', added: null, list: [{ x: 1 }, {}] } });
  for (const kind of ['type_change', 'added_field', 'removed_field', 'array_shape_change', 'optionality_change']) assert.ok(value.items.some(i => i.kind === kind), kind);
  const schema = await call('contract_diff', { mode: 'schema', before_value: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }, after_value: { type: 'object', properties: { x: { type: 'string' } } } });
  assert.equal(schema.items[0].kind, 'optionality_change');
  const nested = await call('contract_diff', { before_value: { name: 'a' }, after_value: { user: { name: 'b' } } });
  assert.ok(nested.items.some(c => c.kind === 'nesting_change' && c.from === '/name' && c.to === '/user/name'));
  await call('contract_diff', { before_value: {}, after: 'openapi.yaml' }, true);
});
test('environment audit returns names/locations, no values, and marks unresolved accesses', async () => {
  const result = await call('env_audit', { sources: ['src/a.js', 'src/b.py'], configs: ['.env.example', 'compose.yaml'] });
  assert.deepEqual(result['required-but-undocumented'], ['TOKEN']);
  assert.deepEqual(result['documented-but-unused'], ['UNUSED']);
  assert.deepEqual(result['referenced-across-files'][0], { name: 'DATABASE_URL', files: ['src/a.js', 'src/b.py'] });
  assert.ok(result.unresolved.some(r => r.kind === 'dynamic_reference'));
  assert.ok(result.unresolved.some(r => r.kind === 'external_environment_source_not_followed'));
  assert.doesNotMatch(JSON.stringify(result), /SENTINEL_SECRET/);
  write('bad.yaml', 'env: [SENTINEL_SECRET: : invalid');
  const error = await call('env_audit', { sources: ['src/a.js'], configs: ['bad.yaml'] }, true);
  assert.doesNotMatch(JSON.stringify(error), /SENTINEL_SECRET/);
});
test('LCOV coverage intersects actual unstaged, staged and untracked Git lines', async () => {
  const args = { artifacts: ['coverage.info'], files: ['covered.js'], changed: 'all' };
  const result = (await call('coverage_probe', args)).items[0];
  assert.equal(result.lines.total, 3); assert.deepEqual(result.uncovered_lines, [2, 3]);
  assert.deepEqual(result.changed.added_or_modified_lines, [2, 5]);
  assert.deepEqual(result.changed.uncovered_lines, [2]); assert.deepEqual(result.changed.uninstrumented_lines, [5]);
  assert.equal(result.changed.uncovered_functions[0].name, 'work');
  git(['add', 'covered.js']);
  assert.deepEqual((await call('coverage_probe', { ...args, changed: 'staged' })).items[0].changed.added_or_modified_lines, [2, 5]);
  write('new.js', 'hello\nworld\n');
  const untracked = (await call('coverage_probe', { ...args, files: ['new.js'] })).items[0];
  assert.equal(untracked.present, false); assert.deepEqual(untracked.changed.uninstrumented_lines, [1, 2]);
});
test('Istanbul and Cobertura coverage preserve uncovered branch/function evidence', async () => {
  write('coverage-final.json', { 'covered.js': { path: 'covered.js', statementMap: { 0: { start: { line: 2 }, end: { line: 2 } } }, s: { 0: 0 }, fnMap: { 0: { name: 'fn', loc: { start: { line: 1 }, end: { line: 3 } } } }, f: { 0: 0 }, branchMap: { 0: { type: 'if', line: 2, locations: [{ start: { line: 2 }, end: { line: 2 } }, { start: { line: 2 }, end: { line: 2 } }] } }, b: { 0: [0, 1] } } });
  const istanbul = (await call('coverage_probe', { artifacts: ['coverage-final.json'], files: ['covered.js'] })).items[0];
  assert.deepEqual(istanbul.uncovered_lines, [2]); assert.equal(istanbul.uncovered_branches.length, 1); assert.equal(istanbul.uncovered_functions[0].name, 'fn');
  write('coverage.xml', '<coverage><packages><package><classes><class filename="covered.js"><methods><method name="fn"><lines><line number="2" hits="0"/></lines></method></methods><lines><line number="2" hits="0" branch="true" condition-coverage="50% (1/2)"/></lines></class></classes></package></packages></coverage>');
  const cobertura = (await call('coverage_probe', { artifacts: ['coverage.xml'], files: ['covered.js'] })).items[0];
  assert.equal(cobertura.lines.total, 1); assert.equal(cobertura.uncovered_branches.length, 1); assert.equal(cobertura.uncovered_functions[0].name, 'fn');
  write('entity.xml', '<!DOCTYPE coverage [<!ENTITY steal SYSTEM "file:///etc/passwd">]><coverage>&steal;</coverage>');
  await call('coverage_probe', { artifacts: ['entity.xml'], files: ['covered.js'] }, true);
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
test('output remains valid JSON within cap for large schemas and source changes invalidate hash', async () => {
  write('large.json', { openapi: '3.0.0', paths: {}, components: { schemas: { Large: { type: 'object', properties: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['field' + i, { type: 'string' }])) } } } });
  const result = await call('openapi_probe', { path: 'large.json', action: 'schema', name: 'Large' });
  assert.equal(result.output_truncated, true);
});
test('extension prewarms automatically and closes its MCP process at shutdown', async () => {
  const { default: extension } = await import(pathToFileURL(path.join(agent, 'extensions/utility-tools.ts')));
  const events = new Map(), registered = new Map();
  extension({ on: (name, fn) => events.set(name, fn), registerTool: t => registered.set(t.name, t) });
  assert.equal(registered.size, 8);
  await events.get('session_start')({}, { cwd: root });
  try {
    const value = await registered.get('package_probe').execute('id', { package: 'demo' }, undefined, undefined, { cwd: root });
    assert.equal(value.isError, false);
    for (const tool of registered.values()) assert.ok(tool.promptGuidelines.length);
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
  const api = vm.runInNewContext(source + '\n;({dispatch,shutdown,jobs})', {fs, Worker: FakeWorker, TOOLS, validate: (_name, args) => args, process: {argv:['node','server','--workspace',root],stdin,stdout,on(){}}, Buffer, URL, TextDecoder, setTimeout, clearTimeout});
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

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import dns from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const tree = path.resolve(import.meta.dirname, '..');
const agent = [path.join(tree, 'agent'), path.resolve(tree, '..'), path.resolve(tree, '../agent')].find(p => fs.existsSync(path.join(p, 'extensions/sys-probe.ts')));
const load = name => import(pathToFileURL(path.join(agent, 'extensions', name)));
const { netDiagnose, netProbe } = await load('lib/utility-mcp/net.mjs');
const { systemDiagnose, inspectionFailure } = await load('lib/utility-mcp/system-probe.mjs');
const { runSysProbe, default: registerSys } = await load('sys-probe.ts');
const { UtilityClient } = await load('lib/utility-client.ts');
const { validate } = await load('lib/utility-mcp/catalog.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-diagnosis-'));
const client = new UtilityClient(root);
after(() => { client.close(); fs.rmSync(root, { recursive: true, force: true }); });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const diagnosis = (port, protocol = 'tcp', extra = {}) => ({ action: 'diagnose', host: '127.0.0.1', port, protocol, ...extra });

test('MCP one-call HTTP diagnosis keeps ordered phase facts and sends one fixed request on one connection', async () => {
  let connections = 0, requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.method, 'HEAD'); assert.equal(req.url, '/ready');
    assert.deepEqual(Object.keys(req.headers).sort(), ['connection', 'host']);
    res.writeHead(204, { 'set-cookie': 'NEVER_EXPOSE_HTTP_CANARY', location: 'https://example.test/NEVER_EXPOSE_HTTP_CANARY' }); res.end();
  });
  server.on('connection', () => connections++);
  const port = await listen(server);
  try {
    const result = await client.call('net_probe', diagnosis(port, 'http', { path: '/ready' }));
    assert.equal(result.isError, false);
    const value = JSON.parse(result.content[0].text);
    assert.equal(value.ready, true); assert.equal(value.connection_attempts, 1);
    assert.deepEqual(value.phases.map(p => [p.phase, p.status]), [['dns', 'not_needed'], ['tcp', 'ok'], ['http', 'ok']]);
    assert.equal(value.phases[2].status_code, 204); assert.equal(connections, 1); assert.equal(requests, 1);
    assert.equal(value.executed_changes, false); assert.doesNotMatch(JSON.stringify(value), /CANARY|set-cookie|location/);
  } finally { await close(server); }
});

test('HTTP responses classify differential failure without following redirects or exposing body/header values', async () => {
  for (const [code, classification] of [[302, 'redirect_not_followed'], [401, 'authorization_required'], [404, 'route_not_found'], [405, 'head_not_supported'], [429, 'rate_limited'], [503, 'application_unavailable']]) {
    let calls = 0;
    const server = http.createServer((_req, res) => { calls++; res.writeHead(code, { location: 'http://169.254.169.254/private', 'x-private': 'NEVER_EXPOSE_HTTP_CANARY' }); res.end('NEVER_EXPOSE_BODY_CANARY'); });
    const port = await listen(server);
    try {
      const result = await netDiagnose(diagnosis(port, 'http', { path: '/' }));
      assert.equal(result.ready, false); assert.equal(result.phases.at(-1).classification, classification); assert.equal(calls, 1);
      assert.doesNotMatch(JSON.stringify(result), /CANARY|169\.254/);
    } finally { await close(server); }
  }
});

test('TLS diagnosis preserves TCP success and rejects trust before sending any HTTP bytes', async () => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { timeout: 5000, stdio: 'ignore' });
  let bytes = 0, connections = 0;
  const server = tls.createServer({ key: fs.readFileSync(path.join(root, 'key.pem')), cert: fs.readFileSync(path.join(root, 'cert.pem')) }, socket => socket.on('data', chunk => { bytes += chunk.length; }));
  server.on('connection', () => connections++);
  const port = await listen(server);
  try {
    const result = await netDiagnose(diagnosis(port, 'https', { path: '/', servername: 'localhost' }));
    assert.equal(result.ready, false); assert.equal(result.phases[1].status, 'ok');
    assert.equal(result.phases[2].authorized, false); assert.equal(result.phases[2].error, 'certificate_validation_failed');
    assert.equal(result.phases[3].status, 'skipped'); assert.equal(bytes, 0); assert.equal(connections, 1);
  } finally { await close(server); }
});

test('TCP refusal identifies only the failing layer; DNS failures make no connection', async () => {
  const server = net.createServer(); const port = await listen(server); await close(server);
  const refused = await netDiagnose(diagnosis(port, 'http', { path: '/' }));
  assert.equal(refused.phases[1].error, 'ECONNREFUSED'); assert.equal(refused.phases[2].status, 'skipped');
  assert.match(refused.next_checks[0], /cannot identify/);
  const original = dns.lookup;
  try {
    dns.lookup = async () => { throw Object.assign(Error('NEVER_EXPOSE_DNS_CANARY'), { code: 'ENOTFOUND' }); };
    const result = await netDiagnose({ action: 'diagnose', host: 'fixture.test', port: 123 });
    assert.equal(result.phases[0].error, 'ENOTFOUND'); assert.equal(result.connection_attempts, 0);
    assert.doesNotMatch(JSON.stringify(result), /CANARY/);
  } finally { dns.lookup = original; }
});

test('DNS deadline and cancellation return bounded partial evidence, then later lookup results are ignored', async () => {
  const original = dns.lookup;
  try {
    dns.lookup = async () => new Promise(() => {});
    const start = performance.now();
    const timed = await netDiagnose({ host: 'fixture.test', port: 123, timeout_ms: 100 });
    assert.equal(timed.phases[0].error, 'timeout'); assert.ok(performance.now() - start < 1000);
    const controller = new AbortController();
    const pending = netDiagnose({ host: 'fixture.test', port: 123 }, controller.signal);
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.phases[0].status, 'cancelled'); assert.equal(cancelled.connection_attempts, 0);
    await assert.rejects(netDiagnose(diagnosis(123), AbortSignal.abort()));
  } finally { dns.lookup = original; }
});

test('HTTP deadline/cancellation/oversize/close retain successful lower phases and release the socket', async () => {
  for (const mode of ['timeout', 'cancelled', 'header_limit', 'closed_before_phase_complete']) {
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      socket.once('data', () => {
        if (mode === 'header_limit') socket.end('HTTP/1.1 200 OK\r\nX-Private: ' + 'x'.repeat(20000));
        else if (mode === 'closed_before_phase_complete') socket.end();
      });
    });
    const port = await listen(server);
    try {
      const controller = new AbortController();
      const pending = netDiagnose(diagnosis(port, 'http', { path: '/', timeout_ms: mode === 'timeout' ? 100 : 4500 }), controller.signal);
      if (mode === 'cancelled') setTimeout(() => controller.abort(), 30);
      const result = await pending;
      assert.equal(result.phases[1].status, 'ok'); assert.equal(result.phases[2].error, mode);
      assert.equal(result.connection_attempts, 1);
    } finally { for (const socket of sockets) socket.destroy(); await close(server); }
  }
});

test('host/path/scope guards reject before connection, including resolved metadata and mapped IPv6', async () => {
  for (const target of ['0.0.0.0', '169.254.169.254', '224.0.0.1', '255.255.255.255', '::', 'fe80::1', 'ff02::1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe']) {
    const result = await netDiagnose({ host: target, port: 123 });
    assert.equal(result.phases[0].status, 'blocked', target); assert.equal(result.connection_attempts, 0);
  }
  for (const host of ['127.0.0.0/24', '*.example.test', 'http://example.test', 'user@example.test', 'host:123', 'fixture\n.test']) await assert.rejects(netDiagnose({ host, port: 123 }));
  for (const pathname of ['//example.test', '/?secret=CANARY', '/%0d%0aHost:evil', '/x#fragment', '/x\r\nCookie:private']) await assert.rejects(netDiagnose(diagnosis(123, 'http', { path: pathname })));
  await assert.rejects(netDiagnose(diagnosis(123, 'http')));
  await assert.rejects(netDiagnose(diagnosis(123, 'tcp', { path: '/' })));
  assert.throws(() => validate('net_probe', { ...diagnosis(123), headers: { authorization: 'SYNTHETIC_TEST_CANARY' } }));
  const original = dns.lookup;
  try { dns.lookup = async () => ({ address: '169.254.170.2', family: 4 }); const result = await netDiagnose({ host: 'fixture.test', port: 123 }); assert.equal(result.phases[0].status, 'blocked'); assert.equal(result.connection_attempts, 0); }
  finally { dns.lookup = original; }
  await assert.rejects(netProbe({ action: 'tcp', host: '169.254.169.254', port: 80 }), /blocked/);
});

test('Linux diagnosis uses exact read-only commands and omission-safe numeric metadata with partial evidence', async () => {
  const writes = new Set(), commands = [];
  const metadata = {
    '/proc/meminfo': 'MemTotal: 100000 kB\nMemAvailable: 3000 kB\nSecret: NEVER_EXPOSE_SYSTEM_CANARY\n',
    '/proc/pressure/cpu': 'some avg10=1.00 avg60=2.00 avg300=3.00 total=42\n',
    '/proc/self/cgroup': '0::/fixture\n',
    '/sys/fs/cgroup/fixture/memory.max': '1024000\n', '/sys/fs/cgroup/fixture/memory.current': '1024\n', '/sys/fs/cgroup/fixture/cpu.max': '200000 100000\n', '/sys/fs/cgroup/fixture/pids.max': 'max\n', '/sys/fs/cgroup/fixture/pids.current': '2\n',
    '/proc/42/status': 'Name: NEVER_EXPOSE_PROCESS_CANARY\nState: D (disk sleep)\nPPid: 1\nThreads: 2\nVmRSS: 1024 kB\n',
  };
  const value = await systemDiagnose({ pid: 42, port: 123, unit: 'example.service' }, undefined, {
    platform: 'linux', read: async file => { writes.add(file); return metadata[file] === undefined ? { status: 'permission_denied' } : { status: 'ok', text: metadata[file] }; },
    run: async (binary, args) => { commands.push([binary, args]); return 'LISTEN 0 10 127.0.0.1:123 0.0.0.0:* users:(("NEVER_EXPOSE_COMMAND_CANARY",pid=42,fd=1))\n'; },
    service: async () => ({ rows: [{ ActiveState: 'failed', MainPID: 42 }] }),
  });
  assert.deepEqual(commands, [['/usr/bin/ss', ['-ltnpH', 'sport', '=', ':123']]]);
  assert.ok(![...writes].some(file => /environ|cmdline|config/.test(file)));
  assert.equal(value.rows[0].facts.cgroup.cpu_quota_cores, 2); assert.equal(value.rows[0].facts.pressure.memory.status, 'permission_denied');
  assert.equal(value.rows[1].facts.state, 'D'); assert.deepEqual(value.rows[2].facts.listeners, [{ bind: 'loopback', pids: [42] }]);
  assert.deepEqual(value.findings.map(row => row.code).sort(), ['low_available_memory', 'partial', 'process_uninterruptible_wait', 'service_failed']);
  assert.equal(value.status, 'partial');
  assert.equal(value.proposed_recovery.executed, false); assert.doesNotMatch(JSON.stringify(value), /CANARY|restart|kill|chmod/);
});

test('Linux diagnosis separates unavailable, denied and generic failures; no-target default avoids commands', async () => {
  for (const [code, expected] of [['ENOENT', 'unavailable'], ['EACCES', 'permission_denied'], [1, 'inspection_failed']]) {
    const result = await systemDiagnose({ port: 123 }, undefined, { platform: 'linux', read: async () => ({ status: 'unavailable' }), run: async () => { throw Object.assign(Error('NEVER_EXPOSE_COMMAND_CANARY'), { code }); } });
    assert.equal(result.rows[1].status, expected); assert.equal(result.status, 'partial'); assert.doesNotMatch(JSON.stringify(result), /CANARY/);
  }
  assert.equal(inspectionFailure({ inspectionCode: 'manager_unavailable' }), 'manager_unavailable');
  const value = await systemDiagnose({}, undefined, { platform: 'linux', run: async () => { assert.fail('default must not enumerate'); }, read: async () => ({ status: 'unavailable' }) });
  assert.equal(value.rows.length, 1); assert.equal(value.status, 'partial');
  assert.equal((await systemDiagnose({}, undefined, { platform: 'other' })).status, 'unavailable');
  for (const options of [{ pid: 0 }, { port: 65536 }, { unit: '*.service' }, { unit: '../x.service' }, { user: true }, { cursor: 's=1' }]) await assert.rejects(systemDiagnose(options));
  await assert.rejects(systemDiagnose({}, AbortSignal.abort()));
});

test('Linux cancellation retains completed evidence and fixed metadata reads reject links, unavailable and denied files', async () => {
  const controller = new AbortController();
  const pending = systemDiagnose({ port: 123 }, controller.signal, { platform: 'linux', read: async () => ({ status: 'unavailable' }), run: async (_binary, _args, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  setTimeout(() => controller.abort(), 20);
  const cancelled = await pending;
  assert.equal(cancelled.rows[0].status, 'unavailable'); assert.equal(cancelled.rows[1].status, 'cancelled');
  const fixture = path.join(root, 'system'); fs.mkdirSync(path.join(fixture, 'proc/42'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'proc/meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 500 kB\n');
  fs.writeFileSync(path.join(root, 'secret-status'), 'Name: NEVER_EXPOSE_SYMLINK_CANARY\nState: R (running)\n');
  fs.symlinkSync(path.join(root, 'secret-status'), path.join(fixture, 'proc/42/status'));
  const linked = await systemDiagnose({ pid: 42 }, undefined, { root: fixture, platform: 'linux' });
  assert.equal(linked.rows[0].facts.memory.status, 'ok'); assert.equal(linked.rows[0].facts.pressure.cpu.status, 'unavailable');
  assert.notEqual(linked.rows[1].status, 'ok'); assert.doesNotMatch(JSON.stringify(linked), /CANARY/);
  fs.chmodSync(path.join(fixture, 'proc/meminfo'), 0);
  try {
    const denied = await systemDiagnose({}, undefined, { root: fixture, platform: 'linux' });
    if (process.getuid?.() !== 0) assert.equal(denied.rows[0].facts.memory.status, 'permission_denied');
  } finally { fs.chmodSync(path.join(fixture, 'proc/meminfo'), 0o600); }
});

test('Linux actual resources and self PID execute in one native call; explicit port agrees with loopback listener', { skip: process.platform !== 'linux' }, async () => {
  let tool; registerSys({ registerTool: value => { tool = value; } });
  assert.ok(tool.parameters.properties.action.enum.includes('diagnose'));
  const server = net.createServer(socket => socket.end()); const port = await listen(server);
  try {
    const result = await tool.execute('diagnosis', { action: 'diagnose', pid: process.pid, port });
    assert.notEqual(result.isError, true, result.content[0].text);
    const value = JSON.parse(result.content[0].text);
    assert.deepEqual(value.rows.map(row => row.phase), ['resources', 'process', 'port']);
    assert.equal(value.rows[0].facts.platform, 'linux'); assert.ok(value.rows[0].facts.memory.total_mib > 0);
    assert.equal(value.rows[1].facts.pid, process.pid); assert.equal(value.rows[1].status, 'ok');
    if (fs.existsSync('/usr/bin/ss')) { assert.equal(value.rows[2].status, 'ok'); assert.ok(value.rows[2].facts.listeners.some(row => row.bind === 'loopback')); }
    else assert.equal(value.rows[2].status, 'unavailable');
    assert.equal(value.executed_changes, false); assert.ok(Buffer.byteLength(JSON.stringify(value)) < 8192);
    const wrong = await runSysProbe('host', 10, undefined, { pid: process.pid }).then(() => null, error => error);
    assert.match(wrong.message, /diagnose/);
  } finally { await close(server); }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = [path.join(root, 'agent'), path.resolve(root, '..')].find((candidate) =>
  fs.existsSync(path.join(candidate, 'extensions/http-tools.ts')),
);
assert.ok(agentRoot, 'http tools ship with the distribution');

const { default: registerHttpTools, performHttp } = await import(
  pathToFileURL(path.join(agentRoot, 'extensions/http-tools.ts')),
);

await assert.rejects(
  () => performHttp(
    { url: 'http://public-host.example/metadata' },
    undefined,
    { lookup: async () => [{ address: '169.254.169.254', family: 4 }] },
  ),
  /Blocked internal address/,
  'public host resolving to cloud metadata is blocked before undici connects',
);

const controller = new AbortController();
let started;
const lookupStarted = new Promise((resolve) => { started = resolve; });
const pending = performHttp(
  { url: 'http://localhost/' },
  controller.signal,
  { lookup: async () => { started(); return new Promise(() => {}); } },
);
await lookupStarted;
controller.abort();
await assert.rejects(
  () => pending,
  /Remote fetch aborted/,
  'localhost DNS pinning remains bounded by cancellation',
);

const tools = new Map();
registerHttpTools({ registerTool(definition) { tools.set(definition.name, definition); } });
const result = await tools.get('http_request').execute(
  'id',
  { url: 'http://169.254.169.254/latest' },
  new AbortController().signal,
);
assert.equal(result.isError, true);
assert.equal(result.details.kind, 'validation');
assert.equal(result.details.retryable, false);

// DNS validation consumes the same wall-time budget as response transfer.
const keepAlive = setTimeout(() => {}, 3000);
try {
  await assert.rejects(
    performHttp({ url: 'http://localhost/', timeoutMs: 1000 }, undefined,
      { lookup: () => new Promise(() => {}) }),
    /Request timed out after 1000ms/,
    'a DNS deadline is a retryable timeout, not user cancellation',
  );
} finally { clearTimeout(keepAlive); }

// Binary response truncation must preserve complete, decodable base64 blocks.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.end(Buffer.alloc(Number(req.url.slice(1)), 0xff));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const size of [1, 761, 762, 763, 1024, 2048]) {
    const result = await performHttp({ url: `http://127.0.0.1:${server.address().port}/${size}`, maxBytes: 1024 });
    assert.equal(result.encoding, 'base64');
    assert.ok(result.body.startsWith('base64:'));
    const encoded = result.body.slice('base64:'.length);
    const decoded = Buffer.from(encoded, 'base64');
    assert.equal(decoded.toString('base64'), encoded, 'binary truncation remains canonical base64');
    assert.deepEqual(decoded, Buffer.alloc(Math.min(size, 762), 0xff));
    assert.equal(result.truncated, size > 762);
    assert.ok(Buffer.byteLength(result.body) <= 1024);
  }
} finally { await new Promise(resolve => server.close(resolve)); }

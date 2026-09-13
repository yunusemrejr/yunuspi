import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

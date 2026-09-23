import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/model-exclusions.ts')));
assert.ok(agent, 'model exclusion owner not found');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared')).href + '/';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-exclusions-'));
process.env.PI_PROVIDER_STATE_FILE = path.join(temporary, 'provider-health.json');
const { isLocalModelResolutionFailure: local } = await import(shared + 'local-model-failure.ts');
const health = await import(shared + 'provider-health.ts');
let counter = 0;
const store = async name => {
  const file = path.join(temporary, name + '.json');
  process.env.PI_MODEL_EXCLUSIONS_PATH = file;
  const api = await import(shared + `model-exclusions.ts?fixture=${counter++}`);
  return { file, api, read: () => JSON.parse(fs.readFileSync(file, 'utf8')).exclusions };
};
const diagnostic = id => `Error: Model "${id}" not found. Use --list-models to see available models.`;
const entry = (modelId, reason, extra = {}) => ({ provider: 'fixture', ...(modelId === undefined ? {} : { modelId }), reason, recordedAt: Date.now() - 1000, expiresAt: Date.now() + 86400000, ...extra });
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('local classification requires complete owned pre-transport diagnostics, never remote bodies', () => {
  const known = [diagnostic('fixture/namespaced/model'), '\u001b[31m' + diagnostic('fixture/429-quota-model') + '\u001b[0m\n',
    'Unknown provider "fixture". Use --list-models to see available providers/models.',
    'Error: Unknown provider "fixture". Use --list-models to see available providers.',
    'route fixture/quota-model not in registry at launch'];
  for (const value of known) assert.equal(local(value), true, value);
  for (const value of [null, {}, '', 'model not found', 'HTTP 404 model not found', '401 invalid API key', '429 quota exceeded',
    'HTTP 404: ' + diagnostic('fixture/model'), JSON.stringify({ error: { message: diagnostic('fixture/model') } }),
    'Remote server said: ' + diagnostic('fixture/model'), diagnostic('fixture/model') + '\nHTTP status 404',
    'Error: Model "fixture/model" not found.', diagnostic('x'.repeat(513)), diagnostic('fixture/model') + ' '.repeat(8192)])
    assert.equal(local(value), false, String(value));
});

test('new local failures never create exclusions or provider pressure, including misleading route words', async () => {
  const s = await store('local-failure');
  for (const reason of [diagnostic('fixture/429-quota-model'), 'route fixture/authentication-error not in registry at launch']) {
    s.api.recordModelFailure({ provider: 'fixture', modelId: '429-quota-model', reason });
    assert.equal(health.classifyFailure(reason), undefined);
    assert.equal(health.recordFailure({ provider: 'fixture', model: '429-quota-model', errorMessage: reason }), undefined);
  }
  assert.equal(fs.existsSync(s.file), false);
  assert.equal(fs.existsSync(process.env.PI_PROVIDER_STATE_FILE), false);
  assert.equal(s.api.findModelExclusion('fixture/429-quota-model'), undefined);
  assert.equal(health.classifyFailure('HTTP 429 quota exceeded').kind, 'quota-rate');
  assert.equal(health.classifyFailure('HTTP 401 invalid API key').kind, 'provider-auth');
  assert.equal(health.classifyFailure('HTTP 503 service unavailable').kind, 'provider-outage');
});

test('loading reconciles only historical local diagnostics and preserves true remote exclusions exactly', async () => {
  const s = await store('historical');
  const retained = [entry('missing', 'HTTP 404 model not found'), entry('auth', 'HTTP 401 invalid API key'),
    entry('quota', '429 quota exceeded'), entry('remote-quote', JSON.stringify({ error: { message: diagnostic('fixture/remote-quote') } })),
    entry('ambiguous', 'Model is unavailable'), entry(undefined, '429 provider quota exceeded')];
  fs.writeFileSync(s.file, JSON.stringify({ version: 1, exclusions: [entry('local', diagnostic('fixture/local')), ...retained] }));
  assert.equal(s.api.isExcluded('local', 'other'), false);
  assert.deepEqual(s.read(), retained, 'timestamps and reasons of true provider failures stay unchanged');
  assert.equal(s.api.findModelExclusion('fixture/missing').reason, retained[0].reason);
  assert.equal(s.api.findModelExclusion('fixture/anything').reason, '429 provider quota exceeded');
  assert.deepEqual(s.api.filterFallbackCandidates(['other/local', 'fixture/missing']), ['other/local']);
});

test('a stale reader cannot erase sibling failures or resurrect cleared exclusions', async () => {
  const a = await store('stale');
  const b = await import(shared + `model-exclusions.ts?fixture=${counter++}`);
  a.api.recordModelFailure({ provider: 'fixture', modelId: 'a', reason: 'HTTP 404 model not found' });
  b.recordModelFailure({ provider: 'fixture', modelId: 'b', reason: 'HTTP 429 quota exceeded' });
  a.api.flushPersist();
  assert.deepEqual(a.read().map(x => x.modelId).sort(), ['a', 'b']);
  assert.equal(a.api.isExcluded('b', 'fixture'), true, 'queries observe sibling durable writes');
  b.clearExclusions();
  a.api.flushPersist();
  assert.deepEqual(a.read(), [], 'stale flush cannot undo a deliberate clear');
  b.recordModelFailure({ provider: 'fixture', modelId: 'after-clear', reason: 'HTTP 401 invalid API key' });
  a.api.clearExpiredExclusions();
  assert.deepEqual(a.read().map(x => x.modelId), ['after-clear'], 'pruning cannot overwrite a later failure');
});

test('concurrent native processes preserve independent exclusions with atomic private writes', { timeout: 15000 }, async () => {
  const s = await store('concurrent');
  const go = path.join(temporary, 'start-writers');
  const worker = `import fs from 'node:fs';
const [source,file,ready,go,writer]=process.argv.slice(1);
process.env.PI_MODEL_EXCLUSIONS_PATH=file;
const api=await import(source);
fs.writeFileSync(ready,'ready');
const wait=new Int32Array(new SharedArrayBuffer(4)), deadline=Date.now()+10000;
while(!fs.existsSync(go)){if(Date.now()>deadline)throw Error('fixture barrier timed out');Atomics.wait(wait,0,0,5);}
for(let i=0;i<8;i++)api.recordModelFailure({provider:'fixture',modelId:'writer-'+writer+'-'+i,reason:'HTTP 404 model not found'});`;
  const ready = Array.from({ length: 6 }, (_, i) => path.join(temporary, `writer-ready-${i}`));
  const children = ready.map((file, i) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', worker, shared + 'model-exclusions.ts', s.file, file, go, String(i)]));
  const deadline = Date.now() + 10000;
  while (!ready.every(file => fs.existsSync(file))) { assert.ok(Date.now() < deadline, 'workers became ready'); await new Promise(resolve => setTimeout(resolve, 10)); }
  fs.writeFileSync(go, 'go');
  const output = await Promise.all(children);
  assert.ok(output.every(row => row.stderr === ''), 'all writers obtained the lock');
  assert.equal(s.read().length, 48);
  assert.equal(new Set(s.read().map(row => row.modelId)).size, 48);
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(s.file + '.lock'), false);
});

test('TTL shortening persists without losing later rows, and switching paths cannot copy cached state', async () => {
  const s = await store('ttl');
  s.api.recordModelFailure({ provider: 'fixture', modelId: 'shorten', reason: 'HTTP 404 model not found' });
  const recordedAt = s.read()[0].recordedAt;
  s.api.setDefaultTTL(10000, { shortenExisting: true });
  assert.equal(s.read()[0].expiresAt, recordedAt + 10000);
  for (const ttl of [0, -1, Infinity, NaN, s.api.MAX_MODEL_EXCLUSION_TTL_MS + 1]) assert.throws(() => s.api.setDefaultTTL(ttl));
  const replacement = path.join(temporary, 'replacement.json');
  process.env.PI_MODEL_EXCLUSIONS_PATH = replacement;
  assert.equal(s.api.findModelExclusion('fixture/shorten'), undefined);
  s.api.flushPersist();
  assert.deepEqual(JSON.parse(fs.readFileSync(replacement, 'utf8')).exclusions, []);
});

test('malformed durable state is retained and cannot be overwritten by a cached empty snapshot', async () => {
  const s = await store('malformed');
  const raw = '{broken-fixture'; fs.writeFileSync(s.file, raw);
  const old = console.error, errors = []; console.error = (...args) => errors.push(args.join(' '));
  try {
    s.api.recordModelFailure({ provider: 'fixture', modelId: 'new', reason: 'HTTP 503 service unavailable' });
    s.api.flushPersist();
  } finally { console.error = old; }
  assert.equal(fs.readFileSync(s.file, 'utf8'), raw);
  assert.ok(errors.length > 0); assert.ok(errors.every(text => !text.includes(raw)));
  assert.equal(fs.existsSync(s.file + '.lock'), false);
  fs.writeFileSync(s.file, JSON.stringify({ version: 1, exclusions: [] }));
  s.api.recordModelFailure({ provider: 'fixture', modelId: 'repaired', reason: 'HTTP 503 service unavailable' });
  assert.deepEqual(s.read().map(x => x.modelId), ['repaired']);
});

test('invalid model targets never broaden into provider-wide exclusions', async () => {
  const s = await store('invalid-target');
  for (const target of [{ provider: 'fixture', modelId: '' }, { provider: 'fixture', modelId: null }, { provider: 'fixture', modelId: 3 }, { provider: '' }, {}, { modelId: '   ' }])
    assert.throws(() => s.api.recordModelFailure({ ...target, reason: 'HTTP 429 quota exceeded' }), /target/);
  assert.equal(fs.existsSync(s.file), false);
  const invalid = entry('', 'HTTP 429 quota exceeded');
  fs.writeFileSync(s.file, JSON.stringify({ version: 1, exclusions: [invalid] }));
  const old = console.error; console.error = () => {};
  try { assert.equal(s.api.isExcluded('unrelated-model', 'fixture'), false); s.api.flushPersist(); }
  finally { console.error = old; }
  assert.deepEqual(s.read(), [invalid], 'invalid durable scope is retained for repair, not silently rewritten');
});

test('transient read corruption retains valid same-path exclusions but never leaks across paths', async () => {
  const s = await store('cached-corruption');
  s.api.recordModelFailure({ provider: 'fixture', modelId: 'known-failure', reason: 'HTTP 401 invalid API key' });
  fs.writeFileSync(s.file, '{truncated');
  const old = console.error, errors = []; console.error = text => errors.push(text);
  try {
    assert.equal(s.api.isExcluded('known-failure', 'fixture'), true);
    s.api.reloadFromDisk();
    assert.equal(s.api.isExcluded('known-failure', 'fixture'), true, 'explicit reload preserves last valid same-path state');
    s.api.clearExpiredExclusions();
    assert.equal(s.api.findModelExclusion('fixture/known-failure').reason, 'HTTP 401 invalid API key');
    assert.equal(errors.filter(text => text.includes('Could not read')).length, 1, 'same corrupt stamp reports one read warning');
    const replacement = path.join(temporary, 'other-corruption.json');
    fs.writeFileSync(replacement, '{truncated'); process.env.PI_MODEL_EXCLUSIONS_PATH = replacement;
    assert.equal(s.api.isExcluded('known-failure', 'fixture'), false);
  } finally { console.error = old; }
  assert.equal(fs.readFileSync(s.file, 'utf8'), '{truncated');
});

test('an existing old lock is never reclaimed, and bounded contention retains durable exclusions', { timeout: 5000 }, async () => {
  const s = await store('contended');
  s.api.recordModelFailure({ provider: 'fixture', modelId: 'known-failure', reason: 'HTTP 404 model not found' });
  const before = fs.readFileSync(s.file, 'utf8'), lock = s.file + '.lock';
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), '{"pid":2147483647}');
  fs.utimesSync(lock, new Date(0), new Date(0));
  const old = console.error; console.error = () => {}; const started = Date.now();
  try { s.api.recordModelFailure({ provider: 'fixture', modelId: 'blocked-write', reason: 'HTTP 429 quota exceeded' }); }
  finally { console.error = old; }
  assert.ok(Date.now() - started < 4000, 'lock wait remains bounded');
  assert.equal(fs.existsSync(lock), true, 'no writer can remove and replace another lock during stale reclamation');
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  const readsStarted = Date.now(), unchanged = fs.statSync(s.file).mtimeMs;
  assert.equal(s.api.getExcludedCount(), 1);
  assert.equal(s.api.getExcludedCount(), 1);
  assert.ok(Date.now() - readsStarted < 1000, 'ordinary counts do not wait for the existing lock');
  assert.equal(fs.statSync(s.file).mtimeMs, unchanged);
  fs.rmSync(lock, { recursive: true });
  assert.equal(s.api.isExcluded('known-failure', 'fixture'), true);
});

test('a blocked historical reconciliation is cached and does not stall every later read', { timeout: 5000 }, async () => {
  const s = await store('blocked-reconciliation');
  const entries = [entry('local', diagnostic('fixture/local')), entry('remote', 'HTTP 429 quota exceeded')];
  fs.writeFileSync(s.file, JSON.stringify({ version: 1, exclusions: entries }));
  fs.mkdirSync(s.file + '.lock');
  const old = console.error, messages = []; console.error = text => messages.push(text);
  try {
    assert.equal(s.api.findModelExclusion('fixture/local'), undefined);
    const next = Date.now();
    assert.equal(s.api.findModelExclusion('fixture/remote').reason, 'HTTP 429 quota exceeded');
    assert.equal(s.api.getExcludedCount(), 1);
    assert.ok(Date.now() - next < 1000, 'same-stamp reads do not keep retrying locked migration');
    assert.equal(messages.length, 1); assert.match(messages[0], /abandoned lock requires explicit repair/);
  } finally { console.error = old; fs.rmSync(s.file + '.lock', { recursive: true }); }
  assert.deepEqual(s.read(), entries, 'content remains unchanged until a writer can reconcile it');
  s.api.flushPersist(); assert.deepEqual(s.read().map(row => row.modelId), ['remote']);
});

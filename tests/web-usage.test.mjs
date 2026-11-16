import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSessionCost } from '@yunuspi/coding-agent/session-accounting';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-web-usage-'));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = scratch;
test.after(() => {
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});
const base = fs.existsSync(new URL('../agent/extensions/pi-web-access/', import.meta.url))
  ? '../agent/extensions/pi-web-access/' : '../extensions/pi-web-access/';
const load = name => import(new URL(base + name, import.meta.url));
const { bindWebUsage, startWebUsage } = await load('web-usage.ts');

function ledger() {
  const entries = [];
  let id = 'original-session';
  const ctx = { sessionManager: { getSessionId: () => id } };
  const onUsage = bindWebUsage({ appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) }, ctx, 'fixture');
  return { entries, onUsage, switchSession: session => { id = session; } };
}

test('late receipts stay bound to their originating session', () => {
  const usage = ledger();
  const finish = startWebUsage(usage, 'provider', 'model-id');
  assert.equal(collectSessionCost(usage.entries).pending, 1);
  usage.switchSession('different-session');
  finish('completed', { cost: { total: 99, source: 'provider-reported' } });
  assert.equal(usage.entries.length, 1);
  assert.equal(collectSessionCost(usage.entries).formatted, '$?');
});

test('Sonar records a reported total once, includes zero, and flags absent billing', async (t) => {
  const { searchWithPerplexity } = await load('perplexity.ts');
  const old = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = 'synthetic-sonar-fixture';
  t.after(() => { if (old === undefined) delete process.env.PERPLEXITY_API_KEY; else process.env.PERPLEXITY_API_KEY = old; });
  const pendingBills = [{ total_cost: .033, request_cost: .03 }, { total_cost: 0 }, undefined];
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    choices: [{ message: { content: 'fixture answer' } }],
    usage: { prompt_tokens: 7, completion_tokens: 2, cost: pendingBills.shift() },
  }));
  const usage = ledger();
  const options = { onUsage: usage.onUsage };
  for (let request = 0; request < 3; request++) await searchWithPerplexity('fixture question', options);
  assert.equal(usage.entries.length, 6);
  assert.equal(new Set(usage.entries.map(entry => entry.data.id)).size, 3);
  assert.equal(collectSessionCost(usage.entries.slice(0, 4)).formatted, '$0.033000');
  assert.equal(collectSessionCost(usage.entries.slice(2, 4)).formatted, '$0.000');
  assert.equal(collectSessionCost(usage.entries).formatted, '$0.033000+?');
  assert.equal(usage.entries[1].data.usage.input, 7);
  assert.doesNotMatch(JSON.stringify(usage.entries), /fixture question|synthetic-sonar-fixture|fixture answer/);
});

test('Datalab bills the final discounted cents once despite polling and local result failure', async (t) => {
  const { extractPDFViaDatalab } = await load('datalab-pdf-extract.ts');
  const old = process.env.DATALAB_API_KEY;
  process.env.DATALAB_API_KEY = 'synthetic-datalab-fixture';
  t.after(() => { if (old === undefined) delete process.env.DATALAB_API_KEY; else process.env.DATALAB_API_KEY = old; });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const route = new URL(url).pathname;
    calls.push([init.method, route]);
    if (route.endsWith('/files/upload')) return Response.json({ file_id: 'fixture', upload_url: 'https://example.invalid/object' });
    if (route === '/object') return new Response();
    if (route.endsWith('/confirm')) return Response.json({ reference: 'datalab://fixture' });
    if (route.endsWith('/convert')) return Response.json({ success: true, request_check_url: '/api/v1/convert/fixture' });
    if (route.endsWith('/convert/fixture')) return Response.json({ status: 'complete', cost_breakdown: { final_cost_cents: 3, list_cost_cents: 11 } });
    if (init.method === 'DELETE') return new Response();
    throw Error('Unexpected fixture fetch');
  });
  const usage = ledger();
  await assert.rejects(extractPDFViaDatalab(new ArrayBuffer(1), { maxPages: 1, title: 'fixture PDF', onUsage: usage.onUsage }), /empty markdown/);
  assert.deepEqual(usage.entries.map(entry => entry.data.status), ['pending', 'completed']);
  assert.equal(usage.entries[0].data.id, usage.entries[1].data.id);
  const cost = collectSessionCost(usage.entries);
  assert.equal(cost.formatted, '$0.030000');
  assert.equal(cost.pending, 0);
  assert.ok(calls.length >= 5);
});

test('local-only PDF extraction keeps authenticated and background documents out of hosted conversion', async (t) => {
  const config = path.join(scratch, 'web-search.json');
  fs.writeFileSync(config, JSON.stringify({ pdf: { provider: 'datalab' }, datalabApiKey: 'synthetic-pdf-fixture' }));
  t.after(() => fs.rmSync(config, { force: true }));
  const { extractPDFToMarkdown } = await load('pdf-extract.ts');
  const providerFetch = t.mock.method(globalThis, 'fetch', async () => { throw Error('unexpected hosted PDF upload'); });
  const usage = ledger();
  // Malformed bytes reach the local parser and must not trigger a remote fallback.
  await assert.rejects(extractPDFToMarkdown(new ArrayBuffer(1), 'https://example.invalid/fixture.pdf', { localOnly: true, onUsage: usage.onUsage }));
  assert.equal(providerFetch.mock.callCount(), 0);
  assert.deepEqual(usage.entries, []);
});

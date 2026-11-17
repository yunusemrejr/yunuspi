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

test('a paid Datalab failure settles its source ledger after the SDK forks', async (t) => {
  const { AgentSessionRuntime, DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } = await import('@yunuspi/coding-agent');
  const { extractPDFViaDatalab } = await load('datalab-pdf-extract.ts');
  const old = process.env.DATALAB_API_KEY;
  process.env.DATALAB_API_KEY = 'synthetic-datalab-fork';
  t.after(() => { if (old === undefined) delete process.env.DATALAB_API_KEY; else process.env.DATALAB_API_KEY = old; });
  const cwd = fs.mkdtempSync(path.join(scratch, 'fork-'));
  const submitted = Promise.withResolvers();
  const response = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/files/upload')) return Response.json({ file_id:'fixture', upload_url:'https://example.invalid/object' });
    if (route === '/object' || init.method === 'DELETE') return new Response();
    if (route.endsWith('/confirm')) return Response.json({ reference:'datalab://fixture' });
    if (route.endsWith('/convert')) { submitted.resolve(); return response.promise; }
    throw Error('Unexpected fixture fetch');
  });
  const model = { id:'fixture', name:'Fixture', api:'openai-completions', provider:'audit', baseUrl:'https://fixture.invalid',
    input:['text'], reasoning:false, contextWindow:8192, maxTokens:2048, cost:{input:0, output:0, cacheRead:0, cacheWrite:0} };
  const modelRuntime = { getModel:()=>model, getAvailable:()=>[model], hasConfiguredAuth:()=>true, isUsingSubscription:()=>false,
    streamSimple(){ assert.fail('the fixture makes no model request'); } };
  let onUsage;
  async function create(sessionManager) {
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir:cwd, settingsManager, noExtensions:true,
      noSkills:true, noPromptTemplates:true, noThemes:true, noContextFiles:true, extensionFactories:[pi => {
        pi.on('session_start', (_event, ctx) => { onUsage = bindWebUsage(pi, ctx, 'fetch_content'); });
      }] });
    await resourceLoader.reload();
    const result = await createAgentSession({ cwd, agentDir:cwd, model, modelRuntime, settingsManager, resourceLoader, sessionManager, tools:[] });
    await result.session.bindExtensions({mode:'print'});
    return {...result, services:{cwd, agentDir:cwd}};
  }
  const manager = SessionManager.create(cwd, cwd);
  manager.appendMessage({role:'user', content:'Convert a fixture PDF', timestamp:Date.now()});
  manager.flush();
  const original = await create(manager);
  const sourceLeaf = manager.getLeafId();
  const sourceFile = manager.getSessionFile();
  const host = new AgentSessionRuntime(original.session, original.services, ({sessionManager}) => create(sessionManager));
  t.after(() => host.dispose());
  const saved = () => SessionManager.open(sourceFile, cwd).getEntries();
  const earlier = startWebUsage({onUsage}, 'datalab', 'convert-fast');
  earlier('completed', {cost:{total:0, source:'provider-reported'}});
  const extraction = assert.rejects(extractPDFViaDatalab(new ArrayBuffer(1), {maxPages:1, title:'fixture PDF', mode:'balanced', onUsage}), /fixture failure/);
  try {
    await Promise.race([submitted.promise, extraction.then(() => { throw Error('the fixture failed before submitting the conversion'); })]);
    assert.equal(collectSessionCost(saved()).pending, 1);
    assert.equal((await host.fork(sourceLeaf, {position:'at'})).cancelled, false);
  } finally {
    response.resolve(Response.json({status:'failed', error:'fixture failure', cost_breakdown:{final_cost_cents:14}}));
    await extraction;
  }
  const entries = saved();
  const source = collectSessionCost(entries);
  assert.equal(source.reported, .14);
  assert.equal(source.pending, 0);
  assert.equal(collectSessionCost([...entries, ...entries]).reported, .14);
  const receipts = entries.filter(entry => entry.customType === 'auxiliary-model-usage-v1' && entry.data.model === 'convert-balanced');
  assert.deepEqual(receipts.map(entry => [entry.parentId, entry.data.status]), [[sourceLeaf, 'pending'], [sourceLeaf, 'failed']]);
  assert.equal(receipts[0].data.id, receipts[1].data.id);
  const current = collectSessionCost(host.session.sessionManager.getEntries());
  assert.equal(current.total, 0);
  assert.equal(current.pending, 0);
  assert.equal(current.formatted, '$0.000', 'the fork preserves previous settled zero evidence');
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

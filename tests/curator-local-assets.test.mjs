import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCuratorPage } from '../agent/extensions/pi-web-access/curator-page.ts';
import { startCuratorServer } from '../agent/extensions/pi-web-access/curator-server.ts';

const options = (sessionToken) => ({
  queries: ['a query'], sessionToken, timeout: 60,
  availableProviders: { duckduckgo: true }, defaultProvider: 'duckduckgo', searchProvider: 'duckduckgo',
  summaryModels: [], defaultSummaryModel: null,
});
const callbacks = {
  onSubmit() {}, onCancel() {}, onProviderChange() {},
  onAddSearch: async () => [], onAddSearchResults() {},
  onSummarize: async () => ({ summary: '', meta: {} }), onRewriteQuery: async (q) => q,
};

test('the curator page never reaches an external host to render', () => {
  const html = generateCuratorPage(['q'], 'tok en', 60, { duckduckgo: true }, 'duckduckgo', 'duckduckgo', [], null);
  const hosts = [...html.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)/g)].map((m) => m[1]);
  assert.deepEqual(hosts, [], 'fonts and scripts load from the local server only');
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/);
  assert.match(html, /src="\/vendor\/marked\.js\?session=tok%20en"/);
  assert.doesNotMatch(html, /Instrument Serif|Outfit/, 'no webfont dependency');
  assert.doesNotMatch(html.match(/\.hero-title \{[^}]*\}/)[0], /italic|font-display/, 'the headline is not an italic display serif');
  assert.doesNotMatch(html, /class="hero-kicker"/);
});

test('the local server serves marked only for the session and the page keeps working without it', async (t) => {
  const handle = await startCuratorServer(options('s3cret'), callbacks);
  t.after(() => handle.close());
  const base = new URL(handle.url).origin;
  const denied = await fetch(`${base}/vendor/marked.js?session=wrong`);
  assert.equal(denied.status, 403);
  assert.equal((await fetch(`${base}/vendor/marked.js`)).status, 403);
  const ok = await fetch(`${base}/vendor/marked.js?session=s3cret`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /javascript/);
  const source = await ok.text();
  const sandbox = {};
  new Function('self', 'globalThis', `${source}\nreturn typeof self.marked`).call(sandbox, sandbox, sandbox);
  assert.ok(sandbox.marked && typeof sandbox.marked.parse === 'function', 'the bundle exposes marked.parse');
  assert.match(sandbox.marked.parse('**bold**'), /<strong>bold<\/strong>/);
});

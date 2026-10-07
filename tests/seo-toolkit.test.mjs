import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'extensions/pi-web-access/seo-toolkit.ts')));
const load = file => import(pathToFileURL(path.join(agent, 'extensions', file)));
const { seoTaskIntent, publicSeoPages, excludedSeoUrl } = await load('lib/seo-policy.ts');
const { selectTaskPipelines, createPipelineLedger, recordPipelineEvidence } = await load('lib/task-pipelines.ts');
const { intentBundleTools } = await load('lib/tool-discovery.ts');
const { matchHook } = await load('lib/session-hooks.ts');
const { inspectSeoDocument, validSeoDate } = await load('pi-web-access/seo-document.ts');
const { buildSeoDiscovery } = await load('pi-web-access/seo-discovery.ts');
const { auditSeoSite, parseSeoSitemap, parseSeoFeed } = await load('pi-web-access/seo-audit.ts');
const { registerSeoToolkit, seoPlan, compactSeoResult } = await load('pi-web-access/seo-toolkit.ts');
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

const page = (base, pathname, { title = 'Sensor calibration reference', extra = '', links = '', body = 'Sensor calibration uses two measured reference points. Use the measured offset and scale for the device. This page describes repeatable procedures and limitations with original readings and examples.' } = {}) => `<!doctype html><html lang="en"><head><title>${title}</title><meta name="viewport" content="width=device-width"><meta name="description" content="A reference to calibrating sensors with two measured values, worked examples and known limitations."><link rel="canonical" href="${base}${pathname}"><meta property="og:url" content="${base}${pathname}"><meta property="og:title" content="${title}"><meta property="og:description" content="Measured calibration procedures"><meta property="og:image" content="${base}/image.webp"><meta name="twitter:card" content="summary_large_image">${extra}</head><body><main><h1>${title}</h1><p>${body}</p><h2>Measured examples</h2>${links}</main></body></html>`;

test('public website work stages SEO without asking; private apps, questions, exclusions and unrelated edits remain quiet', () => {
  for (const prompt of ['Build a website for the workshop', 'Create a public documentation site', 'Update the product landing page', 'Add an evergreen blog guide']) {
    assert.ok(selectTaskPipelines({ prompt }).ids.includes('seo'), prompt);
    assert.ok(intentBundleTools(prompt).includes('seo_toolkit'), prompt);
  }
  for (const prompt of ['Build an internal dashboard', 'Improve SEO in the private employee portal', 'Build a local-only app on localhost', 'Create a website without SEO', 'What is SEO?', 'Fix the login form validation', 'Refactor the parser']) {
    assert.ok(!selectTaskPipelines({ prompt }).ids.includes('seo'), prompt);
    assert.ok(!intentBundleTools(prompt).includes('seo_toolkit'), prompt);
  }
  assert.ok(seoTaskIntent('Add a public landing page for the private admin app').relevant);
  assert.ok(selectTaskPipelines({ prompt: 'Improve the navigation', files: ['app/layout.tsx'] }).ids.includes('seo'));
  assert.ok(!selectTaskPipelines({ prompt: 'Improve the internal dashboard', files: ['app/layout.tsx'] }).ids.includes('seo'));
  assert.ok(!selectTaskPipelines({ prompt: 'Fix a one-line PHP comment typo', files: ['index.php'] }).ids.includes('seo'));
  assert.ok(!selectTaskPipelines({ prompt: 'Fix the login form validation', files: ['index.html'] }).ids.includes('seo'));
  assert.ok(selectTaskPipelines({ prompt: 'Improve the page metadata', files: ['templates/article.html'] }).ids.includes('seo'));
  assert.equal(matchHook('edit', { path: 'content/guide.md' }).key, 'seo-discovery-source');
  assert.equal(matchHook('seo_toolkit', { action: 'audit' }).key, 'seo-inspection-evidence');
  assert.equal(matchHook('seo_toolkit', { action: 'discovery' }).key, 'seo-discovery-parity');
});

test('SEO stage evidence retires after a source change and cannot certify editorial checks from raw HTML', () => {
  const selection = selectTaskPipelines({ prompt: 'Improve SEO canonical tags' });
  const ledger = createPipelineLedger();
  const record = (stageId, evidenceKind, revision = 'v1', status = 'passed') => recordPipelineEvidence(ledger, { scope: 'site', revision, stageId, evidenceKind, source: 'native:fixture', status }, selection);
  record('discovery', 'inspection'); record('implementation', 'artifact'); record('validation', 'execution'); record('seo-raw', 'inspection');
  assert.throws(() => record('delivery', 'artifact'), /unresolved/);
  record('seo-content', 'assessment'); record('delivery', 'artifact');
  assert.throws(() => record('delivery', 'artifact', 'v2'), /unresolved/);
  record('seo-raw', 'inspection', 'v1', 'failed');
  assert.throws(() => record('delivery', 'artifact'), /unresolved/);
});

test('one public inventory generates escaped XML, stable entity IDs, real feeds and no invented freshness/private URLs', () => {
  const pages = [
    { url: '/', title: 'Sensor lab', purpose: 'public home' },
    { url: '/guide', title: 'Calibration & readings', description: 'Use measured references <safely>', published: '2026-09-01', lastmod: '2026-10-01', locale: 'en' },
    { url: '/private', index: false }, { url: '/member-only', purpose: 'private' }, { url: '/search?q=a' },
    { url: '/alternate', canonical: '/guide' }, { url: 'https://staging.example.com/' }, { url: '/guide' },
  ];
  const generated = buildSeoDiscovery({ canonicalOrigin: 'https://example.com', pages, siteName: 'Lab [test]\n## injected', sitemapBatchSize: 1 });
  assert.equal(generated.accepted.length, 2); assert.equal(generated.excluded.length, 6);
  assert.equal(parseSeoSitemap(generated.files['sitemap.xml']).kind, 'sitemapindex');
  assert.equal(parseSeoSitemap(generated.files['sitemap-2.xml']).entries[0].lastmod, '2026-10-01');
  assert.ok(!generated.files['sitemap-1.xml'].includes('lastmod'));
  assert.match(generated.files['feed.xml'], /Calibration &amp; readings/);
  assert.match(generated.files['feed.xml'], /Tue, 01 Sep 2026/);
  assert.equal(parseSeoFeed(generated.files['feed.xml']).entries[0].url, 'https://example.com/guide');
  for (const content of Object.values(generated.files)) assert.ok(!/member-only|\/private|staging|search\?/.test(content));
  const graph = JSON.parse(generated.files['site-graph.json'])['@graph'];
  assert.equal(graph[2]['@id'], 'https://example.com/guide#webpage');
  assert.equal(graph[2].dateModified, '2026-10-01');
  assert.ok(!graph[1].dateModified);
  assert.throws(() => buildSeoDiscovery({ canonicalOrigin: 'https://example.com', pages: [{ url: '/', lastmod: '2026-02-30' }] }), /valid source date/);
  assert.throws(() => buildSeoDiscovery({ canonicalOrigin: 'https://example.com', pages: [{ url: '/', lastmod: '2099-01-01' }] }), /valid source date/);
  assert.ok(excludedSeoUrl('https://example.com/wp-login.php'));
  assert.ok(excludedSeoUrl('https://example.com/%61dmin'));
  assert.equal(publicSeoPages([{ url: '/guide?utm_source=x', canonical: '/guide' }], 'https://example.com').accepted.length, 0);
});

test('XML parsing rejects malformed roots, nesting, external entities and missing namespace', () => {
  for (const xml of ['<html><body>fallback</body></html>', '<urlset><url><loc>x</loc></url></urlset>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>x</url></urlset>', '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///secret">]><urlset/>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/&unknown;</loc></url></urlset>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" bad=unquoted/>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" a="1" a="2"/>']) assert.equal(parseSeoSitemap(xml).kind, 'invalid', xml);
  const good = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a&amp;b</loc></url></urlset>';
  assert.deepEqual(parseSeoSitemap(good).entries, [{ url: 'https://example.com/a&b' }]);
  assert.equal(parseSeoSitemap('<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://example.com/</sm:loc></sm:url></sm:urlset>').kind, 'urlset');
  assert.ok(validSeoDate('2024-02-29')); assert.ok(!validSeoDate('2026-02-29'));
  assert.ok(validSeoDate('2026-10-01T00:00:00+03:00'), 'valid offset dates can cross a UTC day boundary');
});

test('internal and authenticated page purposes exclude public-looking paths from discovery and public-page optimization', () => {
  const privatePages = ['internal', 'authenticated', 'intranet', 'staff-only', 'employee-only', 'members-only', 'local-only', 'non-public', 'noindex'].map((purpose, index) => ({ url: `/restricted-${index}`, purpose, title: `Restricted ${index}`, description: 'Restricted team reference', published: '2026-09-01' }));
  const generated = buildSeoDiscovery({ canonicalOrigin: 'https://example.com', pages: [{ url: '/', title: 'Public home' }, ...privatePages] });
  assert.deepEqual(generated.accepted, ['https://example.com/']);
  assert.equal(generated.excluded.length, privatePages.length);
  for (const content of Object.values(generated.files)) assert.ok(!content.includes('restricted-'));
  for (const policy of privatePages) {
    const url = `https://example.com${policy.url}`;
    const served = inspectSeoDocument('<html><body><h1>Team reference</h1></body></html>', url, { status: 200, policy });
    assert.ok(served.findings.some(row => row.code === 'excluded-indexable'), policy.purpose);
    assert.ok(!served.findings.some(row => row.code === 'canonical-missing' || row.code === 'social-metadata'), policy.purpose);
    const built = inspectSeoDocument('<html><body><h1>Team reference</h1></body></html>', url, { policy });
    assert.ok(built.findings.some(row => row.code === 'excluded-access-unknown'), policy.purpose);
  }
});

test('raw document audit detects conflicting identities, schema dates and semantics without claiming rendered/factual verification', () => {
  const html = page('https://example.com', '/guide', { extra: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","url":"https://example.com/other","datePublished":"2026-10-01","dateModified":"2026-09-01","author":{"@type":"Person","name":"A"}}</script>',
    links: '<img src="photo.webp" alt="" loading="lazy" fetchpriority="high"><form><input type="text"></form><table><tr><td>x</td></tr></table>' }).replace('content="https://example.com/guide"', 'content="https://example.com/other"');
  const result = inspectSeoDocument(html, 'https://example.com/guide');
  const codes = new Set(result.findings.map(f => f.code));
  for (const code of ['social-identity', 'schema-page-identity', 'date-order', 'schema-stable-id', 'form-label', 'table-semantics', 'critical-image-lazy']) assert.ok(codes.has(code), code);
  assert.ok(!result.findings.some(f => /no alt attribute/.test(f.message)), 'decorative empty alt is valid');
  assert.equal(result.coverage.renderedDom, false); assert.equal(result.coverage.schemaFacts, false); assert.equal(result.coverage.indexed, 'unverified');
  assert.equal(result.status, null); assert.equal(result.coverage.httpStatus, false); assert.equal(result.coverage.headers, false);
  assert.equal(result.headings[1].level, 2);
  const privatePage = inspectSeoDocument(page('https://example.com', '/member-only'), 'https://example.com/member-only', { status: 200, policy: { url: '/member-only', index: false } });
  assert.ok(privatePage.findings.some(f => f.code === 'excluded-indexable'));
});

test('real served audit finds sitemap/noindex/link/redirect/hreflang/orphan defects and never crawls private/query/trap URLs', async () => {
  const requested = []; let base;
  const server = http.createServer((req, res) => {
    requested.push(req.url); res.setHeader('content-type', 'text/html');
    if (req.url === '/robots.txt') { res.setHeader('content-type', 'text/plain'); res.end(`User-agent: *\nDisallow: /blocked\nSitemap: ${base}/sitemap.xml`); return; }
    if (req.url === '/sitemap.xml') { res.setHeader('content-type', 'application/xml'); res.end(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/guide', '/duplicate', '/orphan', '/blocked', '/noindex', '/private', '/member-only', '/team-docs', '/old'].map(url => `<url><loc>${base}${url}</loc><lastmod>2099-01-01</lastmod></url>`).join('')}</urlset>`); return; }
    if (req.url === '/llms.txt') { res.setHeader('content-type', 'text/plain'); res.end(`# Lab\n- [Bad](${base}/private)\n- [Alternate](${base}/duplicate)`); return; }
    if (req.url === '/feed.xml') { res.setHeader('content-type', 'application/rss+xml'); res.end(`<rss version="2.0"><channel><item><link>${base}/private</link><pubDate>2099-01-01</pubDate></item></channel></rss>`); return; }
    if (req.url === '/old') { res.writeHead(302, { location: '/move' }); res.end(); return; }
    if (req.url === '/move') { res.writeHead(301, { location: '/guide' }); res.end(); return; }
    if (req.url === '/broken') { res.writeHead(404); res.end(page(base, '/broken', { title: 'Not found' })); return; }
    if (req.url === '/') { res.end(page(base, '/', { title: 'Sensor lab homepage', extra: '<link rel="alternate" type="application/rss+xml" href="/feed.xml">', links: '<a href="/guide">Calibration guide</a><a href="/broken">Reference removed</a><a href="/private">Account</a><a href="/calendar?date=2026-01-01">Calendar</a><a href="/member-only">Members</a><a href="/team-docs">Team reference</a>' })); return; }
    if (req.url === '/guide') { res.end(page(base, '/guide', { extra: `<link rel="alternate" hreflang="de" href="${base}/duplicate">` })); return; }
    if (req.url === '/duplicate') { res.end(page(base, '/guide')); return; }
    if (req.url === '/noindex') { res.end(page(base, '/noindex', { extra: '<meta name="robots" content="noindex">' })); return; }
    res.end(page(base, req.url, { title: 'Orphan measurements reference' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await auditSeoSite({ url: base, maxPages: 20, pages: [{ url: '/member-only', purpose: 'private' }, { url: '/team-docs', purpose: 'internal' }, { url: '/orphan', intent: 'original measurements' }], allowLoopback: true });
    const codes = new Set(result.findings.map(f => f.code));
    for (const code of ['sitemap-url-policy', 'sitemap-lastmod', 'sitemap-indexability', 'robots-block', 'broken-internal-link', 'redirect-chain', 'temporary-redirect', 'hreflang-reciprocity', 'orphan-in-sample', 'machine-private-url', 'machine-canonical-parity', 'feed-entry-policy', 'feed-date', 'duplicate-title']) assert.ok(codes.has(code), `${code}: ${JSON.stringify(result.findings)}`);
    for (const url of ['/private', '/member-only', '/team-docs', '/blocked', '/calendar?date=2026-01-01']) assert.ok(!requested.includes(url), url);
    assert.equal(result.coverage.indexed, 'unverified'); assert.equal(result.coverage.boundedSample, true);
    assert.ok(result.coverage.requests <= 100); assert.ok(result.pages.length <= 20);
    const compact = compactSeoResult(result); assert.ok(compact.findings.length <= 12); assert.equal(compact.findingsTotal, result.findings.length);
    assert.ok(!JSON.stringify(compact).includes('answerPreview'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('robots uncertainty and redirect-origin boundaries do not become successful crawl evidence', async () => {
  const requests = [];
  const fetcher = async input => { const url = String(input); requests.push(url); const pathname = new URL(url).pathname;
    if (pathname === '/robots.txt') return new Response('limited', { status: 429 });
    if (pathname === '/') return new Response(page('https://example.com', '/', { extra: '<link rel="alternate" type="application/rss+xml" href="/feed.xml">', links: '<a href="/guide">Guide</a>' }), { headers: { 'content-type': 'text/html' } });
    return new Response('missing', { status: 404 }); };
  const limited = await auditSeoSite({ url: 'https://example.com/', lookup, fetcher });
  assert.equal(limited.coverage.robotsKnown, false); assert.ok(!requests.includes('https://example.com/guide'));
  assert.ok(!requests.includes('https://example.com/feed.xml'), 'unknown robots also stops discovered feed expansion');
  const absent = await auditSeoSite({ url: 'https://example.com/', lookup, fetcher: async input => new URL(String(input)).pathname === '/robots.txt' ? new Response('<html>not found</html>', { status: 404 }) : fetcher(input) });
  assert.equal(absent.coverage.robotsKnown, true, 'ordinary missing robots with HTML 404 permits crawling');
  const outside = await auditSeoSite({ url: 'https://example.com/', lookup, fetcher: async () => new Response('', { status: 301, headers: { location: 'https://outside.example/' } }) });
  assert.equal(outside.coverage.complete, false); assert.match(outside.failures[0].error, /leaves the selected site origin/);
  const privateRequests = [];
  const privateFetch = async input => { privateRequests.push(String(input)); return new Response('', { status: 301, headers: { location: '/member-only' } }); };
  await assert.rejects(auditSeoSite({ url: 'https://example.com/member-only', pages: [{ url: '/member-only', purpose: 'private' }], lookup, fetcher: privateFetch }), /inventory excludes/);
  assert.deepEqual(privateRequests, [], 'a private reviewed entry is rejected before transport');
  const privateRedirect = await auditSeoSite({ url: 'https://example.com/', pages: [{ url: '/member-only', purpose: 'private' }], lookup, fetcher: privateFetch });
  assert.match(privateRedirect.failures[0].error, /excluded private/);
  assert.deepEqual(privateRequests, ['https://example.com/'], 'an explicitly private destination is never fetched through a redirect');
  await assert.rejects(auditSeoSite({ url: 'https://example.com/private' }), /public HTTP/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(auditSeoSite({ url: 'https://example.com/', signal: controller.signal }), /abort/i);
});

test('registered tool checks built workspace HTML, rejects escaped paths, and private scope performs no audit/generation', async () => {
  let tool; registerSeoToolkit({ registerTool(value) { tool = value; } });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-seo-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-seo-outside-'));
  try {
    fs.writeFileSync(path.join(cwd, 'page.html'), page('https://example.com', '/guide'));
    fs.writeFileSync(path.join(outside, 'private.html'), 'private'); fs.symlinkSync(path.join(outside, 'private.html'), path.join(cwd, 'escape.html'));
    const sessionManager = { getSessionId: () => 'seo-session' };
    const run = params => tool.execute('fixture', params, undefined, undefined, { cwd, sessionManager });
    const inspected = await run({ action: 'inspect', url: 'https://example.com/guide', path: 'page.html' });
    assert.ok(!inspected.isError); assert.equal(inspected.details.sha256.length, 64);
    assert.equal(inspected.details.status, null); assert.equal(inspected.details.coverage.httpStatus, false); assert.equal(inspected.details.coverage.headers, false);
    fs.writeFileSync(path.join(cwd, 'page.html'), '<html><body>new source</body></html>');
    const cached = await run({ action: 'report', resultId: inspected.details.resultId });
    assert.equal(cached.details.sha256, inspected.details.sha256, 'report preserves old evidence instead of claiming a new read');
    const fresh = await run({ action: 'inspect', url: 'https://example.com/guide', path: 'page.html' });
    assert.notEqual(fresh.details.sha256, inspected.details.sha256);
    assert.equal((await tool.execute('other', { action: 'report', resultId: inspected.details.resultId }, undefined, undefined, { cwd: outside, sessionManager })).isError, true, 'the same session ID cannot expose another project snapshot');
    assert.equal((await tool.execute('other', { action: 'report', resultId: inspected.details.resultId }, undefined, undefined, { cwd, sessionManager: { getSessionId: () => 'other-session' } })).isError, true);
    assert.equal((await run({ action: 'inspect', url: 'https://example.com/', path: 'escape.html' })).isError, true);
    assert.equal((await run({ action: 'inspect', url: 'https://example.com/', html: '<html/>', path: 'page.html' })).isError, true);
    let injectedFetches = 0;
    const blocked = await run({ action: 'audit', url: 'http://127.0.0.1:8088/', allowLoopback: true, lookup, fetcher: async () => { injectedFetches++; return new Response('fixture override'); } });
    assert.equal(injectedFetches, 0, 'registered tools cannot activate transport fixture overrides through extra arguments');
    assert.equal(blocked.details.pages.length, 0);
    assert.ok(blocked.details.failures.some(row => /loopback|private|blocked/i.test(row.error)));
    const privateRun = await run({ action: 'audit', scope: 'private', url: 'http://127.0.0.1/private' });
    assert.equal(privateRun.details.scope, 'private'); assert.ok(!privateRun.details.pages);
    const privateGeneration = await run({ action: 'discovery', scope: 'private', canonicalOrigin: 'https://example.com', pages: [{ url: '/' }] });
    assert.ok(!privateGeneration.details.files);
    const plan = seoPlan({ task: 'Build a public website', canonicalOrigin: 'https://example.com', pages: [{ url: '/a', intent: 'calibration' }, { url: '/b', intent: 'calibration' }] });
    assert.equal(plan.overlappingIntents.length, 1); assert.equal(plan.checks.length, 14);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

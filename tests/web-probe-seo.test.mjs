import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { probePage, robotsVerdict } = await import(pathToFileURL(path.join(root, 'agent/extensions/pi-web-access/web-probe.ts')).href);
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

function site(pages) {
  const requested = [];
  const fetcher = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    const page = pages[new URL(url).pathname];
    if (!page) return new Response('not found', { status: 404 });
    return new Response(page.body, { status: page.status ?? 200, headers: { 'content-type': page.type ?? 'text/html; charset=utf-8', ...page.headers } });
  };
  return { fetcher, requested };
}

test('robots.txt: the named group beats *, the longest rule wins, Allow wins a tie, and * and $ are the only wildcards', () => {
  const robots = 'User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nUser-agent: Bingbot\nDisallow: /private\nAllow: /private/press\nDisallow: /*.pdf$\nDisallow: /a$b\nSitemap: https://example.com/sitemap.xml # main';
  assert.deepEqual(robotsVerdict(robots, '/blog'), { allowed: true, rule: null, sitemaps: ['https://example.com/sitemap.xml'] });
  assert.equal(robotsVerdict(robots, '/private/x').allowed, false);
  assert.equal(robotsVerdict(robots, '/private/press/1').rule, 'Allow: /private/press');
  assert.equal(robotsVerdict(robots, '/doc.pdf').allowed, false);
  assert.equal(robotsVerdict(robots, '/doc.pdf?x=1').allowed, true, '$ anchors the end');
  assert.equal(robotsVerdict(robots, '/a$b').allowed, false, 'a mid-pattern $ is literal');
  assert.equal(robotsVerdict(robots, '/blog', 'duckduckbot').allowed, false, 'an unnamed crawler falls back to *');
  assert.equal(robotsVerdict('User-agent: *\nDisallow: /x\nAllow: /x', '/x').allowed, true, 'Allow wins a tie');
});

test('web_probe seo reports on-page signals and the robots verdict without changing the default probe', async () => {
  const html = `<!doctype html><html><head><title>Hi</title><link rel="canonical" href="/other">
    <meta name="robots" content="noindex, follow"><link rel="alternate" hreflang="de" href="/de/">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["WebPage","FAQPage"]}]}</script>
    <script type="application/ld+json">{broken</script></head>
    <body><h1>One</h1><h3>Skipped</h3><h1>Two</h1><img src="a.png"><img src="b.png" alt=""></body></html>`;
  const { fetcher, requested } = site({ '/page': { body: html, headers: { 'x-robots-tag': 'noarchive' } }, '/robots.txt': { body: 'User-agent: *\nDisallow: /page\nSitemap: https://example.com/s.xml', type: 'text/plain' } });
  const plain = await probePage('https://example.com/page', undefined, fetcher, { lookup });
  assert.equal(plain.seo, undefined);
  assert.deepEqual(requested, ['https://example.com/page'], 'the default probe makes one request');
  const { seo } = await probePage('https://example.com/page', undefined, fetcher, { lookup, seo: true });
  assert.equal(seo.canonical, 'https://example.com/other');
  assert.equal(seo.robots, 'noindex, follow, noarchive');
  assert.deepEqual(seo.hreflang, [{ lang: 'de', url: 'https://example.com/de/' }]);
  assert.deepEqual(seo.jsonLd, [{ types: ['Organization', 'WebPage', 'FAQPage'] }, { invalid: true }]);
  assert.deepEqual(seo.h1, ['One', 'Two']);
  assert.equal(seo.missingAlt, 1, 'an empty alt is a deliberate decorative image');
  assert.deepEqual(seo.robotsTxt, { url: 'https://example.com/robots.txt', status: 200, allowed: false, rule: 'Disallow: /page', sitemaps: ['https://example.com/s.xml'] });
  for (const expected of [/title is 2 characters/, /missing meta description/, /canonical points to another URL/, /blocks indexing/, /2 h1 elements/, /skips from h1 to h3/, /missing <html lang>/, /viewport/, /JSON-LD block does not parse/, /1 of 2 images/, /og:image/])
    assert.ok(seo.findings.some(f => expected.test(f)), `finding ${expected}`);
});

test('web_probe seo: a missing robots.txt allows crawling and a server error blocks it', async () => {
  const good = '<html lang="en"><head><title>A page title of fair length</title><meta name="viewport" content="width=device-width"><meta name="description" content="A description that is long enough to be shown as the result snippet."><link rel="canonical" href="https://example.com/"><meta property="og:image" content="/og.png"></head><body><h1>Title</h1><h2>Part</h2></body></html>';
  const missing = await probePage('https://example.com/', undefined, site({ '/': { body: good } }).fetcher, { lookup, seo: true });
  assert.deepEqual(missing.seo.findings, []);
  assert.deepEqual(missing.seo.openGraph, { title: false, description: false, image: 'https://example.com/og.png', type: null, twitterCard: null });
  const long = await probePage('https://example.com/', undefined, site({ '/': { body: good.replace('A page title of fair length', 'T'.repeat(400)) } }).fetcher, { lookup, seo: true });
  assert.equal(long.seo.titleLength, 400, 'length is measured before the display cut');
  assert.equal(long.seo.title.length, 160);
  const bare = await probePage('https://example.com/', undefined, site({ '/': { body: '<html><head><title>t</title><link rel="canonical" href=" "></head><body></body></html>' } }).fetcher, { lookup, seo: true });
  assert.equal(bare.seo.canonical, null, 'an empty canonical href is not the page itself');
  assert.ok(bare.seo.findings.includes('no canonical link'));
  const heavy = `<html lang="en"><head><title>${'x'.repeat(30)}</title>${'<meta name="x" content="' + 'y'.repeat(1000) + '">'.repeat(100)}</head><body><h1>Late heading</h1></body></html>`;
  const deep = await probePage('https://example.com/', undefined, site({ '/': { body: heavy } }).fetcher, { lookup, seo: true });
  assert.deepEqual(deep.seo.h1, ['Late heading'], 'a heading past the 64 KiB probe sample is still read in seo mode');
  assert.equal(missing.seo.robotsTxt.allowed, true);
  const failing = await probePage('https://example.com/', undefined, site({ '/': { body: good }, '/robots.txt': { body: 'down', status: 503, type: 'text/plain' } }).fetcher, { lookup, seo: true });
  assert.equal(failing.seo.robotsTxt.allowed, false);
  assert.match(failing.seo.robotsTxt.note, /server error/);
});

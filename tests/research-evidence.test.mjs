import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { researchDossier, researchPassages, sourceDigest } from '../agent/extensions/lib/research-evidence.ts';
import registerResearch from '../agent/extensions/research-toolkit.ts';

const source = { id: 'official', title: 'Reference', url: 'https://example.org/guide', text: 'Measured throughput is 20 requests per second.\nThis applies to the test configuration.', kind: 'primary', retrievedAt: '2026-10-06T09:00:00Z' };
const claim = { id: 'throughput', text: 'Throughput was measured in a test configuration.', citations: [{ sourceId: 'official', quote: 'Measured throughput is 20 requests per second.', relation: 'supports' }] };
const dossier = extra => researchDossier({ goal: 'Throughput and test configuration', sources: [source], claims: [claim], ...extra });

test('dossier retains exact quote/hash/line attribution and never certifies an interpretation', () => {
  const result = dossier({ view: 'report' });
  assert.equal(result.counts.claimsWithGaps, 0);
  assert.equal(result.claims[0].status, 'interpretation_requires_review');
  assert.equal(result.claims[0].citations[0].line, 1);
  assert.equal(result.claims[0].citations[0].sha256, sourceDigest(source.text));
  assert.match(result.report, /SHA256/);
  assert.match(result.scope, /caller labels/);
  assert.equal(result.sources[0].text, undefined, 'whole documents are not echoed into context');
});

test('missing, stale and contradictory citations stay visible with independent-source counts', () => {
  const same = { ...source, id: 'copy', url: 'https://copy.example.net/post' };
  const refs = [claim.citations[0], { ...claim.citations[0], sourceId: 'copy' }, { ...claim.citations[0], relation: 'contradicts' },
    { ...claim.citations[0], sha256: '0'.repeat(64) }, { ...claim.citations[0], quote: 'Invented result.' }, { ...claim.citations[0], sourceId: 'missing' }];
  const result = dossier({ sources: [source, same], claims: [{ ...claim, citations: refs }] });
  assert.equal(result.counts.uniqueSources, 1);
  assert.equal(result.claims[0].independentSources, 1);
  assert.equal(result.counts.invalidCitations, 3);
  assert.deepEqual(result.claims[0].citations.slice(-3).map(ref => ref.status), ['source_changed', 'quote_missing', 'source_missing']);
  assert.ok(result.claims[0].gaps.includes('contradiction_requires_review'));
});

test('no citation, context only, and unknown authority never become supported claims', () => {
  for (const citations of [[], [{ ...claim.citations[0], relation: 'context' }]]) {
    const result = dossier({ claims: [{ ...claim, citations }] });
    assert.ok(result.claims[0].gaps.includes('no_matched_support'));
  }
  assert.ok(dossier({ sources: [{ ...source, kind: 'unknown' }] }).claims[0].gaps.includes('primary_source_missing'));
  assert.equal(dossier({ sources: [{ ...source, retrievedAt: undefined }] }).sources[0].retrievedAt, undefined);
});

test('URL/text bridges merge transitive duplicate snapshots without inflating support', () => {
  const alternate = { ...source, id: 'alternate', url: 'https://example.net/results', text: source.text + ' Additional context.' };
  const bridge = { ...alternate, id: 'bridge', url: source.url };
  const result = dossier({ sources: [source, alternate, bridge], claims: [{ ...claim, citations: [claim.citations[0], { ...claim.citations[0], sourceId: 'alternate' }] }] });
  assert.equal(result.counts.uniqueSources, 1);
  assert.equal(result.claims[0].independentSources, 1);
  assert.equal(result.sources[1].duplicateOf, 'official');
});

test('ranked passages find consequential tail content with exact offsets and bounded output', () => {
  const text = 'Unrelated introduction.\n'.repeat(200) + '\nembedding quantization accuracy drops for rare classes.\n' + 'Other text.\n'.repeat(100);
  const evidence = researchPassages(text, 'embedding quantization rare classes', 1400);
  assert.ok(evidence.passages.some(row => row.text.includes('accuracy drops')));
  assert.ok(evidence.passages.some(row => row.start > 2400));
  for (const row of evidence.passages) {
    assert.equal(row.text, text.slice(row.start, row.end));
    assert.equal(row.line, text.slice(0, row.start).split('\n').length);
  }
  assert.ok(evidence.sampledChars <= 1400);
  assert.equal(evidence.sha256, sourceDigest(text));
});

test('dossiers reject unsafe URLs, invalid identifiers/dates and oversized input', () => {
  const credentialUrl = new URL('https://example.org');
  credentialUrl.username = 'example-user'; credentialUrl.password = 'example-password';
  for (const url of ['file:///etc/passwd', credentialUrl.href, 'javascript:alert(1)', 'https://example.org/\nsecret']) assert.throws(() => dossier({ sources: [{ ...source, url }] }));
  for (const retrievedAt of ['yesterday', '2026-02-31']) assert.throws(() => dossier({ sources: [{ ...source, retrievedAt }] }));
  assert.throws(() => dossier({ sources: [source, source] }), /unique/);
  assert.throws(() => dossier({ sources: [{ ...source, text: 'x'.repeat(64001) }] }), /64000/);
  assert.throws(() => dossier({ claims: [{ ...claim, citations: [{ ...claim.citations[0], relation: 'verified' }] }] }), /relation/);
  assert.throws(() => researchDossier({}), /goal/);
  assert.throws(() => researchDossier({ goal: 'x', sources: [source], claims: [] }, AbortSignal.abort()));
});

test('research tool reads a local JSON snapshot, paginates and refuses workspace escape', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'research-dossier-')); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let tool; registerResearch({ registerTool(value) { tool = value; } });
  fs.writeFileSync(path.join(cwd, 'dossier.json'), JSON.stringify({ goal: 'Compare evidence', sources: [source], claims: [claim] }));
  const result = await tool.execute('dossier', { action: 'dossier', path: 'dossier.json' }, undefined, undefined, { cwd });
  assert.equal(result.details.counts.claimsWithGaps, 0);
  assert.equal(JSON.parse(result.content[0].text).nextOffset, null);
  for (const input of [{ path: '../escape.json' }, { path: 'dossier.json', sources: [source] }]) {
    assert.equal((await tool.execute('dossier', { action: 'dossier', ...input }, undefined, undefined, { cwd })).isError, true);
  }
  assert.equal((await tool.execute('dossier', { action: 'dossier', path: 'dossier.json' }, AbortSignal.abort(), undefined, { cwd })).isError, true);
});

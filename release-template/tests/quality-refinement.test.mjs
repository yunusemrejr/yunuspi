import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const tree=path.resolve(import.meta.dirname,'..');
const agent=[path.join(tree,'agent'),path.resolve(tree,'..'),path.resolve(tree,'../agent')].find(p=>fs.existsSync(path.join(p,'extensions/lib/quality-refinement.ts')));
const load=p=>import(pathToFileURL(path.join(agent,p)));
const {codeQuality,compactQualityReport}=await load('extensions/lib/code-quality.ts');
const {codeAudit}=await load('extensions/lib/code-audit.ts');
const {refineQuality}=await load('extensions/lib/quality-refinement.ts');
const {inspectUiSource,slopGuidanceSignals}=await load('extensions/lib/slop-guidance-signals.ts');
const jev=await load('extensions/lib/jev-client.ts');

const saved = { PI_JEV: process.env.PI_JEV, PI_OFFLINE: process.env.PI_OFFLINE, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-judge-'));
process.env.PI_JEV = 'on';
delete process.env.PI_OFFLINE;
process.env.OPENROUTER_API_KEY = 'synthetic-quality-fixture';
process.env.PI_CODING_AGENT_DIR = keyDir;
after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; fs.rmSync(keyDir, { recursive: true, force: true }); });
const item = (id, evidence = 'Our robust platform is seamless.') => ({ id, file: 'copy.md', line: 1, rule: 'stock-phrase', evidence });
const answer = { type: 'choice', choice: 'contextual', probabilities: { revise: 0.05, contextual: 0.9, uncertain: 0.05 } };
const answerFor = questions => ({ ok: true, answers: Object.fromEntries(Object.keys(questions).map(q => [q, answer])), usage: { model: 'synthetic', inputTokens: 20, costUsd: 0, ms: 0, cached: false } });

test('ambiguous cues batch once and identical evidence reuses the real JEV cache', async () => {
  const requests = [], ledger = [];
  jev.resetJevClient();
  jev.configureJevClient({ fetchImpl: async (url, options) => {
    if (String(url).includes('/api/v1/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    const body = JSON.parse(options.body); requests.push(body);
    return new Response(JSON.stringify({ answers: answerFor(body.questions).answers, usage: { input_tokens: 120 } }), { status: 200 });
  }, schedule: () => ({ unref() {} }) });
  const candidates = Array.from({ length: 14 }, (_, i) => item(`f${i}`, `${i}: Our robust platform is seamless.`));
  const pi = { appendEntry: (type, data) => ledger.push({ type, data }) };
  const first = await refineQuality(candidates, { pi, direction: 'Explain a technical migration to existing operators.' });
  const second = await refineQuality(candidates, { pi, direction: 'Explain a technical migration to existing operators.' });
  assert.equal(requests.length, 1);
  assert.equal(Object.keys(requests[0].questions).length, 8);
  assert.ok(JSON.stringify(requests[0]).length < 16000);
  assert.equal(first.remaining, 6);
  assert.equal(second.usage.cached, true);
  assert.equal(second.annotations.length, 8);
  assert.ok(ledger.some(row => row.type === 'jev-usage-v1'));
});

test('obvious, disabled, protected, malformed and offline triage keeps deterministic work local', async () => {
  let calls = 0;
  const judge = async (_site, _state, questions) => { calls++; return answerFor(questions); };
  assert.equal((await refineQuality([{ ...item('security'), rule: 'hardcoded-secret' }], { judge })).reason, 'no-ambiguous-findings');
  assert.equal((await refineQuality([item('p')], { judge, semantic: false })).reason, 'disabled');
  const privateItems = [
    { ...item('credential'), evidence: 'password = "SYNTHETIC_TEST_CANARY"' },
    { ...item('confidential'), evidence: '<protected>Private customer draft</protected>' },
    { ...item('file'), file: 'memory/notes.md' },
    { ...item('path'), file: 'protected/report.md' },
  ];
  assert.equal((await refineQuality(privateItems, { judge, protectedPaths: ['protected'] })).reason, 'protected-input');
  assert.equal((await refineQuality([item('p')], { judge, direction: 'Confidential: review the copy.' })).reason, 'protected-context');
  assert.equal(calls, 0);
  const malformed = await refineQuality([item('p')], { judge: async () => ({ ok: true, answers: { q0: { choice: 'contextual', probabilities: { contextual: 1 } } }, usage: {} }) });
  assert.deepEqual(malformed.annotations, []);
  assert.equal((await refineQuality([item('p')], { judge: async () => { throw Error('network down'); } })).reason, 'judge-error');
  assert.equal((await refineQuality([item('p')], { judge: async () => ({ ok: false, skipped: 'unavailable' }) })).reason, 'unavailable');
});

test('quality tool analyzes short reader copy and retains all local findings when the judge contextualizes them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-short-'));
  try {
    fs.writeFileSync(path.join(dir, 'copy.md'), 'Our robust, seamless, innovative platform unlocks your productivity.');
    let calls = 0;
    const judge = async (_site, _state, questions) => { calls++; return answerFor(questions); };
    const report = await codeQuality({ operation: 'prose' }, dir, undefined, undefined, { judge });
    assert.equal(report.scope.analyzed, 1);
    assert.ok(report.files[0].findings.length >= 4);
    assert.equal(calls, 1);
    assert.equal(report.semantic.annotations[0].context, 'contextual');
    assert.ok(JSON.stringify(compactQualityReport(report)).length < JSON.stringify(report).length);
    const offline = await codeQuality({ operation: 'prose' }, dir, undefined, undefined, { judge: async () => ({ ok: false, skipped: 'unavailable' }) });
    assert.deepEqual(offline.files[0].findings, report.files[0].findings);
    assert.equal(offline.counts.total, report.counts.total);
    fs.writeFileSync(path.join(dir, 'copy.md'), '<protected>Our robust platform is seamless.</protected>');
    calls = 0;
    const protectedReport = await codeQuality({ operation: 'prose' }, dir, undefined, undefined, { judge });
    assert.equal(calls, 0, 'private markers removed by the reader projection still protect the entire source');
    assert.equal(protectedReport.semantic.reason, 'protected-input');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stock style cues preserve supplied branding and distinguish white or ordinary serif from cream plus cursive', async () => {
  const gradient = '.hero { background:linear-gradient(90deg,#6366f1,#ec4899); }';
  const editorial = 'body {background:#fff8ec} h1 {font-family:"Great Vibes",cursive}';
  const has = (source, key, direction) => inspectUiSource('src/page.css', source, { direction }).findings.some(f => f.key === key);
  assert.equal(has(gradient, 'ui-stock-palette'), true);
  assert.equal(has(gradient, 'ui-stock-palette', 'Preserve the supplied purple gradient. No new cards.'), false);
  assert.equal(has(gradient, 'ui-stock-palette', 'Do not use a purple gradient.'), true);
  assert.equal(has(editorial, 'ui-stock-editorial'), true);
  assert.equal(has(editorial, 'ui-stock-editorial', 'Use an ivory ground and cursive type for the supplied wedding brand.'), false);
  assert.equal(has(editorial.replace('#fff8ec', '#ffffff'), 'ui-stock-editorial'), false);
  assert.equal(has(editorial.replace('"Great Vibes",cursive', 'Georgia,serif'), 'ui-stock-editorial'), false);
  assert.equal(has('/* Use purple gradients */' + gradient, 'ui-stock-palette'), true, 'source comments cannot grant an exemption');
  assert.ok(slopGuidanceSignals('index.html', '<p>Trusted by 10K+ customers</p>', 12).some(f => f.key === 'prose-metric-theater'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-ui-'));
  try {
    fs.writeFileSync(path.join(dir, 'style.css'), gradient);
    const audited = await codeAudit({ domains: ['ui'], semantic: false }, dir);
    assert.ok(audited.findings.some(f => f.rule === 'ui-stock-palette'));
    const requested = await codeAudit({ domains: ['ui'], direction: 'Use the supplied violet to pink gradient.' }, dir);
    assert.ok(!requested.findings.some(f => f.rule === 'ui-stock-palette'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreativeEvidence } from '../agent/extensions/lib/creative-evidence.ts';
import { normalizeVerdict, summarizePageState, summarizeNoise, planUiMatrix } from '../agent/extensions/lib/creative-qa.ts';

const capture = (overrides = {}) => ({ runId: 'run-1', source: 'index.html', revision: 'rev-1', consistent: true, file: 'capture.png', sections: [{ id: 'hierarchy', verdict: 'UNKNOWN', needsVision: true }], ...overrides });
const verdict = value => [{ id: 'hierarchy', verdict: value, evidence: ['Primary form owns the left column; secondary help is below it.'] }];
const matrix = (status = 'measured') => ({ consistent: true, status, cells: [320, 390, 834, 1440].map(width => ({ ok: true, width, dom: { available: true } })) });

test('real DOM schema preserves native controls, names, broken images and page overflow', () => {
  const facts = summarizePageState({ layout: { horizontalOverflowPx: 61 }, items: [
    { tag: 'button', name: '', bounds: { width: 18, height: 20 } },
    { tag: 'input', name: 'Customer', bounds: { width: 200, height: 44 } },
    { tag: 'img', alt: null, image: { loadState: 'unavailable' } },
    { tag: 'img', alt: '', image: { loadState: 'loaded' } },
  ] });
  assert.equal(facts.scopeOverflowPx, 61);
  assert.equal(facts.controls, 2); assert.equal(facts.unnamedControls, 1); assert.equal(facts.smallTargets, 1);
  assert.equal(facts.images, 2); assert.equal(facts.missingAlt, 1); assert.equal(facts.brokenImages, 1);
  assert.equal(facts.available, true); assert.equal(summarizePageState(undefined).available, false);
  assert.deepEqual(summarizeNoise({ findings: [{ kind: 'placeholder-copy', selector: 'main > p' }] }), [{ key: 'placeholder-copy', detail: 'main > p' }]);
});

test('capture budget cannot silently discard custom breakpoint widths', () => {
  const plan = planUiMatrix({ widths: [390, 375, 768, 1024], states: ['default', 'dark', 'reduced-motion', 'full'] });
  assert.equal(plan.capped, true);
  assert.deepEqual(plan.cells.filter(c => c.state === 'default').map(c => c.width), [320, 390, 834, 1440, 375, 768, 1024]);
  assert.equal(plan.cells.length, 12);
});

test('a fabricated, omitted, text-only, stale or changed-dependency verdict cannot approve UI', () => {
  const evidence = createCreativeEvidence(); evidence.observe('index.html', 'h1', 'ui');
  assert.throws(() => evidence.record({ source: 'index.html', revision: 'rev-1', verdict: verdict('PASS') }), /runId/);
  evidence.run(capture(), 'png-hash', false);
  assert.throws(() => evidence.record({ runId: 'run-1', source: 'index.html', revision: 'rev-1', verdict: [{ id: 'spacing', verdict: 'PASS', evidence: ['8px'] }] }), /every captured rubric/);
  assert.throws(() => evidence.record({ runId: 'run-1', source: 'index.html', revision: 'rev-1', verdict: verdict('PASS') }), /delivered pixels/);
  evidence.vision('other-image');
  assert.throws(() => evidence.record({ runId: 'run-1', source: 'index.html', revision: 'rev-1', verdict: verdict('PASS') }), /delivered pixels/);
  evidence.vision('png-hash');
  assert.equal(evidence.record({ runId: 'run-1', source: 'index.html', revision: 'rev-1', verdict: verdict('PASS') }).blocking, 0);
  evidence.observe('styles.css', 'new-css', 'ui');
  assert.throws(() => evidence.record({ runId: 'run-1', source: 'index.html', revision: 'rev-1', verdict: verdict('PASS') }), /dependencies changed/);
  assert.ok(evidence.gaps().some(line => line.includes('stale')));
});

test('UNKNOWN, measured failures, incomplete capture and uninspected responsive pixels remain open', () => {
  assert.equal(normalizeVerdict(verdict('UNKNOWN')).blocking, 1);
  const evidence = createCreativeEvidence(); evidence.observe('index.html', 'h1', 'ui');
  evidence.run(capture({ sections: [{ id: 'hierarchy', verdict: 'FAIL', needsVision: true }] }), 'png', true);
  assert.throws(() => evidence.record({ runId: 'run-1', source: 'index.html', revision: 'rev-1', verdict: verdict('PASS') }), /dismissal/);
  evidence.record({ runId: 'run-1', source: 'index.html', revision: 'rev-1', verdict: verdict('PASS'), dismissals: [{ id: 'hierarchy', reason: 'The sampled overlap belongs to the intentional scroll container shown in the crop.' }] });
  evidence.matrix('index.html', matrix(), evidence.stamp(), 'matrix-png');
  assert.ok(evidence.gaps().some(line => line.includes('responsive matrix pixels')));
  evidence.vision('matrix-png'); assert.deepEqual(evidence.gaps(), []);
  evidence.matrix('index.html', matrix('incomplete'), evidence.stamp(), 'matrix-png', true);
  assert.ok(evidence.gaps().some(line => line.includes('incomplete')));
  assert.throws(() => evidence.run(capture({ consistent: false }), 'png', true), /revision changed/);
});

test('served entrypoint requires keyboard and a successful state verification; plain snapshots do not pass', () => {
  const evidence = createCreativeEvidence(); evidence.observe('index.html', 'h1', 'ui');
  const url = 'http://localhost:8000/';
  evidence.run(capture({ source: url, surface: 'index.html', dom: { controls: 2 } }), 'png', true);
  evidence.matrix('index.html', matrix(), evidence.stamp(), 'matrix', true);
  evidence.record({ runId: 'run-1', source: url, revision: 'rev-1', verdict: verdict('PASS') });
  evidence.interaction(url, 'snapshot'); evidence.interaction(url, 'keyboard');
  assert.ok(evidence.gaps().some(line => line.includes('user task')));
  evidence.interaction(url, 'verify'); assert.deepEqual(evidence.gaps(), []);
  evidence.workspace('new-tree'); assert.ok(evidence.gaps().some(line => line.includes('final revision')));
});

test('separate entry pages and SVGs retain their own missing evidence', () => {
  const evidence = createCreativeEvidence(); evidence.observe('one.html', 'a', 'ui'); evidence.observe('two.html', 'b', 'ui'); evidence.observe('icon.svg', 'c', 'svg');
  evidence.matrix('one.html', matrix(), evidence.stamp(), 'matrix', true);
  evidence.run(capture({ source: 'one.html' }), 'png', true);
  evidence.record({ runId: 'run-1', source: 'one.html', revision: 'rev-1', verdict: verdict('PASS') });
  const gaps = evidence.gaps();
  assert.ok(!gaps.some(line => line.startsWith('one.html')));
  assert.ok(gaps.some(line => line.startsWith('two.html')));
  assert.ok(gaps.some(line => line.includes('SVG geometry')));
});

test('each verification obligation has its own identity and deleting a surface retires its checks', () => {
  const evidence = createCreativeEvidence(); evidence.observe('index.html', 'h1', 'ui');
  const obligations = evidence.verification();
  assert.deepEqual(obligations.map(row => row.id), ['responsive:index.html', 'visual:index.html']);
  assert.equal(new Set(obligations.map(row => row.id)).size, obligations.length);
  evidence.observe('index.html', 'unavailable', 'ui'); assert.ok(evidence.gaps().length > 0);
  evidence.observe('index.html', 'missing', 'ui'); assert.deepEqual(evidence.gaps(), []);
});

test('SVG captures cannot approve application UI and abandoned alternatives do not own its task', () => {
  const evidence = createCreativeEvidence(); evidence.observe('App.tsx', 'h1', 'ui');
  evidence.matrix('icon.svg', { ...matrix(), source: 'icon.svg' }, evidence.stamp(), 'svg-matrix', true);
  evidence.run(capture({ source: 'icon.svg', dom: { documentType: 'image/svg+xml' } }), 'svg', true);
  evidence.record({ runId: 'run-1', source: 'icon.svg', revision: 'rev-1', verdict: verdict('PASS') });
  assert.equal(evidence.gaps().length, 2);
  const source = 'http://localhost/app';
  evidence.matrix(source, { ...matrix(), source }, evidence.stamp(), 'ui-matrix', true);
  evidence.run(capture({ runId: 'chosen', source, dom: { controls: 2, documentType: 'text/html' } }), 'ui', true);
  evidence.record({ runId: 'chosen', source, revision: 'rev-1', verdict: verdict('PASS') });
  evidence.interaction(source, 'keyboard'); evidence.interaction(source, 'verify');
  evidence.run(capture({ runId: 'unused', source: 'http://localhost/alternative', dom: { controls: 2 } }), 'alternative', true);
  assert.deepEqual(evidence.gaps(), []);
});

test('desktop pixels cannot substitute for a current responsive visual judgment', () => {
  const evidence = createCreativeEvidence(); evidence.observe('index.html', 'h1', 'ui');
  const sections = [{ id: 'responsive', verdict: 'UNKNOWN', needsVision: true }];
  const record = { runId: 'run-1', source: 'index.html', revision: 'rev-1', verdict: [{ id: 'responsive', verdict: 'PASS', evidence: ['Narrow controls remain legible and the form reflows into one column.'] }] };
  evidence.run(capture({ sections }), 'desktop', true);
  assert.throws(() => evidence.record(record), /current inspected ui_explore/);
  evidence.matrix('index.html', matrix(), evidence.stamp(), 'matrix', true);
  assert.throws(() => evidence.record(record), /current inspected ui_explore/);
  evidence.run(capture({ sections, responsiveHash: 'matrix' }), 'desktop', true);
  assert.equal(evidence.record(record).blocking, 0);
  evidence.matrix('index.html', matrix(), evidence.stamp(), 'new-matrix', true);
  assert.throws(() => evidence.record(record), /current inspected ui_explore/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreativeEvidence } from '../agent/extensions/lib/creative-evidence.ts';
import { normalizeVerdict, summarizePageState, summarizeNoise, planUiMatrix } from '../agent/extensions/lib/creative-qa.ts';

const capture = (overrides = {}) => ({ runId: 'run-1', source: 'index.html', revision: 'rev-1', consistent: true, file: 'capture.png', sections: [{ id: 'hierarchy', verdict: 'UNKNOWN', needsVision: true }], ...overrides });
const verdict = value => [{ id: 'hierarchy', verdict: value, evidence: ['Primary form owns the left column; secondary help is below it.'] }];

test('run identity recovers only this session source and does not bypass stale or mismatched evidence', () => {
  const evidence = createCreativeEvidence();
  evidence.run(capture(), 'png', true);
  assert.equal(evidence.sourceForRun('run-1'), 'index.html');
  assert.equal(evidence.sourceForRun('unknown'), undefined);
  assert.equal(createCreativeEvidence().sourceForRun('run-1'), undefined);
  evidence.run(capture({ runId: 'alias', originalSource: './index.html?view=preview#contact' }), 'png', true);
  assert.equal(evidence.sourceForRun('alias'), './index.html?view=preview#contact', 'revision lookup retains the original local path/URL spelling');
  assert.equal(evidence.record({ runId: 'alias', source: 'index.html', revision: 'rev-1', verdict: verdict('PASS') }).blocking, 0, 'evidence still compares the canonical identity');
  assert.throws(() => evidence.record({ runId: 'run-1', source: 'other.html', revision: 'rev-1', verdict: verdict('PASS') }), /matching/);
  evidence.workspace('changed');
  assert.throws(() => evidence.record({ runId: 'run-1', source: evidence.sourceForRun('run-1'), revision: 'rev-1', verdict: verdict('PASS') }), /changed/);
});
test('once reviews have named the files their pages load, evidence goes stale with those files and not with the rest of the workspace', () => {
  const evidence = createCreativeEvidence();
  evidence.observe('index.html', 'h1', 'ui');
  const start = evidence.stamp();
  evidence.workspace('rev-1');
  assert.notEqual(evidence.stamp(), start, 'before any review has named its files, every change counts');
  const reviewed = evidence.stamp();
  evidence.loaded({ '/site/index.html': 'a', '/site/styles.css': 'b', '/site/absent.js': 'missing' });
  assert.equal(evidence.stamp(), reviewed, 'naming the files is not a change');
  evidence.workspace('rev-2');
  assert.equal(evidence.stamp(), reviewed, 'a change elsewhere in the workspace');
  evidence.reloaded('/site/styles.css', 'b');
  evidence.reloaded('/site/never-loaded.css', 'z');
  assert.equal(evidence.stamp(), reviewed, 'the same bytes, and a file no page loaded');
  evidence.reloaded('/site/styles.css', 'b2');
  assert.notEqual(evidence.stamp(), reviewed, 'a loaded file changed');
  let last = evidence.stamp();
  evidence.reloaded('/site/absent.js', 'c');
  assert.notEqual(evidence.stamp(), last, 'a file the page asked for and did not get now exists');
  last = evidence.stamp();
  evidence.loaded({ '/site/styles.css': 'b3' });
  assert.equal(evidence.stamp(), last, 'a later review keeps the identity the earlier one saw');
  evidence.reloaded('/site/styles.css', 'b3');
  assert.notEqual(evidence.stamp(), last, 'so a file that changed between two reviews makes the earlier one stale');
  last = evidence.stamp();
  evidence.loaded(undefined);
  assert.equal(evidence.stamp(), last);
  evidence.workspace('rev-3');
  assert.notEqual(evidence.stamp(), last, 'after a review that could not name its files, every change counts again');
  last = evidence.stamp();
  evidence.reloaded('/site/index.html', 'a2');
  assert.notEqual(evidence.stamp(), last, 'and the files already named still count');
});
test('more loaded files than can be watched count as a review that could not name them', () => {
  const evidence = createCreativeEvidence();
  evidence.loaded({ '/site/index.html': 'a' });
  evidence.workspace('rev-1');
  const reviewed = evidence.stamp();
  const parts = Object.fromEntries(Array.from({ length: 511 }, (_, index) => [`/site/part-${index}.js`, 'x']));
  evidence.loaded(parts);
  evidence.loaded(parts);
  evidence.workspace('rev-2');
  assert.equal(evidence.stamp(), reviewed, 'files named again are not counted twice');
  evidence.loaded({ '/site/one-more.js': 'x' });
  assert.equal(evidence.loadedFiles().length, 512);
  evidence.workspace('rev-3');
  assert.notEqual(evidence.stamp(), reviewed);
});
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
  evidence.matrix('index.html', { ...matrix('incomplete'), plan: { capped: true } }, evidence.stamp(), 'matrix-png', true);
  assert.ok(evidence.gaps().some(line => line.includes('incomplete')), 'a capped matrix stays open: fewer states complete it');
  evidence.matrix('index.html', matrix('incomplete'), evidence.stamp(), 'limited-png');
  assert.ok(evidence.gaps().some(line => line.includes('responsive matrix pixels')), 'an inspection-limited matrix still needs its pixels seen');
  evidence.vision('limited-png');
  assert.deepEqual(evidence.gaps(), [], 'DOM inspection bounds the agent cannot repair hold nothing open once the pixels are seen');
  assert.throws(() => evidence.run(capture({ consistent: false }), 'png', true), /revision changed/);
});

test('served entrypoint requires keyboard and a successful state verification; plain snapshots do not pass', () => {
  const evidence = createCreativeEvidence(); evidence.observe('index.html', 'h1', 'ui');
  const url = 'http://localhost:8000/';
  evidence.run(capture({ source: url, surface: 'index.html', dom: { controls: 2 } }), 'png', true);
  evidence.matrix('index.html', matrix(), evidence.stamp(), 'matrix', true);
  evidence.record({ runId: 'run-1', source: url, revision: 'rev-1', verdict: verdict('PASS') });
  evidence.interaction(url, 'snapshot');
  assert.ok(evidence.gaps().some(line => line.includes('key press and a matching verify')), 'a snapshot is neither of the two');
  evidence.interaction(url, 'keyboard');
  assert.ok(evidence.gaps().some(line => line.includes('still needs a matching verify')), 'only the action still missing is named');
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
  assert.throws(() => evidence.record(record), /contact sheet of the page as it is now/);
  evidence.matrix('index.html', matrix(), evidence.stamp(), 'matrix');
  assert.throws(() => evidence.record(record), /contact sheet looked at/, 'a sheet nobody looked at judges nothing');
  evidence.matrix('index.html', matrix(), evidence.stamp(), 'matrix', true);
  assert.equal(evidence.record(record).blocking, 0, 'a sheet taken and inspected after the capture is the same evidence as one taken before');
  evidence.run(capture({ sections, responsiveHash: 'matrix' }), 'desktop', true);
  assert.equal(evidence.record(record).blocking, 0);
  // A sheet taken after the capture was not in its rubric: a failure it measured still binds the verdict.
  evidence.matrix('index.html', matrix('fail'), evidence.stamp(), 'failing', true);
  assert.throws(() => evidence.record(record), /Measured responsive failure needs repair/);
  assert.equal(evidence.record({ ...record, dismissals: [{ id: 'responsive', reason: 'The measured overflow is the price table, which scrolls sideways by design.' }] }).blocking, 0);
  // A sheet of an earlier state of the page is no evidence for this one.
  evidence.workspace('edited');
  evidence.run(capture({ sections }), 'desktop', true);
  assert.throws(() => evidence.record(record), /contact sheet of the page as it is now/);
});

test('interaction identity retains query and fragment state without exposing URL parameters', () => {
  const evidence = createCreativeEvidence(); evidence.observe('index.html', 'h1', 'ui');
  const source = 'http://localhost/app?screen=customer#contact';
  evidence.matrix('index.html', matrix(), evidence.stamp(), 'matrix', true);
  evidence.run(capture({ source, surface: 'index.html', dom: { controls: 2 } }), 'png', true);
  evidence.record({ runId: 'run-1', source, revision: 'rev-1', verdict: verdict('PASS') });
  evidence.interaction('http://localhost/app?screen=other', 'keyboard'); evidence.interaction('http://localhost/app?screen=other', 'verify');
  assert.ok(evidence.gaps().some(line => line.includes('key press and a matching verify')), 'another screen proves nothing about this one');
  evidence.interaction(source, 'keyboard'); evidence.interaction(source, 'verify');
  assert.deepEqual(evidence.gaps(), []);
});

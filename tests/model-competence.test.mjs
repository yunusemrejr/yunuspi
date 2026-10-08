import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyToolOutcome, createStepTracker, createCompetenceEstimator, wilsonBounds, mergeCompetence,
  priorFromAggregate, fleetRateFromAggregate, COMPETENCE_PARAMS,
} from '../agent/extensions/lib/model-competence.ts';
import { competenceStoreFile, readCompetenceStore, writeCompetenceDeltas, FLEET_KEY } from '../agent/extensions/lib/competence-store.ts';

const clean = (family = 'read') => ({ cls: 'clean', weight: 1, family });
const slip = (family = 'edit', weight = 1) => ({ cls: 'slip', weight, family });
const DAY = 86_400_000;

test('tool outcomes separate model mistakes from environment, expected exits and polling', () => {
  const cases = [
    [{ toolName: 'edit', isError: true, text: 'Could not find edits[0] in src/a.ts The oldText must match exactly' }, 'slip', 1],
    [{ toolName: 'todo', isError: true, text: 'Validation failed for tool "todo": - action: must have required properties action' }, 'slip', 1],
    [{ toolName: 'read', isError: true, text: "ENOENT: no such file or directory, open '/x'" }, 'slip', 0.7],
    [{ toolName: 'edit', isError: true, text: 'No verified read-tool coverage for `a.ts`. Read the target range first.' }, 'slip', 0.6],
    [{ toolName: 'bash', isError: true, text: 'bash: frobnicate: command not found' }, 'slip', 0.8],
    [{ toolName: 'bash', isError: true, text: 'Blocked: Cannot operate on protected path "/etc"' }, 'slip', 0.5],
    [{ toolName: 'bash', isError: true, text: 'npm ERR! Test failed. 3 failing', check: true }, 'check', 0.35],
    [{ toolName: 'bash', isError: true, text: '(no output) Command exited with code 1' }, 'neutral', 0],
    [{ toolName: 'web_search', isError: true, text: 'fetch failed: ECONNRESET' }, 'neutral', 0],
    [{ toolName: 'subagent', isError: true, text: 'Provider stream idle timeout' }, 'neutral', 0],
    [{ toolName: 'bg_status', isError: false }, 'neutral', 0],
    [{ toolName: 'quality_review', isError: true, text: 'Current independent review is still pending; run or complete the current review before recording blocked.' }, 'gate', 0.5],
    [{ toolName: 'read', isError: false, repeated: true }, 'stall', 0.8],
    [{ toolName: 'edit', isError: false, reversed: true }, 'reversal', 0.8],
    [{ toolName: 'read', isError: false }, 'clean', 1],
  ];
  for (const [input, cls, weight] of cases) {
    const outcome = classifyToolOutcome(input);
    assert.equal(outcome.cls, cls, JSON.stringify(input));
    assert.equal(outcome.weight, weight, JSON.stringify(input));
  }
  assert.equal(classifyToolOutcome({ toolName: 'bash', isError: false, check: true }).family, 'check', 'a passing check closes open slips of every family');
});

test('step tracker flags only unchanged repeats and edits that undo earlier edits', () => {
  const tracker = createStepTracker();
  const read = { toolName: 'read', args: { path: 'a.ts' }, text: 'same text', isError: false, mutated: false };
  assert.deepEqual(tracker.track(read), { repeated: false, reversed: false });
  assert.equal(tracker.track(read).repeated, true, 'identical call and result with no change is a stall');
  assert.equal(tracker.track({ ...read, text: 'different text' }).repeated, false, 'a new result is progress');
  tracker.track(read);
  tracker.track({ toolName: 'edit', args: { path: 'a.ts', edits: [{ oldText: 'const value = 1;', newText: 'const value = 2;' }] }, text: 'ok', isError: false, mutated: true });
  assert.equal(tracker.track(read).repeated, false, 'a workspace change resets what counts as a repeat');
  const undo = tracker.track({ toolName: 'edit', args: { path: 'a.ts', edits: [{ oldText: 'const value = 2;', newText: 'const value = 1;' }] }, text: 'ok', isError: false, mutated: true });
  assert.equal(undo.reversed, true);
  assert.equal(tracker.track({ toolName: 'edit', args: { path: 'b.ts', edits: [{ oldText: 'const value = 1;', newText: 'const other = 5;' }] }, text: 'ok', isError: false, mutated: true }).reversed, false, 'reversal is per file');
  const repeatedFailure = { toolName: 'bash', args: { command: 'x' }, text: 'boom', isError: true, mutated: false };
  tracker.track(repeatedFailure);
  assert.equal(tracker.track(repeatedFailure).repeated, false, 'repeated failures are already counted as slips');
});

test('step tracker sees changed result tails and refuses partial argument fingerprints', () => {
  const tracker = createStepTracker();
  const input = { toolName: 'read', args: { path: 'a.ts' }, text: 'x'.repeat(5000) + 'old', isError: false, mutated: false };
  tracker.track(input);
  assert.equal(tracker.track({ ...input, text: 'x'.repeat(5000) + 'new' }).repeated, false);
  const large = { ...input, args: { path: 'a.ts', padding: 'x'.repeat(9000), target: 'first' } };
  tracker.track(large);
  assert.equal(tracker.track({ ...large, args: { ...large.args, target: 'second' } }).repeated, false);
});

test('step tracker bounds argument traversal and tolerates cycles', () => {
  let reads = 0;
  const args = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, 'v']));
  const observed = new Proxy(args, { get: (target, key) => { reads++; return target[key]; } });
  const input = { toolName: 'read', args: observed, text: 'same', isError: false, mutated: false };
  const tracker = createStepTracker();
  assert.equal(tracker.track(input).repeated, false);
  assert.ok(reads < 1000, `fingerprint work must stop at its budget, read ${reads} values`);
  const cyclic = {}; cyclic.self = cyclic;
  assert.doesNotThrow(() => tracker.track({ ...input, args: cyclic }));
});

test('competence store handles inherited-looking route names without corrupting evidence', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-route-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = competenceStoreFile(dir);
  const store = writeCompetenceDeltas(file, { constructor: { slip: 1, mass: 10 } }, 100);
  assert.equal(store.constructor.mass, 10);
  assert.equal(store.constructor.slip, 1);
  assert.equal(readCompetenceStore(file).constructor.mass, 10);
});

test('invalid step tracker capacity cannot spin its eviction loop', () => {
  const input = { toolName: 'read', args: { path: 'a' }, text: 'same', isError: false, mutated: false };
  for (const capacity of [-1, Number.NaN, Infinity, 0]) {
    const tracker = createStepTracker(capacity);
    assert.equal(tracker.track(input).repeated, false);
    assert.equal(tracker.track(input).repeated, true);
  }
});

test('Wilson bounds narrow with evidence and stay inside the unit interval', () => {
  const narrow = wilsonBounds(0.04, 200, 1.28), wide = wilsonBounds(0.04, 20, 1.28);
  assert.ok(narrow.hi - narrow.lo < wide.hi - wide.lo);
  for (const [p, n] of [[0, 50], [1, 50], [0.5, 1], [0.04, 0]]) {
    const { lo, hi } = wilsonBounds(p, n, 1.64);
    assert.ok(lo >= 0 && hi <= 1 && lo <= hi, `${p}/${n}`);
  }
  assert.ok(wilsonBounds(0, 200, 1.04).hi < COMPETENCE_PARAMS.enterEarned * COMPETENCE_PARAMS.neutralRate, 'a clean record of 200 observations can earn freedom');
});

test('freedom is never granted without evidence and a clean long record can earn it', () => {
  const unknown = createCompetenceEstimator();
  let snapshot;
  for (let i = 0; i < 40; i++) snapshot = unknown.observe(clean());
  assert.equal(snapshot.level, 'standard', 'forty clean steps with no history are not enough');
  assert.match(snapshot.reason, /trust needs/);
  const proven = createCompetenceEstimator({ rate: 0.01, strength: 60 });
  for (let i = 0; i < COMPETENCE_PARAMS.dwell - 1; i++) assert.equal(proven.observe(clean()).level, 'standard', 'a level cannot change before the dwell');
  assert.equal(proven.observe(clean()).level, 'earned');
  const rushed = createCompetenceEstimator({ rate: 0.01, strength: 60 });
  for (let i = 0; i < 20; i++) rushed.observe(clean());
  assert.equal(rushed.observe(slip('edit')).level, 'earned', 'one slip does not revoke earned autonomy');
  const open = createCompetenceEstimator({ rate: 0.01, strength: 60 });
  open.observe(slip('edit'));
  for (let i = 0; i < COMPETENCE_PARAMS.dwell - 2; i++) open.observe(clean('read'));
  assert.equal(open.snapshot().open, 1);
  assert.equal(open.snapshot().level, 'standard', 'freedom waits for the slip to be repaired');
  open.observe(clean('edit'));
  assert.equal(open.snapshot().open, 0, 'a clean step of the same family repairs it');
  const abandoned = createCompetenceEstimator({ rate: 0.01, strength: 60 });
  abandoned.observe(slip('todo'));
  for (let i = 0; i < COMPETENCE_PARAMS.openTtl + 2; i++) abandoned.observe(clean('read'));
  assert.equal(abandoned.snapshot().open, 0, 'a slip in a family that is never retried is abandoned, not held against the session forever');
  for (let i = 0; i < 40; i++) abandoned.observe(clean('read'));
  assert.equal(abandoned.snapshot().level, 'earned', 'its weight fades and the record earns freedom');
});

test('a credibly high slip rate tightens oversight and recovery relaxes it again without flapping', () => {
  const estimator = createCompetenceEstimator(undefined, { fleetRate: 0.034 });
  const levels = [];
  const feed = outcome => levels.push(estimator.observe(outcome).level);
  for (let i = 0; i < 6; i++) { feed(clean()); feed(slip(`tool${i % 3}`, 1)); feed(clean()); }
  assert.equal(levels.at(-1), 'guarded');
  assert.match(estimator.snapshot().reason, /fleet rate/);
  for (let i = 0; i < 400; i++) feed(clean());
  assert.notEqual(levels.at(-1), 'guarded', 'a long clean stretch ends the tightening');
  let transitions = 0;
  for (let i = 1; i < levels.length; i++) if (levels[i] !== levels[i - 1]) transitions++;
  assert.ok(transitions <= 3, `hysteresis and dwell prevent flapping (${transitions})`);
  const noisy = createCompetenceEstimator(undefined, { fleetRate: 0.034 });
  for (let i = 0; i < 5; i++) noisy.observe(clean());
  assert.equal(noisy.observe(slip()).level, 'standard', 'a slip before the evidence floor never tightens');
});

test('thresholds follow the installation: the same record is judged against its own fleet rate', () => {
  const careful = createCompetenceEstimator({ rate: 0.03, strength: 60 }, { fleetRate: 0.015 });
  const messy = createCompetenceEstimator({ rate: 0.03, strength: 60 }, { fleetRate: 0.06 });
  for (let i = 0; i < 60; i++) { careful.observe(i % 33 === 0 ? slip('read') : clean()); messy.observe(i % 33 === 0 ? slip('read') : clean()); }
  assert.notEqual(careful.snapshot().level, 'earned');
  assert.equal(messy.snapshot().level, 'earned', 'a 3% route is excellent on a fleet that slips 6%');
});

test('a burst starts on two strong slips among three steps, names the family and ends when it is repaired or expires', () => {
  const estimator = createCompetenceEstimator();
  estimator.observe(clean()); estimator.observe(slip('edit', 1));
  assert.equal(estimator.snapshot().burst, undefined, 'one slip is not a burst');
  assert.deepEqual(estimator.observe(slip('edit', 1)).burst, { family: 'edit', slips: 2 });
  assert.ok(estimator.observe(clean('read')).burst, 'an unrelated success does not end the burst');
  assert.equal(estimator.observe(clean('edit')).burst, undefined, 'a clean step of the failing family ends it');
  const weak = createCompetenceEstimator();
  weak.observe(slip('bash', 0.3)); weak.observe(slip('bash', 0.3));
  assert.equal(weak.snapshot().burst, undefined, 'weak evidence never starts a burst');
  const expiring = createCompetenceEstimator();
  expiring.observe(slip('todo')); expiring.observe(slip('todo'));
  for (let i = 0; i < COMPETENCE_PARAMS.burstHold; i++) expiring.observe(clean('read'));
  assert.ok(expiring.snapshot().burst);
  assert.equal(expiring.observe(clean('read')).burst, undefined);
});

test('persisted history ages by days, adds commutatively and bounds a new session prior', () => {
  const t0 = Date.UTC(2026, 9, 1);
  const first = mergeCompetence(undefined, { slip: 3, mass: 100 }, t0);
  const later = mergeCompetence(first, { slip: 1, mass: 50 }, t0 + 14 * DAY);
  assert.ok(Math.abs(later.mass - 100) < 1e-9, 'one half-life halves the old mass');
  assert.ok(Math.abs(later.slip - 2.5) < 1e-9);
  const a = mergeCompetence(mergeCompetence(undefined, { slip: 2, mass: 40 }, t0), { slip: 1, mass: 10 }, t0);
  const b = mergeCompetence(mergeCompetence(undefined, { slip: 1, mass: 10 }, t0), { slip: 2, mass: 40 }, t0);
  assert.deepEqual(a, b, 'increments from concurrent sessions commute');
  const prior = priorFromAggregate({ slip: 40, mass: 1000, updatedAt: t0 }, t0);
  assert.equal(prior.strength, COMPETENCE_PARAMS.maxPriorStrength);
  assert.ok(Math.abs(prior.rate - 0.04) < 1e-9);
  assert.equal(priorFromAggregate({ slip: 1, mass: 40, updatedAt: t0 }, t0 + 200 * DAY), undefined, 'old history fades out');
  assert.equal(fleetRateFromAggregate({ slip: 10, mass: 100, updatedAt: t0 }, t0), COMPETENCE_PARAMS.neutralRate, 'too little fleet history keeps the neutral rate');
  assert.ok(Math.abs(fleetRateFromAggregate({ slip: 20, mass: 400, updatedAt: t0 }, t0) - 0.05) < 1e-9);
  assert.equal(mergeCompetence(undefined, { slip: Number.NaN, mass: -4 }, t0).mass, 0, 'non-finite evidence is ignored');
});

test('the store survives corruption, concurrent increments, hostile keys and size bounds', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-competence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = competenceStoreFile(dir);
  assert.deepEqual(readCompetenceStore(file), {}, 'a missing store is empty');
  const now = Date.UTC(2026, 9, 3);
  writeCompetenceDeltas(file, { 'deepseek/flash': { slip: 2, mass: 50 } }, now);
  writeCompetenceDeltas(file, { 'deepseek/flash': { slip: 1, mass: 30 }, 'other/model': { slip: 0, mass: 20 } }, now);
  const store = readCompetenceStore(file);
  assert.equal(store['deepseek/flash'].mass, 80);
  assert.equal(store['deepseek/flash'].slip, 3);
  assert.equal(store[FLEET_KEY].mass, 100, 'the fleet row aggregates every route');
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  writeCompetenceDeltas(file, { '../escape': { slip: 1, mass: 5 }, [FLEET_KEY]: { slip: 9, mass: 9 }, 'x y': { slip: 1, mass: 1 } }, now);
  assert.deepEqual(Object.keys(readCompetenceStore(file)).sort(), [FLEET_KEY, 'deepseek/flash', 'other/model'].sort(), 'invalid and reserved keys are refused');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(readCompetenceStore(file), {}, 'a corrupt store is treated as empty');
  fs.writeFileSync(file, JSON.stringify({ version: 1, routes: { 'a/b': { slip: 9, mass: 3, updatedAt: 1 }, 'c/d': { slip: -1, mass: 3, updatedAt: 1 } } }));
  assert.deepEqual(readCompetenceStore(file), {}, 'impossible rows (slips above observations, negative values) are dropped');
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`route/${index}`, { slip: 1, mass: 10 }]));
  const bounded = writeCompetenceDeltas(file, many, now);
  assert.ok(Object.keys(bounded).length <= 65, 'the store keeps a bounded number of routes plus the fleet row');
});

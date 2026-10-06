import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { auditSplits, evaluateModel, rlTargets, notebookAudit, mlPreflight } from '../agent/extensions/lib/ml-lab.ts';
import registerMl from '../agent/extensions/ml-lab.ts';

const samples = [
  { id: 'a', features: [1, 2], label: 0, split: 'train', group: 'a', time: '2026-01-01T00:00:00Z' },
  { id: 'b', features: [2, 3], label: 1, split: 'train', group: 'b', time: '2026-01-02T00:00:00Z' },
  { id: 'v', features: [3, 4], label: 0, split: 'validation', group: 'v', time: '2026-01-03T00:00:00Z' },
  { id: 't', features: [4, 5], label: 1, split: 'test', group: 't', time: '2026-01-04T00:00:00Z' },
];
test('split audit checks dimensions, exact content, id, group and temporal leakage', () => {
  const clean = auditSplits({ samples, grouped: true, temporal: true, task: 'classification' });
  assert.equal(clean.ok, true); assert.equal(clean.dimensions, 2);
  const dirty = auditSplits({ samples: [...samples, { ...samples[0], split: 'test' }], temporal: true });
  for (const kind of ['duplicate_id', 'group_leakage', 'content_leakage', 'temporal_leakage']) assert.ok(dirty.findings.some(row => row.kind === kind), kind);
  assert.throws(() => auditSplits({ samples: [{ ...samples[0], features: [NaN] }] }), /finite/);
  assert.throws(() => auditSplits({ samples: [{ ...samples[0], features: [1] }, samples[1]] }), /dimensions/);
  assert.equal(auditSplits({ samples: samples.slice(0, 2) }).ok, false);
});
test('text normalization finds duplicate examples and findings remain bounded', () => {
  const rows = [{ id: 'a', text: '  HELLO\nworld ', split: 'train' }, { id: 'b', text: 'hello world', split: 'test' }];
  assert.equal(auditSplits({ samples: rows }).ok, false);
  const many = Array.from({ length: 1000 }, (_, i) => ({ id: 'same', text: 'same text', split: i % 2 ? 'train' : 'test' }));
  const result = auditSplits({ samples: many });
  assert.equal(result.findings.length, 60); assert.ok(result.omittedFindings > 100);
});
test('classification metrics, minority errors and paired baseline intervals are hand-checkable', () => {
  const result = evaluateModel({ task: 'classification', targets: [0, 0, 1, 1], predictions: [0, 0, 1, 0], baseline: [0, 0, 0, 0], groups: ['a', 'a', 'b', 'b'] });
  assert.equal(result.measured.accuracy, .75);
  assert.ok(Math.abs(result.measured.macroF1 - (0.8 + 2 / 3) / 2) < 1e-12);
  assert.equal(result.comparison.improvement, .25);
  assert.equal(result.slices[1].accuracy, .5);
  assert.deepEqual(result.comparison.interval95, evaluateModel({ task: 'classification', targets: [0, 0, 1, 1], predictions: [0, 0, 1, 0], baseline: [0, 0, 0, 0] }).comparison.interval95);
});
test('regression handles constant targets, empty/misaligned/nonfinite inputs and absent baselines honestly', () => {
  const r = evaluateModel({ task: 'regression', targets: [2, 2], predictions: [1, 3], baseline: [0, 0] });
  assert.equal(r.measured.mae, 1); assert.equal(r.measured.rmse, 1); assert.equal(r.measured.r2, null);
  assert.equal(r.comparison.improvement, 1);
  assert.equal(evaluateModel({ task: 'regression', targets: [1], predictions: [1] }).comparison.status, 'baseline_missing');
  for (const args of [{ targets: [] }, { predictions: [1, 2] }, { baseline: [NaN] }, { groups: [] }]) assert.throws(() => evaluateModel({ task: 'regression', targets: [1], predictions: [1], ...args }));
});
test('RL targets distinguish termination, truncation and final observations', () => {
  const result = rlTargets({ gamma: .9, transitions: [
    { reward: 1, nextValue: 10, terminated: false, truncated: true },
    { reward: 1, nextValue: 10, terminated: true, truncated: false },
    { reward: 1, nextValue: 10, terminated: true, truncated: true },
  ] });
  assert.deepEqual(result.targets, [10, 1, 1]);
  assert.throws(() => rlTargets({ gamma: 2, transitions: [] }));
  assert.throws(() => rlTargets({ gamma: .9, transitions: [{ reward: 1, nextValue: 1, terminated: 0, truncated: false }] }), /booleans/);
});
test('Colab notebook is statically complete without inventing execution or GPU access', () => {
  const notebook = JSON.parse(fs.readFileSync(new URL('../agent/skills/google-colab-training/assets/ml-lab-training.ipynb', import.meta.url)));
  const result = notebookAudit(notebook);
  assert.equal(result.ok, true); assert.equal(result.executedCells, 0); assert.equal(result.runtime, 'unverified');
  notebook.cells.find(cell => cell.metadata.tags?.includes('smoke')).outputs = [{ output_type: 'error', ename: 'OOM' }];
  assert.ok(notebookAudit(notebook).findings.some(row => row.kind === 'stored_error'));
  notebook.cells = notebook.cells.filter(cell => !cell.metadata.tags?.includes('evaluate'));
  assert.ok(notebookAudit(notebook).findings.some(row => row.stage === 'evaluate'));
});
test('ML lab reads bounded workspace data and returns executable plans without running or writing', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-lab-')); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let tool; registerMl({ registerTool(value) { tool = value; } });
  fs.writeFileSync(path.join(cwd, 'data.json'), JSON.stringify({ samples }));
  assert.equal((await tool.execute('m', { operation: 'split_audit', path: 'data.json' }, undefined, undefined, { cwd })).details.ok, true);
  for (const recipe of ['tiny_mlp', 'tabular_q', 'embedding', 'lora']) {
    const receipt = await tool.execute('m', { operation: 'recipe', recipe });
    assert.equal(receipt.details.status, 'prepared'); assert.equal(receipt.details.runtime, 'unverified');
    assert.ok(fs.existsSync(receipt.details.trainer)); assert.match(receipt.details.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal((await tool.execute('m', { operation: 'split_audit', path: '../data.json' }, undefined, undefined, { cwd })).isError, true);
  assert.equal((await tool.execute('m', { operation: 'split_audit', data: { samples } }, AbortSignal.abort())).isError, true);
  assert.equal(mlPreflight({ parameters: 100, weightBytes: 4 }).estimate.adamFp32StateLowerBoundBytes, 1600);
});

test('large ML results page without repeating full target arrays or per-class slice matrices', async () => {
  let tool; registerMl({ registerTool(value) { tool = value; } });
  const transitions = Array.from({ length: 1000 }, (_, i) => ({ reward: i, nextValue: 1, terminated: false, truncated: false }));
  const receipt = await tool.execute('rl', { operation: 'rl_targets', data: { gamma: .9, transitions }, offset: 64 });
  const shown = JSON.parse(receipt.content[0].text);
  assert.equal(receipt.details.targets.length, 1000);
  assert.equal(shown.targets.length, 64); assert.equal(shown.targets[0], 64.9); assert.equal(shown.nextOffset, 128);
  const targets = Array.from({ length: 4096 }, (_, i) => i % 128);
  const result = await tool.execute('eval', { operation: 'evaluate', data: { task: 'classification', targets,
    predictions: targets.map(x => (x + 1) % 128), baseline: targets.map(() => 0), groups: targets.map((_, i) => 'group-' + Math.floor(i / 128)) } });
  assert.notEqual(result.isError, true);
  const view = JSON.parse(result.content[0].text);
  assert.equal(view.measured.perClass.length, 32); assert.equal(view.nextOffset, 32);
  assert.equal(view.slices.length, 32); assert.equal(view.slices[0].perClass, undefined);
  assert.ok(result.content[0].text.length < 24000);
});

const trainer = path.resolve(import.meta.dirname, '../agent/scripts/ml-lab.py');
const run = (file, output, args = []) => JSON.parse(execFileSync('python3', ['-I', trainer, '--spec', file, '--output', output, ...args], { encoding: 'utf8', timeout: 30000 }));
test('real local MLP trains, beats its held-out baseline and resumes identically with saved scaling/RNG', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-training-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: String(i), split: i < 80 ? 'train' : i < 100 ? 'validation' : 'test', features: [(i % 2 ? 1 : -1) * (1 + i / 120)], label: i % 2 }));
  const file = path.join(dir, 'spec.json'); fs.writeFileSync(file, JSON.stringify({ recipe: 'tiny_mlp', samples: rows, steps: 180, hidden: 4 }));
  const direct = run(file, path.join(dir, 'direct'));
  assert.equal(direct.status, 'executed'); assert.equal(direct.checkpointReload, true);
  assert.ok(direct.evaluation.test.accuracy > direct.evaluation.test.baselineAccuracy);
  run(file, path.join(dir, 'smoke'), ['--steps', '2']);
  const resumed = run(file, path.join(dir, 'resumed'), ['--resume', path.join(dir, 'smoke/checkpoint.json')]);
  assert.equal(resumed.resumedFromStep, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'direct/model.json'))), JSON.parse(fs.readFileSync(path.join(dir, 'resumed/model.json'))));
  assert.throws(() => run(file, path.join(dir, 'direct')), /Command failed/, 'existing output cannot be overwritten');
  const spec = JSON.parse(fs.readFileSync(file)); spec.samples[0].features[0] -= .1; fs.writeFileSync(file, JSON.stringify(spec));
  assert.throws(() => run(file, path.join(dir, 'invalid'), ['--resume', path.join(dir, 'smoke/checkpoint.json')]), /hash mismatch/);
});
test('real tabular Q keeps time-limit bootstrap and saves an honest offline evaluation', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-training-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = ['train', 'validation', 'test'].map((split, i) => ({ id: String(i), split, state: 0, action: 0, reward: 1, nextState: 0, terminated: false, truncated: true }));
  const file = path.join(dir, 'spec.json'); fs.writeFileSync(file, JSON.stringify({ recipe: 'tabular_q', samples: rows, states: 1, actions: 1, gamma: .5, learningRate: .5, steps: 100 }));
  const result = run(file, path.join(dir, 'run'));
  const model = JSON.parse(fs.readFileSync(path.join(dir, 'run/model.json')));
  assert.ok(Math.abs(model.model[0][0] - 2) < 1e-10, 'terminal masking would incorrectly converge to 1');
  assert.match(result.evaluation.test.scope, /not policy success/);
});
test('transformer recipes validate real datasets before any package import, download or training', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transformer-data-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const datasets = {};
  for (const split of ['train', 'validation', 'test']) {
    datasets[split] = `${split}.jsonl`;
    fs.writeFileSync(path.join(dir, datasets[split]), [0, 1].map(i => JSON.stringify({ id: `${split}${i}`, textA: `${split} A ${i}`, textB: `${split} B ${i}`, score: i })).join('\n'));
  }
  const file = path.join(dir, 'spec.json'); fs.writeFileSync(file, JSON.stringify({ recipe: 'embedding', model: 'test/model', revision: 'a'.repeat(40), datasets }));
  const script = path.resolve(import.meta.dirname, '../agent/scripts/ml-transformer-train.py');
  const receipt = JSON.parse(execFileSync('python3', ['-I', script, '--spec', file, '--check'], { encoding: 'utf8' }));
  assert.equal(receipt.status, 'validated'); assert.equal(receipt.counts.test, 2);
  assert.equal(fs.existsSync(path.join(dir, 'runs')), false);
  fs.writeFileSync(path.join(dir, 'test.jsonl'), fs.readFileSync(path.join(dir, 'train.jsonl')));
  assert.throws(() => execFileSync('python3', ['-I', script, '--spec', file, '--check'], { encoding: 'utf8' }), /unique/);
});

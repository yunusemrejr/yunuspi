/** Deterministic ML contracts and evaluation. No project execution, downloads,
 * inference, training mutations, or claims about a connected cloud runtime. */
import { createHash } from 'node:crypto';
import os from 'node:os';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const finite = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error(`${label} must be finite`);
  return value;
};
const numbers = (value: unknown, label: string, max = 10000): number[] => {
  if (!Array.isArray(value) || !value.length || value.length > max) throw Error(`${label} requires 1–${max} numbers`);
  return value.map(item => finite(item, label));
};
const splitNames = ['train', 'validation', 'test'];
const boundedId = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) throw Error(`${label} requires 1–160 characters`);
  return value;
};
const normalizeText = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export function auditSplits(input: any, signal?: AbortSignal) {
  if (!Array.isArray(input.samples) || !input.samples.length || input.samples.length > 10000) throw Error('Supply 1–10000 samples with id, split and text or numeric features');
  const counts: Record<string, number> = { train: 0, validation: 0, test: 0 };
  const indexes = new Map<string, { id: string; split: string }>();
  const findings: any[] = [];
  let totalFindings = 0, dimensions: number | undefined, groupRows = 0, timeRows = 0;
  const times: Record<string, number[]> = { train: [], validation: [], test: [] };
  const labels = new Map<string, Set<number>>();
  const add = (kind: string, row: any, other?: any) => {
    totalFindings++;
    if (findings.length < 60) findings.push({ kind, id: row.id, split: row.split, ...(other ? { other } : {}) });
  };
  for (const row of input.samples) {
    signal?.throwIfAborted();
    const id = boundedId(row?.id, 'sample id'), split = row.split;
    if (!splitNames.includes(split)) throw Error('split must be train, validation or test');
    counts[split]++;
    const keys = ['id:' + id];
    if (row.text !== undefined) {
      if (typeof row.text !== 'string' || !row.text.trim() || row.text.length > 64000) throw Error('Sample text must be nonempty and at most 64000 characters');
      keys.push('content:' + hash(normalizeText(row.text)));
    } else {
      const features = numbers(row.features, 'features', 256);
      if (dimensions === undefined) dimensions = features.length;
      if (dimensions !== features.length) throw Error('Feature dimensions must match');
      keys.push('content:' + hash(JSON.stringify(features)));
    }
    if (row.group !== undefined) { keys.push('group:' + boundedId(row.group, 'group')); groupRows++; }
    if (row.label !== undefined) {
      const label = finite(row.label, 'label');
      const set = labels.get(split) ?? new Set<number>(); set.add(label); labels.set(split, set);
    }
    if (row.time !== undefined) {
      if (typeof row.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(row.time) || !Number.isFinite(Date.parse(row.time))) throw Error('time requires an ISO timestamp');
      times[split].push(Date.parse(row.time)); timeRows++;
    }
    for (const key of keys) {
      const other = indexes.get(key);
      if (other && (other.split !== split || key.startsWith('id:'))) add(key.startsWith('group:') ? 'group_leakage' : key.startsWith('content:') ? 'content_leakage' : 'duplicate_id', row, other);
      else if (!other) indexes.set(key, { id, split });
    }
  }
  if (!counts.train) add('train_split_missing', { id: '', split: 'train' });
  if (!counts.validation && !counts.test) add('heldout_split_missing', { id: '', split: 'test' });
  if (input.grouped === true && groupRows !== input.samples.length) add('group_ids_missing', { id: '', split: '' });
  if (input.temporal === true) {
    if (timeRows !== input.samples.length) add('timestamps_missing', { id: '', split: '' });
    const present = splitNames.filter(name => times[name].length);
    for (let i = 1; i < present.length; i++) {
      if (Math.max(...times[present[i - 1]]) > Math.min(...times[present[i]])) add('temporal_leakage', { id: '', split: present[i] });
    }
  }
  if (input.task === 'classification') for (const split of ['validation', 'test']) {
    for (const label of labels.get(split) ?? []) if (!labels.get('train')?.has(label)) add('unseen_eval_label', { id: String(label), split });
  }
  return { operation: 'split_audit', ok: totalFindings === 0, counts, dimensions, datasetSha256: hash(JSON.stringify(input.samples)),
    totalFindings, findings, omittedFindings: Math.max(0, totalFindings - findings.length),
    coverage: { exactContent: true, groupIds: groupRows, timestamps: timeRows, nearDuplicates: false },
    scope: 'Exact numeric or normalized-text duplicates, ids, supplied groups and optional chronological bounds only. Feature availability, label provenance, semantic near-duplicates and learned preprocessing leakage require inspection. Fit preprocessing on train only; tune on validation and reserve test.' };
}

function metrics(task: string, targets: number[], predictions: number[]) {
  if (task === 'regression') {
    const mean = targets.reduce((a, b) => a + b / targets.length, 0);
    const errors = predictions.map((value, i) => value - targets[i]);
    const mse = errors.reduce((sum, e) => sum + e * e / errors.length, 0);
    const variance = targets.reduce((sum, y) => sum + (y - mean) ** 2 / targets.length, 0);
    return { n: targets.length, mae: finite(errors.reduce((sum, e) => sum + Math.abs(e) / errors.length, 0), 'MAE'),
      rmse: finite(Math.sqrt(mse), 'RMSE'), r2: variance > 0 ? finite(1 - mse / variance, 'R2') : null };
  }
  if (![...targets, ...predictions].every(Number.isSafeInteger)) throw Error('Classification labels must be safe integers');
  const labels = [...new Set([...targets, ...predictions])].sort((a, b) => a - b);
  if (labels.length > 128) throw Error('Classification supports at most 128 labels');
  const perClass = labels.map(label => {
    let tp = 0, fp = 0, fn = 0, support = 0;
    targets.forEach((y, i) => { if (y === label) { support++; if (predictions[i] === label) tp++; else fn++; } else if (predictions[i] === label) fp++; });
    const precision = tp + fp ? tp / (tp + fp) : 0, recall = tp + fn ? tp / (tp + fn) : 0;
    return { label, support, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 };
  });
  return { n: targets.length, accuracy: predictions.filter((p, i) => p === targets[i]).length / targets.length,
    macroF1: perClass.reduce((sum, row) => sum + row.f1, 0) / perClass.length, perClass };
}

export function evaluateModel(input: any, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const targets = numbers(input.targets, 'targets'), predictions = numbers(input.predictions, 'predictions');
  if (targets.length !== predictions.length) throw Error('Targets and predictions must have equal length');
  if (!['classification', 'regression'].includes(input.task)) throw Error('task must be classification or regression');
  const measured = metrics(input.task, targets, predictions);
  let comparison: any = { status: 'baseline_missing' };
  if (input.baseline !== undefined) {
    const baseline = numbers(input.baseline, 'baseline');
    if (baseline.length !== targets.length) throw Error('Baseline must use the same cases in the same order');
    const baselineMetrics = metrics(input.task, targets, baseline);
    const delta = targets.map((y, i) => input.task === 'classification' ? Number(predictions[i] === y) - Number(baseline[i] === y) : Math.abs(baseline[i] - y) - Math.abs(predictions[i] - y));
    // Paired, seeded bootstrap; whole cases are resampled together. No extra
    // model, hidden tuning or unpaired aggregate comparison.
    let seed = 0x12345678;
    const draws: number[] = [], rounds = 300;
    for (let r = 0; r < rounds; r++) {
      signal?.throwIfAborted();
      let sum = 0;
      for (let i = 0; i < delta.length; i++) {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
        sum += delta[Math.floor(seed / 4294967296 * delta.length)] / delta.length;
      }
      draws.push(finite(sum, 'Bootstrap delta'));
    }
    draws.sort((a, b) => a - b);
    comparison = { status: 'paired', baseline: baselineMetrics, metric: input.task === 'classification' ? 'accuracy' : 'mae_reduction',
      improvement: finite(delta.reduce((sum, d) => sum + d / delta.length, 0), 'Improvement'),
      interval95: [draws[Math.floor(rounds * .025)], draws[Math.ceil(rounds * .975) - 1]], bootstrapRounds: rounds,
      assumptions: 'Cases assumed independent. Correlated entities/time series require group/block resampling; interval is approximate, not a deployment approval.' };
  }
  const slices: any[] = [];
  if (input.groups !== undefined) {
    if (!Array.isArray(input.groups) || input.groups.length !== targets.length) throw Error('groups must align with cases');
    const indexes = new Map<string, number[]>();
    input.groups.forEach((value: any, i: number) => { const id = boundedId(value, 'slice'); const rows = indexes.get(id) ?? []; rows.push(i); indexes.set(id, rows); });
    if (indexes.size > 32) throw Error('At most 32 evaluation slices');
    for (const [group, rows] of indexes) slices.push({ group, ...metrics(input.task, rows.map(i => targets[i]), rows.map(i => predictions[i])) });
  }
  return { operation: 'evaluate', task: input.task, measured, comparison, slices,
    casesSha256: hash(JSON.stringify({ targets, predictions, baseline: input.baseline, groups: input.groups })),
    scope: 'Metrics from supplied aligned arrays; no model was run. Freeze cases, record model/data versions and evaluation seeds, and inspect tail failures. A training-loss curve or exploratory reward is not held-out quality.' };
}

export function rlTargets(input: any) {
  const gamma = finite(input.gamma, 'gamma');
  if (gamma < 0 || gamma > 1 || !Array.isArray(input.transitions) || !input.transitions.length || input.transitions.length > 10000) throw Error('gamma must be 0–1 with 1–10000 transitions');
  const targets = input.transitions.map((row: any) => {
    const reward = finite(row.reward, 'reward'), nextValue = finite(row.nextValue, 'nextValue');
    if (typeof row.terminated !== 'boolean' || typeof row.truncated !== 'boolean') throw Error('terminated and truncated must be booleans');
    return finite(reward + (row.terminated ? 0 : gamma * nextValue), 'Value target');
  });
  return { operation: 'rl_targets', targets, scope: 'One-step Bellman targets: true termination masks bootstrap; external truncation does not. nextValue must refer to the final observation before auto-reset. Does not validate n-step returns, GAE, environment contracts or learned policy quality.' };
}

export function notebookAudit(notebook: any) {
  if (notebook?.nbformat !== 4 || !Array.isArray(notebook.cells) || notebook.cells.length > 200) throw Error('Require a v4 notebook with at most 200 cells');
  const stages = ['config', 'preflight', 'data', 'smoke', 'train', 'evaluate', 'export'];
  const findings: any[] = [], observed = new Map<string, number>();
  let codeCells = 0, executedCells = 0;
  notebook.cells.forEach((cell: any, index: number) => {
    if (!['code', 'markdown', 'raw'].includes(cell.cell_type)) throw Error('Invalid notebook cell type');
    if (!Array.isArray(cell.source) && typeof cell.source !== 'string') throw Error('Cell source must be text or text lines');
    if (Array.isArray(cell.source) && cell.source.some((line: any) => typeof line !== 'string')) throw Error('Cell source lines must be strings');
    const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
    if (source.length > 64000) throw Error('Notebook cell exceeds 64000 characters');
    if (cell.cell_type !== 'code') return;
    codeCells++;
    const tags = cell.metadata?.tags ?? [];
    if (!Array.isArray(tags) || tags.some((tag: any) => typeof tag !== 'string')) throw Error('Cell tags must be strings');
    for (const stage of stages) if (tags.includes(stage)) {
      if (!source.trim()) findings.push({ cell: index, kind: 'empty_stage', stage });
      if (observed.has(stage)) findings.push({ cell: index, kind: 'duplicate_stage', stage });
      else observed.set(stage, index);
    }
    if (Number.isInteger(cell.execution_count) && cell.execution_count > 0) executedCells++;
    if (cell.outputs !== undefined && !Array.isArray(cell.outputs)) throw Error('Notebook outputs must be an array');
    if (cell.outputs?.some((output: any) => output.output_type === 'error')) findings.push({ cell: index, kind: 'stored_error' });
    if (/\b(?:TODO|YOUR_[A-Z_]+|NotImplementedError)\b/.test(source)) findings.push({ cell: index, kind: 'placeholder' });
    if (/\bpip\s+install\b/.test(source) && !/==\d/.test(source)) findings.push({ cell: index, kind: 'unpinned_install' });
    if (/(?:hf_|sk-)[A-Za-z0-9_-]{20,}/.test(JSON.stringify(cell))) findings.push({ cell: index, kind: 'possible_secret' });
  });
  let previous = -1;
  for (const stage of stages) {
    const index = observed.get(stage);
    if (index === undefined) findings.push({ kind: 'missing_stage', stage });
    else { if (index < previous) findings.push({ kind: 'stage_order', stage }); previous = Math.max(previous, index); }
  }
  return { operation: 'notebook', ok: findings.length === 0, codeCells, executedCells, findings,
    runtime: 'unverified', scope: 'Static notebook structure and stored outputs only. Execution counts can be stale or supplied; they do not establish a connected Colab runtime, GPU availability, rerunnability or successful training. Validate syntax and observe runtime/checkpoint receipts separately.' };
}

export function mlPreflight(input: any) {
  const parameters = finite(input.parameters ?? 0, 'parameters');
  if (!Number.isSafeInteger(parameters) || parameters < 0 || parameters > 1e12) throw Error('parameters must be an integer between 0 and 1e12');
  const bytes = finite(input.weightBytes ?? 4, 'weightBytes');
  if (![1, 2, 4, 8].includes(bytes)) throw Error('weightBytes must be 1, 2, 4 or 8');
  return { operation: 'preflight', host: { platform: os.platform(), arch: os.arch(), cpuWorkers: os.availableParallelism(), totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem() },
    estimate: { weightsBytes: parameters * bytes, sgdTrainingLowerBoundBytes: parameters * bytes * 2, adamFp32StateLowerBoundBytes: parameters * (bytes * 2 + 8) },
    excluded: ['activations', 'optimizer master weights', 'KV cache', 'allocator/workspace', 'OS and other processes'],
    next: 'Use sys_probe/env_audit for the selected interpreter, actual GPU and installed packages. Choose a bounded smoke run, durable checkpoints and frozen evaluation before scaling; this estimate is not an OOM guarantee.' };
}

/** Bounded, local diagnostics for explicitly supplied data; never reads files or trains models. */
export type NumericCheckResult = { operation: string; limitations: string[]; [key: string]: unknown };
const MAX = 2048;
const arithmetic = 'IEEE-754 double precision; rounding and underflow remain possible. No statistical significance or population claims are inferred.';
function fail(message: string): never { throw new Error(`numeric_check: ${message}`); }
function numbers(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX) fail(`${name} must contain 1–${MAX} numbers`);
  for (let i = 0; i < value.length; i++) if (typeof value[i] !== 'number' || !Number.isFinite(value[i]) || Math.abs(value[i]) > 1e100) fail(`${name}[${i}] must be finite with absolute value <= 1e100`);
  return value;
}
function strings(value: unknown, name: string, empty = false): string[] {
  if (!Array.isArray(value) || value.length < (empty ? 0 : 1) || value.length > MAX) fail(`${name} must contain ${empty ? 0 : 1}–${MAX} strings`);
  for (let i = 0; i < value.length; i++) if (typeof value[i] !== 'string' || value[i].length === 0 || value[i].length > 128) fail(`${name}[${i}] must be a nonempty string of <=128 characters`);
  return value;
}
// Neumaier summation preserves small contributions even with mixed-sign cancellation.
function sum(values: number[]): number {
  let total = 0, correction = 0;
  for (const x of values) { const next = total + x; correction += Math.abs(total) >= Math.abs(x) ? (total - next) + x : (x - next) + total; total = next; }
  return total + correction;
}
function norm(values: number[]): number {
  const scale = Math.max(...values.map(Math.abs));
  return scale === 0 ? 0 : scale * Math.sqrt(sum(values.map(x => (x / scale) ** 2)));
}
function mean(values: number[]): number { return sum(values) / values.length; }
function equalLengths(a: unknown[], b: unknown[]): void { if (a.length !== b.length) fail('paired arrays must have equal lengths'); }
function divide(a: number, b: number): number | null { return b === 0 ? null : a / b; }
function output(operation: string, metrics: Record<string, unknown>, limitations: string[] = []): NumericCheckResult {
  return { operation, ...metrics, limitations: [arithmetic, ...limitations] };
}
export function numericCheck(input: unknown): NumericCheckResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('input must be an object');
  const v = input as Record<string, unknown>;
  switch (v.operation) {
    case 'summarize': {
      const values = numbers(v.values, 'values'), count = values.length, average = mean(values);
      const sorted = [...values].sort((a, b) => a - b);
      const quantile = (p: number) => { const at = p * (count - 1), low = Math.floor(at), f = at - low; return f === 0 ? sorted[low] : sorted[low] * (1 - f) + sorted[low + 1] * f; };
      return output(v.operation, { count, mean: average, sampleStd: count < 2 ? null : values.every(x => x === values[0]) ? 0 : norm(values.map(x => x - average)) / Math.sqrt(count - 1), min: sorted[0], q1: quantile(.25), median: quantile(.5), q3: quantile(.75), max: sorted[count - 1], quantileMethod: 'linear interpolation at p*(n-1)' }, ['Sample standard deviation uses n-1 and is undefined for one observation.']);
    }
    case 'compare': {
      const actual = numbers(v.actual, 'actual'), predicted = numbers(v.predicted, 'predicted'); equalLengths(actual, predicted);
      const average = mean(actual);
      const errors = actual.map((x, i) => x - predicted[i]), errorNorm = norm(errors), centeredNorm = actual.every(x => x === actual[0]) ? 0 : norm(actual.map(x => x - average));
      const ratio = centeredNorm === 0 ? null : errorNorm / centeredNorm;
      const rawR2 = ratio === null ? null : 1 - ratio ** 2;
      const r2 = rawR2 !== null && Number.isFinite(rawR2) ? rawR2 : null;
      return output(v.operation, { count: actual.length, mae: mean(errors.map(Math.abs)), rmse: errorNorm / Math.sqrt(actual.length), maxError: Math.max(...errors.map(Math.abs)), r2, r2UndefinedReason: centeredNorm === 0 ? 'constant_actual' : r2 === null ? 'outside_float_range' : null }, ['Metrics describe only the supplied paired observations; training-set results do not establish held-out model quality. R2 is undefined when actual values are constant.']);
    }
    case 'vectors': {
      const a = numbers(v.a, 'a'), b = numbers(v.b, 'b'); equalLengths(a, b);
      const aNorm = norm(a), bNorm = norm(b);
      const aScale = Math.max(...a.map(Math.abs)), bScale = Math.max(...b.map(Math.abs));
      const scaledA = aScale === 0 ? a : a.map(x => x / aScale), scaledB = bScale === 0 ? b : b.map(x => x / bScale);
      const cosine = aScale === 0 || bScale === 0 ? null : Math.max(-1, Math.min(1, sum(scaledA.map((x, i) => x * scaledB[i])) / (norm(scaledA) * norm(scaledB))));
      return output(v.operation, { count: a.length, dot: sum(a.map((x, i) => x * b[i])), cosine, distance: norm(a.map((x, i) => x - b[i])), aNorm, bNorm }, ['Cosine is undefined for a zero vector; distance is Euclidean. Dot products can underflow for extremely small inputs.']);
    }
    case 'classify': {
      const actual = strings(v.actual, 'actual'), predicted = strings(v.predicted, 'predicted'); equalLengths(actual, predicted);
      const labels = v.labels === undefined ? [...new Set([...actual, ...predicted])] : [...strings(v.labels, 'labels')];
      if (labels.length > 32 || new Set(labels).size !== labels.length) fail('labels must be unique and contain at most 32 classes');
      const positions = new Map(labels.map((label, i) => [label, i]));
      if ([...actual, ...predicted].some(label => !positions.has(label))) fail('labels must cover all actual and predicted classes');
      const confusion = labels.map(() => labels.map(() => 0));
      actual.forEach((label, i) => { confusion[positions.get(label)!][positions.get(predicted[i])!]++; });
      const perClass = labels.map((label, i) => { const tp = confusion[i][i], support = sum(confusion[i]), predictedCount = sum(confusion.map(row => row[i])); return { label, support, predictedCount, precision: divide(tp, predictedCount), recall: divide(tp, support), f1: divide(2 * tp, support + predictedCount) }; });
      const macro = (key: 'precision' | 'recall' | 'f1') => { const valid = perClass.map(row => row[key]).filter((x): x is number => x !== null); return { value: valid.length ? mean(valid) : null, definedClasses: valid.length }; };
      return output(v.operation, { count: actual.length, labels, confusion, confusionAxes: { rows: 'actual', columns: 'predicted' }, perClass, accuracy: sum(perClass.map((_, i) => confusion[i][i])) / actual.length, macro: { precision: macro('precision'), recall: macro('recall'), f1: macro('f1') } }, ['Zero-denominator metrics are null. Macro averages exclude undefined classes and report the number included. Results describe the supplied single-label observations only; training results do not establish held-out quality.']);
    }
    case 'split_overlap': {
      const train = strings(v.train, 'train', true), validation = v.validation === undefined ? [] : strings(v.validation, 'validation', true), test = strings(v.test, 'test', true);
      const sets = { train: new Set(train), validation: new Set(validation), test: new Set(test) };
      const intersection = (a: Set<string>, b: Set<string>) => { let count = 0; for (const id of a) if (b.has(id)) count++; return count; };
      const overlaps = { trainValidation: intersection(sets.train, sets.validation), trainTest: intersection(sets.train, sets.test), validationTest: intersection(sets.validation, sets.test) };
      return output(v.operation, { counts: { train: train.length, validation: validation.length, test: test.length }, uniqueCounts: { train: sets.train.size, validation: sets.validation.size, test: sets.test.size }, duplicateCounts: { train: train.length - sets.train.size, validation: validation.length - sets.validation.size, test: test.length - sets.test.size }, overlaps, hasExactOverlap: Object.values(overlaps).some(n => n > 0) }, ['Case-sensitive exact ID overlap only; no IDs are returned. No exact overlap does not rule out semantic duplicates, group leakage, temporal leakage or target leakage.']);
    }
    default: return fail('unknown operation; use summarize, compare, classify, vectors or split_overlap');
  }
}

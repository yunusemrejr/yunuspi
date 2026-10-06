#!/usr/bin/env python3
"""Bounded, dependency-free reference trainers; no network or pickle.

Spec: {recipe: tiny_mlp|tabular_q, seed: 7, steps: 200, learningRate: .05,
hidden: 8, batchSize: 16, gamma: .95, states: 16, actions: 4, samples: [...]}
MLP samples: {id, split: train|validation|test, features: [finite...], label: 0|1}.
Q samples: {id, split, state, action, reward, nextState, terminated, truncated}.
--steps is the absolute final step (smoke: 2); --resume checkpoint.json restores
weights and RNG exactly. MLP fits scaling on train only. Q reports held-out TD
residuals, which do not establish environment policy success. For larger jobs
use a vectorized trainer after checking parity against this bounded reference.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import platform
import random
import time


def finite(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'{label} must be finite')
    return value


def integer(value, label, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f'{label} must be an integer in {low}..{high}')
    return value


def read_json(file):
    source = Path(file).read_bytes()
    if len(source) > 1048576:
        raise ValueError('Input exceeds 1 MiB')
    return json.loads(source, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def save(file, value):
    tmp = file.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, allow_nan=False, separators=(',', ':')) + '\n')
    tmp.replace(file)


def tuples(value):
    return tuple(tuples(v) if isinstance(v, list) else v for v in value)


def validate(spec):
    kind = spec.get('recipe')
    if kind not in ('tiny_mlp', 'tabular_q'):
        raise ValueError('recipe must be tiny_mlp or tabular_q')
    rows = spec.get('samples')
    if not isinstance(rows, list) or not 3 <= len(rows) <= 5000:
        raise ValueError('Require 3..5000 samples with train, validation and test splits')
    splits = {name: [] for name in ('train', 'validation', 'test')}
    ids, content, groups = set(), {}, {}
    dimensions = None
    states = integer(spec.get('states', 16), 'states', 1, 2048)
    actions = integer(spec.get('actions', 4), 'actions', 1, 64)
    if states * actions > 65536:
        raise ValueError('Q-table budget exceeds 65536 values')
    for row in rows:
        id_ = row.get('id')
        if not isinstance(id_, str) or not id_.strip() or len(id_) > 160 or id_ in ids:
            raise ValueError('Require unique nonempty sample ids')
        ids.add(id_)
        split = row.get('split')
        if split not in splits:
            raise ValueError('split must be train, validation or test')
        if kind == 'tiny_mlp':
            features = row.get('features')
            if not isinstance(features, list) or not 1 <= len(features) <= 64:
                raise ValueError('MLP requires 1..64 numeric features')
            for v in features:
                finite(v, 'feature')
            if dimensions is None:
                dimensions = len(features)
            if len(features) != dimensions:
                raise ValueError('Feature dimensions must match')
            integer(row.get('label'), 'binary label', 0, 1)
            key = digest(features)
            if key in content and content[key] != split:
                raise ValueError('Feature content leakage across splits')
            content[key] = split
        else:
            integer(row.get('state'), 'state', 0, states - 1)
            integer(row.get('nextState'), 'nextState', 0, states - 1)
            integer(row.get('action'), 'action', 0, actions - 1)
            finite(row.get('reward'), 'reward')
            if type(row.get('terminated')) is not bool or type(row.get('truncated')) is not bool:
                raise ValueError('Require separate boolean terminated and truncated')
        if 'group' in row:
            group = row['group']
            if not isinstance(group, str) or not group:
                raise ValueError('group must be a nonempty string')
            if group in groups and groups[group] != split:
                raise ValueError('Entity/episode group leakage across splits')
            groups[group] = split
        splits[split].append(row)
    if not all(splits.values()):
        raise ValueError('Require nonempty train, validation and frozen test splits')
    if kind == 'tiny_mlp' and {row['label'] for row in splits['train']} != {0, 1}:
        raise ValueError('Binary MLP training requires both labels')
    return kind, splits, dimensions, states, actions


class TinyMlp:
    def __init__(self, rows, dimensions, hidden, rng):
        self.mean = [sum(row['features'][j] / len(rows) for row in rows) for j in range(dimensions)]
        self.scale = [max(1e-8, math.sqrt(sum((row['features'][j] - self.mean[j]) ** 2 / len(rows) for row in rows))) for j in range(dimensions)]
        self.w1 = [[rng.gauss(0, 1 / math.sqrt(dimensions)) for _ in range(dimensions)] for _ in range(hidden)]
        self.b1 = [0.] * hidden
        self.w2 = [rng.gauss(0, 1 / math.sqrt(hidden)) for _ in range(hidden)]
        self.b2 = 0.

    def forward(self, features):
        x = [(v - mean) / scale for v, mean, scale in zip(features, self.mean, self.scale)]
        h = [math.tanh(sum(w * v for w, v in zip(weights, x)) + b) for weights, b in zip(self.w1, self.b1)]
        z = max(-40, min(40, sum(w * v for w, v in zip(self.w2, h)) + self.b2))
        return x, h, 1 / (1 + math.exp(-z))

    def update(self, rows, rate):
        gw1 = [[0.] * len(self.mean) for _ in self.w1]
        gb1, gw2, gb2 = [0.] * len(self.w1), [0.] * len(self.w2), 0.
        for row in rows:
            x, h, p = self.forward(row['features'])
            dz = (p - row['label']) / len(rows)
            gb2 += dz
            for j in range(len(h)):
                gw2[j] += dz * h[j]
                dh = dz * self.w2[j] * (1 - h[j] ** 2)
                gb1[j] += dh
                for k in range(len(x)):
                    gw1[j][k] += dh * x[k]
        self.b2 -= rate * gb2
        for j in range(len(self.w1)):
            self.b1[j] -= rate * gb1[j]
            self.w2[j] -= rate * gw2[j]
            for k in range(len(self.mean)):
                self.w1[j][k] -= rate * gw1[j][k]
        # Serializing with allow_nan=False below also checks the checkpoint.
        finite(self.b2, 'MLP output bias')


def classification(rows, model, baseline):
    targets = [row['label'] for row in rows]
    predictions = [int(model.forward(row['features'])[2] >= .5) for row in rows]
    scores = []
    for label in (0, 1):
        tp = sum(y == p == label for y, p in zip(targets, predictions))
        fp = sum(y != label and p == label for y, p in zip(targets, predictions))
        fn = sum(y == label and p != label for y, p in zip(targets, predictions))
        scores.append(2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0)
    return {'task': 'classification', 'targets': targets, 'predictions': predictions, 'baseline': [baseline] * len(rows),
            'accuracy': sum(y == p for y, p in zip(targets, predictions)) / len(rows), 'macroF1': sum(scores) / 2,
            'baselineAccuracy': sum(y == baseline for y in targets) / len(rows)}


def q_target(row, table, gamma):
    return row['reward'] + (0 if row['terminated'] else gamma * max(table[row['nextState']]))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--spec', required=True)
    parser.add_argument('--output')
    parser.add_argument('--check', action='store_true', help='Validate data/config only; no training or writes')
    parser.add_argument('--steps', type=int)
    parser.add_argument('--resume')
    args = parser.parse_args()
    spec = read_json(args.spec)
    kind, splits, dimensions, states, actions = validate(spec)
    spec_hash = digest(spec)
    steps = integer(args.steps if args.steps is not None else spec.get('steps', 200), 'steps', 1, 2000)
    seed = integer(spec.get('seed', 7), 'seed', 0, 2**32 - 1)
    batch = integer(spec.get('batchSize', 16), 'batchSize', 1, 64)
    hidden = integer(spec.get('hidden', 8), 'hidden', 1, 32)
    rate = finite(spec.get('learningRate', .05), 'learningRate')
    gamma = finite(spec.get('gamma', .95), 'gamma')
    if not 0 < rate <= 1 or not 0 <= gamma <= 1:
        raise ValueError('learningRate must be (0,1], gamma in [0,1]')
    if kind == 'tiny_mlp' and steps * min(batch, len(splits['train'])) * dimensions * hidden > 50000000:
        raise ValueError('CPU reference work budget exceeded; reduce steps/batch/hidden or use a vectorized trainer')
    if args.check:
        print(json.dumps({'status': 'validated', 'recipe': kind, 'specSha256': spec_hash, 'counts': {k: len(v) for k, v in splits.items()}}))
        return
    if not args.output:
        raise ValueError('--output is required for training')
    rng = random.Random(seed)
    model = TinyMlp(splits['train'], dimensions, hidden, rng) if kind == 'tiny_mlp' else None
    table = [[0.] * actions for _ in range(states)] if kind == 'tabular_q' else None
    start = 0
    if args.resume:
        checkpoint = read_json(args.resume)
        if checkpoint.get('version') != 1 or checkpoint.get('specSha256') != spec_hash or checkpoint.get('recipe') != kind:
            raise ValueError('Checkpoint version, recipe or spec/data hash mismatch')
        start = integer(checkpoint['step'], 'checkpoint step', 0, 2000)
        rng.setstate(tuples(checkpoint['rng']))
        if model:
            # Only JSON numeric state produced by this exact spec is restored.
            state = checkpoint['model']
            expected = {'mean': dimensions, 'scale': dimensions, 'w1': hidden, 'b1': hidden, 'w2': hidden}
            if not isinstance(state, dict) or set(state) != set(expected) | {'b2'}:
                raise ValueError('Checkpoint state keys mismatch')
            for key, count in expected.items():
                if not isinstance(state.get(key), list) or len(state[key]) != count:
                    raise ValueError('Checkpoint shape mismatch')
            if any(not isinstance(row, list) or len(row) != dimensions for row in state['w1']):
                raise ValueError('Checkpoint weight shape mismatch')
            for values in [state['mean'], state['scale'], state['b1'], state['w2'], *state['w1'], [state['b2']]]:
                for value in values:
                    finite(value, 'Checkpoint value')
            if state['mean'] != model.mean or state['scale'] != model.scale:
                raise ValueError('Checkpoint preprocessing mismatch')
            model.__dict__.update(state)
        else:
            table = checkpoint['model']
            if len(table) != states or any(len(row) != actions for row in table):
                raise ValueError('Checkpoint Q shape mismatch')
            for row in table:
                for value in row:
                    finite(value, 'Checkpoint Q value')
        if start >= steps:
            raise ValueError('Resume requires a final step above checkpoint step')
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    began = time.monotonic()
    def checkpoint_at(step):
        state = model.__dict__ if model else table
        save(output / 'checkpoint.json', {'version': 1, 'recipe': kind, 'specSha256': spec_hash, 'step': step,
                                        'optimizer': {'name': 'sgd', 'learningRate': rate, 'momentum': 0}, 'rng': rng.getstate(), 'model': state})
    for step in range(start, steps):
        if model:
            model.update(rng.sample(splits['train'], min(batch, len(splits['train']))), rate)
        else:
            row = rng.choice(splits['train'])
            value = table[row['state']][row['action']]
            table[row['state']][row['action']] = finite(value + rate * (q_target(row, table, gamma) - value), 'Q update')
        if (step + 1) % 50 == 0 or step + 1 == steps:
            checkpoint_at(step + 1)
    # Reload JSON before evaluating/exporting; checkpoint corruption cannot
    # masquerade as successful in-memory training.
    reloaded = read_json(output / 'checkpoint.json')
    if reloaded['specSha256'] != spec_hash or reloaded['model'] != (model.__dict__ if model else table):
        raise ValueError('Saved checkpoint did not reload identically')
    baseline = int(sum(row['label'] for row in splits['train']) >= len(splits['train']) / 2) if model else None
    evaluations = {}
    for split in (('validation', 'test') if steps >= spec.get('steps', 200) else ('validation',)):
        rows = splits[split]
        if model:
            evaluations[split] = classification(rows, model, baseline)
        else:
            residuals = [q_target(row, table, gamma) - table[row['state']][row['action']] for row in rows]
            evaluations[split] = {'n': len(rows), 'meanAbsoluteTdResidual': finite(sum(abs(e) / len(rows) for e in residuals), 'TD residual'),
                                  'scope': 'Offline held-out transition residual, not policy success in an environment'}
    report = {'version': 1, 'recipe': kind, 'status': 'executed', 'specSha256': spec_hash, 'steps': steps,
              'resumedFromStep': start, 'counts': {k: len(v) for k, v in splits.items()}, 'evaluation': evaluations,
              'seconds': time.monotonic() - began, 'python': platform.python_version(), 'checkpointReload': True}
    save(output / 'metrics.json', report)
    save(output / 'model.json', {'version': 1, 'recipe': kind, 'specSha256': spec_hash, 'model': model.__dict__ if model else table,
                                 'greedyActions': [max(range(actions), key=row.__getitem__) for row in table] if table else None,
                                 'scope': 'JSON reference format; evaluate quantization and target runtime separately'})
    print(json.dumps({**report, 'output': str(output.resolve())}, allow_nan=False))


if __name__ == '__main__':
    main()

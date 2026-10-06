#!/usr/bin/env python3
"""Bounded embedding/LoRA Trainer entrypoint; installs nothing.

Prepare a venv with torch, transformers, datasets, accelerate and safetensors;
embedding also needs sentence-transformers, lora needs peft. Lock that environment.
Spec: {recipe: embedding|lora, model: public-model-id, revision: 40-char commit,
datasets: {train: train.jsonl, validation: validation.jsonl, test: test.jsonl},
seed: 7, steps: 100, batchSize: 2, maxLength: 128, learningRate: 0.0001,
targetModules: [q_proj,v_proj], rank: 8}. JSONL paths resolve beside the spec.
Every row needs id. Embedding: textA,textB,score in [0,1]. LoRA: text (whole-text
causal loss; instruction/completion-only masking requires a different recipe).
Optional group keeps entities out of multiple splits. --steps 2 is a smoke run;
--resume checkpoint.json verifies data/config/environment before resuming the
Trainer's complete optimizer/scheduler/RNG checkpoint. Model loading can download
weights; training and cloud costs need task authorization. No cloud connection
is inferred. Metrics are similarity correlation or causal loss, not task success.
"""
import argparse
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import platform
import re
import time


def sha(value):
    return hashlib.sha256(value).hexdigest()


def save(file, value):
    tmp = file.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, allow_nan=False, default=str) + '\n')
    tmp.replace(file)


def bounded_int(value, name, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f'{name} must be an integer in {low}..{high}')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--spec', required=True)
    parser.add_argument('--output')
    parser.add_argument('--check', action='store_true', help='Validate local data/config only; no imports/downloads/writes')
    parser.add_argument('--steps', type=int)
    parser.add_argument('--resume')
    args = parser.parse_args()
    spec_file = Path(args.spec).resolve()
    if spec_file.stat().st_size > 262144:
        raise ValueError('Spec exceeds 256 KiB')
    spec = json.loads(spec_file.read_text())
    kind = spec.get('recipe')
    if kind not in ('embedding', 'lora') or not isinstance(spec.get('model'), str) or not spec['model'].strip():
        raise ValueError('Require embedding/lora and a model id or local model directory')
    model_path = (spec_file.parent / spec['model']).resolve()
    local_model = model_path.is_dir()
    if not local_model and not re.fullmatch(r'[a-f0-9]{40}', spec.get('revision', '')):
        raise ValueError('Remote models require an immutable 40-character revision')
    model_id = str(model_path) if local_model else spec['model']
    model_hashes = {}
    if local_model:
        files = sorted(p for p in model_path.rglob('*') if p.is_file())
        if len(files) > 10000:
            raise ValueError('Local model file budget exceeded')
        for file in files:
            hasher = hashlib.sha256()
            with file.open('rb') as handle:
                for chunk in iter(lambda: handle.read(1048576), b''):
                    hasher.update(chunk)
            model_hashes[str(file.relative_to(model_path))] = hasher.hexdigest()
    steps = bounded_int(args.steps if args.steps is not None else spec.get('steps', 100), 'steps', 1, 100000)
    planned_steps = bounded_int(spec.get('steps', 100), 'spec steps', 1, 100000)
    if steps > planned_steps:
        raise ValueError('--steps cannot exceed the declared schedule/budget horizon in the spec')
    seed = bounded_int(spec.get('seed', 7), 'seed', 0, 2**32 - 1)
    batch = bounded_int(spec.get('batchSize', 2), 'batchSize', 1, 64)
    length = bounded_int(spec.get('maxLength', 128), 'maxLength', 8, 4096)
    rate = spec.get('learningRate', .0001)
    if type(rate) not in (float, int) or not math.isfinite(rate) or not 0 < rate <= 1:
        raise ValueError('learningRate must be finite and in (0,1]')
    modules, rank = None, None
    if kind == 'lora':
        modules = spec.get('targetModules')
        if not isinstance(modules, list) or not 1 <= len(modules) <= 32 or any(not isinstance(m, str) or not m or len(m) > 160 for m in modules):
            raise ValueError('Inspect architecture and supply 1..32 exact targetModules for LoRA')
        rank = bounded_int(spec.get('rank', 8), 'rank', 1, 128)
    rows, hashes, ids, contents, groups = {}, {}, set(), {}, {}
    for split in ('train', 'validation', 'test'):
        file = (spec_file.parent / spec['datasets'][split]).resolve()
        if file.stat().st_size > 16 * 1024 * 1024:
            raise ValueError('Each dataset must be <=16 MiB; use a streaming pipeline for larger data')
        raw = file.read_bytes()
        hashes[split] = sha(raw)
        rows[split] = [json.loads(line) for line in raw.decode('utf8').splitlines() if line.strip()]
        if not 2 <= len(rows[split]) <= 20000:
            raise ValueError('Each split requires 2..20000 rows')
        for row in rows[split]:
            id_ = row.get('id')
            if not isinstance(id_, str) or not id_.strip() or len(id_) > 160 or id_ in ids:
                raise ValueError('Sample ids must be nonempty and unique across splits')
            ids.add(id_)
            fields = ('textA', 'textB') if kind == 'embedding' else ('text',)
            if any(not isinstance(row.get(key), str) or not row[key].strip() or len(row[key]) > 64000 for key in fields):
                raise ValueError('Require bounded nonempty training texts')
            content = sha(json.dumps([re.sub(r'\s+', ' ', row[key]).strip().casefold() for key in fields]).encode())
            if content in contents and contents[content] != split:
                raise ValueError('Exact content leakage across splits')
            contents[content] = split
            if 'group' in row:
                group = row['group']
                if not isinstance(group, str) or not group:
                    raise ValueError('Group ids must be nonempty strings')
                if group in groups and groups[group] != split:
                    raise ValueError('Entity group leakage across splits')
                groups[group] = split
            if kind == 'embedding' and (type(row.get('score')) not in (int, float) or not math.isfinite(row['score']) or not 0 <= row['score'] <= 1):
                raise ValueError('Embedding score must be finite in [0,1]')
    if args.check:
        print(json.dumps({'status': 'validated', 'recipe': kind, 'dataHashes': hashes, 'counts': {k: len(v) for k, v in rows.items()}}))
        return
    if not args.output:
        raise ValueError('--output is required for training')
    packages = ['torch', 'transformers', 'datasets', 'accelerate', 'safetensors', 'sentence-transformers' if kind == 'embedding' else 'peft']
    versions = {name: importlib.metadata.version(name) for name in packages}
    identity = {'spec': spec, 'dataHashes': hashes, 'localModelHashes': model_hashes, 'packages': versions, 'python': platform.python_version(), 'trainerSha256': sha(Path(__file__).read_bytes())}
    run_hash = sha(json.dumps(identity, sort_keys=True).encode())
    resume = None
    if args.resume:
        checkpoint = json.loads(Path(args.resume).read_text())
        if checkpoint.get('version') != 1 or checkpoint.get('runSha256') != run_hash:
            raise ValueError('Resume config/data/environment/trainer identity mismatch')
        resume = Path(checkpoint['trainerCheckpoint']).resolve()
        if not (resume / 'trainer_state.json').is_file() or not (resume / 'optimizer.pt').is_file():
            raise ValueError('Complete Trainer optimizer checkpoint unavailable')
        if int(checkpoint['step']) >= steps:
            raise ValueError('Resume final step must exceed checkpoint step')
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    save(output / 'manifest.json', {'version': 1, 'runSha256': run_hash, **identity, 'status': 'prepared'})
    began = time.monotonic()
    try:
        import torch
        import random
        import numpy as np
        from datasets import Dataset
        from transformers import set_seed, TrainerCallback
        set_seed(seed)
        torch.set_num_threads(min(4, torch.get_num_threads()))
        class RunBoundary(TrainerCallback):
            def on_step_end(self, args, state, control, **kwargs):
                if state.global_step >= steps:
                    control.should_training_stop = True
                    control.should_save = True
                    control.should_evaluate = True
                return control

            def on_log(self, args, state, control, logs=None, **kwargs):
                for key in ('loss', 'eval_loss', 'grad_norm'):
                    if key in (logs or {}) and not math.isfinite(float(logs[key])):
                        raise ValueError('Nonfinite training loss/gradient; preserve checkpoints and inspect data/runtime')

        class EvaluationRng:
            # Evaluation loaders can consume global RNG to generate iterator
            # seeds. Smoke boundaries must not change subsequent dropout or
            # sampling compared with uninterrupted training.
            def evaluate(self, *args, **kwargs):
                python_state, numpy_state = random.getstate(), np.random.get_state()
                try:
                    with torch.random.fork_rng(devices=list(range(torch.cuda.device_count()))):
                        return super().evaluate(*args, **kwargs)
                finally:
                    random.setstate(python_state)
                    np.random.set_state(numpy_state)

        common = dict(output_dir=str(output / 'trainer'), max_steps=planned_steps, per_device_train_batch_size=batch,
                      per_device_eval_batch_size=batch, learning_rate=rate, seed=seed, data_seed=seed,
                      eval_strategy='steps', eval_steps=min(50, planned_steps), save_strategy='steps',
                      save_steps=min(50, planned_steps), save_total_limit=2, logging_steps=min(10, planned_steps),
                      report_to=[], optim='adamw_torch', logging_nan_inf_filter=False, dataloader_num_workers=0)
        if kind == 'embedding':
            from sentence_transformers import SentenceTransformer, SentenceTransformerTrainer, SentenceTransformerTrainingArguments
            from sentence_transformers.sentence_transformer import losses
            from sentence_transformers.sentence_transformer.evaluation import EmbeddingSimilarityEvaluator
            class StableEmbeddingTrainer(EvaluationRng, SentenceTransformerTrainer):
                pass
            model = SentenceTransformer(model_id, revision=spec.get('revision'), trust_remote_code=False, local_files_only=local_model)
            model.max_seq_length = length
            data = {split: Dataset.from_dict({'sentence1': [r['textA'] for r in values], 'sentence2': [r['textB'] for r in values], 'score': [r['score'] for r in values]}) for split, values in rows.items()}
            def evaluate(split):
                values = rows[split]
                evaluator = EmbeddingSimilarityEvaluator([r['textA'] for r in values], [r['textB'] for r in values], [r['score'] for r in values], name=split)
                return {key: float(value) for key, value in evaluator(model).items() if isinstance(value, (int, float)) or hasattr(value, 'item')}
            evaluated_splits = ('validation', 'test') if steps >= spec.get('steps', 100) else ('validation',)
            baseline = {split: evaluate(split) for split in evaluated_splits}
            trainer = StableEmbeddingTrainer(model=model, args=SentenceTransformerTrainingArguments(**common), train_dataset=data['train'],
                                                  eval_dataset=data['validation'], loss=losses.CosineSimilarityLoss(model), callbacks=[RunBoundary()])
        else:
            from transformers import AutoTokenizer, AutoModelForCausalLM, Trainer, TrainingArguments, DataCollatorWithPadding
            from peft import get_peft_model, LoraConfig, TaskType
            class StableTrainer(EvaluationRng, Trainer):
                pass
            tokenizer = AutoTokenizer.from_pretrained(model_id, revision=spec.get('revision'), trust_remote_code=False, local_files_only=local_model)
            if tokenizer.pad_token_id is None:
                if tokenizer.eos_token_id is None:
                    raise ValueError('Tokenizer has no pad or EOS token; configure explicitly')
                tokenizer.pad_token = tokenizer.eos_token
            model = AutoModelForCausalLM.from_pretrained(model_id, revision=spec.get('revision'), trust_remote_code=False, local_files_only=local_model)
            data = {split: Dataset.from_list([tokenizer(row['text'], truncation=True, max_length=length) for row in values]) for split, values in rows.items()}
            if any(len(row['input_ids']) < 2 for values in data.values() for row in values):
                raise ValueError('Causal loss needs at least two tokens in each example')
            pad = DataCollatorWithPadding(tokenizer)
            def collate(features):
                batch_data = pad(features)
                labels = batch_data['input_ids'].clone()
                labels[batch_data['attention_mask'] == 0] = -100  # preserve genuine EOS targets
                batch_data['labels'] = labels
                return batch_data
            training_args = TrainingArguments(**common)
            baseline_trainer = StableTrainer(model=model, args=training_args, eval_dataset=data['validation'], data_collator=collate)
            evaluated_splits = ('validation', 'test') if steps >= spec.get('steps', 100) else ('validation',)
            baseline = {split: baseline_trainer.evaluate(data[split]) for split in evaluated_splits}
            del baseline_trainer
            model = get_peft_model(model, LoraConfig(task_type=TaskType.CAUSAL_LM, r=rank, lora_alpha=2 * rank, lora_dropout=.05, target_modules=modules))
            trainer = StableTrainer(model=model, args=training_args, train_dataset=data['train'], eval_dataset=data['validation'], data_collator=collate, callbacks=[RunBoundary()])
            def evaluate(split):
                return trainer.evaluate(data[split])
        trainer.train(resume_from_checkpoint=str(resume) if resume else None)
        actual_step = int(trainer.state.global_step)
        checkpoint_dir = output / 'trainer' / f'checkpoint-{actual_step}'
        if not (checkpoint_dir / 'trainer_state.json').is_file() or not (checkpoint_dir / 'optimizer.pt').is_file():
            raise ValueError('Trainer did not save a complete resumable checkpoint')
        save(output / 'checkpoint.json', {'version': 1, 'runSha256': run_hash, 'step': actual_step, 'trainerCheckpoint': str(checkpoint_dir)})
        tuned = {split: evaluate(split) for split in evaluated_splits}
        trainer.save_model(str(output / 'export'))
        if kind == 'lora':
            tokenizer.save_pretrained(str(output / 'export'))
        report = {'version': 1, 'recipe': kind, 'status': 'executed', 'runSha256': run_hash, 'step': actual_step,
                  'baseline': baseline, 'tuned': tuned, 'dataHashes': hashes, 'packages': versions,
                  'seconds': time.monotonic() - began, 'cudaAvailable': torch.cuda.is_available(),
                  'scope': 'Frozen supplied similarity scores or causal loss only; inspect task-specific quality and exported inference. Colab connection and cloud durability are unverified.'}
        save(output / 'metrics.json', report)
        print(json.dumps({**report, 'output': str(output)}, allow_nan=False))
    except Exception as error:
        save(output / 'failure.json', {'status': 'failed', 'kind': type(error).__name__, 'seconds': time.monotonic() - began,
                                      'next': 'Inspect original exception and existing checkpoints before retrying. Preserve completed artifacts.'})
        raise


if __name__ == '__main__':
    main()

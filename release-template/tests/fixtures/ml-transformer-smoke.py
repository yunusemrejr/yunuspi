"""Offline CPU integration: tiny local embedding/LoRA models, native resume/export.

Run only in an explicitly selected isolated ML dependency environment. Models
are initialized locally; the test performs no remote retrieval or installation.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

import torch
from tokenizers import Tokenizer, models, pre_tokenizers
from transformers import BertConfig, BertModel, GPT2Config, GPT2LMHeadModel, PreTrainedTokenizerFast
from sentence_transformers import SentenceTransformer
from sentence_transformers.sentence_transformer.modules import Pooling, Transformer

root, trainer_script = map(Path, sys.argv[1:3])
root.mkdir(parents=True)
torch.manual_seed(7)
torch.set_num_threads(2)
words = ['[UNK]', '[EOS]', '[PAD]', '[CLS]', '[SEP]', 'train', 'validation', 'test',
         'alpha', 'beta', 'gamma', 'delta', 'one', 'two', 'three', 'four', 'good', 'bad', 'text', 'model']
tokenizer = Tokenizer(models.WordLevel({word: i for i, word in enumerate(words)}, unk_token='[UNK]'))
tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
fast = PreTrainedTokenizerFast(tokenizer_object=tokenizer, unk_token='[UNK]', eos_token='[EOS]',
                              pad_token='[PAD]', cls_token='[CLS]', sep_token='[SEP]')
bert = root / 'bert'
fast.save_pretrained(bert)
BertModel(BertConfig(vocab_size=len(words), hidden_size=16, num_hidden_layers=1, num_attention_heads=2,
                     intermediate_size=32, max_position_embeddings=64)).save_pretrained(bert)
embedding = root / 'embedding'
SentenceTransformer(modules=[Transformer(str(bert), max_seq_length=32), Pooling(16)]).save_pretrained(embedding)
gpt = root / 'gpt'
fast.save_pretrained(gpt)
GPT2LMHeadModel(GPT2Config(vocab_size=len(words), n_embd=16, n_layer=1, n_head=2, n_positions=64,
                         bos_token_id=1, eos_token_id=1, pad_token_id=2)).save_pretrained(gpt)

for recipe, model in [('embedding', embedding), ('lora', gpt)]:
    datasets = {}
    for split in ['train', 'validation', 'test']:
        file = root / f'{recipe}-{split}.jsonl'
        datasets[split] = str(file)
        rows = []
        for i, (a, b) in enumerate([('alpha', 'beta'), ('gamma', 'delta'), ('one', 'two'), ('three', 'four')]):
            row = {'id': split + str(i), 'textA': f'{split} {a} text', 'textB': f'{split} {b} model', 'score': i / 3}
            if recipe == 'lora':
                row = {'id': split + str(i), 'text': f'{split} {a} {b} good model [EOS]'}
            rows.append(row)
        file.write_text('\n'.join(json.dumps(row) for row in rows) + '\n')
    spec = root / f'{recipe}-spec.json'
    spec.write_text(json.dumps({'recipe': recipe, 'model': str(model), 'datasets': datasets, 'steps': 4,
                               'batchSize': 2, 'maxLength': 32, 'targetModules': ['c_attn'], 'rank': 2}))
    for phase, args in [('smoke', ['--steps', '2']),
                        ('resumed', ['--resume', str(root / f'{recipe}-smoke/checkpoint.json')]),
                        ('uninterrupted', [])]:
        output = root / f'{recipe}-{phase}'
        result = subprocess.run([sys.executable, '-I', str(trainer_script), '--spec', str(spec), '--output', str(output), *args],
                                env={**os.environ, 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'TOKENIZERS_PARALLELISM': 'false'},
                                capture_output=True, text=True, timeout=120)
        (root / f'{recipe}-{phase}.log').write_text(result.stdout + '\n' + result.stderr)
        if result.returncode:
            raise AssertionError(f'{recipe}/{phase}: {result.stderr[-6000:]}')
        metrics = json.loads((output / 'metrics.json').read_text())
        checkpoint = json.loads((output / 'checkpoint.json').read_text())
        assert metrics['status'] == 'executed' and metrics['step'] == (2 if phase == 'smoke' else 4)
        assert checkpoint['runSha256'] == metrics['runSha256']
        native = Path(checkpoint['trainerCheckpoint'])
        assert (native / 'optimizer.pt').is_file() and (native / 'scheduler.pt').is_file()
        assert (native / 'rng_state.pth').is_file() and (native / 'trainer_state.json').is_file()
        assert 'test' not in metrics['tuned'] if phase == 'smoke' else 'test' in metrics['tuned']
        assert (output / 'export').is_dir()
        print(json.dumps({'recipe': recipe, 'phase': phase, 'step': metrics['step'], 'cpu': not metrics['cudaAvailable']}), flush=True)
    # Runtime speed/timestamps differ, so compare actual exported weights instead.
    from safetensors.torch import load_file
    resumed_files = sorted((root / f'{recipe}-resumed/export').rglob('*.safetensors'))
    assert resumed_files
    for file in resumed_files:
        relative = file.relative_to(root / f'{recipe}-resumed/export')
        resumed = load_file(str(file))
        complete = load_file(str(root / f'{recipe}-uninterrupted/export' / relative))
        assert resumed.keys() == complete.keys()
        for key in resumed:
            assert torch.equal(resumed[key], complete[key]), f'{recipe}: resume changed {key}'
    print(json.dumps({'recipe': recipe, 'resumeWeightsEqual': True}), flush=True)

# Colab reference scripts

Runnable-shaped starting points for the `colab` skill. They target a Google Colab VM reached through the `colab` tool or the official `colab` CLI, write outputs under `/content`, and end with a machine-readable summary line.

Validation status: these files are syntax-checked (`python3 -m py_compile`), not certified on a live runtime. Run `colab_smoke.py` and a short smoke run before trusting any default. The reference scripts contain no credentials, private data or fixed account values.

## Shared setup

One session per job, an explicit name, and a smoke test before any real run:

```sh
colab new -s lab --gpu T4
colab exec -s lab -f colab_smoke.py --timeout 120 --require-cuda
```

Equivalent through the harness: `setup`, `status`, `new`, then `exec` with the same script and session, `timeout_sec: 120`.

`colab_smoke.py` prints one JSON object with the runtime, GPU devices, memory, disk, package versions and a small matmul benchmark. It exits non-zero with `--require-cuda` when no CUDA device exists. Check `ok`, `torch.cuda_available`, `torch.devices[0].name` and the free-memory figure against the plan before continuing.

Common packages for the training references:

```sh
colab install -s lab "transformers>=4.46" "peft>=0.13" "trl>=0.16" \
  "datasets>=3.0" "bitsandbytes>=0.46" "accelerate>=1.0"
```

`pretrain_tiny.py` needs only PyTorch, which a Colab runtime already provides. Restart the kernel after installing a new `transformers`/`trl` major version so the session does not mix imported modules.

Scripts are sent to the kernel from the local disk by `colab exec -f`; only datasets and other input files need `upload`. The default working directory is `/content`, and every reference writes below `/content/runs/`.

## Hugging Face access

The default model and datasets are public. A gated model (for example most Gemma checkpoints) needs a token and the license accepted on the Hub. Keep the token out of scripts and shell history:

```sh
colab exec -s lab -f finetune_qlora.py --timeout 1800 --env HF_TOKEN="$HF_TOKEN"
```

The scripts read `HF_TOKEN` or `HUGGING_FACE_HUB_TOKEN` from `os.environ`. The CLI records executed code in session history, and the `--env` prelude that sets the variable is part of that code. Treat `colab log` exports as sensitive: do not share a notebook or JSONL export that may contain a token, and rotate the token if one leaks.

## finetune_qlora.py

QLoRA supervised fine-tuning with transformers, peft and trl: 4-bit NF4 base model, LoRA adapter, held-out validation split, checkpointing, adapter save and one generation sample. Defaults are Qwen2.5-1.5B-Instruct on `HuggingFaceH4/no_robots`, sized as a starting point for a 16 GB T4.

Smoke run first (validates formatting, quantization, memory, save path):

```sh
colab exec -s lab -f finetune_qlora.py --timeout 1200 \
  --max-samples 200 --max-steps 20 --output-dir /content/runs/qlora_smoke
```

Then a real run:

```sh
colab exec -s lab -f finetune_qlora.py --timeout 7200 \
  --max-samples 2000 --num-train-epochs 1 --output-dir /content/runs/qlora_sft
```

Resume after a timeout or a reclaimed session from a downloaded checkpoint:

```sh
colab exec -s lab -f finetune_qlora.py --timeout 7200 \
  --resume-from-checkpoint /content/runs/qlora_sft/checkpoint-100
```

Outputs under the output directory: adapter weights (`adapter_model.safetensors`, `adapter_config.json`), tokenizer files, `trainer_log_history.json`, `run_metadata.json`, `samples.txt`, and checkpoint subdirectories. Final stdout line: `summary: {...}` with train/eval metrics, step count, GPU and package versions.

Useful flags: `--no-load-in-4bit` for a full-precision run on a larger GPU, `--lora-r`/`--lora-alpha` for adapter capacity, `--max-seq-length` for context, `--batch-size`/`--grad-accum` for memory, `--eval-fraction 0` to skip the held-out split, `--dtype bf16` on L4/A100. On T4 the script picks fp16 compute automatically; do not force bf16 there.

## rl_grpo.py

GRPO on GSM8K with a deterministic numeric-match reward (1.0 correct, 0.0 otherwise) plus a 0.2 format reward for a parseable `<answer>` tag. No reward model is trained. Defaults are Qwen2.5-0.5B-Instruct and a short smoke run.

```sh
colab exec -s lab -f rl_grpo.py --timeout 1800 \
  --max-samples 300 --max-steps 20 --num-generations 4 --output-dir /content/runs/grpo_smoke
```

A longer run:

```sh
colab exec -s lab -f rl_grpo.py --timeout 10800 \
  --max-samples 2000 --max-steps 200 --output-dir /content/runs/grpo_gsm8k
```

Outputs: the trained model, tokenizer, `trainer_log_history.json`, `eval_metrics.json`, `eval_predictions.jsonl`, and the final `summary: {...}` line. Greedy held-out accuracy in `eval_metrics.json` is the evidence; a reward that never leaves zero means the task, prompt format or reward is wrong, not that the run needs more steps.

`--batch-size` must be divisible by `--num-generations`. GRPO holds the policy, reference model and sampled completions in memory; on a 16 GB T4 reduce `--max-completion-length` and `--batch-size` first, and expect a smoke run to be slow.

## pretrain_tiny.py

A byte-level decoder-only Transformer trained from scratch on a local text file. No tokenizer training and no internet access are required. Defaults are a roughly 5M-parameter model on up to 5 MB of corpus.

```sh
colab upload ./corpus.txt /content/corpus.txt
colab exec -s lab -f pretrain_tiny.py --timeout 1200 \
  --data /content/corpus.txt --max-steps 40 --output-dir /content/runs/pretrain_smoke
```

A longer run:

```sh
colab exec -s lab -f pretrain_tiny.py --timeout 7200 \
  --data /content/corpus.txt --max-steps 500 --output-dir /content/runs/pretrain
```

Outputs: `ckpt.pt` (resumable: model, optimizer, step), `ckpt_best.pt` (lowest measured validation loss), `metrics.jsonl` (one loss record per evaluation), `samples.txt`, and the final `summary: {...}` line. Resume with `--resume-from-checkpoint auto` and the same output directory. Byte-level sampling can include replacement characters for invalid UTF-8; that is a tokenizer limitation, not a loading bug.

## Pulling artifacts back

Download files before stopping; `/content` disappears with the session. For a whole directory, archive it on the VM and fetch the archive:

```sh
echo "import shutil; shutil.make_archive('/content/qlora_sft','zip','/content/runs','qlora_sft')" | colab exec -s lab
colab download -s lab /content/qlora_sft.zip ./qlora_sft.zip
colab ls -s lab /content/runs
```

Export the session history when the run matters:

```sh
colab log -s lab -o ./lab-session.ipynb
```

Check the export for secrets before sharing. Then release the VM:

```sh
colab stop -s lab
```

Confirm with `colab sessions` or the tool's `sessions` action that nothing is left, and use `colab usage` when compute-unit cost matters.

## Common failures

| Symptom | Likely cause and next step |
| --- | --- |
| `CUDA is not available` from the smoke test | Session was allocated on CPU or the accelerator was not entitled. Check `colab status`/`sessions`, reallocate with an explicit `--gpu`, and confirm the account tier. |
| `ModuleNotFoundError` after installing | The kernel imported the old module before install, or the package landed in a different environment. Restart the kernel and rerun. |
| `torch.cuda.OutOfMemoryError` | Lower `--batch-size`, `--max-seq-length`, `--num-generations` or LoRA rank; reduce `--grad-accum` last. |
| Training loss stuck at a constant | Wrong text column, empty formatting, label masking issue, or learning rate far too low. Inspect `samples.txt`/completions before extending the run. |
| GRPO rewards all zero | Task too hard for the model, prompt format not followed, or answer extraction mismatch. Test `extract_number` on a few completions offline. |
| Timeout with no checkpoint | `--timeout` too short for the silent stretch or checkpoint interval too large. Lower `--save-steps`/`--eval-interval`, raise the timeout, resume from a checkpoint. |
| Session lost (`404`/`401`) | The backend reclaimed the VM. Download the last checkpoint, allocate again, re-upload inputs and resume. |

## Files

| File | Purpose |
| --- | --- |
| `colab_smoke.py` | JSON runtime/GPU/memory/disk/package report; `--require-cuda` makes a missing GPU fail. |
| `finetune_qlora.py` | QLoRA SFT with validation, checkpointing, adapter save and generation check. |
| `rl_grpo.py` | GRPO with deterministic reward, held-out greedy evaluation and predictions. |
| `pretrain_tiny.py` | Small byte-level GPT pretraining with resume, loss log and samples. |

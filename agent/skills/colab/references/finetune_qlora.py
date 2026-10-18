#!/usr/bin/env python3
"""QLoRA supervised fine-tuning for a Colab GPU runtime.

Shapes: load a chat or text dataset, format it for the tokenizer, quantize the
base model to 4-bit, attach a LoRA adapter, train with TRL's SFTTrainer, then
save the adapter, tokenizer, metrics and one generation sample.

Usage (on a Colab VM, from /content):
    python finetune_qlora.py --max-samples 500 --max-steps 30     # smoke run
    python finetune_qlora.py --num-train-epochs 1                 # real run
    python finetune_qlora.py --resume-from-checkpoint auto        # after timeout

The script reads HF_TOKEN (or HUGGING_FACE_HUB_TOKEN) from the environment and
never prints it. The final stdout line is `summary: {...}` with JSON, so a log
can be checked without parsing prose. A gated model needs the token and a
license accepted on the Hub; the default model and dataset are public.

This is a reference, not a benchmark: defaults are chosen to fit a 16 GB T4 in
4-bit, and every fit claim must be checked with colab_smoke.py before a long run.
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Any


def _clean_argv() -> list[str]:
    """Drop the Jupyter kernel launcher's own ``-f kernel.json`` arguments.

    ``colab exec -f script.py`` runs the source through a Colab kernel and the
    kernel launcher appends ``-f /.../kernel-*.json`` to ``sys.argv``. Strip
    only that exact shape so ``python script.py --flag`` and ``colab run``
    (which sets sys.argv itself) behave normally.
    """
    raw = list(sys.argv[1:])
    cleaned: list[str] = []
    i = 0
    while i < len(raw):
        if raw[i] == "-f" and i + 1 < len(raw) and str(raw[i + 1]).endswith(".json"):
            i += 2
            continue
        cleaned.append(raw[i])
        i += 1
    return cleaned

DEFAULT_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"
DEFAULT_DATASET = "HuggingFaceH4/no_robots"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="QLoRA supervised fine-tuning (transformers + peft + trl).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    model = parser.add_argument_group("model and data")
    model.add_argument("--model", default=DEFAULT_MODEL, help="Hub id or local path.")
    model.add_argument("--dataset", default=DEFAULT_DATASET, help="Hub dataset id.")
    model.add_argument("--dataset-config", default=None, help="Dataset config name.")
    model.add_argument("--split", default="train", help="Dataset split to load.")
    model.add_argument(
        "--max-samples", type=int, default=1000, help="Rows to use; -1 for all."
    )
    model.add_argument(
        "--eval-fraction",
        type=float,
        default=0.05,
        help="Held-out fraction; 0 disables evaluation during training.",
    )
    model.add_argument(
        "--text-field",
        default="text",
        help="Column with ready-to-train text, if the dataset has one.",
    )
    model.add_argument(
        "--messages-field",
        default="messages",
        help="Column holding a chat message list, if the dataset has one.",
    )
    model.add_argument(
        "--max-seq-length", type=int, default=1024, help="Token truncation length."
    )
    model.add_argument(
        "--system-prompt",
        default=None,
        help="Optional system message prepended to chat-formatted examples.",
    )

    quant = parser.add_argument_group("quantization and LoRA")
    quant.add_argument(
        "--load-in-4bit",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Quantize the base model to 4-bit NF4 (QLoRA).",
    )
    quant.add_argument(
        "--dtype",
        choices=["auto", "bf16", "fp16", "fp32"],
        default="auto",
        help="Compute dtype; auto uses bf16 when the GPU supports it, else fp16.",
    )
    quant.add_argument("--lora-r", type=int, default=16)
    quant.add_argument("--lora-alpha", type=int, default=32)
    quant.add_argument("--lora-dropout", type=float, default=0.05)
    quant.add_argument(
        "--lora-target-modules",
        default="all-linear",
        help="Comma-separated module names, or all-linear.",
    )

    train = parser.add_argument_group("training")
    train.add_argument("--output-dir", default="runs/qlora_sft")
    train.add_argument("--num-train-epochs", type=float, default=1.0)
    train.add_argument(
        "--max-steps", type=int, default=-1, help="Override epochs; -1 disables."
    )
    train.add_argument("--batch-size", type=int, default=2)
    train.add_argument("--grad-accum", type=int, default=4)
    train.add_argument("--learning-rate", type=float, default=2e-4)
    train.add_argument("--warmup-ratio", type=float, default=0.03)
    train.add_argument("--lr-scheduler", default="cosine")
    train.add_argument("--weight-decay", type=float, default=0.0)
    train.add_argument("--max-grad-norm", type=float, default=1.0)
    train.add_argument("--logging-steps", type=int, default=5)
    train.add_argument("--save-steps", type=int, default=25)
    train.add_argument("--eval-steps", type=int, default=25)
    train.add_argument("--save-total-limit", type=int, default=2)
    train.add_argument(
        "--gradient-checkpointing",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Trade compute for activation memory; keep on for T4.",
    )
    train.add_argument(
        "--assistant-only-loss",
        action="store_true",
        help="Compute loss on assistant turns only (requires chat-formatted data).",
    )
    train.add_argument(
        "--packing",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Pack short examples into full-length sequences (TRL feature).",
    )
    train.add_argument(
        "--optim",
        default=None,
        help="Trainer optimizer; default paged_adamw_8bit when 4-bit is on.",
    )
    train.add_argument("--report-to", default="none")
    train.add_argument("--seed", type=int, default=42)
    train.add_argument("--dataloader-workers", type=int, default=2)
    train.add_argument(
        "--resume-from-checkpoint",
        default=None,
        help="Checkpoint path, or auto/latest to resume the newest one in output-dir.",
    )
    train.add_argument("--max-new-tokens", type=int, default=128)
    return parser.parse_args(argv)


def set_seed(seed: int) -> None:
    random.seed(seed)
    os.environ.setdefault("PYTHONHASHSEED", str(seed))
    try:
        import numpy as np

        np.random.seed(seed)
    except Exception:
        pass
    import torch

    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def pick_dtype(name: str) -> tuple[Any, str]:
    import torch

    if name == "auto":
        if torch.cuda.is_available():
            dtype = (
                torch.bfloat16
                if getattr(torch.cuda, "is_bf16_supported", lambda: False)()
                else torch.float16
            )
        else:
            dtype = torch.float32
    else:
        dtype = {
            "bf16": torch.bfloat16,
            "fp16": torch.float16,
            "fp32": torch.float32,
        }[name]
    return dtype, str(dtype).replace("torch.", "")


def accepted_kwargs(factory: Any, candidates: dict[str, Any]) -> dict[str, Any]:
    """Drop options this installed library version does not accept.

    TRL and transformers rename trainer options between minor releases. A
    reference script should keep running across those renames and say what it
    ignored, rather than fail on an unexpected keyword argument.
    """
    try:
        params = inspect.signature(factory).parameters
    except (TypeError, ValueError):
        return dict(candidates)
    accepted = {key: value for key, value in candidates.items() if key in params}
    dropped = sorted(key for key in candidates if key not in accepted)
    if dropped:
        print(
            f"[finetune_qlora] note: this library version ignores options "
            f"{dropped}; defaults apply.",
            file=sys.stderr,
        )
    return accepted


def loader_kwargs(token: str | None) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    if token:
        kwargs["token"] = token
    return kwargs


def format_example(
    example: dict[str, Any],
    tokenizer: Any,
    args: argparse.Namespace,
) -> str | None:
    text = example.get(args.text_field)
    if isinstance(text, str) and text.strip():
        return text

    messages = example.get(args.messages_field)
    if isinstance(messages, list) and messages:
        messages = list(messages)
        if args.system_prompt and not any(m.get("role") == "system" for m in messages):
            messages.insert(0, {"role": "system", "content": args.system_prompt})
        if tokenizer.chat_template is None:
            raise SystemExit(
                f"[finetune_qlora] {args.messages_field} looks conversational but the "
                "tokenizer has no chat template. Pass --model with a chat template "
                "or use a dataset with a text column."
            )
        return tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=False
        )

    prompt = example.get("prompt")
    completion = example.get("completion") or example.get("response")
    if isinstance(prompt, str) and isinstance(completion, str):
        return f"{prompt}{completion}"
    return None


def build_datasets(
    tokenizer: Any, args: argparse.Namespace, token: str | None
) -> tuple[Any, Any | None]:
    from datasets import load_dataset

    load_kwargs: dict[str, Any] = {"split": args.split}
    if args.dataset_config:
        load_kwargs["name"] = args.dataset_config
    raw = load_dataset(args.dataset, **loader_kwargs(token), **load_kwargs)
    if args.max_samples >= 0:
        n = min(args.max_samples, len(raw))
        raw = raw.shuffle(seed=args.seed).select(range(n))

    formatted = raw.map(
        lambda example: {"text": format_example(example, tokenizer, args)},
        remove_columns=raw.column_names,
        desc="formatting examples",
    ).filter(lambda example: isinstance(example["text"], str) and example["text"].strip())

    if len(formatted) < 2:
        raise SystemExit(
            "[finetune_qlora] fewer than 2 formattable rows; check --dataset, "
            "--split and the text/messages fields."
        )

    if args.eval_fraction <= 0:
        return formatted, None
    split = formatted.train_test_split(
        test_size=min(max(args.eval_fraction, 1 / len(formatted)), 0.9),
        seed=args.seed,
        shuffle=True,
    )
    train_ds, eval_ds = split["train"], split["test"]
    if len(eval_ds) == 0:
        eval_ds = None
    print(
        f"[finetune_qlora] train={len(train_ds)} eval={0 if eval_ds is None else len(eval_ds)}",
        file=sys.stderr,
    )
    return train_ds, eval_ds


def load_model_and_tokenizer(args: argparse.Namespace, token: str | None) -> tuple[Any, Any, str]:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    dtype, dtype_name = pick_dtype(args.dtype)
    common = {"trust_remote_code": False, **loader_kwargs(token)}
    tokenizer = AutoTokenizer.from_pretrained(args.model, **common)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model_kwargs: dict[str, Any] = {"device_map": "auto", **common}
    if args.load_in_4bit:
        from transformers import BitsAndBytesConfig

        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=dtype,
        )
        model = AutoModelForCausalLM.from_pretrained(args.model, **model_kwargs)
    elif torch.cuda.is_available():
        try:
            model = AutoModelForCausalLM.from_pretrained(
                args.model, dtype=dtype, **model_kwargs
            )
        except TypeError:
            model = AutoModelForCausalLM.from_pretrained(
                args.model, torch_dtype=dtype, **model_kwargs
            )
    else:
        model = AutoModelForCausalLM.from_pretrained(args.model, **model_kwargs)

    if args.load_in_4bit:
        from peft import prepare_model_for_kbit_training

        model = prepare_model_for_kbit_training(
            model, use_gradient_checkpointing=args.gradient_checkpointing
        )
    elif args.gradient_checkpointing:
        model.gradient_checkpointing_enable()
    model.config.use_cache = False
    return model, tokenizer, dtype_name


def build_peft_model(model: Any, args: argparse.Namespace) -> Any:
    from peft import LoraConfig, get_peft_model

    targets = args.lora_target_modules
    target_modules: str | list[str]
    if targets.strip() == "all-linear":
        target_modules = "all-linear"
    else:
        target_modules = [part.strip() for part in targets.split(",") if part.strip()]

    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        target_modules=target_modules,
        bias="none",
        task_type="CAUSAL_LM",
    )
    peft_model = get_peft_model(model, lora_config)
    try:
        peft_model.print_trainable_parameters()
    except Exception:
        pass
    return peft_model


def build_trainer(
    model: Any,
    tokenizer: Any,
    train_ds: Any,
    eval_ds: Any | None,
    args: argparse.Namespace,
    dtype_name: str,
) -> tuple[Any, Any]:
    import torch
    from trl import SFTConfig, SFTTrainer

    is_cuda = torch.cuda.is_available()
    config_candidates: dict[str, Any] = {
        "output_dir": args.output_dir,
        "num_train_epochs": args.num_train_epochs,
        "max_steps": args.max_steps,
        "per_device_train_batch_size": args.batch_size,
        "per_device_eval_batch_size": max(1, args.batch_size),
        "gradient_accumulation_steps": args.grad_accum,
        "learning_rate": args.learning_rate,
        "lr_scheduler_type": args.lr_scheduler,
        "warmup_ratio": args.warmup_ratio,
        "weight_decay": args.weight_decay,
        "max_grad_norm": args.max_grad_norm,
        "logging_steps": args.logging_steps,
        "save_strategy": "steps",
        "save_steps": args.save_steps,
        "save_total_limit": args.save_total_limit,
        "gradient_checkpointing": args.gradient_checkpointing,
        "gradient_checkpointing_kwargs": {"use_reentrant": False},
        "report_to": args.report_to,
        "seed": args.seed,
        "dataloader_num_workers": args.dataloader_workers,
        "bf16": is_cuda and dtype_name == "bf16",
        "fp16": is_cuda and dtype_name == "fp16",
        "dataset_text_field": "text",
        # Both spellings exist across TRL releases; the helper keeps the one
        # this installed version knows and reports the other as ignored.
        "max_length": args.max_seq_length,
        "max_seq_length": args.max_seq_length,
    }
    if args.optim:
        config_candidates["optim"] = args.optim
    elif args.load_in_4bit and is_cuda:
        config_candidates["optim"] = "paged_adamw_8bit"
    if eval_ds is not None:
        config_candidates["eval_strategy"] = "steps"
        config_candidates["evaluation_strategy"] = "steps"
        config_candidates["eval_steps"] = args.eval_steps
        config_candidates["per_device_eval_batch_size"] = 1
    if args.assistant_only_loss:
        config_candidates["assistant_only_loss"] = True
    if args.packing:
        config_candidates["packing"] = True

    config = SFTConfig(**accepted_kwargs(SFTConfig, config_candidates))

    trainer_params = set(inspect.signature(SFTTrainer.__init__).parameters)
    trainer_kwargs: dict[str, Any] = {
        "model": model,
        "args": config,
        "train_dataset": train_ds,
    }
    if eval_ds is not None:
        trainer_kwargs["eval_dataset"] = eval_ds
    if "processing_class" in trainer_params:
        trainer_kwargs["processing_class"] = tokenizer
    elif "tokenizer" in trainer_params:
        trainer_kwargs["tokenizer"] = tokenizer
    if "dataset_text_field" in trainer_params:
        trainer_kwargs["dataset_text_field"] = "text"
    trainer = SFTTrainer(**trainer_kwargs)
    return trainer, config


def save_generation_sample(
    trainer: Any,
    tokenizer: Any,
    dataset: Any,
    args: argparse.Namespace,
    out_dir: Path,
) -> str | None:
    import torch

    try:
        example = dataset[0]
        prompt = str(example["text"])
        device = next(trainer.model.parameters()).device
        encoded = tokenizer(prompt, return_tensors="pt").to(device)
        if encoded["input_ids"].shape[1] > args.max_seq_length:
            encoded["input_ids"] = encoded["input_ids"][:, : args.max_seq_length]
            encoded["attention_mask"] = encoded["attention_mask"][:, : args.max_seq_length]
        with torch.no_grad():
            output = trainer.model.generate(
                **encoded,
                max_new_tokens=args.max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
            )
        continuation = output[0][encoded["input_ids"].shape[1] :]
        generated = tokenizer.decode(continuation, skip_special_tokens=True).strip()
        (out_dir / "samples.txt").write_text(
            f"PROMPT\n{prompt}\n\nGENERATED\n{generated}\n", encoding="utf-8"
        )
        return generated[:2000]
    except Exception as exc:
        print(
            f"[finetune_qlora] generation check skipped: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return None


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    started = time.time()
    set_seed(args.seed)
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")

    import torch

    if not torch.cuda.is_available() and args.load_in_4bit:
        raise SystemExit(
            "[finetune_qlora] 4-bit QLoRA needs a CUDA device. Run "
            "colab_smoke.py --require-cuda, or pass --no-load-in-4bit on CPU."
        )

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    model, tokenizer, dtype_name = load_model_and_tokenizer(args, token)
    model = build_peft_model(model, args)
    train_ds, eval_ds = build_datasets(tokenizer, args, token)
    trainer, config = build_trainer(model, tokenizer, train_ds, eval_ds, args, dtype_name)

    resume: str | bool | None = None
    if args.resume_from_checkpoint:
        value = args.resume_from_checkpoint.strip()
        resume = True if value in {"auto", "latest"} else value
    print(
        f"[finetune_qlora] model={args.model} dtype={dtype_name} "
        f"4bit={args.load_in_4bit} out={out_dir.resolve()}",
        file=sys.stderr,
    )

    train_result = trainer.train(resume_from_checkpoint=resume)
    train_metrics = dict(getattr(train_result, "metrics", {}) or {})

    eval_metrics: dict[str, Any] = {}
    if eval_ds is not None:
        try:
            eval_metrics = dict(trainer.evaluate() or {})
        except Exception as exc:
            print(
                f"[finetune_qlora] final evaluation failed: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )

    trainer.model.save_pretrained(out_dir)
    tokenizer.save_pretrained(out_dir)
    (out_dir / "trainer_log_history.json").write_text(
        json.dumps(trainer.state.log_history, indent=2), encoding="utf-8"
    )

    generation = save_generation_sample(
        trainer, tokenizer, eval_ds if eval_ds is not None else train_ds, args, out_dir
    )

    safe_args = {
        key: value
        for key, value in vars(args).items()
        if "token" not in key.lower() and "key" not in key.lower()
    }
    (out_dir / "run_metadata.json").write_text(
        json.dumps(
            {
                "args": safe_args,
                "dtype": dtype_name,
                "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
                "world_size": 1,
                "created_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    adapter_files = sorted(
        str(path.relative_to(out_dir))
        for path in out_dir.rglob("*")
        if path.is_file()
    )
    summary = {
        "script": "finetune_qlora.py",
        "model": args.model,
        "dataset": args.dataset,
        "output_dir": str(out_dir.resolve()),
        "train_samples": len(train_ds),
        "eval_samples": 0 if eval_ds is None else len(eval_ds),
        "load_in_4bit": args.load_in_4bit,
        "dtype": dtype_name,
        "global_step": int(trainer.state.global_step),
        "train_metrics": train_metrics,
        "eval_metrics": eval_metrics,
        "generated_sample": generation,
        "elapsed_sec": round(time.time() - started, 1),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        "adapter_files": adapter_files,
        "versions": package_versions(),
    }
    print("summary: " + json.dumps(summary, default=str))
    return 0


def package_versions() -> dict[str, str | None]:
    import importlib.metadata

    versions: dict[str, str | None] = {}
    for name in ("torch", "transformers", "peft", "trl", "datasets", "accelerate", "bitsandbytes"):
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    return versions


if __name__ == "__main__":
    raise SystemExit(main(_clean_argv()))

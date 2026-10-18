#!/usr/bin/env python3
"""GRPO reinforcement learning on a verifiable-answer task (GSM8K-style).

The reward is deterministic: a completion earns 1.0 when the number inside its
<answer> tags matches the dataset's gold answer, plus a small format reward for
using the tags. No reward model is trained, so the only stochastic part is
sampling from the policy.

Usage (on a Colab VM, from /content):
    python rl_grpo.py --max-samples 500 --max-steps 20      # smoke run
    python rl_grpo.py --max-steps 200 --num-generations 4   # longer run
    python rl_grpo.py --resume-from-checkpoint auto         # after a timeout

The first print after training is a `summary: {...}` JSON line. Sample
completions and a greedy evaluation on held-out problems are saved beside the
model. Defaults target a first smoke run on a 16 GB T4; raising batch size and
completion length needs a memory check from colab_smoke.py first.
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
import random
import re
import sys
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

DEFAULT_MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
DEFAULT_DATASET = "openai/gsm8k"
DEFAULT_CONFIG = "main"
SYSTEM_PROMPT = (
    "You are a careful math tutor. Solve the problem step by step, then put the "
    "final numeric answer inside <answer></answer> tags, for example "
    "<answer>42</answer>."
)

NUMBER_RE = re.compile(r"[-+]?\d[\d,]*(?:\.\d+)?")
ANSWER_TAG_RE = re.compile(r"<answer>\s*(.*?)\s*</answer>", re.DOTALL | re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="GRPO on GSM8K with a deterministic numeric-match reward.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--dataset-config", default=DEFAULT_CONFIG)
    parser.add_argument("--split", default="train")
    parser.add_argument(
        "--max-samples", type=int, default=500, help="Rows to train on; -1 for all."
    )
    parser.add_argument(
        "--eval-samples",
        type=int,
        default=16,
        help="Held-out problems used for the final greedy evaluation.",
    )
    parser.add_argument("--output-dir", default="runs/grpo_gsm8k")

    parser.add_argument("--max-steps", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--num-generations", type=int, default=4)
    parser.add_argument("--max-completion-length", type=int, default=192)
    parser.add_argument("--max-prompt-length", type=int, default=512)
    parser.add_argument("--temperature", type=float, default=1.0)
    parser.add_argument("--beta", type=float, default=0.04)
    parser.add_argument("--learning-rate", type=float, default=1e-6)
    parser.add_argument("--lr-scheduler", default="cosine")
    parser.add_argument("--warmup-ratio", type=float, default=0.03)
    parser.add_argument("--logging-steps", type=int, default=1)
    parser.add_argument("--save-steps", type=int, default=10)
    parser.add_argument("--save-total-limit", type=int, default=2)
    parser.add_argument(
        "--gradient-checkpointing",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--log-completions",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Print sample completions during training when supported.",
    )
    parser.add_argument("--dtype", choices=["auto", "bf16", "fp16", "fp32"], default="auto")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--report-to", default="none")
    parser.add_argument(
        "--resume-from-checkpoint",
        default=None,
        help="Checkpoint path, or auto/latest for the newest one in output-dir.",
    )
    return parser.parse_args()


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


def accepted_kwargs(factory: Any, candidates: dict[str, Any]) -> dict[str, Any]:
    """Keep only options this installed TRL/transformers version accepts."""
    try:
        params = inspect.signature(factory).parameters
    except (TypeError, ValueError):
        return dict(candidates)
    accepted = {key: value for key, value in candidates.items() if key in params}
    dropped = sorted(key for key in candidates if key not in accepted)
    if dropped:
        print(
            f"[rl_grpo] note: this library version ignores options {dropped}; "
            "defaults apply.",
            file=sys.stderr,
        )
    return accepted


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
        dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[name]
    return dtype, str(dtype).replace("torch.", "")


def loader_kwargs(token: str | None) -> dict[str, Any]:
    return {"token": token} if token else {}


def normalize_number(text: str) -> str | None:
    text = text.strip().replace(",", "").replace("$", "").rstrip(".")
    if not text:
        return None
    try:
        value = Decimal(text)
    except (InvalidOperation, ValueError):
        return None
    if not value.is_finite():
        return None
    # 42, 42.0 and 042 all mean the same answer.
    return format(value.normalize(), "f")


def extract_number(text: str) -> str | None:
    """Pull the final numeric answer out of a completion.

    Preference order: the last <answer> tag, then the last number in the text.
    Returns a normalized decimal string or None.
    """
    tagged = ANSWER_TAG_RE.findall(text)
    candidates = tagged[-1:] if tagged else [text]
    for candidate in reversed(candidates):
        numbers = NUMBER_RE.findall(candidate)
        for raw in reversed(numbers):
            normalized = normalize_number(raw)
            if normalized is not None:
                return normalized
    return None


def completion_text(completion: Any) -> str:
    """Reward functions receive strings or, for chat data, message lists."""
    if isinstance(completion, str):
        return completion
    if isinstance(completion, list):
        if completion and isinstance(completion[-1], dict):
            return str(completion[-1].get("content", ""))
        return "".join(str(part) for part in completion)
    return str(completion)


def format_reward(completions: list[Any], **kwargs: Any) -> list[float]:
    """Small shaped reward for producing a parseable <answer> tag."""
    rewards = []
    for completion in completions:
        text = completion_text(completion)
        has_tag = bool(ANSWER_TAG_RE.search(text))
        has_number = extract_number(text) is not None
        rewards.append(0.2 if has_tag and has_number else 0.0)
    return rewards


def correctness_reward(completions: list[Any], answer: list[str], **kwargs: Any) -> list[float]:
    """1.0 for a numeric answer equal to the gold value, else 0.0."""
    rewards = []
    for completion, gold in zip(completions, answer):
        prediction = extract_number(completion_text(completion))
        correct = prediction is not None and prediction == normalize_number(str(gold))
        rewards.append(1.0 if correct else 0.0)
    return rewards


def extract_gold(answer_text: str) -> str:
    # GSM8K stores the final answer after a "####" marker.
    candidate = answer_text.split("####")[-1] if "####" in answer_text else answer_text
    normalized = normalize_number(candidate)
    if normalized is None:
        raise SystemExit(f"[rl_grpo] could not parse gold answer: {answer_text[:200]!r}")
    return normalized


def build_prompt(question: str) -> str:
    return (
        f"{SYSTEM_PROMPT}\n\n"
        f"Problem:\n{question.strip()}\n\n"
        "Respond with your reasoning and finish with <answer>N</answer>."
    )


def load_data(token: str | None, args: argparse.Namespace) -> tuple[Any, list[dict[str, str]]]:
    from datasets import load_dataset

    load_kwargs: dict[str, Any] = {"split": args.split, **loader_kwargs(token)}
    if args.dataset_config:
        load_kwargs["name"] = args.dataset_config
    raw = load_dataset(args.dataset, **load_kwargs)
    raw = raw.shuffle(seed=args.seed)
    if args.max_samples >= 0:
        raw = raw.select(range(min(args.max_samples, len(raw))))
    if len(raw) < 2:
        raise SystemExit("[rl_grpo] need at least 2 rows from --dataset")

    eval_n = max(1, min(max(args.eval_samples, 1), max(1, len(raw) // 10)))
    split = raw.train_test_split(test_size=eval_n, seed=args.seed, shuffle=True)
    train_raw, eval_raw = split["train"], split["test"]

    def to_train(example: dict[str, Any]) -> dict[str, str]:
        return {
            "prompt": build_prompt(example["question"]),
            "answer": extract_gold(example["answer"]),
        }

    train_ds = train_raw.map(to_train, remove_columns=train_raw.column_names)
    eval_rows = [
        {
            "question": example["question"],
            "prompt": build_prompt(example["question"]),
            "answer": extract_gold(example["answer"]),
        }
        for example in eval_raw
    ]
    print(
        f"[rl_grpo] train={len(train_ds)} eval={len(eval_rows)}", file=sys.stderr
    )
    return train_ds, eval_rows


def load_model_and_tokenizer(args: argparse.Namespace, token: str | None) -> tuple[Any, Any, str]:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    dtype, dtype_name = pick_dtype(args.dtype)
    common = loader_kwargs(token)
    tokenizer = AutoTokenizer.from_pretrained(args.model, **common)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model_kwargs: dict[str, Any] = dict(common)
    if torch.cuda.is_available():
        try:
            model = AutoModelForCausalLM.from_pretrained(args.model, dtype=dtype, **model_kwargs)
        except TypeError:
            model = AutoModelForCausalLM.from_pretrained(
                args.model, torch_dtype=dtype, **model_kwargs
            )
        model.to("cuda")
    else:
        model = AutoModelForCausalLM.from_pretrained(args.model, **model_kwargs)
    model.config.use_cache = False
    return model, tokenizer, dtype_name


def build_trainer(model: Any, tokenizer: Any, train_ds: Any, args: argparse.Namespace, dtype_name: str) -> Any:
    import torch
    from trl import GRPOConfig, GRPOTrainer

    if args.batch_size % args.num_generations != 0:
        raise SystemExit(
            "[rl_grpo] --batch-size must be divisible by --num-generations "
            f"({args.batch_size} % {args.num_generations} != 0)."
        )
    is_cuda = torch.cuda.is_available()
    candidates: dict[str, Any] = {
        "output_dir": args.output_dir,
        "max_steps": args.max_steps,
        "per_device_train_batch_size": args.batch_size,
        "gradient_accumulation_steps": args.grad_accum,
        "num_generations": args.num_generations,
        "max_completion_length": args.max_completion_length,
        "max_prompt_length": args.max_prompt_length,
        "temperature": args.temperature,
        "beta": args.beta,
        "learning_rate": args.learning_rate,
        "lr_scheduler_type": args.lr_scheduler,
        "warmup_ratio": args.warmup_ratio,
        "logging_steps": args.logging_steps,
        "save_strategy": "steps",
        "save_steps": args.save_steps,
        "save_total_limit": args.save_total_limit,
        "gradient_checkpointing": args.gradient_checkpointing,
        "gradient_checkpointing_kwargs": {"use_reentrant": False},
        "bf16": is_cuda and dtype_name == "bf16",
        "fp16": is_cuda and dtype_name == "fp16",
        "report_to": args.report_to,
        "seed": args.seed,
        "remove_unused_columns": False,
        "use_vllm": False,
        "log_completions": args.log_completions,
    }
    config = GRPOConfig(**accepted_kwargs(GRPOConfig, candidates))

    trainer_params = set(inspect.signature(GRPOTrainer.__init__).parameters)
    trainer_kwargs: dict[str, Any] = {
        "model": model,
        "args": config,
        "train_dataset": train_ds,
        "reward_funcs": [correctness_reward, format_reward],
    }
    if "processing_class" in trainer_params:
        trainer_kwargs["processing_class"] = tokenizer
    elif "tokenizer" in trainer_params:
        trainer_kwargs["tokenizer"] = tokenizer
    return GRPOTrainer(**trainer_kwargs)


def save_history(trainer: Any, out_dir: Path) -> None:
    (out_dir / "trainer_log_history.json").write_text(
        json.dumps(trainer.state.log_history, indent=2, default=str), encoding="utf-8"
    )


def evaluate_greedy(
    model: Any,
    tokenizer: Any,
    rows: list[dict[str, str]],
    args: argparse.Namespace,
    out_dir: Path,
) -> dict[str, Any]:
    import torch

    model.config.use_cache = True
    device = next(model.parameters()).device
    predictions = []
    correct = 0
    started = time.time()
    for row in rows:
        inputs = tokenizer(
            row["prompt"],
            return_tensors="pt",
            truncation=True,
            max_length=args.max_prompt_length,
        ).to(device)
        with torch.no_grad():
            output = model.generate(
                **inputs,
                max_new_tokens=args.max_completion_length,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
            )
        text = tokenizer.decode(
            output[0][inputs["input_ids"].shape[1] :], skip_special_tokens=True
        ).strip()
        prediction = extract_number(text)
        is_correct = prediction is not None and prediction == row["answer"]
        correct += int(is_correct)
        predictions.append(
            {
                "question": row["question"],
                "gold": row["answer"],
                "prediction": prediction,
                "correct": is_correct,
                "completion": text[:2000],
            }
        )
    model.config.use_cache = False
    with (out_dir / "eval_predictions.jsonl").open("w", encoding="utf-8") as handle:
        for item in predictions:
            handle.write(json.dumps(item) + "\n")
    return {
        "count": len(predictions),
        "correct": correct,
        "accuracy": round(correct / len(predictions), 4) if predictions else 0.0,
        "elapsed_sec": round(time.time() - started, 1),
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args()
    started = time.time()
    set_seed(args.seed)
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")

    import torch

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    model, tokenizer, dtype_name = load_model_and_tokenizer(args, token)
    train_ds, eval_rows = load_data(token, args)
    trainer = build_trainer(model, tokenizer, train_ds, args, dtype_name)

    resume: str | bool | None = None
    if args.resume_from_checkpoint:
        value = args.resume_from_checkpoint.strip()
        resume = True if value in {"auto", "latest"} else value
    print(
        f"[rl_grpo] model={args.model} dtype={dtype_name} "
        f"generations={args.num_generations} steps={args.max_steps}",
        file=sys.stderr,
    )

    train_result = trainer.train(resume_from_checkpoint=resume)
    train_metrics = dict(getattr(train_result, "metrics", {}) or {})
    save_history(trainer, out_dir)
    trainer.save_model(str(out_dir))
    tokenizer.save_pretrained(out_dir)

    eval_metrics = evaluate_greedy(trainer.model, tokenizer, eval_rows, args, out_dir)
    (out_dir / "eval_metrics.json").write_text(
        json.dumps(eval_metrics, indent=2), encoding="utf-8"
    )

    summary = {
        "script": "rl_grpo.py",
        "model": args.model,
        "dataset": args.dataset,
        "output_dir": str(out_dir.resolve()),
        "train_samples": len(train_ds),
        "eval_samples": len(eval_rows),
        "num_generations": args.num_generations,
        "max_steps": args.max_steps,
        "global_step": int(trainer.state.global_step),
        "train_metrics": train_metrics,
        "eval": eval_metrics,
        "dtype": dtype_name,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        "elapsed_sec": round(time.time() - started, 1),
        "versions": package_versions(),
    }
    print("summary: " + json.dumps(summary, default=str))
    return 0


def package_versions() -> dict[str, str | None]:
    import importlib.metadata

    versions: dict[str, str | None] = {}
    for name in ("torch", "transformers", "trl", "datasets", "accelerate"):
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    return versions


if __name__ == "__main__":
    raise SystemExit(main())

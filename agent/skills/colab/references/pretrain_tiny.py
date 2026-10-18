#!/usr/bin/env python3
"""Pretrain a small decoder-only Transformer from scratch on a local text file.

Deliberately dependency-light: PyTorch only, byte-level tokenizer, explicit
train/val split, loss logging to JSONL, rolling checkpoints with resume,
top-k sampling from the trained model, and a final `summary: {...}` JSON line.

Usage (on a Colab VM, from /content):
    python pretrain_tiny.py --data /content/data/corpus.txt --max-steps 40   # smoke
    python pretrain_tiny.py --data /content/data/corpus.txt --max-steps 500  # run
    python pretrain_tiny.py --data ... --resume-from-checkpoint auto

The corpus is read as UTF-8 bytes, so any text file works and no vocabulary
needs to be trained. This is a small model for learning the workflow, not a
claim that tiny pretraining produces a useful assistant.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import random
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class GPTConfig:
    vocab_size: int = 256
    block_size: int = 256
    n_layer: int = 4
    n_head: int = 4
    n_embd: int = 256
    dropout: float = 0.0
    bias: bool = True


class CausalSelfAttention(nn.Module):
    def __init__(self, config: GPTConfig) -> None:
        super().__init__()
        self.n_head = config.n_head
        self.n_embd = config.n_embd
        self.c_attn = nn.Linear(config.n_embd, 3 * config.n_embd, bias=config.bias)
        self.c_proj = nn.Linear(config.n_embd, config.n_embd, bias=config.bias)
        self.attn_dropout = nn.Dropout(config.dropout)
        self.resid_dropout = nn.Dropout(config.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        batch, seq_len, channels = x.shape
        q, k, v = self.c_attn(x).split(self.n_embd, dim=2)
        head_size = channels // self.n_head
        q = q.view(batch, seq_len, self.n_head, head_size).transpose(1, 2)
        k = k.view(batch, seq_len, self.n_head, head_size).transpose(1, 2)
        v = v.view(batch, seq_len, self.n_head, head_size).transpose(1, 2)
        y = F.scaled_dot_product_attention(
            q,
            k,
            v,
            dropout_p=self.attn_dropout.p if self.training else 0.0,
            is_causal=True,
        )
        y = y.transpose(1, 2).contiguous().view(batch, seq_len, channels)
        return self.resid_dropout(self.c_proj(y))


class MLP(nn.Module):
    def __init__(self, config: GPTConfig) -> None:
        super().__init__()
        self.c_fc = nn.Linear(config.n_embd, 4 * config.n_embd, bias=config.bias)
        self.gelu = nn.GELU()
        self.c_proj = nn.Linear(4 * config.n_embd, config.n_embd, bias=config.bias)
        self.dropout = nn.Dropout(config.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.dropout(self.c_proj(self.gelu(self.c_fc(x))))


class Block(nn.Module):
    def __init__(self, config: GPTConfig) -> None:
        super().__init__()
        self.ln_1 = nn.LayerNorm(config.n_embd, bias=config.bias)
        self.attn = CausalSelfAttention(config)
        self.ln_2 = nn.LayerNorm(config.n_embd, bias=config.bias)
        self.mlp = MLP(config)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln_1(x))
        return x + self.mlp(self.ln_2(x))


class GPT(nn.Module):
    def __init__(self, config: GPTConfig) -> None:
        super().__init__()
        self.config = config
        self.transformer = nn.ModuleDict(
            {
                "wte": nn.Embedding(config.vocab_size, config.n_embd),
                "wpe": nn.Embedding(config.block_size, config.n_embd),
                "drop": nn.Dropout(config.dropout),
                "h": nn.ModuleList([Block(config) for _ in range(config.n_layer)]),
                "ln_f": nn.LayerNorm(config.n_embd, bias=config.bias),
            }
        )
        self.lm_head = nn.Linear(config.n_embd, config.vocab_size, bias=False)
        self.transformer["wte"].weight = self.lm_head.weight  # weight tying
        self.apply(self._init_weights)
        for name, param in self.named_parameters():
            if name.endswith("c_proj.weight"):
                nn.init.normal_(
                    param, mean=0.0, std=0.02 / math.sqrt(2 * config.n_layer)
                )

    @staticmethod
    def _init_weights(module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def forward(
        self, idx: torch.Tensor, targets: torch.Tensor | None = None
    ) -> tuple[torch.Tensor, torch.Tensor | None]:
        batch, seq_len = idx.shape
        if seq_len > self.config.block_size:
            raise ValueError(
                f"sequence length {seq_len} exceeds block size {self.config.block_size}"
            )
        positions = torch.arange(seq_len, device=idx.device)
        x = self.transformer["drop"](self.transformer["wte"](idx) + self.transformer["wpe"](positions))
        for block in self.transformer["h"]:
            x = block(x)
        x = self.transformer["ln_f"](x)
        logits = self.lm_head(x)
        loss = None
        if targets is not None:
            loss = F.cross_entropy(
                logits.view(-1, logits.size(-1)), targets.view(-1), ignore_index=-1
            )
        return logits, loss

    @torch.no_grad()
    def generate(
        self,
        idx: torch.Tensor,
        max_new_tokens: int,
        temperature: float = 0.8,
        top_k: int = 40,
    ) -> torch.Tensor:
        self.eval()
        for _ in range(max_new_tokens):
            idx_cond = idx[:, -self.config.block_size :]
            logits, _ = self(idx_cond)
            logits = logits[:, -1, :] / max(temperature, 1e-6)
            if top_k > 0:
                k = min(top_k, logits.size(-1))
                values, _ = torch.topk(logits, k)
                logits[logits < values[:, [-1]]] = float("-inf")
            probs = F.softmax(logits, dim=-1)
            next_token = torch.multinomial(probs, num_samples=1)
            idx = torch.cat((idx, next_token), dim=1)
        return idx


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pretrain a small byte-level GPT on a local text file.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--data", required=True, help="Local text corpus path.")
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=5_000_000,
        help="Corpus prefix to use; -1 for the whole file.",
    )
    parser.add_argument("--output-dir", default="runs/tiny_pretrain")
    parser.add_argument("--val-fraction", type=float, default=0.1)
    parser.add_argument("--block-size", type=int, default=256)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--max-steps", type=int, default=400)
    parser.add_argument("--eval-interval", type=int, default=50)
    parser.add_argument("--eval-iters", type=int, default=10)
    parser.add_argument("--save-interval", type=int, default=0, help="0 follows eval-interval.")
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--min-lr-ratio", type=float, default=0.1)
    parser.add_argument("--warmup-steps", type=int, default=20)
    parser.add_argument("--weight-decay", type=float, default=0.1)
    parser.add_argument("--beta1", type=float, default=0.9)
    parser.add_argument("--beta2", type=float, default=0.95)
    parser.add_argument("--grad-clip", type=float, default=1.0)
    parser.add_argument("--n-layer", type=int, default=4)
    parser.add_argument("--n-head", type=int, default=4)
    parser.add_argument("--n-embd", type=int, default=256)
    parser.add_argument("--dropout", type=float, default=0.0)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda", "mps"], default="auto")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--sample-tokens", type=int, default=200)
    parser.add_argument("--sample-prompt", default="Once upon a time")
    parser.add_argument(
        "--resume-from-checkpoint",
        default=None,
        help="Checkpoint path, or auto/latest for <output-dir>/ckpt.pt.",
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
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def pick_device(name: str) -> torch.device:
    if name == "auto":
        if torch.cuda.is_available():
            return torch.device("cuda")
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")
    return torch.device(name)


def load_corpus(path: str, max_bytes: int) -> bytes:
    raw = Path(path).read_bytes()
    if max_bytes >= 0:
        raw = raw[:max_bytes]
    if len(raw) < 1000:
        raise SystemExit(f"[pretrain_tiny] corpus too small: {len(raw)} bytes")
    return raw


def split_tokens(raw: bytes, val_fraction: float) -> tuple[torch.Tensor, torch.Tensor]:
    # Byte-level: one token per byte. Keeping uint8 avoids 8x memory for int64.
    tokens = torch.frombuffer(bytearray(raw), dtype=torch.uint8).clone()
    split = int(len(tokens) * (1.0 - val_fraction))
    train = tokens[:split]
    val = tokens[split:]
    if len(train) < 2 or len(val) < 2:
        raise SystemExit("[pretrain_tiny] corpus is too short for this --val-fraction")
    return train, val


def get_batch(
    data: torch.Tensor,
    batch_size: int,
    block_size: int,
    device: torch.device,
    generator: torch.Generator,
) -> tuple[torch.Tensor, torch.Tensor]:
    max_start = len(data) - block_size - 1
    if max_start < 1:
        raise SystemExit(
            "[pretrain_tiny] corpus shorter than --block-size + 2; lower --block-size"
        )
    starts = torch.randint(0, max_start, (batch_size,), generator=generator)
    x = torch.stack([data[start : start + block_size] for start in starts]).long()
    y = torch.stack([data[start + 1 : start + 1 + block_size] for start in starts]).long()
    return x.to(device, non_blocking=True), y.to(device, non_blocking=True)


def eval_loss(
    model: GPT,
    data: torch.Tensor,
    batch_size: int,
    block_size: int,
    eval_iters: int,
    device: torch.device,
    seed: int,
) -> float:
    model.eval()
    generator = torch.Generator().manual_seed(seed)
    losses = []
    with torch.no_grad():
        for _ in range(eval_iters):
            x, y = get_batch(data, batch_size, block_size, device, generator)
            _, loss = model(x, y)
            if loss is not None:
                losses.append(loss.item())
    model.train()
    return sum(losses) / len(losses) if losses else float("nan")


def configure_optimizer(model: GPT, args: argparse.Namespace) -> torch.optim.Optimizer:
    decay, no_decay = [], []
    for name, param in model.named_parameters():
        if not param.requires_grad:
            continue
        if param.dim() >= 2:
            decay.append(param)
        else:
            no_decay.append(param)
    groups = [
        {"params": decay, "weight_decay": args.weight_decay},
        {"params": no_decay, "weight_decay": 0.0},
    ]
    return torch.optim.AdamW(
        groups,
        lr=args.learning_rate,
        betas=(args.beta1, args.beta2),
        eps=1e-8,
    )


def lr_at_step(step: int, args: argparse.Namespace) -> float:
    if step < args.warmup_steps:
        return args.learning_rate * (step + 1) / max(1, args.warmup_steps)
    if step >= args.max_steps:
        return args.learning_rate * args.min_lr_ratio
    progress = (step - args.warmup_steps) / max(1, args.max_steps - args.warmup_steps)
    cosine = 0.5 * (1.0 + math.cos(math.pi * progress))
    return args.learning_rate * (args.min_lr_ratio + (1 - args.min_lr_ratio) * cosine)


def save_checkpoint(
    path: Path,
    model: GPT,
    optimizer: torch.optim.Optimizer,
    step: int,
    best_val_loss: float,
    config: GPTConfig,
    args: argparse.Namespace,
) -> None:
    torch.save(
        {
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "step": step,
            "best_val_loss": best_val_loss,
            "config": asdict(config),
            "args": vars(args),
        },
        path,
    )


def main(argv: list[str] | None = None) -> int:
    args = parse_args()
    started = time.time()
    set_seed(args.seed)

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = out_dir / "metrics.jsonl"

    raw = load_corpus(args.data, args.max_bytes)
    train_data, val_data = split_tokens(raw, args.val_fraction)
    if args.eval_interval < 1 or args.save_interval < 0:
        raise SystemExit("[pretrain_tiny] --eval-interval must be >= 1")
    if len(train_data) < args.block_size + 2 or len(val_data) < args.block_size + 2:
        raise SystemExit(
            "[pretrain_tiny] train/val split is shorter than --block-size + 2; "
            "lower --block-size, raise --max-bytes or lower --val-fraction"
        )
    device = pick_device(args.device)
    generator = torch.Generator().manual_seed(args.seed)

    config = GPTConfig(
        vocab_size=256,
        block_size=args.block_size,
        n_layer=args.n_layer,
        n_head=args.n_head,
        n_embd=args.n_embd,
        dropout=args.dropout,
    )
    if config.n_embd % config.n_head != 0:
        raise SystemExit("[pretrain_tiny] --n-embd must be divisible by --n-head")
    model = GPT(config).to(device)
    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    optimizer = configure_optimizer(model, args)

    start_step = 0
    best_val_loss = float("inf")
    resume = args.resume_from_checkpoint
    if resume and resume.strip().lower() in {"auto", "latest"}:
        resume = str(out_dir / "ckpt.pt")
    if resume:
        try:
            checkpoint = torch.load(resume, map_location=device, weights_only=False)
        except TypeError:  # PyTorch before weights_only was added
            checkpoint = torch.load(resume, map_location=device)
        model.load_state_dict(checkpoint["model"])
        optimizer.load_state_dict(checkpoint["optimizer"])
        start_step = int(checkpoint.get("step", 0))
        best_val_loss = float(checkpoint.get("best_val_loss", float("inf")))
        print(f"[pretrain_tiny] resumed {resume} at step {start_step}", file=sys.stderr)

    is_cuda = device.type == "cuda"
    amp_dtype = (
        torch.bfloat16
        if is_cuda and torch.cuda.is_bf16_supported()
        else torch.float16
        if is_cuda
        else None
    )
    amp_enabled = is_cuda and amp_dtype is not None
    want_scaler = amp_enabled and amp_dtype == torch.float16
    try:
        scaler: Any = torch.amp.GradScaler("cuda", enabled=want_scaler)
    except (AttributeError, TypeError):
        scaler = torch.cuda.amp.GradScaler(enabled=want_scaler)

    print(
        f"[pretrain_tiny] tokens={len(train_data) + len(val_data)} train={len(train_data)} "
        f"val={len(val_data)} params={parameter_count} device={device} "
        f"dtype={amp_dtype if amp_enabled else torch.float32}",
        file=sys.stderr,
    )

    def autocast() -> Any:
        if amp_enabled:
            return torch.amp.autocast("cuda", dtype=amp_dtype)
        return contextlib.nullcontext()

    save_interval = args.save_interval or args.eval_interval
    tokens_per_step = args.batch_size * args.grad_accum * args.block_size
    metrics_path.write_text("", encoding="utf-8")
    model.train()
    step = start_step
    train_loss = float("nan")
    last_lr = args.learning_rate

    while step < args.max_steps:
        last_lr = lr_at_step(step, args)
        for group in optimizer.param_groups:
            group["lr"] = last_lr
        optimizer.zero_grad(set_to_none=True)
        step_started = time.time()
        for _ in range(args.grad_accum):
            x, y = get_batch(
                train_data, args.batch_size, args.block_size, device, generator
            )
            with autocast():
                _, loss = model(x, y)
                if loss is None:
                    raise SystemExit("[pretrain_tiny] model returned no loss")
                scaled_loss = loss / args.grad_accum
            scaler.scale(scaled_loss).backward()
            train_loss = loss.item()

        if want_scaler:
            scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip)
        scaler.step(optimizer)
        scaler.update()
        step += 1

        if step % args.eval_interval == 0 or step == args.max_steps:
            val = eval_loss(
                model,
                val_data,
                args.batch_size,
                args.block_size,
                args.eval_iters,
                device,
                args.seed + 1,
            )
            record = {
                "step": step,
                "train_loss": round(train_loss, 6),
                "val_loss": round(val, 6),
                "lr": round(last_lr, 8),
                "tokens_seen": step * tokens_per_step,
                "elapsed_sec": round(time.time() - started, 1),
            }
            with metrics_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record) + "\n")
            print(f"[pretrain_tiny] {json.dumps(record)}", file=sys.stderr)
            if val < best_val_loss:
                best_val_loss = val
                save_checkpoint(
                    out_dir / "ckpt_best.pt",
                    model,
                    optimizer,
                    step,
                    best_val_loss,
                    config,
                    args,
                )
            if step % save_interval == 0 or step == args.max_steps:
                save_checkpoint(
                    out_dir / "ckpt.pt",
                    model,
                    optimizer,
                    step,
                    best_val_loss,
                    config,
                    args,
                )
        elif step % save_interval == 0:
            save_checkpoint(
                out_dir / "ckpt.pt",
                model,
                optimizer,
                step,
                best_val_loss,
                config,
                args,
            )
        if step % args.eval_interval == 0:
            print(
                f"[pretrain_tiny] step {step}/{args.max_steps} "
                f"loss {train_loss:.4f} lr {last_lr:.2e} "
                f"({time.time() - step_started:.1f}s/step-block)",
                file=sys.stderr,
            )

    save_checkpoint(
        out_dir / "ckpt.pt",
        model,
        optimizer,
        step,
        best_val_loss,
        config,
        args,
    )
    final_val = eval_loss(
        model,
        val_data,
        args.batch_size,
        args.block_size,
        args.eval_iters,
        device,
        args.seed + 1,
    )

    prompt_bytes = args.sample_prompt.encode("utf-8") or b"\n"
    prompt = torch.tensor([list(prompt_bytes)], dtype=torch.long, device=device)
    generated = model.generate(
        prompt,
        max_new_tokens=args.sample_tokens,
        temperature=0.8,
        top_k=40,
    )
    generated_bytes = bytes(int(token) for token in generated[0].tolist())
    sample_text = generated_bytes.decode("utf-8", errors="replace")
    (out_dir / "samples.txt").write_text(
        f"PROMPT\n{args.sample_prompt}\n\nSAMPLE\n{sample_text}\n", encoding="utf-8"
    )

    summary = {
        "script": "pretrain_tiny.py",
        "output_dir": str(out_dir.resolve()),
        "data": args.data,
        "corpus_bytes_used": len(raw),
        "train_tokens": len(train_data),
        "val_tokens": len(val_data),
        "parameters": parameter_count,
        "steps": step,
        "tokens_seen": step * tokens_per_step,
        "final_val_loss": round(final_val, 6),
        "best_val_loss": round(best_val_loss, 6),
        "device": str(device),
        "dtype": str(amp_dtype) if amp_enabled else "float32",
        "elapsed_sec": round(time.time() - started, 1),
        "checkpoints": sorted(
            path.name for path in out_dir.glob("ckpt*.pt")
        ),
    }
    print("summary: " + json.dumps(summary))
    print(f"[pretrain_tiny] sample:\n{sample_text[:500]}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

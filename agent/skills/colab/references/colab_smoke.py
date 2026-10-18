#!/usr/bin/env python3
"""Smoke-test a Google Colab runtime and print one JSON report.

Run this before any training job. It answers: which Python and OS, is CUDA
usable and on which device, how much GPU/CPU/RAM/disk is available, are the
packages an ML run needs installed, does a small matmul work, and is a Hugging
Face token present in the environment (presence only, never its value).

Usage:
    python colab_smoke.py
    python colab_smoke.py --require-cuda    # exits 1 when no CUDA device exists
    python colab_smoke.py --pretty

The exit status is 0 unless --require-cuda was given and CUDA is unavailable,
or --require-cuda was given and the compute benchmark fails on the GPU.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import shutil
import statistics
import sys
import tempfile
import time
from typing import Any

PACKAGES = [
    "torch",
    "torchvision",
    "torchaudio",
    "transformers",
    "datasets",
    "accelerate",
    "peft",
    "trl",
    "bitsandbytes",
    "tokenizers",
    "sentencepiece",
    "safetensors",
    "huggingface_hub",
    "jax",
    "jaxlib",
    "numpy",
    "pandas",
    "scipy",
    "scikit-learn",
    "psutil",
]

SECRET_ENV_VARS = [
    "HF_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
    "WANDB_API_KEY",
    "HF_HUB_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
]


def package_versions(names: list[str]) -> dict[str, str | None]:
    versions: dict[str, str | None] = {}
    for name in names:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
        except Exception:  # malformed dist metadata should not hide the rest
            versions[name] = "unreadable"
    return versions


def total_ram_bytes() -> int | None:
    if sys.platform.startswith("linux"):
        try:
            with open("/proc/meminfo", "r", encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("MemTotal:"):
                        return int(line.split()[1]) * 1024
        except OSError:
            return None
    try:
        import psutil  # type: ignore

        return int(psutil.virtual_memory().total)
    except Exception:
        return None


def content_disk_report() -> dict[str, Any]:
    report: dict[str, Any] = {"path": "/content", "exists": os.path.isdir("/content")}
    path = "/content" if report["exists"] else os.getcwd()
    try:
        usage = shutil.disk_usage(path)
        report.update(
            {
                "checked_path": path,
                "total_bytes": usage.total,
                "free_bytes": usage.free,
                "used_bytes": usage.used,
            }
        )
    except OSError as exc:
        report["error"] = str(exc)
    # A write test is the only useful signal: the mount can exist but be read-only.
    try:
        target_dir = "/content" if report["exists"] else tempfile.gettempdir()
        with tempfile.NamedTemporaryFile(
            dir=target_dir, prefix=".colab_smoke_", delete=True
        ) as handle:
            handle.write(b"smoke")
            handle.flush()
        report["writable"] = True
    except OSError as exc:
        report["writable"] = False
        report["write_error"] = str(exc)
    return report


def torch_report() -> dict[str, Any]:
    report: dict[str, Any] = {"importable": False}
    try:
        import torch
    except Exception as exc:
        report["import_error"] = f"{type(exc).__name__}: {exc}"
        return report

    report["importable"] = True
    report["version"] = torch.__version__
    report["cuda_available"] = bool(torch.cuda.is_available())
    report["cuda_version"] = getattr(torch.version, "cuda", None)
    report["cudnn_version"] = (
        torch.backends.cudnn.version() if torch.backends.cudnn.is_available() else None
    )
    report["mps_available"] = bool(
        getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()
    )
    report["device_count"] = torch.cuda.device_count()

    devices = []
    for index in range(torch.cuda.device_count()):
        try:
            props = torch.cuda.get_device_properties(index)
            free_bytes, total_bytes = torch.cuda.mem_get_info(index)
            devices.append(
                {
                    "index": index,
                    "name": props.name,
                    "capability": f"{props.major}.{props.minor}",
                    "total_memory_bytes": int(total_bytes),
                    "free_memory_bytes": int(free_bytes),
                    "multi_processor_count": props.multi_processor_count,
                }
            )
        except Exception as exc:
            devices.append({"index": index, "error": f"{type(exc).__name__}: {exc}"})
    report["devices"] = devices

    if report["cuda_available"]:
        try:
            report["bf16_supported"] = bool(torch.cuda.is_bf16_supported())
        except Exception:
            report["bf16_supported"] = None
    else:
        report["bf16_supported"] = None
    return report


def matmul_benchmark() -> dict[str, Any]:
    """Time warm float32 1024x1024 matmuls; small enough to be a liveness check."""
    result: dict[str, Any] = {"ran": False}
    try:
        import torch
    except Exception as exc:
        result["error"] = f"torch unavailable: {type(exc).__name__}: {exc}"
        return result
    if not torch.cuda.is_available():
        result["skipped"] = "no CUDA device"
        return result
    try:
        device = torch.device("cuda:0")
        a = torch.randn(1024, 1024, device=device, dtype=torch.float32)
        b = torch.randn(1024, 1024, device=device, dtype=torch.float32)
        for _ in range(2):  # warm up clocks and allocator
            a @ b
        torch.cuda.synchronize()
        timings = []
        for _ in range(5):
            start = time.perf_counter()
            a @ b
            torch.cuda.synchronize()
            timings.append(time.perf_counter() - start)
        result.update(
            {
                "ran": True,
                "device": torch.cuda.get_device_name(0),
                "median_ms": round(statistics.median(timings) * 1000, 3),
                "min_ms": round(min(timings) * 1000, 3),
            }
        )
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    return result


def env_report() -> dict[str, Any]:
    report: dict[str, Any] = {
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "cpu_count": os.cpu_count(),
        "cwd": os.getcwd(),
        "colab_env": {
            key: os.environ[key] for key in sorted(os.environ) if key.startswith("COLAB_")
        },
        "secret_presence": {
            key: bool(os.environ.get(key)) for key in SECRET_ENV_VARS
        },
    }
    report["total_ram_bytes"] = total_ram_bytes()
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report Colab runtime, GPU, memory, disk and package state as JSON."
    )
    parser.add_argument(
        "--require-cuda",
        action="store_true",
        help="Exit non-zero when no CUDA device is available.",
    )
    parser.add_argument(
        "--require-package",
        action="append",
        default=[],
        metavar="NAME",
        help="Exit non-zero when this package is not importable/installed. Repeatable.",
    )
    parser.add_argument(
        "--skip-benchmark",
        action="store_true",
        help="Skip the GPU matmul liveness benchmark.",
    )
    parser.add_argument(
        "--pretty", action="store_true", help="Indent the JSON output for reading."
    )
    args = parser.parse_args(argv)

    code: int = 0
    torch_info = torch_report()
    report: dict[str, Any] = {
        "ok": True,
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runtime": env_report(),
        "disk": content_disk_report(),
        "torch": torch_info,
        "packages": package_versions(PACKAGES),
        "benchmark": (
            {"skipped": "--skip-benchmark"} if args.skip_benchmark else matmul_benchmark()
        ),
    }

    failures: list[str] = []
    if args.require_cuda and not torch_info.get("cuda_available"):
        failures.append("CUDA is not available")
    if args.require_cuda:
        benchmark = report["benchmark"]
        if not benchmark.get("ran") and not benchmark.get("skipped"):
            failures.append(f"GPU benchmark did not run: {benchmark.get('error', 'unknown')}")

    missing_packages = [
        name
        for name in args.require_package
        if report["packages"].get(name) is None
    ]
    if missing_packages:
        failures.append("missing packages: " + ", ".join(missing_packages))

    report["failures"] = failures
    report["ok"] = not failures
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    if failures:
        for failure in failures:
            print(f"[colab_smoke] failed: {failure}", file=sys.stderr)
        code = 1
    return code


if __name__ == "__main__":
    raise SystemExit(main())

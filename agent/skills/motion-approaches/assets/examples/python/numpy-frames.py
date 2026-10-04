#!/usr/bin/env python3
"""Procedural frames with numpy, piped straight into FFmpeg: no browser, no GPU, no intermediate PNGs.

    python3 numpy-frames.py out.mp4 [--seconds 6] [--fps 30] [--size 1280x720] [--bg "#10181c" --a "#e9a63d" --b "#35c9b0" --ink "#eef2f0"]

APPROACH  every frame is a vectorised function of t over the whole pixel grid; frames stream to ffmpeg's stdin as raw RGB
CONCEPTS  1) a field of moving charges: V(x, y, t) = sum(q_i / r_i); the picture is the potential, drawn as banded isolines and a soft fill
          2) loop by construction: charges orbit with integer numbers of turns per clip, so the last frame leads into the first
          3) palette lookup (a 256-entry LUT built from the film's colours) turns the scalar field into colour in one indexing step
          4) ordered dithering (8x8 Bayer) before 8-bit quantisation removes banding in smooth gradients at no visible cost
          5) throughput: a 1280x720 frame takes ~40 ms, so a 6 s clip renders in about 8 s; use this route for data-heavy or math-heavy
             visuals where a browser page would spend its time in JavaScript loops
"""
import argparse
import math
import subprocess
import sys

import numpy as np

p = argparse.ArgumentParser()
p.add_argument("out"); p.add_argument("--seconds", type=float, default=6); p.add_argument("--fps", type=int, default=30); p.add_argument("--size", default="1280x720")
p.add_argument("--bg", default="#0d1512"); p.add_argument("--a", default="#d6e35a"); p.add_argument("--b", default="#3f7a58"); p.add_argument("--ink", default="#f1f4e6")
args = p.parse_args()
W, H = (int(v) for v in args.size.split("x")); N = int(round(args.seconds * args.fps))
rgb = lambda h: np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)
bg, A, B, ink = rgb(args.bg), rgb(args.a), rgb(args.b), rgb(args.ink)
# palette LUT: background -> B -> A -> ink, eased, so low field values stay quiet and only peaks reach the bright colours
stops = np.array([bg, bg * 0.6 + B * 0.4, B, A, ink]); pos = np.array([0, 0.28, 0.55, 0.82, 1.0])
x = np.linspace(0, 1, 256, dtype=np.float32); lut = np.stack([np.interp(x, pos, stops[:, c]) for c in range(3)], axis=1)
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32); xx = (xx - W / 2) / H; yy = (yy - H / 2) / H
bayer = np.array([[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22], [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25], [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]], dtype=np.float32) / 64 - 0.5
dither = np.tile(bayer, (H // 8 + 1, W // 8 + 1))[:H, :W]
rng = np.random.default_rng(7)                               # fixed seed: the same clip every run
charges = [(rng.uniform(0.15, 0.5), rng.integers(1, 3) * rng.choice([-1, 1]), rng.uniform(0, 2 * math.pi), rng.uniform(0.7, 1.3)) for _ in range(7)]
proc = subprocess.Popen(["ffmpeg", "-hide_banner", "-nostdin", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(args.fps), "-i", "-", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", args.out], stdin=subprocess.PIPE)
for frame in range(N):
    t = frame / N                                            # 0..1 over the clip, never reaching 1: a seamless loop
    field = np.zeros((H, W), dtype=np.float32)
    for radius, turns, phase, q in charges:
        cx, cy = radius * math.cos(2 * math.pi * turns * t + phase), radius * math.sin(2 * math.pi * turns * t + phase) * 0.7
        field += q * 0.03 / np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2 + 0.002)
    v = np.clip(field / 1.4, 0, 1)
    s = v * 14; gy, gx = np.gradient(s); near = np.minimum(s - np.floor(s), np.ceil(s) - s) / (np.hypot(gx, gy) + 1e-4)   # distance to the nearest isoline, in pixels
    lines = np.clip(1.6 - near, 0, 1)                                    # isolines of the potential, one anti-aliased pixel-width line each
    idx = np.clip((v ** 0.8) * 255 + dither * 3, 0, 255).astype(np.uint8)
    img = lut[idx]; img = img * (1 - 0.45 * lines[..., None]) + ink * (0.45 * lines[..., None])
    proc.stdin.write(np.clip(img + dither[..., None] * 2, 0, 255).astype(np.uint8).tobytes())
proc.stdin.close(); sys.exit(proc.wait())

#!/usr/bin/env python3
"""Measure an audio file into the JSON the audio-reactive page reads.

    python3 extract-envelope.py music.wav > envelope.json

Five band energies (sub, bass, low-mid, mid, high) and a spectral-flux onset track, 60 samples
per second, each normalised to 0..1 by the 5th/95th percentile so quiet and loud sources both
use the full range. Decoding goes through ffmpeg (any input FFmpeg reads); analysis is numpy.
Deterministic: the same file always gives the same JSON, so renders are reproducible.
"""
import json, subprocess, sys
import numpy as np

SR, FPS = 22050, 60
EDGES = [20, 60, 250, 1000, 4000, 10000]          # Hz: sub | bass | low-mid | mid | high

def main(path):
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    x = np.frombuffer(pcm, dtype="<f4")
    if x.size < SR // 10:
        raise SystemExit("audio is too short to analyse")
    hop, size = SR // FPS, 2048
    window = np.hanning(size)
    freqs = np.fft.rfftfreq(size, 1 / SR)
    bins = [np.where((freqs >= lo) & (freqs < hi))[0] for lo, hi in zip(EDGES[:-1], EDGES[1:])]
    frames = max(1, (x.size - size) // hop + 1)
    mags = np.empty((frames, freqs.size), dtype=np.float32)
    for i in range(frames):                        # one windowed FFT per output sample
        mags[i] = np.abs(np.fft.rfft(x[i * hop:i * hop + size] * window))
    bands = np.stack([np.log1p(60 * mags[:, b].mean(axis=1)) for b in bins])
    flux = np.maximum(0, np.diff(np.log1p(30 * mags), axis=0, prepend=np.log1p(30 * mags[:1]))).sum(axis=1)
    def norm(v):
        lo, hi = np.percentile(v, 5), np.percentile(v, 95)
        return np.clip((v - lo) / max(hi - lo, 1e-9), 0, 1)
    onset = norm(flux)
    peaks = np.zeros_like(onset)
    for i in range(1, onset.size - 1):             # local maxima above a threshold, at least 100 ms apart
        if onset[i] > 0.6 and onset[i] >= onset[i - 1] and onset[i] > onset[i + 1] and not peaks[max(0, i - 6):i].any():
            peaks[i] = 1
    json.dump({"fps": FPS, "seconds": round(frames / FPS, 3), "bands": [np.round(norm(b), 3).tolist() for b in bands], "onset": peaks.astype(int).tolist(), "source": path}, sys.stdout, separators=(",", ":"))

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])

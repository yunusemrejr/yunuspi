#!/usr/bin/env python3
"""Deterministic procedural music beds and sound effects for code-first video.

Usage: synth.py SPEC.json OUTPUT.wav
Spec kinds:
  {"kind":"music","seconds":30,"bpm":84,"key":"D","mode":"minor",
   "progression":["i","VI","III","VII"],"barsPerChord":2,
   "layers":{"pad":0.5,"bass":0.35,"pulse":0.22,"bell":0.12},
   "intensity":[[0,0.35],[12,0.8],[26,0.4]],"seed":7}
  {"kind":"sfx","type":"whoosh|riser|impact|tick|chime","seconds":0.8,"seed":3,"pitch":1.0}
Output: 48 kHz 16-bit stereo WAV. Numpy only; every random choice is seeded.
"""
import json
import sys
import wave

import numpy as np

SR = 48000
NOTES = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6,
         "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
SCALES = {"major": [0, 2, 4, 5, 7, 9, 11], "minor": [0, 2, 3, 5, 7, 8, 10], "dorian": [0, 2, 3, 5, 7, 9, 10]}
ROMAN = {"i": 0, "ii": 1, "iii": 2, "iv": 3, "v": 4, "vi": 5, "vii": 6}


def fail(message):
    raise SystemExit(f"synth: {message}")


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def lowpass(x, cutoff):
    """One-pole low-pass; cutoff may be a per-sample array."""
    cutoff = np.broadcast_to(np.asarray(cutoff, dtype=np.float64), x.shape)
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = (1 - a[i]) * x[i] + a[i] * acc
        y[i] = acc
    return y


def lowpass_fast(x, cutoff):
    """Constant-cutoff one-pole low-pass (scipy when present, exact loop otherwise)."""
    a = float(np.exp(-2 * np.pi * cutoff / SR))
    try:
        from scipy.signal import lfilter
        return lfilter([1 - a], [1, -a], x)
    except ImportError:
        return lowpass(x, cutoff)


def highpass(x, cutoff=35.0):
    """Removes DC and sub-rumble that muddies narration and wastes headroom."""
    return x - lowpass_fast(x, cutoff)


def envelope(n, attack, release, sustain=1.0):
    env = np.full(n, sustain)
    a = min(n, int(attack * SR))
    r = min(n - a, int(release * SR))
    if a:
        env[:a] = np.linspace(0, sustain, a)
    if r:
        env[n - r:] = np.linspace(sustain, 0, r) ** 1.5
    return env


def reverb(x, mix=0.25, size=1.0):
    """Small Schroeder reverb: parallel combs then series all-passes."""
    out = np.zeros(len(x) + SR * 2)
    for delay, gain in ((1557, 0.84), (1617, 0.83), (1491, 0.82), (1422, 0.81)):
        d = int(delay * size * SR / 44100)
        buf = np.zeros(len(out))
        buf[:len(x)] += x
        for start in range(d, len(buf), d):
            end = min(len(buf), start + d)
            buf[start:end] += gain * buf[start - d:end - d]
        out += buf * 0.25
    for delay, gain in ((225, 0.7), (556, 0.7)):
        d = int(delay * SR / 44100)
        y = np.copy(out)
        for start in range(d, len(out), d):
            end = min(len(out), start + d)
            y[start:end] = -gain * out[start:end] + out[start - d:end - d] + gain * y[start - d:end - d]
        out = y
    wet = out[:len(x)]
    return (1 - mix) * x + mix * wet / (np.max(np.abs(wet)) + 1e-9) * np.max(np.abs(x) + 1e-9)


def chord_notes(key, mode, numeral):
    scale = SCALES[mode]
    degree = ROMAN.get(numeral.lower().rstrip("7"))
    if degree is None:
        fail(f"unknown numeral {numeral}")
    root = 48 + NOTES[key]
    return [root + scale[(degree + step) % 7] + 12 * ((degree + step) // 7) for step in (0, 2, 4)]


def automation(points, n):
    if not points:
        return np.ones(n)
    times = np.array([p[0] for p in points], dtype=float) * SR
    values = np.array([p[1] for p in points], dtype=float)
    return np.interp(np.arange(n), times, values)


def music(spec, rng):
    seconds = float(spec.get("seconds", 30))
    if not 1 <= seconds <= 600:
        fail("seconds must be 1..600")
    n = int(seconds * SR)
    bpm = float(spec.get("bpm", 84))
    key, mode = spec.get("key", "D"), spec.get("mode", "minor")
    if key not in NOTES or mode not in SCALES:
        fail("key/mode unsupported")
    progression = spec.get("progression", ["i", "VI", "III", "VII"])
    bar = 4 * 60 / bpm
    chord_len = bar * float(spec.get("barsPerChord", 2))
    layers = {"pad": 0.5, "bass": 0.35, "pulse": 0.22, "bell": 0.12, **spec.get("layers", {})}
    t = np.arange(n) / SR
    left, right = np.zeros(n), np.zeros(n)
    intensity = automation(spec.get("intensity"), n)
    chords = int(np.ceil(seconds / chord_len))
    for c in range(chords):
        notes = chord_notes(key, mode, progression[c % len(progression)])
        start = int(c * chord_len * SR)
        length = min(n - start, int(chord_len * SR) + int(0.8 * SR))
        if length <= 0:
            break
        seg_t = np.arange(length) / SR
        env = envelope(length, 1.2, 1.4)
        if layers["pad"]:
            pad_l, pad_r = np.zeros(length), np.zeros(length)
            for note in notes + [notes[0] + 12]:
                for detune, pan in ((-0.07, 0.8), (0.07, 0.2), (0.0, 0.5)):
                    f = hz(note + detune)
                    phase = rng.uniform(0, 2 * np.pi)
                    tone = 2 / np.pi * np.arcsin(np.sin(2 * np.pi * f * seg_t + phase))
                    pad_l += tone * pan
                    pad_r += tone * (1 - pan)
            pad = layers["pad"] * env / (len(notes) * 3)
            end = min(n, start + length)
            left[start:end] += (pad_l * pad)[:end - start]
            right[start:end] += (pad_r * pad)[:end - start]
        if layers["bass"]:
            f = hz(notes[0] - 12)
            bass = (np.sin(2 * np.pi * f * seg_t) + 0.3 * np.sin(4 * np.pi * f * seg_t)) * envelope(length, 0.05, 0.6) * layers["bass"] * 0.3
            end = min(n, start + length)
            left[start:end] += bass[:end - start]
            right[start:end] += bass[:end - start]
    step = 60 / bpm / 2
    if layers["pulse"]:
        pattern = [0, 1, 2, 1, 0, 2, 1, 2]
        for k in range(int(seconds / step)):
            c = int(k * step / chord_len)
            notes = chord_notes(key, mode, progression[c % len(progression)])
            note = notes[pattern[k % len(pattern)]] + 12
            start = int(k * step * SR)
            length = min(n - start, int(0.45 * SR))
            seg_t = np.arange(length) / SR
            pluck = np.sin(2 * np.pi * hz(note) * seg_t) * np.exp(-seg_t * 9) * layers["pulse"] * (0.7 + 0.3 * rng.random())
            pan = 0.5 + 0.35 * np.sin(k * 0.7)
            left[start:start + length] += pluck * pan
            right[start:start + length] += pluck * (1 - pan)
    if layers["bell"]:
        k = 0.0
        while k < seconds - 2:
            k += rng.choice([2, 3, 4]) * bar / 2
            c = int(k / chord_len)
            note = rng.choice(chord_notes(key, mode, progression[c % len(progression)])) + 24
            start = int(k * SR)
            length = min(n - start, int(2.5 * SR))
            if length <= 0:
                break
            seg_t = np.arange(length) / SR
            f = hz(note)
            bell = (np.sin(2 * np.pi * f * seg_t) + 0.4 * np.sin(2 * np.pi * f * 2.76 * seg_t) * np.exp(-seg_t * 4)) * np.exp(-seg_t * 1.6) * layers["bell"]
            left[start:start + length] += bell * 0.6
            right[start:start + length] += bell * 0.4
    left, right = left * intensity, right * intensity
    brightness = 900 + 2600 * intensity.mean()
    left, right = lowpass_fast(left, brightness), lowpass_fast(right, brightness)
    left, right = reverb(left, 0.3), reverb(right, 0.3, 1.07)
    left, right = highpass(left, 45.0), highpass(right, 45.0)
    fade = envelope(n, min(2.0, seconds / 6), min(3.0, seconds / 5))
    return np.stack([left * fade, right * fade], axis=1)


def sfx(spec, rng):
    kind = spec.get("type")
    seconds = float(spec.get("seconds", {"whoosh": 0.8, "riser": 2.0, "impact": 1.2, "tick": 0.08, "chime": 1.6}.get(kind, 1)))
    if not 0.02 <= seconds <= 20:
        fail("sfx seconds must be 0.02..20")
    pitch = float(spec.get("pitch", 1.0))
    n = int(seconds * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    if kind == "whoosh":
        shape = np.sin(np.pi * np.clip(t / seconds, 0, 1)) ** 2
        sweep = 400 + 5200 * shape * pitch
        mono = lowpass(noise, sweep) * shape * 0.8
        pan = np.linspace(0.15, 0.85, n)
        return np.stack([mono * (1 - pan), mono * pan], axis=1) * 1.6
    if kind == "riser":
        rise = (t / seconds) ** 2
        tone = np.sin(2 * np.pi * np.cumsum(180 * pitch * (1 + 3 * rise)) / SR) * 0.35
        air = lowpass(noise, 300 + 6000 * rise) * 0.5
        mono = (tone + air) * rise * envelope(n, 0.01, 0.05)
        return np.stack([mono, mono], axis=1)
    if kind == "impact":
        body = np.sin(2 * np.pi * np.cumsum(90 * pitch * np.exp(-t * 6) + 38) / SR) * np.exp(-t * 5)
        crack = lowpass_fast(noise, 2400) * np.exp(-t * 30) * 0.6
        mono = np.tanh((body + crack) * 1.8) * 0.8
        wet = reverb(mono, 0.35)
        return np.stack([wet, reverb(mono, 0.35, 1.05)], axis=1)
    if kind == "tick":
        mono = np.sin(2 * np.pi * 2600 * pitch * t) * np.exp(-t * 90) * 0.7
        return np.stack([mono, mono], axis=1)
    if kind == "chime":
        f = 880 * pitch
        mono = sum(a * np.sin(2 * np.pi * f * r * t) * np.exp(-t * d) for a, r, d in ((1, 1, 2.2), (0.5, 2.01, 3.5), (0.25, 3.02, 5)))
        mono = reverb(mono * 0.35, 0.3)
        return np.stack([mono * 0.55, mono * 0.45], axis=1)
    fail("sfx type must be whoosh, riser, impact, tick or chime")


def write(path, stereo, target_rms_db):
    stereo = np.stack([highpass(stereo[:, 0]), highpass(stereo[:, 1])], axis=1)
    peak = np.max(np.abs(stereo)) + 1e-9
    rms = np.sqrt(np.mean(stereo ** 2)) + 1e-9
    gain = min(10 ** (target_rms_db / 20) / rms, 0.89 / peak)
    data = np.clip(stereo * gain, -1, 1)
    with wave.open(path, "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes((data * 32767).astype("<i2").tobytes())
    return {"seconds": round(len(data) / SR, 3), "peakDbfs": round(20 * np.log10(np.max(np.abs(data)) + 1e-9), 2),
            "rmsDbfs": round(20 * np.log10(np.sqrt(np.mean(data ** 2)) + 1e-9), 2)}


def main():
    if len(sys.argv) != 3:
        fail("usage: synth.py SPEC.json OUTPUT.wav")
    with open(sys.argv[1], encoding="utf-8") as handle:
        spec = json.load(handle)
    rng = np.random.default_rng(int(spec.get("seed", 7)))
    if spec.get("kind") == "music":
        stereo, target = music(spec, rng), -20.0
    elif spec.get("kind") == "sfx":
        stereo, target = sfx(spec, rng), -16.0
    else:
        fail("kind must be music or sfx")
    print(json.dumps({"output": sys.argv[2], "kind": spec["kind"], **write(sys.argv[2], stereo, target)}))


if __name__ == "__main__":
    main()

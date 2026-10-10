#!/usr/bin/env python3
"""Deterministic procedural music and sound effects for code-first video.

Usage: synth.py SPEC.json OUTPUT.wav
Spec kinds:
  {"kind":"music","seconds":60,"style":"curious","bpm":96,"key":"G","mode":"major",
   "progression":["i","VI","III","VII"],"barsPerChord":2,"swing":0.0,
   "layers":{"pad":0.5,"bass":0.4,"pulse":0.3,"melody":0.5,"bell":0.15,"drums":0.5},
   "intensity":[[0,0.4],[20,0.8],[50,0.4]],"seed":7}
  {"kind":"sfx","type":"whoosh|riser|downlifter|impact|tick|pop|chime|swell","seconds":0.8,"seed":3,"pitch":1.0}
Styles set defaults for every field above; explicit fields win. The music
enters layer by layer as intensity rises (pad, bass, pulse, bell, drums,
melody), chords are voice-led, the melody is a seeded motif developed over a
four-chord phrase, drums pump the harmony (sidechain), and the piece resolves
on the tonic. Prints one JSON line: level stats, bpm, bar times and chord
changes so picture can lock to the beat. Output: 48 kHz 16-bit stereo WAV.
Numpy only (scipy is used for filtering when present); every random choice
is seeded.
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

# Each style is a small arrangement: tempo, harmony, which layers play and
# how the drums move. Explicit spec fields override every entry.
STYLES = {
    "curious": {"bpm": 96, "mode": "major", "progression": ["I", "V", "vi", "IV"], "layers": {"pad": 0.45, "bass": 0.4, "pulse": 0.3, "melody": 0.5, "bell": 0.14, "drums": 0.35}, "drums": "soft", "melody_voice": "glass", "swing": 0.0},
    "focused": {"bpm": 92, "mode": "dorian", "progression": ["i", "IV", "i", "VII"], "layers": {"pad": 0.4, "bass": 0.42, "pulse": 0.34, "melody": 0.3, "bell": 0.1, "drums": 0.3}, "drums": "soft", "melody_voice": "ep", "swing": 0.04},
    "driving": {"bpm": 104, "mode": "minor", "progression": ["i", "VI", "III", "VII"], "layers": {"pad": 0.36, "bass": 0.5, "pulse": 0.3, "melody": 0.42, "bell": 0.08, "drums": 0.6}, "drums": "drive", "melody_voice": "saw", "swing": 0.0},
    "reflective": {"bpm": 72, "mode": "minor", "progression": ["i", "VI", "iv", "v"], "layers": {"pad": 0.55, "bass": 0.28, "pulse": 0.16, "melody": 0.4, "bell": 0.16, "drums": 0.0}, "drums": "none", "melody_voice": "ep", "swing": 0.0},
    "upbeat": {"bpm": 118, "mode": "major", "progression": ["I", "V", "vi", "IV"], "layers": {"pad": 0.3, "bass": 0.46, "pulse": 0.36, "melody": 0.55, "bell": 0.14, "drums": 0.6}, "drums": "steady", "melody_voice": "pluck", "swing": 0.0},
    "confident": {"bpm": 100, "mode": "major", "progression": ["I", "vi", "IV", "V"], "layers": {"pad": 0.38, "bass": 0.45, "pulse": 0.28, "melody": 0.46, "bell": 0.1, "drums": 0.5}, "drums": "groove", "melody_voice": "ep", "swing": 0.08},
    "warm": {"bpm": 84, "mode": "major", "progression": ["I", "iii", "IV", "V"], "layers": {"pad": 0.5, "bass": 0.34, "pulse": 0.24, "melody": 0.42, "bell": 0.14, "drums": 0.22}, "drums": "soft", "melody_voice": "glass", "swing": 0.06},
    "tense": {"bpm": 68, "mode": "minor", "progression": ["i", "ii", "i", "VII"], "layers": {"pad": 0.5, "bass": 0.4, "pulse": 0.16, "melody": 0.22, "bell": 0.12, "drums": 0.28}, "drums": "soft", "melody_voice": "glass", "swing": 0.0},
}


def fail(message):
    raise SystemExit(f"synth: {message}")


def hz(midi):
    return 440.0 * 2 ** ((np.asarray(midi, dtype=np.float64) - 69) / 12)


def smoothstep(x, lo, hi):
    t = np.clip((x - lo) / max(1e-9, hi - lo), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ───────────────────────────── filters ─────────────────────────────

def lowpass(x, cutoff):
    """One-pole low-pass; cutoff may be a per-sample array (exact loop)."""
    cutoff = np.broadcast_to(np.asarray(cutoff, dtype=np.float64), x.shape)
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = (1 - a[i]) * x[i] + a[i] * acc
        y[i] = acc
    return y


def onepole(x, cutoff):
    """Constant-cutoff one-pole low-pass. scipy's lfilter when present; else a
    truncated exponential kernel through FFT convolution, which is exact to
    within the kernel's tail and stays fast for minutes of audio."""
    a = float(np.exp(-2 * np.pi * cutoff / SR))
    try:
        from scipy.signal import lfilter
        return lfilter([1 - a], [1, -a], x)
    except ImportError:
        length = int(min(len(x), max(8, np.log(1e-5) / np.log(a))))
        kernel = (1 - a) * a ** np.arange(length)
        return fft_convolve(x, kernel)[:len(x)]


def lowpass_fast(x, cutoff, poles=1):
    for _ in range(poles):
        x = onepole(x, cutoff)
    return x


def highpass(x, cutoff=35.0):
    """Removes DC and sub-rumble that muddies narration and wastes headroom."""
    return x - onepole(x, cutoff)


def bandpass(x, lo, hi):
    return onepole(x, hi) - onepole(x, lo)


def fft_convolve(x, kernel, block=1 << 17):
    """Overlap-add convolution: bounded memory whatever the length."""
    size = 1
    while size < block + len(kernel):
        size *= 2
    spectrum = np.fft.rfft(kernel, size)
    out = np.zeros(len(x) + len(kernel))
    for start in range(0, len(x), block):
        chunk = x[start:start + block]
        piece = np.fft.irfft(np.fft.rfft(chunk, size) * spectrum, size)[:len(chunk) + len(kernel) - 1]
        out[start:start + len(piece)] += piece
    return out


def envelope(n, attack, release, sustain=1.0):
    env = np.full(n, sustain)
    a = min(n, int(attack * SR))
    r = min(n - a, int(release * SR))
    if a:
        env[:a] = np.linspace(0, sustain, a)
    if r:
        env[n - r:] = np.linspace(sustain, 0, r) ** 1.5
    return env


def reverb(x, mix=0.25, size=1.0, seed=11, damping=0.55):
    """Room by convolution with a synthetic impulse response: decaying noise
    with high frequencies dying faster, a short pre-delay and a soft onset.
    Stereo callers pass different seeds for a wide, decorrelated tail."""
    r = np.random.default_rng(seed)
    n = int(1.9 * size * SR)
    t = np.arange(n) / SR
    ir = r.standard_normal(n) * np.exp(-t * (3.4 / size))
    ir = ir * (1 - np.exp(-t * 90))
    bright = ir - onepole(ir, 900 + 5000 * (1 - damping))
    ir = onepole(ir, 2500) * 0.7 + bright * 0.3
    ir = np.concatenate([np.zeros(int(0.018 * SR)), ir])
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
    wet = fft_convolve(x, ir)[:len(x)]
    return (1 - mix) * x + mix * wet * 1.6


def echo(x, delay, feedback=0.38, mix=0.3, taps=4):
    """Feed-forward echo (a few taps, each duller than the last)."""
    out = x.copy()
    step = int(delay * SR)
    tap = x
    for k in range(1, taps + 1):
        tap = onepole(np.concatenate([np.zeros(step), tap[:-step]]) * feedback, 4200 / k)
        out += mix * tap
    return out


# ───────────────────────────── harmony ─────────────────────────────

def degree(numeral):
    d = ROMAN.get(numeral.lower().rstrip("7"))
    if d is None:
        fail(f"unknown numeral {numeral}")
    return d


def scale_pitches(key, mode, low, high):
    root = NOTES[key]
    return [m for m in range(low, high + 1) if (m - root) % 12 in SCALES[mode]]


def chord_pitch_classes(key, mode, numeral, extend=False):
    scale = SCALES[mode]
    d = degree(numeral)
    steps = (0, 2, 4, 6) if extend else (0, 2, 4)
    return [(NOTES[key] + scale[(d + s) % 7]) % 12 for s in steps]


def voice_lead(previous, pitch_classes, low=52, high=72):
    """Nearest inversion of the chord to the previous voicing: the common
    tones stay put and the others move by step, which is what makes a
    progression sound composed rather than transposed."""
    candidates = [[m for m in range(low, high + 1) if m % 12 == pc] for pc in pitch_classes]
    if previous is None:
        return sorted(min(c, key=lambda m: abs(m - 60)) for c in candidates)
    voiced = []
    for k, options in enumerate(candidates):
        target = previous[k % len(previous)]
        voiced.append(min(options, key=lambda m: abs(m - target)))
    return sorted(voiced)


def automation(points, n):
    if not points:
        return np.ones(n)
    times = np.array([p[0] for p in points], dtype=float) * SR
    values = np.array([p[1] for p in points], dtype=float)
    return np.interp(np.arange(n), times, values)


# ───────────────────────────── instruments ─────────────────────────────

def add(bus, start, sig):
    end = min(len(bus), start + len(sig))
    if end > start:
        bus[start:end] += sig[:end - start]


def pad_voice(midi, length, r):
    """Detuned additive saw with a slow bloom; harmonics stop below Nyquist."""
    t = np.arange(length) / SR
    out = np.zeros(length)
    for detune in (-0.09, 0.0, 0.09):
        f = float(hz(midi + detune))
        phase = r.uniform(0, 2 * np.pi)
        for k in range(1, 9):
            out += np.sin(2 * np.pi * f * k * t + phase * k) / k ** 1.25
    bloom = 0.35 + 0.65 * smoothstep(t, 0, 1.4)
    return onepole(out, 1400) * bloom / 3.2


def fm_voice(midi, length, index=2.4, ratio=1.0, decay=4.0, attack=0.004):
    """Electric-piano style FM: a decaying modulator gives the bright strike."""
    t = np.arange(length) / SR
    f = float(hz(midi))
    mod = index * np.exp(-t * decay * 1.6) * np.sin(2 * np.pi * f * ratio * t)
    return np.sin(2 * np.pi * f * t + mod) * np.exp(-t * decay) * np.minimum(1, t / attack)


def glass_voice(midi, length, decay=2.2):
    """Soft bell: inharmonic partials with a gentle attack."""
    t = np.arange(length) / SR
    f = float(hz(midi))
    body = sum(a * np.sin(2 * np.pi * f * r * t) * np.exp(-t * d) for a, r, d in ((1.0, 1.0, decay), (0.35, 2.76, decay * 1.8), (0.12, 5.4, decay * 3.2)))
    return body * np.minimum(1, t / 0.006)


def saw_voice(midi, length, cutoff=3200):
    t = np.arange(length) / SR
    f = float(hz(midi))
    vibrato = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * t) * smoothstep(t, 0.15, 0.5)
    phase = np.cumsum(f * vibrato) / SR
    out = sum(np.sin(2 * np.pi * phase * k) / k for k in range(1, 7))
    return onepole(out, cutoff) * envelope(length, 0.012, 0.09) * 0.6


def melody_voice(kind, midi, length):
    if kind == "glass":
        return glass_voice(midi, length)
    if kind == "saw":
        return saw_voice(midi, length)
    if kind == "pluck":
        return fm_voice(midi, length, index=1.6, ratio=2.0, decay=6.5)
    return fm_voice(midi, length, index=2.6, ratio=1.0, decay=3.2)


def kick(length=None):
    n = int((length or 0.4) * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * np.cumsum(46 + 110 * np.exp(-t * 26)) / SR) * np.exp(-t * 9)
    click = np.sin(2 * np.pi * 1800 * t) * np.exp(-t * 300) * 0.25
    return np.tanh((body + click) * 1.5) * 0.9


def snare(r, n=None):
    n = n or int(0.28 * SR)
    t = np.arange(n) / SR
    noise = bandpass(r.standard_normal(n), 900, 6500) * np.exp(-t * 20)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 26) * 0.5
    return (noise * 0.9 + tone) * 0.55


def clap(r):
    n = int(0.3 * SR)
    t = np.arange(n) / SR
    noise = bandpass(r.standard_normal(n), 1100, 4500)
    burst = sum(np.exp(-np.maximum(0, t - k * 0.011) * 90) * (t >= k * 0.011) for k in range(3))
    return noise * (burst * 0.4 + np.exp(-t * 22) * 0.8) * 0.5


def hat(r, length=0.06):
    n = int(length * SR)
    t = np.arange(n) / SR
    noise = r.standard_normal(n)
    return (noise - onepole(noise, 5200)) * np.exp(-t * 6 / length) * 0.35


DRUM_PATTERNS = {
    # 16 steps per bar. kick / snare(or clap) / hat weights (0 = rest).
    "soft": {"kick": {0: 1.0, 8: 0.85}, "snare": {12: 0.45}, "hat": {i: 0.5 if i % 4 == 2 else 0.25 for i in range(0, 16, 2)}},
    "steady": {"kick": {0: 1.0, 4: 0.9, 8: 1.0, 12: 0.9}, "snare": {4: 0.0, 12: 0.55}, "hat": {i: 0.55 for i in range(2, 16, 4)}},
    "groove": {"kick": {0: 1.0, 7: 0.6, 10: 0.85}, "snare": {4: 0.85, 12: 0.9}, "hat": {i: 0.6 if i % 4 == 0 else 0.3 for i in range(0, 16)}},
    "drive": {"kick": {0: 1.0, 4: 0.85, 8: 1.0, 12: 0.85}, "snare": {4: 0.9, 12: 0.95}, "hat": {i: 0.5 if i % 2 == 0 else 0.25 for i in range(0, 16)}},
}


# ───────────────────────────── the piece ─────────────────────────────

MOTIF_RHYTHMS = [[0, 3, 4, 6], [0, 2, 4, 5, 7], [0, 4, 6], [0, 3, 6], [0, 2, 3, 6], [0, 3, 5]]
MOTIF_CONTOURS = [[0, 1, 2, 1], [0, 2, 1, 0], [0, -1, 0, 2], [2, 1, 0, 1], [0, 1, 3, 2], [0, 2, 4, 2]]
# Where each layer enters as intensity rises: (from, to) of a smoothstep.
GATES = {"bass": (0.2, 0.38), "pulse": (0.3, 0.48), "bell": (0.36, 0.52), "drums": (0.5, 0.66), "melody": (0.4, 0.56)}


def plan_melody(chords, key, mode, beat, chord_len, r):
    """Notes as (time_s, midi, duration_s, velocity) over the chord plan. A
    seeded motif (rhythm plus contour) is stated, answered, moved up a scale
    step in sequence, contrasted, and closed on a chord tone at the cadence."""
    pool = scale_pitches(key, mode, 64, 83)
    rhythm_a = MOTIF_RHYTHMS[r.integers(len(MOTIF_RHYTHMS))]
    rhythm_b = MOTIF_RHYTHMS[r.integers(len(MOTIF_RHYTHMS))]
    contour = MOTIF_CONTOURS[r.integers(len(MOTIF_CONTOURS))]
    eighth = beat / 2
    bars_per_chord = max(1, int(round(chord_len / (beat * 4))))
    notes, prev = [], None
    for c, (start, numeral, voiced) in enumerate(chords):
        tones = [m for m in pool if m % 12 in {v % 12 for v in voiced}]
        phrase = c % 4
        for bar in range(bars_per_chord):
            base = start + bar * beat * 4
            rhythm = rhythm_a if (bar % 2 == 0) != (phrase == 2) else rhythm_b
            steps = [-x for x in contour] if phrase == 2 else contour
            # Each bar is the motif's contour hung from a chord tone near where the line just was.
            centre = prev if prev is not None else 74
            anchor = pool.index(min(tones, key=lambda m: abs(m - centre) + 0.2 * abs(m - 74))) + (1 if phrase == 1 and bar == 0 else 0)
            for j, slot in enumerate(rhythm):
                pitch = pool[int(np.clip(anchor + steps[j % len(steps)], 0, len(pool) - 1))]
                if slot in (0, 4):  # strong beats sit on chord tones
                    pitch = min(tones, key=lambda m: (abs(m - pitch), abs(m - centre)))
                last_onset = j == len(rhythm) - 1
                nxt = rhythm[j + 1] * eighth if not last_onset else 8 * eighth
                cadence = phrase == 3 and bar == bars_per_chord - 1 and last_onset
                if cadence:  # close the phrase on the chord's root
                    pitch = min((m for m in tones if m % 12 == voiced[0] % 12), key=lambda m: abs(m - 74), default=pitch)
                length = min(nxt - slot * eighth, beat * 3 if cadence else beat * 1.5) * (1.0 if cadence else 0.9)
                notes.append((base + slot * eighth, pitch, max(0.12, length), 1.0 if slot in (0, 4) else 0.78))
                prev = pitch
    return notes


def bass_steps(kind):
    return {"none": [0, 10], "soft": [0, 10], "steady": list(range(0, 16, 2)), "groove": [0, 3, 6, 10, 14], "drive": list(range(0, 16, 2))}.get(kind, [0, 10])


def music(spec, rng):
    style_name = spec.get("style", "curious")
    if style_name not in STYLES:
        fail(f"style must be one of {', '.join(STYLES)}")
    base = STYLES[style_name]
    seconds = float(spec.get("seconds", 30))
    if not 1 <= seconds <= 600:
        fail("seconds must be 1..600")
    n = int(seconds * SR)
    bpm = float(spec.get("bpm", base["bpm"]))
    key, mode = spec.get("key", "D"), spec.get("mode", base["mode"])
    if key not in NOTES or mode not in SCALES:
        fail("key/mode unsupported")
    progression = spec.get("progression", base["progression"])
    for numeral in progression:
        degree(numeral)
    swing = float(spec.get("swing", base["swing"]))
    drum_kind = spec.get("drumPattern", base["drums"])
    voice = spec.get("melodyVoice", base["melody_voice"])
    layers = {**base["layers"], **spec.get("layers", {})}
    beat = 60 / bpm
    bar = 4 * beat
    chord_len = bar * float(spec.get("barsPerChord", 2))
    step16 = beat / 4
    intensity = automation(spec.get("intensity") or [[0, 0.3], [seconds * 0.15, 0.62], [seconds * 0.5, 0.58], [seconds * 0.8, 0.88], [seconds, 0.35]], n)
    ending = max(0.0, seconds - min(bar, seconds * 0.15))

    # Harmony: voice-led chords, the last block resolving to the tonic.
    plan, previous = [], None
    for c in range(int(np.ceil(seconds / chord_len))):
        numeral = progression[c % len(progression)]
        if (c + 1) * chord_len >= seconds - 0.01:
            numeral = "i" if mode != "major" else "I"
        voiced = voice_lead(previous, chord_pitch_classes(key, mode, numeral, extend=bool(c % 2)))
        plan.append((c * chord_len, numeral, voiced))
        previous = voiced

    gate = {name: smoothstep(intensity, lo, hi) for name, (lo, hi) in GATES.items()}
    at = lambda name, t: float(gate[name][min(n - 1, int(t * SR))])
    L, R = np.zeros(n), np.zeros(n)          # harmony bus: pad + bass
    PL, PR = np.zeros(n), np.zeros(n)        # melodic bus: pulse, bells, melody
    DL, DR = np.zeros(n), np.zeros(n)        # drums
    duck = np.ones(n)
    drum_level = layers["drums"]
    duck_depth = 0.32 * min(1.0, drum_level / 0.5)

    # Pad, blooming into each chord with an overlap so changes never click.
    if layers["pad"]:
        pad_gain = 0.35 + 0.65 * smoothstep(intensity, 0.0, 0.3)
        for start, _numeral, voiced in plan:
            s = int(start * SR)
            length = min(n - s, int((chord_len + 1.0) * SR))
            if length <= 0:
                break
            env = envelope(length, 1.1, 1.3)
            for k, midi in enumerate(voiced + [voiced[0] + 12]):
                tone = pad_voice(midi, length, rng) * env * layers["pad"] / 4
                pan = (0.3, 0.7, 0.45, 0.6)[k % 4]
                add(L, s, tone * (1 - pan)), add(R, s, tone * pan)
        L, R = L * pad_gain, R * pad_gain

    # Bass: roots, rhythm by style, gated by intensity.
    if layers["bass"]:
        pattern = bass_steps(drum_kind)
        for c, (start, _numeral, voiced) in enumerate(plan):
            root = voiced[0] % 12 + 36
            for b in range(int(round(chord_len / bar))):
                for step in pattern:
                    t = start + b * bar + step * step16
                    if t >= ending or t >= seconds - 0.05:
                        continue
                    g = at("bass", t)
                    if g < 0.05:
                        continue
                    length = int(min(step16 * (4 if step in (0, 10) else 2), 0.6) * SR)
                    tt = np.arange(length) / SR
                    f = float(hz(root + (12 if step in (6, 14) else 0)))
                    tone = np.tanh(1.6 * (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(4 * np.pi * f * tt))) * envelope(length, 0.006, 0.18) * layers["bass"] * 0.42 * g * (1.0 if step == 0 else 0.8)
                    add(L, int(t * SR), tone), add(R, int(t * SR), tone)
        # The tonic lands once more as the piece ends.
        f = float(hz(plan[-1][2][0] % 12 + 36))
        length = min(n - int(ending * SR), int(2.4 * SR))
        if length > 0 and ending > 0:
            tt = np.arange(length) / SR
            tone = np.sin(2 * np.pi * f * tt) * np.exp(-tt * 1.4) * layers["bass"] * 0.4
            add(L, int(ending * SR), tone), add(R, int(ending * SR), tone)

    # Pulse: an electric-piano arpeggio that thickens as energy rises.
    if layers["pulse"]:
        pattern = [0, 1, 2, 1, 0, 2, 1, 2]
        sixteenth = drum_kind == "drive"
        stride = step16 * (1 if sixteenth else 2)
        for k in range(int(ending / stride)):
            t = k * stride
            g = at("pulse", t)
            if g < 0.05:
                continue
            _s, _n, voiced = plan[min(len(plan) - 1, int(t / chord_len))]
            note = voiced[pattern[k % len(pattern)] % len(voiced)] + 12
            length = int(0.5 * SR)
            pluck = fm_voice(note, length, index=1.5, ratio=1.0, decay=7.0) * layers["pulse"] * 0.4 * g * (0.75 + 0.25 * rng.random())
            pan = 0.5 + 0.32 * np.sin(k * 0.55)
            add(PL, int(t * SR), pluck * (1 - pan)), add(PR, int(t * SR), pluck * pan)

    # Melody: the developed motif, echoing a dotted eighth behind itself.
    melody_notes = []
    if layers["melody"]:
        melody_notes = plan_melody(plan, key, mode, beat, chord_len, rng)
        for t, midi, dur, vel in melody_notes:
            if t >= ending or t >= seconds - 0.05:
                continue
            g = at("melody", t)
            if g < 0.05:
                continue
            length = int(min(dur + 0.5, 3.0) * SR)
            tone = melody_voice(voice, midi, length) * layers["melody"] * 0.42 * vel * g
            if voice != "saw":
                tone = tone * np.concatenate([np.ones(min(length, int(dur * SR))), np.exp(-np.arange(max(0, length - int(dur * SR))) / (0.4 * SR))])[:length]
            pan = 0.5 + 0.08 * np.sin(t * 0.9)
            add(PL, int(t * SR), tone * (1 - pan)), add(PR, int(t * SR), tone * pan)

    # Bells: sparse high chord tones that catch the light.
    if layers["bell"]:
        t = beat * 2
        while t < ending:
            t += float(rng.choice([2, 3, 4])) * beat
            g = at("bell", min(t, seconds - 0.01))
            if g < 0.05 or t >= ending:
                continue
            _s, _n, voiced = plan[min(len(plan) - 1, int(t / chord_len))]
            note = int(rng.choice(voiced)) + 24
            length = int(2.2 * SR)
            bell = glass_voice(note, length, decay=1.5) * layers["bell"] * 0.45 * g
            pan = 0.35 + 0.3 * rng.random()
            add(PL, int(t * SR), bell * (1 - pan)), add(PR, int(t * SR), bell * pan)

    # Drums: patterns by style with swing, ghost hats and a fill every fourth bar.
    if layers["drums"] and drum_kind in DRUM_PATTERNS:
        pattern = DRUM_PATTERNS[drum_kind]
        k_sample, s_sample, c_sample = kick(), snare(rng), clap(rng)
        for b in range(int(ending / bar) + 1):
            g = at("drums", min(b * bar, seconds - 0.01))
            if g < 0.05:
                continue
            fill = drum_kind != "soft" and b % 4 == 3
            for step in range(16):
                t = b * bar + (step + (swing if step % 2 else 0)) * step16
                if t >= ending:
                    continue
                s = int(t * SR)
                vel = (0.9 + 0.1 * rng.random()) * g * drum_level
                if step in pattern["kick"]:
                    add(DL, s, k_sample * pattern["kick"][step] * vel * 0.9), add(DR, s, k_sample * pattern["kick"][step] * vel * 0.9)
                    seg = min(n - s, int(0.3 * SR))
                    duck[s:s + seg] *= 1 - duck_depth * g * pattern["kick"][step] * np.exp(-np.arange(seg) / (0.1 * SR))
                if step in pattern["snare"] and pattern["snare"][step] > 0:
                    body = s_sample if drum_kind in ("groove", "drive") else c_sample
                    add(DL, s, body * pattern["snare"][step] * vel * 0.9), add(DR, s, body * pattern["snare"][step] * vel * 0.9)
                if fill and step >= 12 and step % 1 == 0 and drum_kind != "steady":
                    add(DL, s, s_sample * 0.35 * vel * (0.5 + (step - 12) / 6)), add(DR, s, s_sample * 0.35 * vel * (0.5 + (step - 12) / 6))
                if step in pattern["hat"]:
                    open_hat = step % 8 == 6 and drum_kind in ("steady", "drive")
                    h = hat(rng, 0.22 if open_hat else 0.05) * pattern["hat"][step] * vel * (0.9 if step % 4 else 1.15)
                    pan = 0.5 + (0.14 if step % 4 == 2 else -0.14) * 0.6
                    add(DL, s, h * (1 - pan) * 1.3), add(DR, s, h * pan * 1.3)

    # Buses: harmony ducks under the kick and gets a soft room, the melodic
    # bus gets echo and a wider room, drums stay close.
    L, R = L * duck, R * duck
    PL, PR = PL * (0.55 + 0.45 * duck), PR * (0.55 + 0.45 * duck)
    L, R = reverb(L, 0.22, 1.0, 21), reverb(R, 0.22, 1.05, 22)
    PL, PR = reverb(echo(PL, beat * 0.75, 0.36, 0.26), 0.3, 1.15, 23), reverb(echo(PR, beat * 0.75 * 1.02, 0.36, 0.26), 0.3, 1.2, 24)
    DL, DR = reverb(DL, 0.06, 0.4, 25), reverb(DR, 0.06, 0.4, 26)
    # Darker as the energy falls, brighter when it peaks; drums keep their air.
    tone_cut = 1100 + 3200 * float(intensity.mean())
    left, right = lowpass_fast(L + PL, tone_cut, 2) + DL, lowpass_fast(R + PR, tone_cut, 2) + DR
    left, right = highpass(left, 42.0), highpass(right, 42.0)
    stereo = glue(np.stack([left, right], axis=1))
    fade = envelope(n, min(1.5, seconds / 8), min(3.0, seconds / 5))
    stereo = stereo * fade[:, None]
    downbeats = [round(float(t), 3) for t in np.arange(0, seconds, bar)][:600]
    entries = {name: round(float(np.argmax(gate[name] > 0.5) / SR), 2) for name in gate if layers.get(name) and gate[name].max() > 0.5}
    info = {"bpm": bpm, "key": key, "mode": mode, "style": style_name, "barSeconds": round(bar, 3), "downbeats": downbeats,
            "chords": [{"t": round(start, 2), "numeral": numeral} for start, numeral, _ in plan], "layerEntries": entries, "endsAt": round(ending, 2)}
    return stereo, info


def glue(stereo, threshold=0.22, ratio=2.2):
    """Gentle bus compression: level follower in 20 ms steps, smoothed gain."""
    hop = int(0.02 * SR)
    frames = len(stereo) // hop
    if frames < 2:
        return stereo
    level = np.abs(stereo[:frames * hop]).max(axis=1).reshape(frames, hop).max(axis=1)
    over = np.maximum(level, 1e-6)
    reduction = np.where(over > threshold, (threshold + (over - threshold) / ratio) / over, 1.0)
    smooth = np.copy(reduction)
    for i in range(1, frames):  # instant attack, ~250 ms release
        smooth[i] = reduction[i] if reduction[i] < smooth[i - 1] else smooth[i - 1] + (reduction[i] - smooth[i - 1]) * 0.08
    gain = np.interp(np.arange(len(stereo)), (np.arange(frames) + 0.5) * hop, smooth)
    return np.tanh(stereo * gain[:, None] * 1.15) / 1.15



def sfx(spec, rng):
    kind = spec.get("type")
    seconds = float(spec.get("seconds", {"whoosh": 0.8, "riser": 2.0, "downlifter": 2.0, "impact": 1.2, "tick": 0.08, "pop": 0.25, "chime": 1.6, "swell": 1.8}.get(kind, 1)))
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
    if kind == "swell":
        # A soft airy breath for fades and blurs: noise opening up, then closing.
        shape = np.sin(np.pi * np.clip(t / seconds, 0, 1)) ** 1.6
        air = lowpass(noise, 250 + 3800 * shape * pitch) * shape * 0.7
        low = np.sin(2 * np.pi * 110 * pitch * t) * shape * 0.18
        mono = air + low
        pan = np.linspace(0.3, 0.7, n)
        return np.stack([mono * (1 - pan), mono * pan], axis=1) * 1.4
    if kind == "riser":
        rise = (t / seconds) ** 2
        tone = np.sin(2 * np.pi * np.cumsum(180 * pitch * (1 + 3 * rise)) / SR) * 0.35
        air = lowpass(noise, 300 + 6000 * rise) * 0.5
        mono = (tone + air) * rise * envelope(n, 0.01, 0.05)
        return np.stack([mono, mono], axis=1)
    if kind == "downlifter":
        fall = 1 - t / seconds
        tone = np.sin(2 * np.pi * np.cumsum(180 * pitch * (1 + 3 * fall)) / SR) * 0.35
        air = lowpass(noise, 300 + 6000 * fall) * 0.5
        mono = (tone + air) * fall * envelope(n, 0.01, 0.05)
        return np.stack([mono, mono], axis=1)
    if kind == "pop":
        body = np.sin(2 * np.pi * np.cumsum(700 * pitch * np.exp(-t * 25) + 220) / SR) * np.exp(-t * 22)
        click = noise * np.exp(-t * 220) * 0.25
        mono = (body + click) * 0.7
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
    fail("sfx type must be whoosh, riser, downlifter, impact, tick, pop, chime or swell")


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
    info = {}
    if spec.get("kind") == "music":
        (stereo, info), target = music(spec, rng), -20.0
    elif spec.get("kind") == "sfx":
        stereo, target = sfx(spec, rng), -16.0
    else:
        fail("kind must be music or sfx")
    print(json.dumps({"output": sys.argv[2], "kind": spec["kind"], **write(sys.argv[2], stereo, target), **info}))


if __name__ == "__main__":
    main()

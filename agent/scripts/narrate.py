#!/usr/bin/env python3
"""Local Piper narration with measured word timing and a light mastering chain.

Usage: narrate.py REQUEST.json   (prints one JSON result line)

Request: {"model": ".../voice.onnx", "outDir": "...", "threads": 4,
          "lengthScale": 1.2, "noiseScale": 0.667, "noiseW": 0.8,
          "sentenceSilence": 0.42, "paragraphSilence": 0.85,
          "scenes": [{"id": "intro", "text": "spoken text (lexicon applied)", "display": "text as on screen",
                      "counts": [1, 3, null]}]}   # spoken words per display token; null = engine decides

Piper's phoneme alignments (needs the `onnx` wheel) give the duration of every
phoneme, so each word's start and end are measured, not estimated. Words map
to the whitespace tokens of `display` using `counts`; when the totals cannot
be reconciled the scene falls back to timing inside the span that alignment
does give. The wav is written raw here; mastering (compression,
presence, level) is done by the caller with FFmpeg.
"""
import json
import re
import sys
import wave

import numpy as np

PUNCT = set(",.;:!?…—–-\"'()[]{}«»")


def fail(message):
    raise SystemExit(f"narrate: {message}")


def limit_threads(threads):
    """Piper builds its ONNX session internally; cap the intra-op pool so a
    narration pass does not occupy every core."""
    import onnxruntime as ort
    original = ort.SessionOptions

    def options():
        opts = original()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        return opts
    ort.SessionOptions = options


def phoneme_words(alignments, rate):
    """[(start_s, end_s)] for each space-separated word in one sentence chunk.
    Trailing punctuation carries the pause after a word, so a word ends at its
    last non-punctuation phoneme."""
    words, cursor, current = [], 0, None
    for entry in alignments:
        symbol = entry.phoneme
        seconds = float(entry.num_samples) / rate
        if symbol in ("^", "$", "_"):
            cursor += seconds
            continue
        if symbol == " ":
            if current:
                words.append(current)
                current = None
            cursor += seconds
            continue
        if symbol in PUNCT:
            cursor += seconds
            continue
        if current is None:
            current = [cursor, cursor + seconds]
        else:
            current[1] = cursor + seconds
        cursor += seconds
    if current:
        words.append(current)
    return words


def estimate(tokens, start, end):
    """Syllable-weighted timing across [start, end] for tokens without alignment."""
    def weight(token):
        letters = re.sub(r"[^a-z]", "", token.lower())
        return max(1, len(re.findall(r"[aeiouy]+", letters))) + (2.4 if re.search(r"[.!?]$", token) else 1.0 if re.search(r"[,;:]$", token) else 0)
    weights = [weight(t) for t in tokens]
    total = sum(weights) or 1
    out, at = [], start
    for token, w in zip(tokens, weights):
        span = (end - start) * w / total
        out.append([at, at + span * 0.86])
        at += span
    return out


def group(timed, counts):
    """Assign consecutive phoneme words to display tokens. `counts[i]` is how
    many spoken words token i produces (respelled acronyms), or None when the
    engine decides (digits, hyphenated compounds); unknowns share what is left."""
    known = sum(c for c in counts if c is not None)
    free = [i for i, c in enumerate(counts) if c is None]
    remaining = len(timed) - known
    if remaining < len(free) or (not free and remaining != 0):
        return None
    sizes = list(counts)
    for k, i in enumerate(free):
        spare = remaining - len(free)
        sizes[i] = 1 + spare // len(free) + (1 if k < spare % len(free) else 0)
    out, at = [], 0
    for size in sizes:
        out.append([timed[at][0], timed[at + size - 1][1]])
        at += size
    return out


def synth_scene(voice, syn_config, text, display, counts, sentence_pause, paragraph_pause, aligned):
    rate = voice.config.sample_rate
    pieces, timed = [], []
    clock = 0.0
    paragraphs = [p.strip() for p in re.split(r"\n+", text) if p.strip()]
    for p_index, paragraph in enumerate(paragraphs):
        chunks = list(voice.synthesize(paragraph, syn_config, include_alignments=aligned))
        for c_index, chunk in enumerate(chunks):
            audio = chunk.audio_int16_array
            pieces.append(audio)
            if aligned and chunk.phoneme_alignments:
                for start, end in phoneme_words(chunk.phoneme_alignments, rate):
                    timed.append([clock + start, clock + end])
            clock += len(audio) / rate
            last_sentence = c_index == len(chunks) - 1
            last_paragraph = p_index == len(paragraphs) - 1
            pause = 0 if last_sentence and last_paragraph else paragraph_pause if last_sentence else sentence_pause
            if pause:
                pieces.append(np.zeros(int(pause * rate), dtype=np.int16))
                clock += pause
    tokens = display.split()
    audio = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.int16)
    speech_end = len(audio) / rate
    grouped = group(timed, counts if len(counts) == len(tokens) else [1] * len(tokens)) if aligned and timed else None
    if grouped:
        words, exact = grouped, True
    else:
        first = timed[0][0] if timed else 0.0
        last = timed[-1][1] if timed else speech_end
        words, exact = estimate(tokens, first, last), False
    return audio, rate, [{"w": t, "s": round(w[0], 3), "e": round(w[1], 3)} for t, w in zip(tokens, words)], exact


def main():
    if len(sys.argv) != 2:
        fail("usage: narrate.py REQUEST.json")
    with open(sys.argv[1], encoding="utf-8") as handle:
        request = json.load(handle)
    limit_threads(int(request.get("threads", 4)))
    from piper import PiperVoice, SynthesisConfig
    aligned = True
    try:
        voice = PiperVoice.load(request["model"], include_alignments=True)
    except Exception as error:  # missing onnx wheel or an older piper: measured length only
        print(f"NARRATE_NOTE alignment unavailable ({type(error).__name__}); words will be estimated", flush=True)
        aligned = False
        voice = PiperVoice.load(request["model"])
    config = SynthesisConfig(length_scale=float(request.get("lengthScale", 1.2)), noise_scale=float(request.get("noiseScale", 0.667)), noise_w_scale=float(request.get("noiseW", 0.8)))
    results = []
    for scene in request["scenes"]:
        print(f"NARRATE_PROGRESS {scene['id']}", flush=True)
        audio, rate, words, exact = synth_scene(voice, config, scene["text"], scene["display"], scene.get("counts") or [], float(request.get("sentenceSilence", 0.42)), float(request.get("paragraphSilence", 0.85)), aligned)
        path = f"{request['outDir']}/{scene['id']}.raw.wav"
        with wave.open(path, "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(rate)
            out.writeframes(audio.astype("<i2").tobytes())
        results.append({"id": scene["id"], "raw": path, "seconds": round(len(audio) / rate, 3), "words": words, "exact": exact})
    print("NARRATE_RESULT " + json.dumps({"aligned": aligned, "scenes": results}), flush=True)


if __name__ == "__main__":
    main()

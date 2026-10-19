#!/usr/bin/env python3
"""Objective listen check: transcribe a delivered master with faster-whisper.

Run by agent/extensions/lib/video-listen.ts as `python -I asr-listen.py request.json`.
The request is a JSON object: {"audio": path, "model": "small.en", "language": "en" | null,
"speechWindows": true, "resultFile": path}. Progress is printed as `LISTEN_PROGRESS <text>`.
On success the full result is printed as one `LISTEN_RESULT <json>` line and also written
to resultFile (the caller bounds stdout lines, so it reads the file). Failures print
`LISTEN_ERROR <message>` and exit 2.

The audio is decoded here with ffmpeg to 16 kHz mono float32 and handed to faster-whisper as an
array. faster-whisper's own file decoder goes through PyAV, and PyAV 19 no longer accepts the
keyword faster-whisper 1.2.1 passes to av.open, so file paths fail in that combination.
Nothing is downloaded unless PI_ASR_ALLOW_DOWNLOAD=1 is set.
"""
import json
import os
import subprocess
import sys
import time

ALLOWED_MODELS = ("small.en", "base.en", "medium", "large-v3-turbo")
MAX_WORDS = 20000
MAX_SEGMENTS = 20000
MAX_SPEECH_WINDOWS = 100000
ALLOW_DOWNLOAD = os.environ.get("PI_ASR_ALLOW_DOWNLOAD") == "1"

# Must be set before huggingface_hub is imported (faster_whisper imports it).
if not ALLOW_DOWNLOAD:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def fail(message, code=2):
    text = " ".join(str(message).split())[:2000]
    print("LISTEN_ERROR " + text, flush=True)
    sys.exit(code)


def progress(text):
    print("LISTEN_PROGRESS " + " ".join(str(text).split())[:300], flush=True)


def load_request(path):
    try:
        with open(path, encoding="utf-8") as handle:
            request = json.load(handle)
    except (OSError, ValueError) as error:
        fail(f"request file is not readable JSON: {error}")
    if not isinstance(request, dict):
        fail("request must be a JSON object")

    audio = request.get("audio")
    if not isinstance(audio, str) or not audio or "\x00" in audio:
        fail("request.audio must be a local file path")
    if not os.path.isfile(audio):
        fail(f"audio file not found: {audio}")

    model = request.get("model", "small.en")
    if model not in ALLOWED_MODELS:
        fail(f"model must be one of {', '.join(ALLOWED_MODELS)} (got {model!r})")

    language = request.get("language", "en")
    if language is not None and not (isinstance(language, str) and language.isalpha() and 2 <= len(language) <= 3):
        fail("language must be a two or three letter code such as \"en\", or null for detection")
    if language is None and model.endswith(".en"):
        language = "en"

    result_file = request.get("resultFile")
    if result_file is not None and not isinstance(result_file, str):
        fail("resultFile must be a path string")

    return {
        "audio": audio,
        "model": model,
        "language": language,
        "speech_windows": request.get("speechWindows", True) is True,
        "result_file": result_file,
    }


def merge_spans(spans):
    """Union of overlapping [start, end] spans, sorted."""
    merged = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def decode_audio(path):
    """16 kHz mono float32 samples of the first audio stream, decoded by ffmpeg."""
    try:
        import numpy as np
    except Exception as error:  # noqa: BLE001
        fail(f"numpy is not importable by this Python ({error}). Install faster-whisper's dependencies or set PI_ASR_PYTHON.")
    try:
        done = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-vn",
             "-ac", "1", "-ar", "16000", "-f", "f32le", "-acodec", "pcm_f32le", "-"],
            capture_output=True, timeout=1800, check=False)
    except FileNotFoundError:
        fail("ffmpeg is not installed or not on PATH")
    except subprocess.TimeoutExpired:
        fail("ffmpeg timed out decoding the audio")
    if done.returncode != 0:
        tail = done.stderr.decode("utf-8", "replace").strip()[-600:]
        fail(f"ffmpeg could not decode the audio: {tail or 'exit ' + str(done.returncode)}")
    return np.frombuffer(done.stdout, dtype=np.float32)


def write_result_file(path, result):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def transcribe(options):
    try:
        from faster_whisper import WhisperModel
    except Exception as error:  # noqa: BLE001 - report any import failure as a listen error
        fail(f"faster_whisper is not importable by this Python ({error}). Install it or set PI_ASR_PYTHON.")

    progress("decoding audio to 16 kHz mono")
    samples = decode_audio(options["audio"])
    progress(f"loading {options['model']} (CPU, int8)")
    try:
        model = WhisperModel(options["model"], device="cpu", compute_type="int8",
                             local_files_only=not ALLOW_DOWNLOAD)
    except Exception as error:  # noqa: BLE001
        fail(f"model {options['model']} is not cached locally ({error}). "
             "Populate the Hugging Face cache, or set PI_ASR_ALLOW_DOWNLOAD=1 for a one-time download.")

    started = time.time()
    segments, info = model.transcribe(
        samples,
        language=options["language"],
        vad_filter=True,
        word_timestamps=True,
    )
    duration = len(samples) / 16000.0

    texts = []
    segment_rows = []
    word_rows = []
    word_total = 0
    spans = []
    logprobs = []
    for index, segment in enumerate(segments):
        text = (segment.text or "").strip()
        if text:
            texts.append(text)
        logprobs.append(float(segment.avg_logprob))
        if len(segment_rows) < MAX_SEGMENTS:
            segment_rows.append({
                "s": round(segment.start, 3),
                "e": round(segment.end, 3),
                "avgLogprob": round(float(segment.avg_logprob), 4),
                "noSpeechProb": round(float(segment.no_speech_prob), 4),
            })
        for word in segment.words or []:
            token = (word.word or "").strip()
            if not token:
                continue
            spans.append([float(word.start), float(word.end)])
            word_total += 1
            if len(word_rows) < MAX_WORDS:
                word_rows.append({
                    "w": token,
                    "s": round(word.start, 3),
                    "e": round(word.end, 3),
                    "p": round(float(word.probability), 4),
                })
        if index % 10 == 0 and duration > 0:
            progress(f"transcribed to {segment.end:.1f}s of {duration:.1f}s")

    windows = merge_spans(spans)
    speech_seconds = sum(end - start for start, end in windows)
    result = {
        "model": options["model"],
        "language": info.language,
        "durationSeconds": round(duration, 3),
        "text": " ".join(texts),
        "words": word_rows,
        "wordCount": word_total,
        "wordsTruncated": word_total > len(word_rows),
        "segments": segment_rows,
        "meanLogprob": round(sum(logprobs) / len(logprobs), 4) if logprobs else None,
        "speechSeconds": round(speech_seconds, 3),
        "elapsedSeconds": round(time.time() - started, 2),
    }
    if options["speech_windows"]:
        result["speechWindows"] = [[round(s, 3), round(e, 3)] for s, e in windows[:MAX_SPEECH_WINDOWS]]
    return result


def main(argv):
    if len(argv) != 2:
        fail("usage: asr-listen.py request.json")
    options = load_request(argv[1])
    result = transcribe(options)
    if options["result_file"]:
        try:
            write_result_file(options["result_file"], result)
        except OSError as error:
            progress(f"could not write result file, stdout line only: {error}")
    print("LISTEN_RESULT " + json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - every failure must end as one LISTEN_ERROR line
        fail(f"{type(error).__name__}: {error}")

---
name: sound-analysis
description: Measure and interpret recorded sound, noise, silence, loudness, peaks and spectral content. Use for audio diagnostics and sound comparisons; use audio-processing for edits and music-composition for writing music.
---

# Sound analysis

Define what the recording can answer. Probe the audio stream and preserve the original sample rate, channel layout, duration and time origin. Record the measurement window and units with every finding.

Use `audio_analyze {path:"recording.wav",start:0,duration:30,spectrum:true}` for integrated LUFS, true peak in dBTP, sample peak and RMS in dBFS, DC offset, silence candidates and a spectrum image. The default window is thirty seconds; pass an explicit interval for a longer measurement. Open the returned spectrum image if visual interpretation is needed. Null measurements mean undefined/nonfinite, often silence or insufficient duration.

Read [measurement interpretation](references/measurements.md) for clipping, channel analysis, spectra, tempo and pitch estimation. A spectrum is evidence of energy distribution, not recognition of a speaker, instrument or event. Silence thresholds are not voice activity detection.

Compare files using equivalent windows and preprocessing. Listen to representative problems and preserve observations separately from calculated metrics. If listening is unavailable, describe the objective checks and leave auditory quality unverified. For repair, hand the measured issue to audio-processing and remeasure the result; avoid denoising or normalization merely because a file differs from a generic target.

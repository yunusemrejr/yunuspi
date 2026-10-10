---
name: audio
description: "Process, measure, mix, narrate, compose and synthesize audio: FFmpeg/SoX filtering, loudness and sync, LUFS/true-peak/spectrum analysis, audio_mix, narration, MIDI scores via music_compose, and seeded procedural beds and SFX via audio_synth."
---

# Audio

## Processing and loudness
- Probe first (streams, codec, rate, layout, duration, clipping) and pick the stream explicitly; videos may carry commentary tracks.
- Keep sources, write distinct outputs, keep lossless intermediates across edits, and record the filter chain.
- Treat gain, EQ, denoising, channel mixing, resampling and limiting as separate steps. Use the least destructive one first; test a noisy and a quiet segment before whole-file denoising.
- Resampling changes the grid, not duration; relabeling the rate changes pitch. Never present upsampling as recovered detail. Check layouts before downmixing: correlated channels clip, opposite polarity cancels.
- Loudness: measure the final chain, then feed integrated loudness, true peak, LRA and threshold into the second loudnorm pass. Confirm it did not fall back to dynamic mode. Set the output rate.
- `audio_mix` takes voice, music and effect tracks (trims, offsets, tempo, loops, fades); voice and music roles duck automatically; `targetLufs` requests measured mastering.
- Sync: two landmarks separate offset from drift; repeated beats create false correlation peaks. `media_sync` checks spoken coverage and boundaries.
- Narration: `narration_tts {action:"recover", dir}` reassembles a retained ElevenLabs cache with no provider call; the account must match the manifest. After a failure, inspect saved checkpoints before regenerating.

## Measuring sound
- Define the question. Keep window, units and channel handling with each finding.
- `audio_analyze {path, start, duration, spectrum:true}` gives integrated LUFS, dBTP, sample peak, RMS, DC offset, silence candidates and a spectrum. Default window is 30 s; pass explicit intervals. Null means undefined (silence or too short).
- Gated LUFS is unstable on short clips; delivery loudness needs a full-program scan.
- Analyze channels separately (FFmpeg per-channel map) to find antiphase or single-channel clipping.
- Silence thresholds are not voice-activity detection; check pacing before cutting pauses.
- A spectrum shows energy, not identity; a 440 Hz peak does not establish key.

## Composing music (`music_compose`)
- Decide mood, instrumentation, tonal center, meter, tempo and form; develop a short phrase before adding parts.
- Score units are quarter notes, even in 6/8. MIDI 60 is C4; programs are zero-based. One track per instrumental role; no same-pitch overlaps on one track.
- Output: `score.mid`, `score.json`, `preview.wav`. Constant tempo; eight tracks including one drum track; two-minute sketches; it never invents content.
- Realistic timbre needs a SoundFont (`soundfont` path or `YUNUSPI_SOUNDFONT`; `backend:"soundfont"` requires it). Install `libfluidsynth3` and a bank separately. Missing banks fail; they never become oscillators.
- A `percussion:true` track uses GM drum pitches (36 kick, 38 snare, 42 closed hat, 46 open hat); program selects the kit. Oscillators cannot render drums.
- For picture, convert cue seconds to beats (`beat = seconds × bpm / 60`, constant tempo only); record pickups, holds, endings and loop seams.
- Audition rhythm, voicing, balance, ending and duration; a MIDI file does not prove quality. Label a sketch as a sketch.

## Procedural beds and sound effects (`audio_synth`)
- In a video project call `audio_synth` with `dir` and `kind` (music, sfx, sound_design). Standalone: `python3 scripts/synth.py SPEC.json OUT.wav`; the spec is in the script header. Output is 48 kHz stereo; numpy only.
- Decide the emotional arc, then express it as intensity automation and chord motion; constant intensity sounds like a loop.
- Under narration: 70–90 bpm, low pulse and bell layers, drums at 0, little energy above 2 kHz; speech sits around 1–4 kHz.
- Without narration, add drums and match beat-synced motion to the same bpm (`pulse(frame, fps, bpm)`).
- SFX are punctuation, one per visual event, 6–12 dB under voice: whoosh, riser or downlifter for transitions; impact for reveals; tick or pop for UI; chime for conclusions.
- Renders are seeded; change `seed` for a new arrangement.
- Verify with `audio_analyze` (no clipping, low end not dominant); `video_qa` measures finished mixes. Listen when possible.

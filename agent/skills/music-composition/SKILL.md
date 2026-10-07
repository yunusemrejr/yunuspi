---
name: music-composition
description: Compose original melodies, harmony, rhythm and arrangements; create editable MIDI scores and audible sketches, including music timed to video. Use for writing music, cue sheets and orchestration rather than recognizing existing songs.
---

# Music composition

Use the user's mood, instrumentation, references and duration to make musical choices. Establish a tonal center or deliberate atonality, meter, tempo, motif and form. Start with a short coherent phrase; develop repetition and contrast before adding parts. Keep bass, chord voicing and melody intentional rather than generating unrelated scale notes.

Use `music_compose` to turn an explicit score into type-1 MIDI, editable JSON and an audible WAV sketch. It runs locally. Supply `soundfont` (SF2/SF3) or configure `YUNUSPI_SOUNDFONT` for real stereo instruments through libfluidsynth; choose `backend:"soundfont"` to require them. Auto otherwise returns a labeled oscillator audition. Read [score format and arrangement](references/score.md) before constructing tool input. The renderer supports constant tempo, eight tracks including one optional drum kit, and two-minute sketches. It does not invent musical content. Instrument fidelity depends on the chosen SoundFont bank; missing banks/programs fail explicitly.

For picture, map cue points to seconds, then quarter-note beats; choose tempo and phrase lengths to support the edit. Record intentional pickups, holds, endings and loop seams. For longer work or tempo maps, use an available DAW/MIDI library with the same timing contract.

Set `percussion:true` on one track to use the General MIDI drum channel with a SoundFont drum bank. Pitch selects the drum: 36 kick, 38 snare, 42 closed hi-hat and 46 open hi-hat. Program selects the kit; zero is the standard kit. Keep accents and rests deliberate. Percussion requires real instrument rendering; the tool refuses to substitute pitched oscillators for drums.

Audition the result for rhythm, voice leading, register, balance and ending. Check note-off timing, overlapping pitches, count-in and exact duration. Program numbers are preserved in MIDI, while the built-in preview uses band-limited sine/triangle/square/saw oscillators (square for leads, saw for basses, triangle for soft pads). Set `stereo: true` and per-track `pan` for a positioned mix sketch; mono stays the default. Use `music_compose backend:"soundfont", soundfont:"path/to/bank.sf2", releaseTail:1.5` when instrument timbre matters; the receipt records the bank digest, note-clock tolerance, source peak and gain. `media_pipeline scoreRender` exposes the same options. Deliver editable score/MIDI with the audio, and distinguish a sketch from a mixed production.

# Score format and arrangement

All `start`, `duration` and `beats` values count quarter notes, even in 6/8. At 120 BPM one quarter note is 0.5 seconds; a 6/8 bar lasts three quarter notes. MIDI pitch 60 is C4, 69 is A4; programs are zero-based. Melodic tracks map to separate channels. One optional `percussion:true` track uses channel 10 (zero-based 9). Tempo maps require a DAW or a separate MIDI workflow.

Example short motif; develop it according to the musical request:

```json
{"score":{"bpm":100,"beats":4,"numerator":4,"denominator":4,"tracks":[{"name":"Motif","program":0,"waveform":"triangle","notes":[{"pitch":60,"start":0,"duration":0.8,"velocity":86},{"pitch":64,"start":1,"duration":0.8,"velocity":80},{"pitch":67,"start":2,"duration":0.8,"velocity":90},{"pitch":64,"start":3,"duration":1,"velocity":72}]}]}}
```

`music_compose` returns a new folder containing `score.mid`, `score.json`, and `preview.wav`. The dependency-free oscillator WAV is mono 44.1 kHz PCM with short attack/release envelopes and gain reduction only when necessary. Program numbers do not change its oscillator sound. Notes and the ending are quantized to 480 ticks per quarter note; MIDI, JSON and WAV use the same integer microsecond tempo. JSON records `midiTempoMicroseconds` and quantized note timing. The preview includes rests through `beats` and rounds its ending up to a complete sample. Long notes, peak scanning and PCM packing yield in bounded blocks so cancellation stays responsive.

Use one track per instrumental role. Avoid same-pitch overlaps on a track: a MIDI note-off would ambiguously stop a still-held note. Legato across different pitches is valid. Split intentional same-pitch layers across tracks. Keep notes inside score duration; release envelopes reach zero before their note ends.

Harmony: choose chord functions and bass motion, then voice chords within playable register with deliberate common tones and tensions. Rhythm: vary accents and rests, maintain the chosen groove, and use intentional anticipation or syncopation. Arrangement: add density to support form and reserve register space for the melody or dialogue.

For loop delivery, check the final decay and transition to the first beat in playback. For synchronized cues, retain a table of cue seconds and musical beats; `beat = seconds * bpm / 60` applies only to constant tempo. A MIDI file alone cannot prove musical quality; use listening or clearly report that it remains unverified.

## Instrument rendering

Pass `backend:"soundfont", soundfont:"bank.sf2"` to render the same score through libfluidsynth. `auto` also selects this backend when a bank or `YUNUSPI_SOUNDFONT` is configured. It writes stereo 44.1 kHz PCM with instrument program selection, MIDI pan, and `releaseTail` (0–5 seconds, default 1.5) after the authored score. Note boundaries follow quantized MIDI beats; the receipt discloses the engine's 64-sample scheduling tolerance. `render.json` records bank SHA256, score/output durations, source peak and limiting gain. A failed instrument render never silently changes to oscillators.

On Ubuntu, install `libfluidsynth3` and an appropriate SoundFont separately; no bank is bundled or downloaded by the tool. Keep the bank's license and audition the actual timbre. Use a release tail for resolved endings; for loops, compose and listen to the seam rather than repeating an arbitrary decay. `media_pipeline` accepts `scoreRender:{backend:"soundfont",soundfont:"bank.sf2",releaseTail:1}` with the same score.

For a rhythm section, put kick, snare and hats on one `percussion:true` track. `pitch` is the General MIDI drum number, and `program` is the kit (zero for standard). The worker requests SoundFont bank 128, keeping drums separate from melodic programs. Missing kits fail explicitly. This short authored pattern uses quarter-note beats:

```json
{"score":{"bpm":100,"beats":4,"tracks":[{"percussion":true,"notes":[{"pitch":36,"start":0,"duration":0.1,"velocity":100},{"pitch":42,"start":0.5,"duration":0.1,"velocity":60},{"pitch":38,"start":1,"duration":0.1,"velocity":90},{"pitch":36,"start":2,"duration":0.1,"velocity":95},{"pitch":38,"start":3,"duration":0.1,"velocity":90}]}]},"backend":"soundfont","soundfont":"bank.sf2"}
```

SoundFont provenance is hashed incrementally, and a bank changed during rendering invalidates the receipt. `backend:"oscillator"` remains explicit even when an environment bank exists; it cannot render percussion.

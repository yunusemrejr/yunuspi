# Narration and sound

## Writing for the ear

- One idea per sentence, 8–18 words. Put the important word at the end of the sentence, where the voice lands.
- Say what the picture shows, in the order it appears, but add what the picture cannot: why it matters, what it replaced, what happens next.
- Avoid parentheses, lists read aloud, and symbols. Spell out numbers the way they should be spoken ("twenty seventeen", "a hundred million").
- Aim for about 3.3–4.3 syllables per second (roughly 140–170 words per minute for typical prose; short plain words can run faster in wpm while sounding relaxed). Dense technical passages go slower; transitions can go faster. `narration_tts` reports the measured rate per scene.
- Leave breaths: 0.3–0.6 s before a scene's narration starts (`narrationOffset`) and about 0.8 s after it ends before the cut.

## Preferred narration and local speech

Set `ELEVENLABS_API_KEY` in the private environment. Optionally set `ELEVENLABS_VOICE_ID` and `ELEVENLABS_TTS_MODEL`. Auto selection prefers ElevenLabs when configured; choose exact `voiceId`/`model` when the brief needs a particular voice. Do not substitute the selected voice/model after a failure.

```js
tool_search({ names: ["narration_tts"] })
narration_tts({ action: "status" })
narration_tts({ action: "voices" })                            // configured ElevenLabs account
narration_tts({ action: "synthesize", dir: "my-video", fitScenes: true })
narration_tts({ action: "synthesize", dir: "my-video", scenes: ["intro"], speed: 0.95 })
// Explicit local alternative, installed once per machine:
narration_tts({ action: "install", voice: "en_US-ryan-high" })
narration_tts({ action: "synthesize", dir: "my-video", backend: "piper", fitScenes: true })
```

`synthesize` writes `public/audio/narration/<scene>.wav` and records `narrationAudio`, decoded `narrationSeconds` and `narrationWords` in `video.json`. With `fitScenes: true`, scenes shorter than their narration and tail are lengthened (the default for ElevenLabs). Cloud text chunks carry neighbouring context and completed paid chunks are cached; completed scenes checkpoint immediately. Continue after an interruption with the same parameters. Request failures do not retry or change provider automatically.

Use `cueWords:{reveal:"engine#2"}` for the second occurrence of a word; synthesis writes the corresponding cue at `narrationOffset + wordStart - cueLead` (default lead 0.08 s). Run `media_sync({dir:"my-video"})` after every timing edit. Its frame audit flags text/word mismatches, stale duration, cues outside frames and speech crossing a cut. Let narration determine scene length and re-time visuals, rather than cutting words to fill a fixed slot.

Pronunciation: TTS guesses at names and acronyms. Pass a `lexicon` to `synthesize` instead of respelling narration text: `narration_tts({action: "synthesize", dir: "my-video", lexicon: {"Vaswani": "Vas-wah-nee", "GPT": "G P T"}})`. The lexicon applies to the spoken text only; `video.json` keeps the display spelling for captions and on-screen text, and the result reports `lexiconEdits` per scene. Re-synthesize only the affected scenes. Keep one project lexicon and reuse it for every synthesis run.

A human recording can replace any scene: put the file in `public/audio/narration/`, set `narrationAudio`, and measure `narrationSeconds` with `media_info`. `narration_align({path:"voice.wav",text:"The supplied transcript."})` returns word spans and loss values for existing recordings. Listen to high-loss spans; forced alignment locates supplied text rather than independently transcribing it. Align scene by scene for long recordings (32 MiB upload limit).

## Music bed

For a directed arrangement, use `audio_generate({kind:"music",prompt:"Instrumental piano and soft strings, builds into the reveal and ends with a resolved chord",seconds:45})`. Instrumental is the default; exact model selection and returned request/song IDs remain visible. Import the returned artifact into `public/` with `video_assets`, retain provenance/usage rights, and use the measured length. Do not assume the provider delivered an exact requested duration or seamless loop. Listen to entrances, narration balance and the ending before mixing. Long films can use separately directed section beds; crossfade them in a planned quiet or visual-only beat.

`audio_synth kind:"music"` renders a seeded ambient bed sized to the timeline. Direct it:

- `key`/`mode`: minor or dorian for reflective and documentary tones, major for optimistic tones.
- `progression`: four chords, `barsPerChord` 2 for calm, 1 for momentum.
- `bpm` 70–90 under narration. Faster tempos compete with speech.
- `layers`: lower `pulse` and `bell` for dense narration; raise them for visual-only beats. Add `drums` (0.2–0.4, kick on beats 1 and 3 plus eighth hats) for momentum sections and explainer energy; leave it at 0 under dense narration.
- `intensity`: automation points `[seconds, 0..1]` that follow the story arc: low in exposition, rising into the key reveal, resolving at the end. Drums follow the same automation.

The template ducks music under narration windows automatically (`musicVolume` to `musicDuckedVolume`). Measure the result with `video_qa`; adjust the two volumes in `video.json`.

## Sound accents

`audio_generate kind:"sfx"` produces a prompted accent when procedural sound cannot express it. For a browser demonstration, use `video_browser`'s observed click/key/scroll event times; planned times can differ when the page responds slowly. `media_sync action:"music_grid"` can suggest beat/bar/half-beat cue times from a supplied BPM and downbeat, but speech cues should stay anchored to words.

`audio_synth kind:"sfx"` with `type` whoosh (object crossing frame, transition), riser (tension into a reveal), downlifter (energy draining out, section end), impact (reveal lands), tick (items counting or stepping), pop (UI confirmations, small appearances), chime (conclusion, success). Use one accent per idea, place it at the visual event (`video.json` `audio.sfx: [{src, at, volume}]`), and keep it 6–12 dB under narration. If you can't say which visual event a sound belongs to, delete it.

## Captions and sound-driven visuals

Most viewers meet a video muted first. Keep `captions.enabled` on for explainers and social cuts: re-run `narration_tts` after editing a line. Use `karaoke` style for short social pieces where the active word helps pacing, `chunks` for calmer documentary work. The final render writes `captions.srt` and `captions.vtt`; upload them as platform subtitles instead of relying only on burned-in text. Captions use recorded `narrationWords` when text coverage matches; missing/stale words use a syllable estimate. Check chunks against the audio and run `media_sync`, including `path` for the final file's actual stream endings.

When music carries a section without narration, let the visuals listen: `AudioSpectrum` reads the actual audio file each frame (align it with `offsetSeconds` to where that audio starts). Tie accents to visible events: a `Glitch` or a `KineticText` word landing on the same frame as its sound accent reads as one gesture.

## Loudness targets

| Target | Integrated | Peak |
| --- | --- | --- |
| Web and social default | -16 LUFS | ≤ -1 dBFS |
| Platforms that normalize (YouTube) | -14 LUFS | ≤ -1 dBFS |
| Narration-only explainer | narration peaks around -3 to -6 dBFS; music 15–20 LU below the voice | |

Adjust `narrationVolume`, `musicVolume` and `musicDuckedVolume` in `video.json`, re-render, and measure with `video_qa`. For standalone audio deliverables, `media_edit action:"normalize"` does measured two-pass loudness normalization.

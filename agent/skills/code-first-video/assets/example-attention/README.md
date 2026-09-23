# Worked example: "How attention works" (36 s)

A complete small project produced with the code-first-video workflow and verified end to end: storyboard, master timeline, four custom scenes built from template primitives (`TokenRow`, `Matrix`, `NeuralNet`, `Heading`), local narration, a procedural music bed, two sound accents, three review rounds and a clean `video_qa`.

To reproduce it:

```js
video_project({ action: "init", dir: "attention" })
// copy video.json to the project root and scenes/* to attention/src/scenes/
video_render({ dir: "attention", mode: "stills" })
narration_tts({ action: "synthesize", dir: "attention", fitScenes: true })
audio_synth({ dir: "attention", kind: "music", key: "D", mode: "dorian", bpm: 78, progression: ["i", "VII", "VI", "VII"], intensity: [[0, 0.3], [8, 0.45], [18, 0.6], [28, 0.85], [35, 0.45]], layers: { pulse: 0.16, bell: 0.1 } })
audio_synth({ dir: "attention", kind: "sfx", type: "impact", name: "winner-hit", pitch: 1.2 })
audio_synth({ dir: "attention", kind: "sfx", type: "chime", name: "title-chime" })
// set audio.music and audio.sfx (15.2 s, 30.8 s, volume 0.35) in video.json, then:
video_render({ dir: "attention", mode: "final" })
video_qa({ path: "attention/out/final-…/final.mp4", dir: "attention" })
```

What the review rounds changed, as examples of the defects the QA loop exists to catch:

1. Frame review: the heat map was nearly invisible (fixed with normalized, gamma-lifted color), matrix column labels collided (angled labels), a title wrapped onto one orphan word (balanced wrapping), and a still sampled on a cue showed a half-built frame (stills now sample settled frames).
2. Motion review: the winning arc was gold before its reveal (it now stays neutral until its beat), group staggers were front-loaded by easing the whole group (primitives take linear `sweep` progress and ease each item), and the last arc never finished.
3. Audio and sync: Piper's default pace was fast (a calibrated default was added); cues were re-timed to the measured sentence onsets that `narration_tts` reports.
4. Final QA: a 5-second static hold got purposeful motion (a scan across the tokens as "the model works it out"), and an empty-looking scene opening got its matrix building under the first sentence. The matrix pulses as one on "computed in parallel".

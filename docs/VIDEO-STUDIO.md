# Code-first video studio

YunusPi agents can produce explainer, documentary and motion-design videos from code. A Remotion (React/TypeScript) project uses one master timeline, `video.json`, for scene order and duration, narration text and measured narration audio, scene-relative cues, music and sound effects. Reusable primitives provide animation; license-tracked media can be imported when appropriate. Rendering code reads that timeline, and both burned captions and sidecar subtitles use the same measured word timing when present.

The workflow lives in skills. `code-first-video` covers direction: research, narrative, storyboard, visual language and the review loop. `remotion-video` covers implementation and `procedural-audio` covers sound. The tools below are discovered with `tool_search` and do not expand the initial prompt.

| Tool | Does |
| --- | --- |
| `video_project` | `init` scaffolds a project with reusable primitives (network, matrix, graph, chart, history timeline, code, particles, typography, kinetic text) and finishing layers (narration captions, audio-reactive spectrum, film grain, light leaks, camera moves, glitch) and installs pinned dependencies; `check` validates timing, cues, narration fit, transitions, captions, component registry and assets; `install` repairs dependencies |
| `video_render` | `stills` renders representative frames and a labelled contact sheet; `preview` renders a low-resolution scene or range; `final` renders full-quality H.264/AAC with decode verification and writes `captions.srt` and `captions.vtt` when scenes have narration. Bundles are content-hash cached and renders are queued |
| `video_qa` | Black and frozen stretches (single holds of 4 s or more, and a runtime that is 35% or more static in holds of 1.5 s or more), audio/video drift, silence gaps, EBU R128 loudness, peak and range, per-scene narration audibility and a scene contact sheet for visual review |
| `narration_tts` | Local Piper neural narration: explicit one-time install of a pinned engine and checksum-verified voice; per-scene synthesis writing measured durations back to the timeline |
| `audio_synth` | Seeded numpy music beds (chord progression, intensity automation) and sound effects (whoosh, riser, impact, tick, chime) |
| `media_pipeline` | Selects audio editing/mixing, clip video composition or scene animation from its inputs; optional editable MIDI score → music bed → voice ducking/effects → render/master → decode and delivery loudness evidence in one call. Writes `pipeline.json` with stage timings and measurements |
| `audio_mix` / `video_compose` | Local bounded timelines with looping, pitch-preserving speed, noise reduction, filters, fades and voice/music roles. Music ducks from the actual voice signal; optional two-pass mastering measures the final WAV or AAC encoding |

`video.json` also sets burned-in captions (`captions: {enabled, style: "chunks" | "karaoke", maxWords, position}`) and per-scene entry transitions (`transition: {type: "fade" | "slide" | "wipe" | "zoom" | "blur", seconds}`). Captions use `narrationWords` recorded by Piper. When narration text changes or no word timing exists, both video and subtitles fall back to the same syllable-weighted estimate. Timeline validation rejects malformed audio arrays, cue objects and invalid word boundaries before final rendering.

```js
tool_search({ names: ["video_project", "video_render", "video_qa", "narration_tts", "audio_synth"] })
video_project({ action: "init", dir: "attention-video", title: "How attention works" })
// storyboard.md → edit video.json and src/scenes → then iterate:
video_render({ dir: "attention-video", mode: "stills" })        // read the contact sheet, fix, repeat
narration_tts({ action: "install" })                             // once per machine
narration_tts({ action: "synthesize", dir: "attention-video", fitScenes: true })
audio_synth({ dir: "attention-video", kind: "music", mode: "dorian", intensity: [[0, 0.3], [20, 0.8], [40, 0.4]] })
video_render({ dir: "attention-video", mode: "preview", scene: "attention" })
video_render({ dir: "attention-video", mode: "final" })
video_qa({ path: "attention-video/out/final-…/final.mp4", dir: "attention-video" })
```

For recurring local sound edits or finishing clips, use the smaller data-only pipeline. It selects only the required stages, preserves inputs and removes all new intermediate artifacts when a stage fails or is cancelled. A clip timeline mixes audio in the video render instead of creating a full intermediate mix. Ducking renders one bounded voice bus first, avoiding FFmpeg 8 scheduling failures that can silently remove compression or truncate the mix. Repeated uses of a source within one timeline share its FFprobe result. A mastered file's existing delivery measurements are reused instead of running another loudness analysis. Keep one-step edits on the focused tools; batching helps when a task would otherwise require several model/tool round trips.

```js
// Clean and edit speech; the speed changes tempo while preserving pitch.
media_pipeline({ duration: 20, targetLufs: -16,
  tracks: [{ path: "voice.wav", role: "voice", start: 2, duration: 18,
    highpass: 80, denoise: 6, speed: 1.1, fadeOut: 0.2 }] })

// A short music bed repeats to fill the timeline and ducks while voice is present.
media_pipeline({ clips: [{ path: "intro.mp4", duration: 3 },
    { path: "demo.mp4", start: 1, duration: 7 }], transition: "fade",
  transitionDuration: 0.5, targetLufs: -16,
  tracks: [{ path: "bed.wav", role: "music", loop: true, gain: 0.3 }] })

// Optional note-level music is delivered as MIDI, score JSON and a WAV audition.
media_pipeline({ animation: "scene.json", targetLufs: -16,
  score: { bpm: 90, beats: 8, stereo: true, tracks: [{ waveform: "triangle",
    notes: [{ pitch: 57, start: 0, duration: 4 },
      { pitch: 60, start: 4, duration: 4 }] }] },
  tracks: [{ path: "narration.wav", role: "voice" }] })
```

`role: "voice"` and `role: "music"` activate signal-driven ducking automatically; included clip audio is treated as voice. The default effect role preserves the existing mix behavior. Set `ducking: false` to disable it or pass `{thresholdDb, ratio, attackMs, releaseMs}` to tune it. Track `duration` is rendered seconds; `speed` controls source consumption, and `loop` repeats the source remainder after `start`. Noise reduction is optional and should be used lightly. Aggregate loop buffers are capped at 128 MiB. Timelines allow at most eight tracks and 120 seconds; video also has the existing pixel work budget. Scene animations retain their stricter 30-second renderer budget. Output duration is checked against the requested timeline before reporting success.

Mastering is optional for focused tools and `media_pipeline` (`targetLufs`). The mastering receipt contains before/after measurements of the delivery file; it does not substitute the requested target for an observed result. Silent audio remains silent and reports undefined loudness. `automatedChecks` distinguishes measured failures, success and unmeasured checks. The pipeline still requires a frame/motion or listening review appropriate to the artifact.

## Requirements and boundaries

- Node.js and npm. The first project install downloads the pinned Remotion, React and `@fontsource` packages (about 250 MB); later installs reuse the npm cache. Dependencies install with lifecycle scripts disabled.
- FFmpeg/ffprobe with `drawtext`, `xstack`, `blackdetect`, `freezedetect`, `silencedetect` and `ebur128`.
- A headless Chromium. The renderer uses Playwright's cached `chrome-headless-shell` when present (`YUNUSPI_VIDEO_BROWSER` overrides it); otherwise Remotion downloads its own browser on first render.
- Python 3 with numpy for `audio_synth`; Piper installs into `~/.pi/agent/local-models/piper` from binary wheels only, and voices are pinned to `rhasspy/piper-voices` tag v1.0.0 with SHA-256 checks. Piper requires an explicit `install` call. Project initialization installs npm dependencies by default (`install: false` creates only the files).
- Project code, npm, Remotion and the synthesizer run through the harness guarded-command wrapper, which keeps the harness read-only.
- Remotion is free for individuals and small teams; companies above its threshold need a Remotion company license.

Automated checks find technical defects only. A successful render or a clean `video_qa` is not visual approval: the skills require agents to view contact sheets and frames, review motion in previews, and check narration timing and loudness before delivery.

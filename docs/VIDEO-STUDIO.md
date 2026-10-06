# Code-first video studio

YunusPi agents can produce explainer, documentary and motion-design videos from code. A Remotion (React/TypeScript) project uses one master timeline, `video.json`, for scene order and duration, narration text and measured narration audio, scene-relative cues, music and sound effects. Reusable primitives provide animation; license-tracked media can be imported when appropriate. Rendering code reads that timeline, and both burned captions and sidecar subtitles use the same measured word timing when present.

The workflow lives in skills. `code-first-video` covers direction: research, narrative, storyboard, visual language and the review loop. `remotion-video` covers implementation and `procedural-audio` covers sound. The tools below are discovered with `tool_search` and do not expand the initial prompt.

| Tool | Does |
| --- | --- |
| `video_project` | `init` scaffolds a project with reusable primitives (network, matrix, graph, chart, history timeline, code, particles, typography, kinetic text) and finishing layers (narration captions, audio-reactive spectrum, film grain, light leaks, camera moves, glitch) and installs pinned dependencies; `check` validates timing, cues, narration fit, transitions, captions, component registry and assets; `install` repairs dependencies |
| `video_render` | `stills` renders representative frames and a labelled contact sheet; `preview` renders a low-resolution scene or range; `final` renders H.264/AAC with decode verification and captions. Long films automatically use resumable parts; `segments` exposes the same bounded workflow explicitly. Bundles and completed parts are content-hash cached |
| `video_qa` | Black and frozen stretches (single holds of 4 s or more, and a runtime that is 35% or more static in holds of 1.5 s or more), audio/video drift, silence gaps, EBU R128 loudness, peak and range, per-scene narration audibility and a scene contact sheet for visual review |
| `video_assets` | Finds and fetches license-tracked photographs, footage and CC0 3D models (Openverse, Wikimedia Commons, Poly Haven) into `public/assets`, records each licence in `assets.json` and adds required credits to `video.json` |
| `video_shot` | Renders a Blender camera move (a `.blend`, an imported model, or extruded 3D title text) into `public/shots/<name>` as a transparent RGBA sequence with named screen anchors. Palette lighting, ground shadows, depth of field, camera rigs and optional scale-aware surface detail; previews are half size |
| `video_browser` | Records a fresh browser take with eased cursor movement, click rings, typing and scrolling. Returns a constant-frame-rate MP4 and observed event/frame timestamps for placing callouts and sound effects |
| `motion_examples` | Searches, reads and copies worked examples of advanced motion: vanilla HTML/CSS/JS pages, Blender scripts, HTML+Blender merges, FFmpeg/libass and numpy. The catalogue is read from each example's own header |
| `narration_tts` | Prefers ElevenLabs timestamped speech when an API key is configured; exact voice/model selection, resumable paid text chunks and per-scene checkpoints. Explicit local Piper remains available with a checksum-verified install. Writes decoded durations and word timing to the timeline |
| `narration_align` | Sends an existing audio file and supplied transcript to ElevenLabs forced alignment; returns word spans, coverage, loss and matching captions. Alignment is not independent transcription |
| `media_sync` | Audits narration endings against cuts, text/word coverage, cue drift in frames and encoded audio/video boundaries. `music_grid` snaps cue times to a supplied tempo and downbeat |
| `audio_generate` | ElevenLabs instrumental music and sound effects with measured delivery duration and decode evidence; generated assets can be imported and mixed with voice |
| `audio_synth` | Seeded numpy music beds (chord progression, intensity automation) and sound effects (whoosh, riser, impact, tick, chime) |
| `media_pipeline` | Selects audio editing/mixing, clip video composition or scene animation from its inputs; optional editable MIDI score → music bed → voice ducking/effects → render/master → decode and delivery loudness evidence in one call. Writes `pipeline.json` with stage timings and measurements |
| `audio_mix` / `video_compose` | Local bounded timelines with looping, pitch-preserving speed, noise reduction, filters, fades and voice/music roles. Music ducks from the actual voice signal; optional two-pass mastering measures the final WAV or AAC encoding |

`video.json` also sets burned-in captions (`captions: {enabled, style: "chunks" | "karaoke", maxWords, position}`) and per-scene entry transitions (`transition: {type: "fade" | "slide" | "wipe" | "zoom" | "blur", seconds}`). Captions use `narrationWords` from the chosen speech backend. When narration text changes or no word timing exists, both video and subtitles fall back to the same syllable-weighted estimate. Re-synthesize changed text and run `media_sync`; timeline validation rejects malformed audio arrays, cue objects and invalid word boundaries before final rendering.

These tools use the same schemas and production code for every selected LLM. They preserve the chosen model and thinking settings. A storyboard, custom scene design and visual/audio review still determine the artistic result; tooling cannot guarantee equal direction from every model or identical quality for every subject.

```js
tool_search({ names: ["video_project", "video_render", "video_qa", "narration_tts", "media_sync", "audio_synth"] })
video_project({ action: "init", dir: "attention-video", title: "How attention works" })
// storyboard.md → edit video.json and src/scenes → then iterate:
video_render({ dir: "attention-video", mode: "stills" })        // read the contact sheet, fix, repeat
narration_tts({ action: "status" })                              // ElevenLabs configuration or Piper installation
narration_tts({ action: "synthesize", dir: "attention-video", fitScenes: true })
media_sync({ dir: "attention-video" })                          // fix drift or speech crossing a cut
audio_synth({ dir: "attention-video", kind: "music", mode: "dorian", intensity: [[0, 0.3], [20, 0.8], [40, 0.4]] })
video_render({ dir: "attention-video", mode: "preview", scene: "attention" })
video_render({ dir: "attention-video", mode: "final" })
video_qa({ path: "attention-video/out/final-…/final.mp4", dir: "attention-video" })
```

## Voice, music and timing

Set `ELEVENLABS_API_KEY` in the private environment; optionally set `ELEVENLABS_VOICE_ID` and `ELEVENLABS_TTS_MODEL`. `backend:"auto"` prefers ElevenLabs when configured. `narration_tts action:"voices"` lists the account's voices; `voiceId` and `model` select exact provider identifiers. `voice` selects a Piper voice, and `backend:"piper"` explicitly selects local speech after `action:"install"`. Failed cloud calls report the failure without paid retries or provider substitution.

ElevenLabs speech uses [character timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps). Text is split at sentence/word boundaries with neighbouring context, decoded into a continuous PCM clock, and caption timing follows the decoded part lengths. Project chunks live in `.video-cache/speech/`; only identical requests and verified audio bytes are reused. Completed scenes update `video.json` immediately, so a later failure preserves usable work. Scene durations fit speech by default for ElevenLabs, with a tail before the cut; re-render visuals after those durations change.

For recorded speech, `narration_align({path:"voice.wav", text:"The supplied transcript."})` uploads audio and text to [forced alignment](https://elevenlabs.io/docs/api-reference/forced-alignment/create). Listen to high-loss words: this locates supplied words and does not verify the recording's contents independently. Uploads are bounded to 32 MiB; align long recordings scene by scene.

`audio_generate({kind:"music", prompt:"Warm instrumental strings, restrained percussion, a resolved ending", seconds:45})` produces an instrumental bed by default. `kind:"sfx"` produces a directed accent. These use the [music](https://elevenlabs.io/docs/api-reference/music/compose) and [sound effects](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert) APIs; music requests allow 3–600 seconds and effects 0.5–30 seconds. Measured lengths can differ from the requested lengths. Import the returned file using `video_assets action:"import"`, then use its public-relative path in the timeline. Keep provenance and applicable usage rights with the asset. Local `audio_synth` and editable `music_compose` remain available.

`media_sync({dir:"my-video", path:"my-video/out/final-…/final.mp4"})` compares probed narration and delivery durations with scene frame boundaries. Its issues include text/word mismatches, stale audio duration, speech crossing a cut, unresolved cue words and cue drift. `cueWords:{reveal:"light#2"}` targets the second occurrence; `cueLead` defaults to 0.08 seconds. `media_sync({action:"music_grid", bpm:96, offset:0.2, times:[1,3,6], unit:"beat"})` returns suggested beat times; it uses the supplied tempo rather than guessing one and does not move speech cues.

## Long films and browser takes

Keep one project and one global frame clock, with narration split into scenes. `video_render mode:"final"` uses segments above 120 seconds; `mode:"segments"` or `segmentSeconds` chooses the same workflow for shorter films. A call renders at most `maxSegments` new parts (default 3, maximum 16). When the result says `complete:false`, call the returned `next` parameters until assembly succeeds. Each checked part is checkpointed, and completed parts survive cancellation or a later error. Changed source, settings or asset bytes invalidate the relevant cache; corrupt parts are re-rendered.

```js
video_render({ dir: "my-video", mode: "segments", segmentSeconds: 45, maxSegments: 2 })
// Continue with the returned next parameters while complete is false.
```

Parts cover contiguous inclusive frame ranges on the global timeline, preserving transitions across boundaries. They retain PCM audio so each seam does not accumulate AAC padding; assembly encodes AAC for the joined film. The final output is decoded and checked. Scene durations remain bounded to 600 seconds, but there is no former 30-minute total timeline cap. Disk space and guarded process budgets still apply; lower resolution or use shorter parts when the machine cannot finish a part. Run timing checks and technical QA on the assembled film, and view scenes on both sides of each join.

`video_browser` uses a fresh isolated browser rather than a logged-in profile. First inspect a site and use observed selectors or viewport coordinates. `url` accepts HTTP(S); `path` accepts self-contained local HTML. A take lasts 1–120 seconds, with at most 100 ordered steps. Capture longer walkthroughs as separate takes and import them into the master timeline.

```js
video_browser({ url: "https://example.com", seconds: 8, width: 1280, height: 720,
  steps: [{at:1, action:"move", selector:"h1", duration:0.6},
          {at:3, action:"scroll", dy:500, duration:0.8},
          {at:6, action:"mark", text:"detail"}] })
```

The returned `take.json` records actual event times, planned times and source-frame ages. Use observed click/typing times for sound effects and annotations. Review the recording and dropped-frame evidence: successful capture alone does not establish that the website reached the intended state. `wait_text` can verify a visible response after a click.

For recurring local sound edits or finishing clips, use the smaller data-only pipeline. It selects only the required stages, preserves inputs and removes all new intermediate artifacts when a stage fails or is cancelled. A clip timeline mixes audio in the video render instead of creating a full intermediate mix. Ducking renders one bounded voice bus first, avoiding FFmpeg 8 scheduling failures that can silently remove compression or truncate the mix. Repeated uses of a source within one timeline share its FFprobe result. A mastered file's existing delivery measurements are reused instead of running another loudness analysis. Keep one-step edits on the focused tools; batching helps when a task would otherwise require several model/tool round trips.

Before synthesis or output-directory creation, the pipeline validates source files, durations, timeline options and the voice/music roles required for ducking. Preflight and rendering share the same call-local source probes. Source inspection and frame extraction use at most four workers; the first failure stops new work, cancels siblings and waits for them to settle before cleanup, retaining the original cause.

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

## Looks, Blender shots and motion examples

**Derived looks.** `video_project action:"init"` (and `action:"look"`) builds the look from the subject unless a curated `look` id is given: a palette generated in OKLCH from the brief's traits, a type pair verified against the pinned `@fontsource` catalogue, a backdrop, captions, music style and narration voice that agree with each other. The generator steers away from stock looks (indigo/violet glow, cream with terracotta, the automatic teal-orange pair, rotation fonts) and the project's creative direction can list further things to avoid. `look:"suggest"` lists the curated looks; `variation` re-rolls a derivation; `accent` and `tone` anchor a brand colour or force a light or dark ground. `video_project action:"check"` lints the design (palette contrast, metronome pacing, transition monotony, avoided defaults) and the scene source (non-deterministic code, glow halos, violet gradients, left accent rails, hard-coded fonts and colours, emoji used as icons).

**Blender in the timeline.** `video_shot` renders the subject once; the template's `BlenderShot` plays the sequence (blending neighbouring frames, so a 12-15 fps render of a slow move plays smoothly at the film's fps), `ShotNote` and `ShotAnchor` pin annotations to named 3D anchors and fade them when the feature turns away, and `ShotScene` is the ready-made scene (`{"component":"ShotScene","props":{"shot":"gauge","notes":[...]}}`). `HtmlScene`/`HtmlMotion` embed a vanilla HTML page (`public/html/*.html` exposing `window.renderFrame(t)`) with the film's theme and fonts passed in, and `Grade` applies one colour treatment over the composited layers.

`surface:{texture:"brushed-metal", scale:120, bump:0.025, bevel:0.008, roughness:0.28, metallic:1}` adds optional material microdetail and edge highlights. `ceramic` and `organic` are also available. Existing material nodes are copied, the bump chains existing normals, and bevel width follows subject scale; the source model remains intact. Keep bumps subtle and compare a preview under the final lighting before paying for a full frame sequence.

**Motion examples.** `motion_examples action:"search"` finds worked, verified examples by the effect wanted; `copy` places one where the project looks for it. HTML: seekable CSS/WAAPI, `@property`, `linear()` springs, SVG morph and draw-on, SVG filter liquid type, curl-noise flow fields, WebGL2 domain warping and SDF raymarching, audio-reactive fields, scroll-driven animation, CSS 3D, halftone transitions, kinetic type. Blender: product hero with anchors, procedural materials, camera rigs, 3D kinetic type, geometry-node terrain, an HTML sequence as a device screen. Merges: HTML annotations tracked to Blender anchors; an FFmpeg composite of a shot over a rendered background. Also FFmpeg/libass kinetic type and numpy procedural frames. The `motion-approaches` skill explains how to choose and combine them; the harness stages these tools and delivers the relevant skill sections when a request is about advanced motion.

## Requirements and boundaries

- Node.js and npm. The first project install downloads the pinned Remotion, React and `@fontsource` packages (about 250 MB); later installs reuse the npm cache. Dependencies install with lifecycle scripts disabled.
- FFmpeg/ffprobe with `drawtext`, `xstack`, `blackdetect`, `freezedetect`, `silencedetect` and `ebur128`.
- A headless Chromium. The renderer uses Playwright's cached `chrome-headless-shell` when present (`YUNUSPI_VIDEO_BROWSER` overrides it); otherwise Remotion downloads its own browser on first render.
- `video_browser` uses the harness's pinned Playwright and Chrome channel; `PI_RENDER_BROWSER_CHANNEL=chromium` selects installed Playwright Chromium where appropriate. Browser captures retain the Chromium sandbox.
- Python 3 with numpy for `audio_synth`; Piper installs into `~/.pi/agent/local-models/piper` from binary wheels only, and voices are pinned to `rhasspy/piper-voices` tag v1.0.0 with SHA-256 checks. Piper requires an explicit `install` call. Project initialization installs npm dependencies by default (`install: false` creates only the files).
- Project code, npm, Remotion and the synthesizer run through the harness guarded-command wrapper, which keeps the harness read-only.
- Remotion is free for individuals and small teams; companies above its threshold need a Remotion company license.

Automated checks find technical defects only. A successful render or a clean `video_qa` is not visual approval: the skills require agents to view contact sheets and frames, review motion in previews, and check narration timing and loudness before delivery.

Standalone speech is available through `narration_tts action:"speak"`. `media_pipeline` combines SVG/Three.js timelines, voice, captions and ducked music; Blender inspection exposes evaluated animation frames, and stepped renders retain source timing. See [media creation](MEDIA-CREATION.md).

# Code-first video studio

YunusPi agents can produce explainer, documentary and motion-design videos from code. A Remotion (React/TypeScript) project uses one master timeline, `video.json`, for scene order and duration, narration text and measured narration audio, scene-relative cues, music and sound effects. Reusable primitives provide animation; license-tracked media can be imported when appropriate. Rendering code reads that timeline, and both burned captions and sidecar subtitles use the same measured word timing when present.

The shared tools own frame clocks, scene contracts and review evidence. Skills are optional workflow guides. `code-first-video` covers direction: research, narrative, storyboard, visual language and the review loop. `remotion-video` covers implementation and `procedural-audio` covers sound. The tools below can be found with `tool_search`; relevant tools are staged proactively for video and hybrid asset work within the host permission ceiling. Model/thinking selections remain unchanged.

| Tool | Does |
| --- | --- |
| `video_ambient` | `plan`, `preview` and `render` preserve an approved detailed plate with evolving clouds, masked mist, depth-weighted rain, wet-surface ripples and diffuse lightning on one clock. Optional periodic loops, inward matte feathering, bounded work, editable recipes and actual comparison frames; final source declaration and separate QA review are required |
| `video_project` | `direction` adopts the full existing creative brief; `upgrade` safely refreshes recognized compositor modules; `compose` authors native layers with fitted typography, reserved media regions, deterministic motion and tracked device screens; `init` scaffolds a project with reusable primitives (network, matrix, graph, chart, history timeline, code, particles, typography, kinetic text) and finishing layers (narration captions, audio-reactive spectrum, film grain, light leaks, camera moves, glitch) and installs pinned dependencies; `check` validates timing, cues, narration fit, transitions, captions, component registry and assets; `install` repairs dependencies |
| `video_render` | `stills` renders critical frames, a labelled contact sheet and actual loaded-font fit/overflow evidence; `preview` renders a low-resolution scene or range; `final` renders H.264/AAC with decode verification and captions. Long films automatically use resumable parts; `segments` exposes the same bounded workflow explicitly. Bundles and completed parts are content-hash cached |
| `video_qa` | `analyze` creates technical and reference/frame evidence; `record` stores separate art-direction/composition/type/playback/listening attestations; `status` checks stale video/project/reference/pixel identities. Black and frozen stretches (single holds of 4 s or more, and a runtime that is 35% or more static in holds of 1.5 s or more), audio/video drift, silence gaps, EBU R128 loudness, peak and range, per-scene narration audibility and paginated strips at entrances, settled states, authored gestures and final scene frames; review status remains unreviewed |
| `video_assets` | Finds and fetches license-tracked photographs, footage, CC0 3D models, PBR map sets and HDRIs (Openverse, Wikimedia Commons, Poly Haven) into `public/assets`, records each licence in `assets.json` and adds required credits to `video.json` |
| `video_generate` | Plans, submits, resumes and downloads short hosted clips from live OpenRouter model capabilities and duration prices. Content-keyed receipts prevent automatic paid resubmission; decoded clips become reusable assets |
| `video_shot` | Renders a Blender camera move (a `.blend`, an imported model, extruded 3D title text or native editable object graph) into `public/shots/<name>` as a transparent RGBA sequence with named screen anchors. Finished device rigs, alpha image cards, shared line/grid/radial instances, staggered motion, editable camera/target/lens paths, object parenting/keyframes, PBR maps, HDRI lighting, preserved authored cameras and optional surface detail; previews are half size |
| `video_browser` | Records a fresh browser take with eased cursor movement, mobile touch emulation, click/tap rings, selector highlights, focused typing and scrolling. Imported take metadata supplies action-follow framing and sound accents. Returns a constant-frame-rate MP4 and observed event/frame timestamps for placing callouts and sound effects |
| `motion_examples` | Searches, reads and copies worked examples of advanced motion: vanilla HTML/CSS/JS pages, Blender scripts, HTML+Blender merges, FFmpeg/libass and numpy. The catalogue is read from each example's own header |
| `narration_tts` | Prefers ElevenLabs timestamped speech when an API key is configured; exact voice/model selection, resumable paid text chunks and per-scene checkpoints. Explicit local Piper remains available with a checksum-verified install. Writes decoded durations and word timing to the timeline |
| `narration_align` | Sends an existing audio file and supplied transcript to ElevenLabs forced alignment; returns word spans, coverage, loss and matching captions. Alignment is not independent transcription |
| `media_sync` | Audits narration endings against cuts, text/word coverage, cue drift in frames and encoded audio/video boundaries. `music_grid` snaps cue times to a supplied tempo and downbeat |
| `audio_generate` | Selected local procedural or ElevenLabs instrumental music and sound effects with measured delivery duration and decode evidence; generated assets can be imported and mixed with voice |
| `audio_synth` | Seeded numpy music beds (chord progression, intensity automation) and sound effects (whoosh, riser, impact, tick, chime) |
| `media_pipeline` | Selects audio editing/mixing, clip video composition or scene animation from its inputs; optional editable MIDI score → music bed → voice ducking/effects → render/master → decode and delivery loudness evidence in one call. Writes `pipeline.json` with stage timings and measurements |
| `audio_mix` / `video_compose` | Local bounded timelines with looping, pitch-preserving speed, noise reduction, filters, fades and voice/music roles. Music ducks from the actual voice signal; optional two-pass mastering measures the final WAV or AAC encoding |

`video.json` also sets burned-in captions (`captions: {enabled, style: "chunks" | "karaoke", maxWords, position}`) and per-scene entry transitions (`transition: {type: "fade" | "slide" | "wipe" | "zoom" | "blur", seconds}`). Captions use `narrationWords` from the chosen speech backend. When narration text changes or no word timing exists, both video and subtitles fall back to the same syllable-weighted estimate. Re-synthesize changed text and run `media_sync`; timeline validation rejects malformed audio arrays, cue objects and invalid word boundaries before final rendering.

These tools use the same schemas and production code for every selected LLM. They preserve the chosen model and thinking settings. A storyboard, asset selection, scene direction and visual/audio review still determine the artistic result; tooling cannot guarantee equal direction from every model or identical quality for every subject.

```js
tool_search({ names: ["video_project", "video_render", "video_qa", "narration_tts", "media_sync", "audio_synth"] })
video_project({ action: "init", dir: "attention-video", title: "How attention works" })
// storyboard.md → video_project action:"compose" → then iterate (custom scene code remains available):
video_render({ dir: "attention-video", mode: "stills" })        // read the contact sheet, fix, repeat
narration_tts({ action: "status" })                              // ElevenLabs configuration or Piper installation
narration_tts({ action: "synthesize", dir: "attention-video", fitScenes: true })
media_sync({ dir: "attention-video" })                          // fix drift or speech crossing a cut
audio_synth({ dir: "attention-video", kind: "music", mode: "dorian", intensity: [[0, 0.3], [20, 0.8], [40, 0.4]] })
video_render({ dir: "attention-video", mode: "preview", scene: "attention" })
video_render({ dir: "attention-video", mode: "final" })
video_qa({ path: "attention-video/out/final-…/final.mp4", dir: "attention-video" })
```

## Fixed camera environments

For a fixed environment, approve the full-size image or Blender render before animating it. `video_ambient` preserves that authored detail and supplies procedural weather without a generated renderer project or substitute primitive scene. Provide a same-canvas `skyMask` (white sky, black terrain/buildings) or observed normalized `skyline` points from x:0 to x:1. Inspect the derived mask and preview to keep foreground edges stationary. Image input is decoded locally with bounded image formats; colors combine in RGB before the final H.264 conversion.

`cloudModel:"evolve"` uses seeded spatial fields to deform and shade the existing sky; `cloudScale` and `cloudContrast` control its forms. `fogMask`, `rainMask` and `reflectionMask` restrict mist, rain and existing reflected pixels respectively. Black pixels remain protected; `maskFeather` fades inward by a fraction of the short canvas side. Mist and ripples require explicit masks. Rain has different lengths, speeds and weights by depth. This image-space treatment preserves the source architecture and camera; it does not reconstruct geometry or simulate fluids or volumes.

`loop:true` closes all visual effects on the quantized frame clock; periodic cloud flow uses an integer number of cycles. Deliver the full period without a duplicate closing frame. A short preview uses the same period and reports that its excerpt is not a closed loop. `maxFramePixels` bounds the actual encoded canvas/frame work; a plan can expose an excessive final cost while allowing a smaller preview. Complete renders return start/interior/last-frame comparisons. QA decodes native atmosphere cadence automatically (up to 30 seconds/1,800 frames, with coverage stated) and checks the actual delivery's last-to-first transition. `checkMotion:true` and `loop:true` request these checks for other videos. Audio needs a separate playback/seam review, and technical motion checks never approve artistic quality.

```js
video_ambient({action:"plan", plate:"assets/approved-plate.png", skyMask:"assets/sky-mask.png", seconds:30, brief:"A detailed fixed-camera landscape at dusk", references:["references/landscape.png"]})
video_ambient({action:"preview", plate:"assets/approved-plate.png", skyMask:"assets/sky-mask.png", fogMask:"assets/valley-mask.png", reflectionMask:"assets/wet-road-mask.png", seconds:30, clouds:0.8, fog:0.5, reflections:0.4, rain:0.4, loop:true})
video_ambient({action:"render", stage:"final", plate:"assets/approved-plate.png", skyMask:"assets/sky-mask.png", fogMask:"assets/valley-mask.png", reflectionMask:"assets/wet-road-mask.png", audio:"assets/music.wav", seconds:30, fog:0.5, reflections:0.4, loop:true, lightning:[12.2], references:["references/landscape.png"]})
video_qa({path:"<returned ambient.mp4>"})
```

This is image-based atmosphere: cloud samples drift slowly inside the mask, rain is overlaid, and lightning changes light. It does not reconstruct 3D geometry, evolve volumetric clouds, articulate objects or simulate wet-ground reflections. Use authored Blender geometry/simulation or an explicitly chosen hosted clip when those motions are essential. A still plate's inherent mist and materials remain part of that image. Intentional calm holds still appear in freeze measurements; assess them against the brief.

Delivered native renders enter session-owned review tracking. `goal complete` and whole-plan completion check current QA identities; repeating the call cannot waive unfinished media review. `video_qa record` requires actual frames, playback or listening evidence for the relevant criterion. Standalone videos accept `references` without a Remotion project. Native recipe edits also invalidate reviews. Missing capabilities remain explicitly unreviewed. A direct human request such as “skip audio review” permits a recorded waiver of the current scope; synthetic prompts and model calls cannot grant it. New bytes or stale evidence require a new decision.

For a rejected take, `video_qa({action:"supersede", path:"old.mp4", report:"<old qa.json>", replacement:"new.mp4", reason:"<concrete defect>"})` preserves the old file and review while tracking its replacement. The new file needs its own analysis and review. A direct correction of an achieved goal reopens its criteria and invalidates prior approval of the rejected video bytes. Paused goals retain their pause. The session tracks native QA report hashes; editing approval metadata outside the native review owner cannot close a goal.

## Native choreography and hybrid asset craft

A shot layer with `subjectFit:false` retains the full Blender camera composition, including atmosphere, subject placement and reserved type space. Background-role shots default to this behavior. Foreground-only shots retain automatic subject fitting; `fit:"contain"|"cover"` controls their placement in the layer box.

Native layers support per-key easing (including exact holds/cuts and linear timing), cubic Bezier travel, axis squash/stretch, perspective rotations, blur, coordinated exits, stroke-drawn vector paths, counters and fixed-layout word/typewriter reveals. `wordCues` keeps typography attached to measured speech when narration changes. Native JSON examples can be copied and composed directly with `storyboard`. These are technique starters; final styling and assets follow the subject and references.

Create art as well as motion. `creative_direct` records the focal/signature subject, hierarchy, visual/material treatment, motion/audio and references; `video_project direction` preserves the complete brief. Use Blender scripts/native scene graphs or licensed models for editable geometry and relighting, and `image_generate` with an explicitly selected image model for detailed artwork, textures, backplates and cutouts. `video_assets import` preserves generated/captured lineage and film-resolution source images. Native image/shot/video layers combine them on the film clock. Blender `image-plane` cards preserve RGBA at real depth, support lit or unlit surfaces and pack artwork into the editable blend. A card remains a flat image; choose modeled geometry for changing views of the subject.

The original `blender/atmospheric-kiosk` example combines procedural architecture/materials, practical lights, an authored camera and a supplied image backplate. See the [hybrid art guide](../agent/skills/code-first-video/references/hybrid-art-production.md) for exact contracts and examples. User references can call for either restrained flat typography or rich cinematic imagery; avoid imposing one default look.

Declare unfinished layers with `asset:{stage:"blockout"|"draft"|"final",description}` and identify focal layers with `role:"hero"`. Explicit drafts and undersampled draft shots block final delivery. Asset checks flag missing files and excessive image enlargement; actual full-size pixels determine whether silhouette, materials, lighting and typography are finished. Font loading fails on missing pinned faces and uses locally bundled Unicode subsets.

Final shot planning preserves full 4K dimensions. Native self-contained shots can reuse verified frame/anchor/editable bytes; external blend/model dependencies are rendered afresh. Per-shot locks serialize replacements; failed or cancelled publication preserves the last good sequence and editable file. Verified cache reuse saves rendering work without granting visual approval.

QA strips include cue/key/exit boundaries and the true final frame. Technical success starts with reviewStatus unreviewed. Registered visual passes require current QA pixels delivered to an image-capable model or inspected through image_understand/read in this session. Art direction also requires current local reference pixels and named compared sources. Appearance needs frames/playback, motion/sync needs playback and audio needs listening. Changing local reference images, sampled pixels, project/assets or delivered bytes invalidates old verdicts. Paged reports approve their scope only. Pixel delivery proves access to evidence; the reviewer still owns its judgment.

Reference studies included varied kinetic typography, product staging and editorial animation, plus the diverse collection in [Column Five's motion examples](https://www.columnfivemedia.com/best-100-motion-graphic-examples/). Those examples inform composition, continuity and craft; they are not copied assets.


## Media choices and bounded generation

Open `/models` for the browser model editor, then choose **Images**, **Video** or **Audio** in the navigation. Search the public catalogs and inspect supported references, transparent backgrounds, frame inputs, durations and resolutions. **Use for session** applies choices immediately; **Save media choices** persists them through SettingsManager for future sessions. Audio has independent speech, music and SFX selections. For the terminal picker, `/scoped-models` uses **Tab / Shift+Tab** for LLM, Images, Video and Audio, Enter to choose and Ctrl+S to save media choices. Media choices never change the LLM, thinking, LLM cycling list or its request cache. An explicit tool `model` takes precedence over the saved choice, followed by existing environment configuration. Provider-qualified IDs use `openrouter/<vendor>/<model>`, `elevenlabs/<model>` or `local/<route>`.

The browser loads an image/video catalog when its media section is opened; Refresh catalog requests fresh metadata. The terminal picker refreshes catalogs when opened. Reads are cached for five minutes, bounded to 2 MiB and cancellable; opening the page never generates media. Catalog presence does not prove that an account can run a model. A saved route absent from the catalog stays visible. ElevenLabs speech/music/SFX routes and local routes remain available offline.

Native motion graphics is the bundled Video choice: real typography, browser events, licensed 3D assets and authored choreography use local rendering without hosted video charges. Image/video **automatic** is an explicit media choice. It filters advertised reference/alpha/aspect/resolution/frame capabilities, then selects a compatible endpoint with a known conservative price estimate. Image planning examines at most eight candidate endpoint catalogs; token/megapixel prices remain unknown and fail a capped automatic request. An exact image model without a cap retains its existing route. Automatic image selection defaults to $0.25 per image and clip planning to $1 per job; set `maxCostUsd` to a smaller limit when suitable. These are preflight estimates, not provider-enforced spending limits or quality rankings. Explicit selections are never silently replaced by a cheaper model.

```js
image_generate({action:"plan", model:"openrouter/auto", prompt:"A tactile red paper ornament on white", aspectRatio:"1:1", maxCostUsd:0.03})
image_generate({action:"generate", model:"openrouter/auto", prompt:"A tactile red paper ornament on white", aspectRatio:"1:1", maxCostUsd:0.03})
video_generate({action:"plan", model:"openrouter/auto", prompt:"A red ribbon settling onto a gift", seconds:4, resolution:"720p", aspectRatio:"16:9", maxCostUsd:0.5})
// Submit once, retain the returned job path; status/download do not generate another take.
video_generate({action:"submit", model:"openrouter/auto", prompt:"A red ribbon settling onto a gift", seconds:4, maxCostUsd:0.5})
video_generate({action:"status", job:".pi/media-generation/video-<hash>/job.json"})
video_generate({action:"download", job:".pi/media-generation/video-<hash>/job.json"})
```

Hosted clips use [OpenRouter's video API](https://openrouter.ai/docs/guides/overview/multimodal/video-generation) with existing private OpenRouter credentials. First/last frame paths are accepted only when the selected model supports them; inputs are decoded before submission. A durable receipt is written before the sole paid POST. Identical submissions reuse the existing job; `newTake:true` deliberately creates another take. Poll no sooner than ten seconds; returned usage and the actual decoded duration are retained. Uncertain submission outcomes keep their receipt and are never retried automatically. Cancellation stops local work; it does not cancel or refund an already submitted provider job. Download uses the authenticated fixed-host content endpoint rather than a supplied redirect URL. Import the returned artifact through `video_assets` and review it on the native master timeline.

Selected `local/procedural` music/SFX can also run outside a project with `audio_generate`; supply `style`, `seed` and `bpm` for music or `sfxType` for effects. Freeform prompts are retained as briefs; local synthesis uses authored parameters rather than semantic prompt interpretation. Piper speech is a separate local selection. Hosted ElevenLabs audio uses the existing provider contracts and account pricing; it does not use the image/video cost estimator.

## Voice, music and timing

Set `ELEVENLABS_API_KEY` in the private environment; optionally set `ELEVENLABS_VOICE_ID` and `ELEVENLABS_TTS_MODEL`. `backend:"auto"` prefers ElevenLabs when configured. `narration_tts action:"voices"` lists the account's voices; `voiceId` and `model` select exact provider identifiers. `voice` selects a Piper voice, and `backend:"piper"` explicitly selects local speech after `action:"install"`. Failed cloud calls report the failure without paid retries or provider substitution.

ElevenLabs speech uses [character timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps). Text is split at sentence/word boundaries with neighbouring context, decoded into a continuous PCM clock, and caption timing follows the decoded part lengths. Project chunks live in `.video-cache/speech/`; only identical requests and verified audio bytes are reused. Completed scenes update `video.json` immediately, so a later failure preserves usable work. Scene durations fit speech by default for ElevenLabs, with a tail before the cut; re-render visuals after those durations change.

For recorded speech, `narration_align({path:"voice.wav", text:"The supplied transcript."})` uploads audio and text to [forced alignment](https://elevenlabs.io/docs/api-reference/forced-alignment/create). Listen to high-loss words: this locates supplied words and does not verify the recording's contents independently. Uploads are bounded to 32 MiB; align long recordings scene by scene.

`audio_generate({kind:"music", prompt:"Warm instrumental strings, restrained percussion, a resolved ending", seconds:45})` produces an instrumental bed by default. `kind:"sfx"` produces a directed accent. These use the [music](https://elevenlabs.io/docs/api-reference/music/compose) and [sound effects](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert) APIs; music requests allow 3–600 seconds and effects 0.5–30 seconds. Measured lengths can differ from the requested lengths. Import the returned file using `video_assets action:"import"`, then use its public-relative path in the timeline. Keep provenance and applicable usage rights with the asset. Local `audio_synth` and editable `music_compose` remain available. `music_compose backend:"soundfont",soundfont:"bank.sf2"` uses libfluidsynth for real stereo instruments, preserving MIDI programs, pan and note timing with release tails. Auto prefers a supplied bank or `YUNUSPI_SOUNDFONT`; without one it returns a labeled oscillator audition. `media_pipeline scoreRender` exposes the same renderer. Bank digest, source peak, output length and note-clock tolerance are recorded.

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

The returned `take.json` records actual event times and source-frame ages. `video_assets import` copies portable event metadata; compose `hero:{kind:"video",src,take,zoom:1.8}` follows observed action targets/clicks (or freeform pointer samples), establishes the view, and clamps crops to real image bounds. Native `startFrom` is seconds; legacy `Clip startFrom` is frames. Use observed click/typing times for sound effects and annotations. Review the recording and dropped-frame evidence: successful capture alone does not establish that the website reached the intended state. `wait_text` can verify a visible response after a click.

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

**Blender in the timeline.** `video_shot` renders the subject once; the template's `BlenderShot` plays the sequence at delivery fps without blending by default; preview shots and accidental low-rate final motion are blocked from final export, `ShotNote` and `ShotAnchor` pin annotations to named 3D anchors and fade them when the feature turns away, and `ShotScene` is the ready-made scene (`{"component":"ShotScene","props":{"shot":"gauge","notes":[...]}}`). `HtmlScene`/`HtmlMotion` embed a vanilla HTML page (`public/html/*.html` exposing `window.renderFrame(t)`) with the film's theme and fonts passed in, and `Grade` applies one colour treatment over the composited layers.

`surface:{texture:"brushed-metal", scale:120, bump:0.025, bevel:0.008, roughness:0.28, metallic:1}` adds optional material microdetail and edge highlights. `ceramic` and `organic` are also available. Existing material nodes are copied, the bump chains existing normals, and bevel width follows subject scale; the source model remains intact. Keep bumps subtle and compare a preview under the final lighting before paying for a full frame sequence.

**Motion examples.** `motion_examples action:"search"` finds worked, verified examples by the effect wanted; `copy` places one where the project looks for it. HTML: seekable CSS/WAAPI, `@property`, `linear()` springs, SVG morph and draw-on, SVG filter liquid type, curl-noise flow fields, WebGL2 domain warping and SDF raymarching, audio-reactive fields, scroll-driven animation, CSS 3D, halftone transitions, kinetic type. Blender: product hero with anchors, procedural materials, camera rigs, 3D kinetic type, geometry-node terrain, an HTML sequence as a device screen. Merges: HTML annotations tracked to Blender anchors; an FFmpeg composite of a shot over a rendered background. Also FFmpeg/libass kinetic type and numpy procedural frames. The `motion-approaches` skill explains how to choose and combine them; the harness stages these tools and delivers the relevant skill sections when a request is about advanced motion.

See [native production contracts](../agent/skills/code-first-video/references/native-production.md) for complete compose, browser, device, screen and instrument workflows, plus the source patterns reviewed from Blender Agent Studio, blender-skills, MCP for Blender and Motion AI Kit.


## Image cards, arrays and camera flythroughs

Combine designed/generated raster assets with real 3D rather than flattening the whole film into a hosted clip. `shape:"image"` is a UV-mapped plane facing -Y in the Z-up native scene; it respects PNG/WebP alpha, derives aspect from the decoded image, and defaults to unlit color for UI/graphic fidelity. Set `unlit:false` for a card that responds to scene lighting, `opacity` for a fade, or `size` for explicit metres. Native instancing shares geometry/material/texture data and supports line, grid and radial layouts, up to 192 objects per shot. Complex devices/imported models use their authored hierarchy or a bpy/Geometry Nodes workflow instead of this array helper.

```js
video_shot({action:"plan", dir:"film", name:"cards", seconds:4, shadow:"none",
  scene:{objects:[{id:"card",shape:"image",path:"public/assets/card.png",
    position:[-2,0,0],size:[1.2,0.01,1.5],
    instances:{count:5,layout:"line",spacing:[1,0.6,0],stagger:0.12},
    motion:[{t:0,position:[-2,0,-1],rotation:[0,0,-8],ease:"backOut"},
            {t:1.5,position:[-2,0,0],rotation:[0,0,0]}]}]},
  cameraPath:[{t:0,position:[0,-7,2],target:[0,0,0],lensMm:35},
              {t:2,position:[1,-5,1],target:[0,0,0],lensMm:42,ease:"inOut"},
              {t:4,position:[3,-3,1.5],target:[1,1,0],lensMm:50}]})
// Same request with action:"render" and mode:"preview", then mode:"final" after review.
```

Object key `ease` describes the incoming segment (`linear`, `inOut`, `in`, `out`, `backOut`). Instance `stagger` delays each copy; the last copy must begin within the shot. Camera path keys start at t=0, with ordered scene-relative times, position, target and optional lens. The worker samples position/target/lens and depth-of-field focus distance into editable Blender keys. Path cameras use the supplied framing rather than automatically fitting the subject: inspect clipping at every critical camera/object gesture. Use detailed licensed models, PBR/HDRI lighting, appropriate bevels and reflections for product heroes; a generic device blockout does not establish commercial finish.

`video_shot action:"plan"` resolves inputs and validates arrays, paths and pixel/sample/pass work without creating scene or render output. Default `maxRenderWork` is 80 billion pixel-samples; resolution, frame count, samples and soft-shadow passes all contribute. This proxy bounds a request, not elapsed render time. Shared geometry reduces scene storage, while render time still depends on lighting, geometry and the machine. Begin with a short low-resolution preview, reuse accepted assets and render independent shots into one film at delivery fps. For more advanced deformation, simulation or procedural geometry, use the guarded `blender_run` data API and preserve the authored camera with `video_shot blend`.

## Requirements and boundaries

- Node.js and npm. The first project install downloads the pinned Remotion, React and `@fontsource` packages (about 250 MB); later installs reuse the npm cache. Dependencies install with lifecycle scripts disabled.
- FFmpeg/ffprobe with `drawtext`, `xstack`, `blackdetect`, `freezedetect`, `silencedetect` and `ebur128`.
- A headless Chromium. The renderer uses Playwright's cached `chrome-headless-shell` when present (`YUNUSPI_VIDEO_BROWSER` overrides it); otherwise Remotion downloads its own browser on first render.
- `video_browser` uses the harness's pinned Playwright and Chrome channel; `PI_RENDER_BROWSER_CHANNEL=chromium` selects installed Playwright Chromium where appropriate. Browser captures retain the Chromium sandbox.
- Optional instrument music: Python 3 standard library, libfluidsynth and a user-selected licensed SF2/SF3 bank. No bank or paid motion content is bundled.
- Python 3 with numpy for `audio_synth`; Piper installs into `~/.pi/agent/local-models/piper` from binary wheels only, and voices are pinned to `rhasspy/piper-voices` tag v1.0.0 with SHA-256 checks. Piper requires an explicit `install` call. Project initialization installs npm dependencies by default (`install: false` creates only the files).
- Project code, npm, Remotion and the synthesizer run through the harness guarded-command wrapper, which keeps the harness read-only.
- Remotion is free for individuals and small teams; companies above its threshold need a Remotion company license.

Automated checks find technical defects only. A successful render or a clean `video_qa` is not visual approval: the skills require agents to view contact sheets and frames, review motion in previews, and check narration timing and loudness before delivery.

Standalone speech is available through `narration_tts action:"speak"`. `media_pipeline` combines SVG/Three.js timelines, voice, captions and ducked music; Blender inspection exposes evaluated animation frames, and stepped renders retain source timing. See [media creation](MEDIA-CREATION.md).

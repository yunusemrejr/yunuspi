# Code-first video studio

YunusPi makes films from code through one pipeline: a Remotion 4.0.529 project from cinetic's starter (MIT licensed), with three.js, `@remotion/three` and `@react-three/fiber` pinned in. One timeline file, `src/timeline.ts`, drives picture, cues and sound. The [cinetic skill](../agent/skills/cinetic/SKILL.md) is the direction guide: brief, treatment, brand, timeline, acts, sound, render and review.

The agent chooses the engine and the voice from the subject, the environment and the user's words; anything the user names explicitly wins. Remotion with three.js suits designed 3D subjects, type and motion graphics. Blender suits photoreal or heavy scenes, delivered as footage or as GLB ([3D studio](3D-STUDIO.md)). HyperFrames suits HTML and GSAP work, and FFmpeg suits footage the user supplied. No planning file or plan action is required before rendering.

`/video <assignment>` (see [GOAL.md](GOAL.md#3d-video-anatomy-and-chaining)) boosts a film goal and chains with `/3d` and `/noslop`. The tools below can be found with `tool_search`.

## Tools

| Tool | Does |
| --- | --- |
| `video_project` | `status` reports the Python tools; `install` creates one shared Python venv for cinetic's render and QA scripts; `init` scaffolds a film with cinetic's `new-film.sh` (size or format, fps, bpm, pace, name, vendored fonts) and adds the pinned three.js packages; `check` runs TypeScript, `lint-film` and the beat grid |
| `video_render` | `stills` renders chosen frames (or evenly spaced ones, default 6) through one bundle and one browser, with a labelled contact sheet; `preview` runs cinetic's `render.sh` quick render with the soundtrack muxed; `final` runs `render.sh` with motion blur, where `budget` caps the blur cost |
| `video_qa` | `analyze`, `listen`, `record`, `status` and `supersede`; see [Video QA](#video-qa) |
| `narration_tts` | Speech: `status`, `voices`, `install` (Piper), `speak` and `recover` |
| `audio_generate` | Instrumental music beds and sound effects |
| `audio_mix` | Timelines with voice and music roles; music ducks under the voice |
| `video_browser` | Real website takes with an observed event clock |
| `blender` | Models and renders 3D; see [3D studio](3D-STUDIO.md) |

## Film projects

```js
video_project({ action: "install" })                        // once per machine
video_project({ action: "init", dir: "films/attention", format: "landscape", fps: 60, name: "Attention" })
// Set the brand in src/brand/tokens.ts, then write src/timeline.ts and the acts in src/acts/
video_project({ action: "check", dir: "films/attention" })
video_render({ dir: "films/attention", mode: "stills" })    // read the contact sheet and full-size stills
video_render({ dir: "films/attention", mode: "preview" })
video_render({ dir: "films/attention", mode: "final", budget: 6 })
video_qa({ action: "analyze", path: "films/attention/out/film.mp4" })
```

A film directory must be inside the workspace. `init` writes a placeholder brand that `lint-film` rejects until it is replaced, and it installs the npm dependencies. `stills` writes a new `out/stills-…` folder; `preview` and `final` write `out/preview.mp4` and `out/film.mp4`. When `audio` is not given, `video_render` muxes `public/audio/soundtrack.wav` if that file exists.

Keep the machine usable: previews at preview scale, one render and one browser at a time, long renders in the background, and the motion-blur master once at the end.

## Review

Look at every contact sheet and the full-size stills that matter before calling a film done: composition, type, colour against the brand tokens, and the 3D subject's detail and light. When the selected model cannot read images, pass the PNG to `image_understand`. Technical checks (TypeScript, `lint-film`, the beat grid, `video_qa`) do not establish artistic approval; view the frames and play the motion.

## Narration and sound

**Narration.** `narration_tts` uses ElevenLabs when `ELEVENLABS_API_KEY` is set and local Piper otherwise (`backend:"auto"`). If ElevenLabs rejects the key, its credits or its rate limit, auto falls back to Piper once. `backend:"elevenlabs"` never falls back and never retries a paid request. `ELEVENLABS_VOICE_ID` and `ELEVENLABS_TTS_MODEL` set the default voice and model; an explicit `voiceId`, `model` or `voice` wins, and a speech model selected in `/models` is used when chosen.

`speak` takes up to 120 seconds of text per call, so make one call per line or paragraph. It returns a WAV, aligned words and SRT/VTT. `voices` lists ElevenLabs voice IDs, `install` sets up Piper, and `recover` reassembles saved ElevenLabs checkpoints without a paid request.

**Music and effects.** `audio_generate` makes an instrumental music bed (3 to 600 seconds) or a directed sound effect (0.5 to 30 seconds, with a loop option). A local selection in `/models` synthesizes procedurally; a cloud selection uses ElevenLabs and needs `ELEVENLABS_API_KEY`. Measured duration can differ from the requested one, and paid requests are never retried or replaced automatically. Use `audio_mix` with the music role to duck the bed under the narration.

`music_compose` writes an editable score. With a licensed SoundFont bank (`backend:"soundfont"`) it renders instrument audio through libfluidsynth; without one it returns a labelled oscillator audition. cinetic's guide also names the earshot kit as a sound source. Say which source produced each sound.

## Video QA

`video_qa` audits a rendered file. Its checks find technical defects; `record` stores review attestations, which are not automated artistic approval.

- `analyze` looks for black and frozen stretches, audio/video duration drift, silence gaps, EBU R128 loudness, peak and range against `targetLufs` (default -16 LUFS), per-scene narration audibility, and cue, exit and transition evidence at exact endpoint frames. It returns a labelled evidence strip; `startScene` pages through long films, eight scenes at a time.
- `listen` transcribes the master with local speech recognition (the first call sets that up). With `script`, it reports word error rate against the script, which may be a `.txt`, `.md` or narration `.json` path, or the spoken text itself. It also measures speech over music and loudness, and writes `<file>.listen.json`.
- `record` stores verdicts on art direction, composition, typography, motion, sync and audio against the brief and any named `references`. Each verdict cites its evidence (frames, sequence, measured, playback or listening). Art-direction verdicts need current pixels delivered to a vision model or inspected with `image_understand`/`read`.
- `status` rejects evidence that is stale after the video, the project, the sampled pixels or a local reference image changes. `supersede` retires a rejected delivery in favour of an existing replacement and keeps the rejected file.

Goal completion checks the current QA records of delivered films. Repeating a call does not waive an unfinished media review; only a direct request from the user to skip a review counts as a waiver.

## Browser takes

`video_browser` records a website take in a fresh, isolated Chromium profile. No logged-in profile is imported. The pointer moves at human pace, and the take can show click rings, highlights, typing and scrolling. A take lasts 1 to 120 seconds and holds at most 100 ordered steps. `device:"phone"` records mobile layout and touch input. The result is a constant-frame MP4 and a `take.json` with the actual click, key and target times and source-frame timestamps.

```js
video_browser({ url: "https://example.com", seconds: 8, width: 1280, height: 720,
  steps: [{at:1, action:"move", selector:"h1", duration:0.6},
          {at:3, action:"scroll", dy:500, duration:0.8},
          {at:6, action:"mark", text:"detail"}] })
```

Observe selectors with `browser_session` first. Place the take in the film's `public/` folder and time callouts and sound effects to its observed events. Split longer walkthroughs into separate takes. A successful capture does not show that the site reached the intended state: review the recording, and use `wait_text` to check a visible response after a click.

## Media choices and bounded generation

Open `/models` and choose **Images** or **Audio** (speech, music and sound effects). **Use for session** applies a choice immediately; **Save media choices** keeps it for future sessions. Media choices never change the LLM, its thinking level or its request cache. An explicit tool `model` takes precedence over the saved choice, then the existing environment configuration. Provider-qualified IDs look like `openrouter/<vendor>/<model>`, `elevenlabs/<model>` or `local/<route>`.

Opening `/models` never generates media, and a catalog entry does not prove that an account can run a model. Video has no hosted route: it is always rendered locally. Image generation and its cost planning are described in [media creation](MEDIA-CREATION.md).

## Requirements and boundaries

- Node.js and npm. The first film install downloads the pinned Remotion, React and three.js packages (about 300 MB); later films reuse the npm cache. Dependencies install with lifecycle scripts disabled, and film commands run through the harness guarded-command wrapper.
- Python 3 for `video_project install`: a venv under `~/.pi/agent/local-tools/film/venv` with binary wheels only, for numpy, scipy, soundfile, opencv-python-headless, pyloudnorm, fonttools and pillow.
- FFmpeg and ffprobe with `drawtext`, `xstack`, `blackdetect`, `freezedetect`, `silencedetect` and `ebur128`, for contact sheets and `video_qa`.
- A headless Chromium. Film renders use Playwright's cached `chrome-headless-shell` when present (`YUNUSPI_VIDEO_BROWSER` overrides it); otherwise Remotion downloads its own browser on the first render. `video_browser` uses the harness's pinned Playwright and Chrome channel; `PI_RENDER_BROWSER_CHANNEL=chromium` selects installed Playwright Chromium where appropriate.
- Piper installs into the harness `local-models` folder from binary wheels only, with voices pinned to `rhasspy/piper-voices` tag v1.0.0 and SHA-256 checks. It needs an explicit `install`.
- Remotion is free for individuals and small teams; companies above its threshold need a Remotion company license.

Automated checks find technical defects only. A successful render or a clean `video_qa` is not visual approval. For standalone speech, Blender inspection and image work, see [media creation](MEDIA-CREATION.md).

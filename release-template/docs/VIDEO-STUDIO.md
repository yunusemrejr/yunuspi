# Code-first video studio

YunusPi agents can produce polished explainer and documentary videos entirely from code: no stock footage, no image or video generators and no GUI editors. A video is a Remotion (React/TypeScript) project driven by one master timeline, `video.json`. It owns scene order and duration, narration text and measured narration audio, scene-relative cues, music and sound effects. Rendering code reads that timeline, so picture, voice and sound cannot drift apart.

The workflow lives in skills. `code-first-video` covers direction: research, narrative, storyboard, visual language and the review loop. `remotion-video` covers implementation and `procedural-audio` covers sound. The tools below are discovered with `tool_search` and do not expand the initial prompt.

| Tool | Does |
| --- | --- |
| `video_project` | `init` scaffolds a project with reusable primitives (network, matrix, graph, chart, history timeline, code, particles, typography, kinetic text) and finishing layers (narration captions, audio-reactive spectrum, film grain, light leaks, camera moves, glitch) and installs pinned dependencies; `check` validates timing, cues, narration fit, transitions, captions, component registry and assets; `install` repairs dependencies |
| `video_render` | `stills` renders representative frames and a labelled contact sheet; `preview` renders a low-resolution scene or range; `final` renders full-quality H.264/AAC with decode verification and writes `captions.srt` and `captions.vtt` when scenes have narration. Bundles are content-hash cached and renders are queued |
| `video_qa` | Black and frozen stretches, audio/video drift, silence gaps, EBU R128 loudness, peak and range, per-scene narration audibility and a scene contact sheet for visual review |
| `narration_tts` | Local Piper neural narration: explicit one-time install of a pinned engine and checksum-verified voice; per-scene synthesis writing measured durations back to the timeline |
| `audio_synth` | Seeded numpy music beds (chord progression, intensity automation) and sound effects (whoosh, riser, impact, tick, chime) |

`video.json` also sets burned-in captions (`captions: {enabled, style: "chunks" | "karaoke", maxWords, position}`), timed from each scene's narration text and measured length with syllable weights and punctuation pauses (an estimate, not speech alignment), and per-scene entry transitions (`transition: {type: "fade" | "slide" | "wipe" | "zoom" | "blur", seconds}`). Prompts that ask for an explainer, documentary or narrated video put the five tools on the wire for the first model turn.

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

## Requirements and boundaries

- Node.js and npm. The first project install downloads the pinned Remotion, React and `@fontsource` packages (about 250 MB); later installs reuse the npm cache. Dependencies install with lifecycle scripts disabled.
- FFmpeg/ffprobe with `drawtext`, `xstack`, `blackdetect`, `freezedetect`, `silencedetect` and `ebur128`.
- A headless Chromium. The renderer uses Playwright's cached `chrome-headless-shell` when present (`YUNUSPI_VIDEO_BROWSER` overrides it); otherwise Remotion downloads its own browser on first render.
- Python 3 with numpy for `audio_synth`; Piper installs into `~/.pi/agent/local-models/piper` from binary wheels only, and voices are pinned to `rhasspy/piper-voices` tag v1.0.0 with SHA-256 checks. Nothing downloads without an explicit `install` call.
- Project code, npm, Remotion and the synthesizer run through the harness guarded-command wrapper, which keeps the harness read-only.
- Remotion is free for individuals and small teams; companies above its threshold need a Remotion company license.

Automated checks find technical defects only. A successful render or a clean `video_qa` is not visual approval: the skills require agents to view contact sheets and frames, review motion in previews, and check narration timing and loudness before delivery.

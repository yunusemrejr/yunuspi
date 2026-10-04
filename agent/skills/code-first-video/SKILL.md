---
name: code-first-video
description: Direct and produce explainer, documentary or motion-design videos entirely in code (Remotion React/TypeScript, SVG, Canvas, optional Three.js, local TTS narration, procedural music and FFmpeg), with no stock footage or generated images. Use for any request to make, script, storyboard, animate, narrate, render or review a video; it sequences research, narrative, storyboard, master timeline, implementation and a mandatory visual/audio QA loop.
---

# Code-first video direction

Treat the video as software whose output is judged by eye and ear. The failure mode to avoid is a slideshow: text cards with fades. Every beat must show an idea working, a visual system the viewer watches change, not a sentence to read.

Move through the phases in order and do not skip a gate. Read [production pipeline](references/production-pipeline.md) for the artifacts, gates and when to use subagents. Scale ceremony to the job: a 20-second loop needs a short storyboard and one review pass; a three-minute documentary needs research notes, a script, a full storyboard, per-scene reviews and an independent review.

1. **Research → narrative.** Gather facts with sources before writing. Write for the ear: one idea per sentence, concrete nouns, about 3.3–4.3 spoken syllables per second.
2. **Storyboard before code.** For each beat: the claim, the visual metaphor, what moves and why, on-screen text (≤ 8 words), duration. Read [visual language](references/visual-language.md) to turn abstract concepts into visual systems, choose primitives, set typography and use motion to carry meaning.
3. **Master timeline.** `video_project action:"init"` scaffolds a Remotion project whose `video.json` owns scene order, seconds, narration, scene-relative cues, music and sound. Narrative, data and timing live there; components only render. Never hard-code timing that narration depends on.
4. **Implementation.** Build reusable scene components from the primitives, parameterised by props from `video.json`. Load the remotion-video skill for code patterns and determinism rules.
5. **Representative-frame review.** `video_render mode:"stills"` returns a labelled contact sheet. Open it with `read` and critique it hard, then fix and re-render. Repeat until every scene passes. Read [QA loop](references/qa-loop.md) for the defect checklist.
6. **Motion review.** `video_render mode:"preview"` per scene or range. Check pacing, easing, transitions and whether motion explains anything. Sample frames around transitions with `video_frames`.
7. **Narration and audio.** `narration_tts` voices each scene and writes measured durations back into the timeline. `audio_synth` creates the music bed and sparse sound accents. Read [narration and sound](references/narration-and-sound.md).
8. **Sync review, final render, final QA.** Re-time cues to the narration's key words, then `video_render mode:"final"` and `video_qa` with `dir` set. Fix every error and review the contact sheet before delivery.

Tools beyond the core loop, used when the video calls for them:
- `video_project action:"init"` also takes `topic`, `look` (omitted or `derive` builds a palette, type pair, backdrop, voice and music from the subject and steers away from the stock looks; `suggest` lists curated ones; `variation` re-rolls and `accent` anchors a brand colour), `format` (landscape, vertical, square), `intent` (publish or personal) and `platforms`; `action:"look"` swaps the look later, `action:"cta"` places like, follow, comment and share moments, `action:"feature" feature:"3d"` adds the optional three.js `Model3D` primitive.
- `video_shot` renders a Blender camera move (a .blend, an imported model or extruded 3D title) into `public/shots/<name>` as a transparent frame sequence lit in the film's palette, with named anchors so 2D annotations follow 3D features (`ShotScene`, `ShotNote`). `motion_examples` returns worked examples of advanced motion (vanilla HTML/CSS/JS, WebGL, SVG, Blender scripts, HTML+Blender merges, FFmpeg, numpy) to search, copy and adapt: use it before writing any hero motion from memory, and read the motion-approaches skill to choose and combine approaches and to avoid the stock motion look.
- `video_assets` finds and fetches license-tracked photographs, footage and CC0 3D models (Openverse, Wikimedia Commons, Poly Haven) into `public/assets`, records each license in `assets.json` and adds required credits to `video.json`. Use it when a real photograph or model beats a drawn one; never take media from elsewhere without its license.
- `video_render mode:"thumbnail"` renders the 1280x720 cover from `publish.thumbnail`; `mode:"final"` masters the audio to delivery loudness and writes captions, chapters and a description draft. `audio_synth kind:"sound_design"` places sound accents from the timeline.

Render within the machine's memory: iterate at `preview` scale or a small `width`/`height`, render a `scene` or `from`/`to` range instead of the whole film while iterating, and keep procedural music to the length the video needs. The harness stops any render or synthesis that outgrows its memory budget and says so; when that happens lower the resolution or render in ranges rather than retrying the same request.

See the [worked example](assets/example-attention/README.md) for a complete small project and the defects its review rounds caught.

A successful render, a passing `video_qa` or a clean type check is never evidence that the video looks or sounds good. Only viewed frames, watched motion and measured, listened-to audio are.

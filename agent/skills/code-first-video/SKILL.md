---
name: code-first-video
description: "Direct and produce explainer, documentary or motion-design videos in code (Remotion, SVG, Blender, browser takes, narration, music, FFmpeg) through storyboard, master timeline, review loops and sync QA, including long films; use to make, script, storyboard, animate, narrate, render or review a video."
---

# Code-first video direction

Treat the video as software judged by eye and ear; every beat must show an idea working, not a text card with a fade.

## Production gates (do not skip)
1. Research, then narrative: sourced facts; write for the ear (one idea per sentence).
2. Storyboard before code: per beat the claim, visual metaphor, motion, on-screen text (8 words max) and duration. Record `beat:{role,claim,visualAction}` per scene.
3. Master timeline: `video_project action:"init"` (flow promo, explainer, walkthrough, longform or loop). `video.json` owns order, seconds, narration, cues and music; components only render. Existing projects start with `video_project action:"plan"`.
4. Implementation: `video_project action:"compose"` first (`hero` staging or normalized `layers`). Write custom scenes only when native layers cannot express the argument.
5. Stills: `video_render mode:"stills"` gives a labelled contact sheet. Critique it, fix, re-render until every scene passes.
6. Motion: `video_render mode:"preview"` per scene or range; check pacing, easing, transitions and cuts (`video_frames`).
7. Narration and sound: `narration_tts` (ElevenLabs preferred; local Piper selectable) writes durations and word spans to the timeline; `audio_generate` directs instrumental music and accents; `audio_synth` provides local procedural sound.
8. Sync and final: resolve `cueWords` to key words, run `media_sync`, then `video_render mode:"final"`, continuing returned `next` parameters while `complete:false`. Run `video_qa` and `media_sync` on the joined file with `dir`.

Scale ceremony to the job: a 20-second loop needs one review pass; a three-minute documentary needs per-scene and independent reviews.

## Before expensive work
- Run `video_render mode:"review"` first: key cue, cut and critical frames at full size plus a decoded clip up to 12 s. Read, play and listen. Check `coverage`; omitted evidence is not whole-film review.
- Prove the hero frame and 2–4 s of motion before rendering minutes.
- Render within memory: preview scale or a `scene` or `from`/`to` range. If the harness stops a render for memory, lower resolution or use ranges; never retry unchanged.
- Long films: `video_render mode:"segments", segmentSeconds:45, maxSegments:2`; keep scene IDs and style consistent; review both sides of every join.
- Standalone Blender or FFmpeg films need no Remotion project.

## Assets and art direction
- Preserve the `creative_direct` brief (`video_project action:"direction"`); name the subject, hierarchy and material before the hero.
- Build detailed assets in Blender or from licensed models. `image_generate` makes artwork, backplates, cutouts and textures; `video_assets import` keeps provenance. Never use media without its license.
- A ball with eyes is not a complex world asset; more samples cannot fix a weak silhouette. Abstract forms and flat type are fine when the brief asks for them.
- Blender: `blender` action `render` returns review paths and a vision handoff for text-only models. `video_shot` renders camera moves as transparent sequences with named anchors; preview at half size; run finals in the background.
- `video_browser` records bounded takes; verify with `wait_text`, then import with `video_assets`.
- Take hero motion from `motion_examples` (motion-approaches), not from memory.

## Verification
- A successful render or technical `video_qa` pass proves file mechanics only. `video_qa action:"record"` stores art-direction, composition, typography, motion, sync and audio verdicts; later edits make old reviews stale.
- Unviewed frames, unwatched motion and unheard audio stay unreviewed. For pixel review, use `image_understand action:"models"` and an explicitly permitted model.

## Tools
- `video_project init` also takes `look`, `format` and `intent`.
- `video_render mode:"thumbnail"` renders the 1280x720 cover; `mode:"final"` masters audio to delivery loudness and writes captions, chapters and a description draft.
- `audio_synth kind:"sound_design"` places sound accents from the timeline.
- Worked example: [example-attention](assets/example-attention/README.md).

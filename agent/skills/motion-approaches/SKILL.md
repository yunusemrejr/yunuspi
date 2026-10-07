---
name: motion-approaches
description: Choose and combine the ways to make advanced motion graphics for video - vanilla HTML/CSS/JS pages (seekable CSS, WAAPI, SVG morph and draw-on, SVG filters, canvas, WebGL shaders, raymarching, scroll-driven animation, kinetic type), Blender scenes and shots (product hero, materials, camera rigs, geometry nodes, 3D type), merging HTML with Blender (annotations pinned to 3D anchors, HTML as a screen texture, FFmpeg composites), FFmpeg/libass and numpy procedural frames - using the worked examples in motion_examples.
---

# Motion approaches

A film's motion is chosen per idea, not per habit. Start native staging with `video_project compose` and `video_shot scene` for clean typography, device rigs and shared cue timing. Most scenes belong in Remotion primitives; the ones that carry the film (a hero move, a transition, a product moment, a data reveal) usually need something stronger, and the strongest results combine two approaches. Do not write advanced motion from memory: `motion_examples action:"search" query:"<the effect>"` returns worked, verified examples with the concepts they use; `action:"copy"` places one in the project; adapt it to the film's look.

## Pick the approach by what the idea needs

| The idea needs | Approach | Enters the film as |
|---|---|---|
| Typography, shapes, data marks, morphs, draw-on, liquid or halftone effects, shader fields, 2D/2.5D worlds | Vanilla HTML page exposing `window.renderFrame(t)` | `HtmlScene` (or `render.mjs` for a standalone clip) |
| Real 3D form: product, object, lit materials, depth of field, camera moves, extruded type, terrain | Blender scene + `video_shot` | `ShotScene` / `BlenderShot` (RGBA frames + anchors) |
| 3D with crisp typography and annotations that follow it | HTML or Remotion layer over the shot, pinned to anchors | `ShotScene` notes, or `merge/shot-overlay.html` |
| UI or footage living on a tracked device | Native laptop/phone plus a `screen` video layer; use baked emission textures when reflections need screen content | `video_shot scene` + compose `hero.screen`, or `blender/html-as-texture.py` |
| Stacks of effects, a shared grade, or output without a browser | FFmpeg filter graphs and libass; numpy for math-heavy frames | `merge/composite.mjs`, `ffmpeg/`, `python/` |

Read [choosing](references/choosing.md) for the full matrix, costs and failure modes before committing, and [motion originality](references/motion-originality.md) before designing: it is the guard against generic motion (the same fade-up stagger, glow, particle field and slow zoom on every scene).

## Rules for every approach

- Every frame is a pure function of absolute time `t`. No `Date.now`, no unseeded `Math.random`, no rAF accumulation, no CSS transitions that depend on wall-clock time. The pages and scripts here already follow this; keep it when adapting.
- Theme and fonts come from the film: HTML pages read `window.__PROPS__.theme`/`.fonts` (HtmlScene supplies both); Blender shots take the project's palette (`video_shot` passes it). An example's own default colours are placeholders, never the design.
- One signature move per scene, supported by quiet. Decide the hero motion first, then what must stay still around it.
- Preview small and cheap, judge frames, then render final. `video_shot` previews at half size; vanilla pages render at 640x360 for review; software WebGL scales with `props.scale`.
- Verify by viewing: contact sheets of real frames, not exit codes.

## References

- [choosing](references/choosing.md): the decision matrix, costs, determinism and failure modes of each approach.
- [html-css-js](references/html-css-js.md): the vanilla toolbox for advanced motion (seekable CSS, typed properties, springs, SVG, filters, canvas, WebGL, scroll-driven) and the page contract.
- [blender-driven](references/blender-driven.md): what Blender adds to a film, how to light, shade and move it, and how to keep it cheap and deterministic.
- [merge-html-blender](references/merge-html-blender.md): the ways to combine the two approaches and the handoff checklist.
- [other approaches](references/other-approaches.md): FFmpeg/libass kinetic type, numpy frames, Remotion-native, three.js, and how to extend the library.
- [motion originality](references/motion-originality.md): deriving motion language from the subject and avoiding the stock look.

Related skills: code-first-video (the whole production loop), remotion-video (scene code), motion-graphics-production (the frame exporter), blender-production (headless Blender discipline).

---
name: motion-approaches
description: "Choose and combine ways to make advanced motion graphics for video (vanilla HTML/CSS/JS or WebGL pages, Blender shots, HTML-Blender merges, FFmpeg/libass, numpy frames, native compose layers) and find verified worked examples with motion_examples."
---

# Motion approaches

Choose motion per idea, not by habit. Stage ordinary scenes natively (`video_project compose`, `video_shot scene`). Give scenes that carry the film (hero move, transition, product moment, data reveal) a stronger approach, often two combined.

## Choose by what the idea needs
| Idea needs | Approach | Enters the film as | Example ids |
|---|---|---|---|
| Layouts, text, charts, scene transitions (the default) | Native compose | `video_project compose` layers; `native/` JSON | native/kinetic-words, native/process-flow |
| Kinetic type, SVG morph or draw-on, liquid or halftone filters, canvas flow, scroll demos | Vanilla HTML page exposing `window.renderFrame(t)` | `HtmlScene`; `render.mjs` for a standalone clip | html/kinetic-type-lines, svg-morph-draw, svg-filter-liquid, halftone-transition |
| Shader fields, raymarched SDF forms, domain warps | WebGL/GLSL in a page (one full-screen shader) | as an HTML page | html/webgl-domain-warp, webgl-raymarch-sdf |
| Lit 3D: products, materials, depth of field, camera moves, extruded type, terrain | Blender shot | `video_shot` gives `ShotScene` or `BlenderShot` (RGBA frames, anchors) | blender/product-hero, materials, camera-rigs, geonodes-terrain |
| Labelled 3D, UI on a tracked screen | Blender + HTML merge | `ShotNote` callouts; `merge/shot-overlay.html`; `blender/html-as-texture.py` | merge/shot-overlay, blender/html-as-texture |
| Grades, blends, ASS text, glitch, speed ramps, composites without a browser | FFmpeg filter graphs / libass | a graph over the composite (one grade for 2D and 3D) | ffmpeg/ass-kinetic, merge/composite |
| Math-heavy seeded fields, fractals, simulations, data | numpy/Pillow frames | image sequences composited into the film | python/numpy-frames |
| A lit GLB inside a Remotion scene | three.js `Model3D` (opt-in) | `Model3D` primitive | none |

Read [choosing](references/choosing.md) for costs and failure modes before committing.

## Rules for every approach
- Find before writing: `motion_examples action:"search" query:"<effect>"`, then `action:"copy"` into the project. Adapt it; example colors and fonts are placeholders. Feed the film's theme and fonts (`window.__PROPS__.theme`, `.fonts`; HtmlScene supplies both).
- Every frame is a pure function of absolute time `t`: no `Date.now`, unseeded random, rAF accumulation or wall-clock CSS transitions. Pages wait for `document.fonts.ready`.
- `fetch()` of local JSON fails under `file://` in the exporter; use XHR or inline the data.
- Decide one signature move per scene, supported by quiet. Before designing, read [motion-originality](references/motion-originality.md) to avoid the stock look (fade-up stagger, glow, particle field, slow zoom).
- Preview small and cheap: `video_shot` previews at half size, pages render at 640x360, WebGL uses `props.scale` 0.5. Judge contact sheets of real frames, not exit codes. Run Blender finals once, in the background.
- Alpha: use `--alpha` when a page sits over footage. Blender's view transform differs from CSS, so judge in the composite. 12 fps is a draft; deliver at film fps.
- Loops: review full playback and the last-to-first seam; a shorter preview does not prove closure.
- Inspect Blender shaders and lights with `blender` action `inspect`; judge pixels, not settings.

## References
- [choosing](references/choosing.md): decision matrix, costs, determinism and failure modes.
- [html-css-js](references/html-css-js.md): page contract and the vanilla toolbox (seekable CSS, SVG, filters, canvas, WebGL, scroll-driven).
- [blender-driven](references/blender-driven.md): lighting, materials, moves, anchors, and cheap deterministic Blender.
- [merge-html-blender](references/merge-html-blender.md): five ways to combine HTML and Blender, plus the handoff checklist.
- [other-approaches](references/other-approaches.md): FFmpeg/libass, numpy frames, Remotion-native, three.js, extending the library.
- [motion-originality](references/motion-originality.md): deriving motion language from the subject.

Related: code-first-video (production loop), remotion-video (scene code), video-editing (render.mjs exporter, timeline starter), 3d-cad (headless Blender).

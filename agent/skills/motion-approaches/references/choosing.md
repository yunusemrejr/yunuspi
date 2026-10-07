# Choosing between motion approaches

Decide from the idea, then check cost and failure modes. Several approaches in one film is normal; several in one scene needs a plan (see [merge-html-blender](merge-html-blender.md)).

## Matrix

| Approach | Best at | Weak at | Determinism | Cost on this machine |
|---|---|---|---|---|
| Remotion primitives (React) | Layouts, text, charts from `video.json`, transitions between scenes | Heavy per-pixel effects, true 3D | Pure by construction | cheap |
| Vanilla HTML/CSS/JS page | Kinetic type, SVG morph/draw, filters (liquid, goo, chroma), canvas flow, halftone, audio-reactive, scroll-driven demos, any effect already written for the web | Real lighting, 3D with materials, big particle counts (CPU canvas) | Pure if it obeys the page contract; verify by rendering the same time twice | cheap; WebGL runs in software GL, so keep it to one full-screen shader at 640x360 for review |
| WebGL / GLSL in a page | Fields, domain warping, raymarched SDF forms, procedural textures, transitions | Meshes with imported assets; debugging | Pure (time as uniform) | moderate in software GL; scale down with `props.scale` |
| Blender via `video_shot` | Lit 3D objects, materials, depth of field, soft shadows, camera moves, extruded type, procedural terrain | Crisp UI text (rasterised), fast iteration | Deterministic at fixed seed/samples | ~0.3-5 s/frame at preview size, minutes for a final; run finals in the background |
| Blender + HTML merge | Annotated 3D, UI on a device, hybrid title sequences | Two pipelines to keep in sync | As above | sum of both |
| FFmpeg filter graphs / libass | Grades, blends, text with ASS animation, glitch, speed ramps, composites, no browser | Complex layout; per-element easing | Deterministic | cheapest per frame |
| numpy/Pillow frames | Math-heavy visuals (fields, fractals, simulations, data), reproducible with a seed | Typography, interactive-style effects | Deterministic with a seed | ~40 ms/frame at 720p for a field |
| three.js (`Model3D`) | A lit GLB in the Remotion scene, orbit, simple PBR | Offline-quality materials, DOF, soft shadows | Pure | moderate; Blender is better when quality matters |

## Decision shortcuts

- "Make the text/shapes do something striking": a vanilla page (kinetic-type-lines, svg-filter-liquid, svg-morph-draw, halftone-transition).
- "A product/object/space that looks real": Blender shot; materials and lighting do the work. Add `ShotNote` callouts for labels.
- "Show a UI/app/chart on a screen in a scene": render the page with `render.mjs`, then `html-as-texture.py`; or skip 3D and use `css-3d-stage` when a perspective plane is enough.
- "Atmosphere/backdrop that is not generic": a shader field (webgl-domain-warp, canvas-flow-field, numpy-frames) derived from the film's palette, transparent so Remotion owns the layout.
- "A transition that belongs to the film": halftone-transition, SVG goo/displacement, a Blender camera move through a title, a wipe tied to the narration beat.
- "Many clips need one finish": FFmpeg grade over the composite so 2D and 3D layers share the same curve and grain.

## Cost and risk rules

- Time-box exploration: preview-size renders and contact sheets first (`video_shot` previews, `render.mjs` at 640x360, `video_render mode:"stills"`).
- A Blender final is the expensive step. Lock framing, lighting and the move at preview quality; render once at `mode:"final"` in the background.
- Software WebGL: one full-screen shader, no big textures, `props.scale` 0.5 while iterating.
- Never ship an example's placeholder palette or font; feed the film's look (the `theme` and `fonts` props).
- Prefer one clean idea executed well to three effects layered. If two approaches fight (a glowing particle field behind a lit 3D object), drop one.

## Handoffs that fail

- Fonts: a page that never waits for `document.fonts.ready` renders the fallback face. Pages here wait; copy that.
- `fetch()` of local JSON fails under `file://` in the exporter; use XHR or inline the data (shot-overlay does).
- Alpha: render with `--alpha` (PNG with transparency) when the page will sit over something; flatten for review only.
- Colour: Blender's view transform differs from CSS. Set the Blender world and light colours from the palette and judge in the composite, not in isolation.
- Frame rate: 12 fps is a draft preview. Delivery uses the film fps; frame blending ghosts outlines and cannot recover missing motion.

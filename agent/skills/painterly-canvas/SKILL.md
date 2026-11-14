---
name: painterly-canvas
description: Paint illustrations in JavaScript on a 2D canvas that look hand-painted - dusk and night landscapes, towering sunset cumulus in palette-knife strokes, star fields and moons, sea and far towns, power lines, pampas grass, cosmos flowers and fireflies, finished with grain and dither like a printed digital painting. Use when someone wants a painted-looking picture, wallpaper, poster, hero or scene drawn in code (not flat vector art), or shows a painterly reference and asks for that look. Not for flat icons and spot art (illustration-svg), isometric figures (iso-glow, anatomy) or 3D (threejs-3d).
---

# Painterly canvas

A kit that builds a painted picture the way a painter does: big value masses first, then thousands of small seeded brush marks, then a print-like finish. Everything is deterministic (seeded), so a picture can be tuned and rendered again identically.

Files:
- `paint.js`: the kit (`window.Paint`, no dependencies).
- `examples/evening-field.js`: a full scene (dusk field above the sea) that shows every brush in use. Start from it.
- `examples/evening-field.jpg`: what it renders to.
- `render.sh <scene.js> <out.png> [w] [h] [seed]`: renders a scene with headless Chrome, CPU raster, about 2 s at 1080x1860.

## Method

1. **Plan the values before colours.** Sketch the composition in three bands (sky, middle distance, foreground) and decide where the brightest light and the darkest dark go. One light source: for dusk scenes the low sun lights the clouds from one side and below, the sky above is already night.
2. **Build each palette as a ramp** (`Paint.ramp`) from shadow to light, taken from the subject or the reference: sky top to horizon, cloud shade to lit edge, sea far to near, grass deep to tip. A ramp per material keeps colour coherent; never pick colours dab by dab.
3. **Paint back to front:** `sky` (gradient covered in horizontal knife dabs) -> `stars`/`sparkle` -> `moon` -> `cumulus` (back clouds first, cooler ramp) -> `band` (horizon glow) -> `ridge` -> `sea` with `glints` -> `town` -> `pole` + `wire` + `bird` -> `meadow` -> far `cosmos` -> `plume` (pampas) -> front blades -> big `cosmos` -> `fireflies` -> `finish`.
4. **Clouds** (`cumulus`): give the tower profile (`towers: [{at, h, w}]`), a ramp from shade to lit, and a light direction. Bubbles fill the profile, a solid core blocks gaps, and each dab is shaded by blending the bubble's normal with the whole cloud's (`global`, default 0.5) so light falls in broad planes. Raise `bubbles` for denser cauliflower crowns, `baseSize` for bigger lobes, `ao` for a darker base. Use `tint` to cool the side away from the light.
5. **Finish** (`finish`): clumped grain plus an ordered-dither posterise (`levels` ~24-32) gives the speckled printed texture; `vignette` 0.2-0.3. It runs over the whole canvas once, last.

## Matching a reference

When the user shows a painting: match it closely (that is the request), not loosely. Read off its composition (horizon height, where the main mass sits), its 5-8 key colours per material (sample them from the image with PIL rather than guessing), its mark size and its grain. Render, view the PNG next to the reference at the same size, and fix the biggest difference first: silhouette and value masses, then colour, then texture. Two or three rounds are normal.

## Checks before handing over

- Look at the full picture and at a 1:1 crop of the busiest area. Common faults: a cloud reading as a bunch of separate balls (raise `global`), holes where sky shows through a cloud, dark shade tones matching the sky (shift the ramp's dark end toward violet), canvas showing through between layers (extend the layer below), repeated items without variety.
- Nothing physically wrong: one light direction, wires hanging from the crossarms, stems rooted in the ground, the moon's lit side toward where the sun went down.
- Size: 1080x1860 is the default portrait; scale every measure with `s = W / 1080` as the example does so any size works. Large sizes (4K+) multiply dab counts: time a 1080 render first (see the machine-limits skill).
- Original pictures only: take the look and technique from a reference, never trace or copy another artist's picture or signature.

# Vanilla HTML/CSS/JS for advanced motion

A page is a self-contained scene. It exposes `window.renderFrame(seconds)`; the exporter (`motion-graphics-production/scripts/render.mjs`) or Remotion's `HtmlMotion` calls it once per frame and takes a screenshot. Everything on the page is a pure function of `seconds`. Each worked example in `motion_examples` (approach `html`) carries its own header listing the concepts; this file explains the toolbox and the contract.

## The page contract

- `window.renderFrame = async (t) => { ... }`; may be async (await fonts, images, decodes). The exporter awaits it, then screenshots.
- Props: `window.__PROPS__` (set before scripts by `render.mjs --props=file.json`, by HtmlMotion in Remotion) or `?props=<json>` in the URL. Read `theme` (`background`, `ink`, `muted`, `accent`, `accent2`, `text`, `display`, `mono`) and `fonts` (family -> `{url, weight}[]`); map them to CSS variables at the top. `transparent: true` removes the page's own ground so Remotion's Stage shows through.
- Fonts: load `FontFace` from the supplied URLs and `await document.fonts.ready` before the first frame.
- `document.body.classList.contains('exporting')` is set during export: hide hover or debug UI.
- Never use `Date.now()`, `performance.now()`, unseeded `Math.random()`, `requestAnimationFrame` accumulation, `setTimeout` choreography or CSS `transition`s. Seed a PRNG (mulberry32) and derive everything from `t`.
- Loops: make the clip periodic in `duration` (integer turns per clip, `sin(2*pi*t/duration)`), so the last frame leads into the first.

## Seekable CSS (waapi-timeline)

Write motion as ordinary CSS keyframes, then drive them from the clock: `document.getAnimations().forEach(a => { a.pause(); a.currentTime = t * 1000 })`. Delays and staggers declared in CSS (`animation-delay: calc(var(--i) * 90ms)`) just work; the same page is a live web animation when opened in a browser. Use `animation-fill-mode: both` so frames before the start and after the end are correct.

- `@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg }` makes gradients, angles and counters interpolable: conic sweeps, animated colour stops, number counters via `counter-reset` and `counter()`.
- `linear()` easing carries a sampled damped spring or bounce: generate the points from the closed-form spring (`1 - e^(-zt) cos(wd t)`) and paste into `animation-timing-function: linear(...)`.
- Prefer `transform`, `opacity`, `clip-path`, `filter` (compositor-friendly, no layout).

## Typography

- Split with `Intl.Segmenter` (grapheme) so emoji and combining marks survive; animate per-character with `transform` and `opacity`, never by re-flowing text.
- Closed-form springs (`pos(t) = target - (target - from) * e^(-zeta*w*t) * (cos(wd*t) + (zeta*w/wd)*sin(wd*t))`) give per-glyph physical settle without simulation state.
- Variable fonts: animate `font-variation-settings` (`wght`, `wdth`, `slnt`) for weight pulses and optical sizing; check the face actually has the axes.
- Focus pull: blur and opacity falloff by distance from the current word; keep the reading line sharp.
- Masks beat fades: a line rising out of an `overflow: hidden` wrapper reads as intent; a plain fade-up reads as default.

## SVG

- Trim-path draw-on: `pathLength="1"`, `stroke-dasharray="1"`, animate `stroke-dashoffset` from 1 to 0. Works for any path without measuring.
- Travel along a path: `getPointAtLength(s * getTotalLength())` for position, `atan2` from a nearby second sample for orientation.
- Path morph: resample both paths to N points (equal arc-length), align the start (find the cyclic shift that minimises summed squared distance), then interpolate point-wise; closed-shape morphs stay clean when topology matches.
- Filters as a pipeline: `feTurbulence` -> `feDisplacementMap` (liquid warp of real HTML text), `feGaussianBlur` + `feColorMatrix` with a steep alpha ramp (goo/metaball merge), offset channels via `feColorMatrix` + `feOffset` + `feBlend` (chromatic aberration). Animate `baseFrequency`, `scale` and `seed`-free noise offsets from `t`.
- Data marks: build charts by hand; each mark is a function of progress; odometers are strips of digits translated by the value (render adjacent rows so rolling digits show both neighbours).

## Canvas 2D

- Flow fields stay frame-pure by evaluating the field analytically at `(x, y, t)` and drawing streamlines by integrating from fixed seeds each frame (no persistent particles). Curl noise (the rotated gradient of a scalar noise) is divergence-free, so flows look fluid.
- Audio-reactive: precompute bands and onset from the actual audio file (`extract-envelope.py`), pass the JSON; sample at `t`, smooth with a stateless one-pole formula over a lookback window, never with frame-to-frame state.
- Halftone/dither transitions: sample two procedural scenes on a coarse grid, compare luminance to an ordered (Bayer) threshold advancing with progress; pixels switch scene as the threshold passes.

## WebGL2 (one fragment shader, full-screen triangle)

- Domain warping: `f(p + fbm(p + fbm(p)))` produces organic flowing structure; add contour lines with `fract` + `fwidth` for graphic clarity.
- Raymarched SDFs: smooth union (`smin`) melts shapes; normals from central differences; soft shadows by marching toward the light and tracking the narrowest miss; AO from a few distance probes.
- Time is a uniform; never accumulate. Compile once, set uniforms, draw, `gl.finish()`, then return so the screenshot sees the frame. `preserveDrawingBuffer: true` if reading back.
- Software GL (no GPU in headless): keep to one pass, lower the internal resolution with a `scale` prop, avoid more than ~64 march steps.

## CSS 3D and scroll-driven

- Perspective worlds: `perspective` on the stage, `transform-style: preserve-3d`, planes at different `translateZ`; a rack focus is a blur that changes with each plane's depth distance from the focal plane.
- Scroll-driven animations (`animation-timeline: scroll()` / `view()`) let one source serve a website and a video: in export, set the scroller's position from `t` and the same CSS plays.

## Pitfalls

- `backdrop-filter`, `mix-blend-mode` over transparency and huge blurs are expensive and sometimes wrong in headless; test one frame.
- `will-change` on many layers hurts memory; use sparingly.
- Fractional device pixels blur 1px lines: align strokes to the pixel grid or render at `--dpr=2` and downscale.
- Large images: decode before the frame (`await img.decode()`), or the screenshot shows nothing.
- Review at small size, then confirm the final size once: shader detail and 1px rules change with resolution.

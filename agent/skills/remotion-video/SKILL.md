---
name: remotion-video
description: "Implement programmatic video in Remotion (React/TypeScript) in a YunusPi project: frame-pure scenes driven by video.json timing, SVG/Canvas primitives, captions, transitions, audio layers, optional three.js, and stills, previews and finals via video_render; use for Remotion compositions, scenes, primitives or render failures."
---

# Remotion video implementation

## Project contract
- Start with `video_project action:"init"`. `action:"compose"` authors native `StudioScene` layers: fitted type, reserved hero regions, camera crops, `ShotScreen` on tracked device corners. Native `startFrom` is seconds; legacy `Clip startFrom` is frames.
- `video.json` owns timing and content. `src/timeline.ts` derives frames (`timeline()`, `cue(scene, name)`, `toFrames()`); scenes never hard-code seconds that narration depends on.
- `src/scenes/index.ts` registers the component names used in `video.json`. Each scene receives `scene` (durationInFrames, cues) and `props`.
- `src/primitives/` (Stage, Backdrop, Heading, KineticText, LowerThird, Counter, ProgressBar, Callout, TokenRow, NeuralNet, Matrix, Graph, BarChart, TimelineAxis, CodeBlock, ParticleField) take data and 0..1 progress; no timing inside.
- Finishing layers: `Captions` (chunks or karaoke), `AudioSpectrum` (public audio via @remotion/media-utils), `FilmGrain`, `LightLeak`, `CameraMove`, `Glitch`. One texture per scene; motion must explain.
- Embeds: `BlenderShot` plays a `video_shot` RGBA sequence without frame blending (blending ghosts edges); `ShotNote`/`ShotAnchor` pin notes to 3D anchors; `ShotScene` is a whole scene. `HtmlMotion`/`HtmlScene` embed a page from `public/html/` exposing `window.renderFrame(t)`, which receives theme and fonts. `Grade` applies one color treatment. Optional three.js `Model3D`: `video_project action:"feature" feature:"3d"`.
- Captions come from `video.json` `captions:{enabled, style, maxWords, position}`; provider word spans beat the syllable-weighted fallback in `src/captions.ts`. Final renders also write `captions.srt` and `captions.vtt`. Scene `transition:{type, seconds}` animates entry (fade, slide, slideup, slidedown, wipe, zoom, blur, none).
- Shared vocabulary: `src/motion.ts` (progress, sweep, stagger, enter, settle, exitFade), `src/timing.ts` (beat, pulse, loopProgress, pingpong, hold), `src/theme.tsx` (useTheme, type, space, SAFE, useCanvas, seeded rng). Beat motion uses `pulse(frame, fps, bpm)` at the bed's bpm.
- Layout units: the short side is 1080 at any output size. Read dimensions from `useCanvas()`, never `useVideoConfig().width/height`.
- `Main.tsx` sequences scenes and layers narration, music (auto-ducked under narration) and sfx. `scene-<id>` compositions exist for isolated previews.

## Render rules
1. Every visual value is a pure function of `useCurrentFrame()`: no `Date.now()`, no `Math.random()` (use `rng(seed)`), no state that accumulates between frames.
2. Draw canvas in `useLayoutEffect` keyed on the frame, clearing first; size it from `useCanvas()` (layout units).
3. Fonts come from pinned `@fontsource` imports in `src/fonts.ts`; never system or network fonts.
4. Assets live in `public/` and load via `staticFile()`; no remote URLs.
5. Parameterize scenes through props and cue-derived progress; extract a primitive rather than duplicating a scene.
6. Keep trees light: move dense fields (particles, grids over about 2,000 cells) from SVG to canvas.
7. Keep lines at least 2 px and labels at least 26 px at 1080p; previews are half scale.

Failures: `unknown component` means register it in `src/scenes/index.ts`; `has no cue` (`cue()` throws) means add it to `video.json`; blank stills mean draw in `useLayoutEffect` with `frame` as a dependency; flicker means unseeded randomness or carried state; audio missing means `narrationAudio` is relative to `public/` (run `video_project check`); missing packages mean `video_project action:"install"`.

Render only through `video_render`: `stills` (60% of each scene, or `scene` plus `count`, or `times`) gives a contact sheet; `preview` is half scale; `final` is full scale, CRF 18, H.264 + AAC 192 kbps, decode-verified. Do not install Remotion globally or run its CLI by hand except to diagnose the tool; code-first-video owns the review loop (render stills after each change and look). Remotion is free for individuals and small teams; larger companies need a license, so flag it when delivering to one.

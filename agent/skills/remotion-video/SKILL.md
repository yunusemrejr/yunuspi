---
name: remotion-video
description: "Implement programmatic video in Remotion (React/TypeScript) inside a YunusPi video project: frame-pure scenes driven by the master video.json timeline, SVG/Canvas primitives, captions, transitions, audio layers, optional three.js, and stills, previews and finals through video_render; use when writing or debugging Remotion compositions, scenes, primitives or render failures."
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
- Shared vocabulary: `src/motion.ts` (progress, sweep, stagger, enter, settle, exitFade), `src/timing.ts` (beat, pulse, loopProgress, pingpong, hold), `src/theme.tsx` (useTheme, type, space, SAFE, useCanvas, seeded rng). Beat-synced motion uses `pulse(frame, fps, bpm)` at the audio bed's bpm.
- Layout units: the short side is 1080 at any output size. Read dimensions from `useCanvas()`, never `useVideoConfig().width/height`.
- `Main.tsx` sequences scenes and layers narration, music (auto-ducked under narration) and sfx. `scene-<id>` compositions exist for isolated previews.

## Render rules
1. Every visual value is a pure function of `useCurrentFrame()`: no `Date.now()`, no `Math.random()` (use `rng(seed)`), no state that accumulates between frames.
2. Draw canvas in `useLayoutEffect` keyed on the frame, clearing first; size it from `useVideoConfig()`.
3. Fonts come from pinned `@fontsource` imports in `src/fonts.ts`; never system or network fonts.
4. Assets live in `public/` and load via `staticFile()`; no remote URLs.
5. Parameterize scenes through props and cue-derived progress; extract a primitive rather than duplicating a scene.
6. Keep trees light: move dense fields (particles, grids over about 2,000 cells) from SVG to canvas.

Render only through `video_render` (stills and contact sheet, scene or range previews, final). Do not install Remotion globally or run its CLI by hand except to diagnose the tool. The code-first-video skill owns the review loop: render stills after each meaningful change and look at them.

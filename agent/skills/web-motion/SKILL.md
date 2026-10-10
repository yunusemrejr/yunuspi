---
name: web-motion
description: "Web and browser motion: CSS, Motion, GSAP, anime.js, Lottie, Rive, Lenis choice; choreography; scroll storytelling; Three.js and SVG animation; procedural and physics math; visual FX (glass, shaders, WebGL); pixel-art scenes."
---

## Choosing the tool
- CSS first (transition, @keyframes, animation-timeline, View Transitions); libraries only for removed-element exits, layout moves, springs or scrubbed timelines.
- Motion (React): AnimatePresence for exits, layoutId for shared moves, scoped to the moved subtree.
- GSAP + ScrollTrigger for scrubbed pinned narratives: gsap.context().revert() on unmount; ScrollTrigger.refresh() after images load.
- Lottie: passive AE JSON at rendered fps, re-cut above ~150KB. Rive: interactive state machines.
- Lenis only if the feel is the product; it breaks anchors and focus. three.js only for genuinely 3D content.

## Timing and interaction
- One owner per property, one clock; derive state from elapsed time (`renderAt(t)`), not accumulated deltas; keep it seekable.
- Retarget from current value and velocity; test reversal and repeats. Springs over fixed tweens for UI.
- Prefer transform/opacity; gate off-screen motion (IntersectionObserver, view()); cancel timers on unmount; cap dt.
- Motion is never the only carrier of state; every effect needs a named job.

## Scroll storytelling
- Scroll is the playhead: map scenes to 0-1 progress with overlapping ranges, not serial A-then-B.
- Pinned scenes need scroll distance (300vh, or end "+=N"): too short is frantic, too long is stuck.
- Discrete states for coarse changes; restrained parallax; clip-path masks for reveals.
- Image sequences: frames on one canvas, preloaded before play. Video scrub needs dense keyframes; test Safari.
- Native scroll by default; no scroll-jacking or pinning every section; separate mobile timeline; 100svh.
- QA: slow, fast, reversed scroll; resize; reduced motion; readable with JS off.

## Browser runtime and budgets
- Per property pick CSS transition, WAAPI or rAF loop; keep the project's engine. Measure at target refresh rate and DPR, reallocate buffers on resize, verify interruption, seeking, teardown in a browser.

## Three.js
- One animation loop; on resize update buffer, camera aspect and updateProjectionMatrix.
- Removing an object frees no GPU memory: dispose geometry, material, textures after last use; stop loops and late loads at teardown.
- One writer per position (mixer, physics, controller): animate a child of a controller parent.
- Color maps are sRGB; normal/roughness/metalness are data. Black output: check camera, lights, normals, load errors.

## Procedural and physics math
- Define quantity, frame, units and duration first; matching positions is not matching velocity: check derivatives.
- Constant speed needs arc-length parameterization (a linear Bezier parameter is not one).
- Orientation: shortest-arc quaternion slerp; parallel transport to avoid flips along paths.
- Physics: one fixed timestep; compare several render rates; stability is not accuracy.

## SVG motion
- State units (user units vs CSS px); convert explicitly; invert the CTM for pointer input.
- Cache getTotalLength until geometry changes; pathLength="1" with numeric dashes draws a line-in (verify per browser).
- Check intermediate morph frames: arcs as cubics, equal topology, stroke caps, moving pivots, filter bounds.

## Pixel-art scenes
- Canvas 2D at 480x270 (320x180 to 800x450); imageSmoothingEnabled=false; CSS `image-rendering: pixelated`; round at render time; letterbox, never stretch.
- Order: composition, grayscale value, silhouettes, palette, props; animate last. A frozen frame must already work.
- Draw back to front; painted glow, not blur; incomplete reflections; motion is 3-10% of the scene; seeded random state.
- Audio: start on a user click (resume()); ambience low; mute always visible.

## Visual FX
- One hero effect per screen, input-woken; its paused still must look finished on mobile.
- backdrop-filter re-rasters per frame: use an opaque scrim. No filter:url on moving text.
- WebGL/canvas: DPR cap 2 (0.5-0.75x on mobile); pause hidden or off-screen; one context; handle webglcontextlost/restored; dispose.
- WCAG 2.3.1: max 3 flashes/s (strobe or glitch needs a cap or reduced-motion kill). No effects under running text.

## Reduced motion
- `prefers-reduced-motion` is a branch, not a slowdown: still composition, posed frame, native scroll, no parallax. Content stays complete.

---
name: web-motion
description: "Web and browser motion: CSS/Motion/GSAP/anime.js/Lottie/Rive/Lenis choice, UI and timeline choreography, scroll-driven storytelling, Three.js and SVG animation, procedural and physics math, visual FX (glass, shaders, WebGL), and pixel-art canvas scenes."
---

## Choosing the tool
- CSS first (transition, @keyframes, animation-timeline, View Transitions). Add a library only for removed-element exits, layout moves, springs, or scrubbed multi-segment timelines.
- Motion (React): AnimatePresence for exits, layoutId for shared moves; scope `layout` to the moved subtree.
- GSAP + ScrollTrigger for scrubbed pinned narratives: gsap.context().revert() on unmount; ScrollTrigger.refresh() after images/fonts load.
- Lottie: passive AE JSON, export at rendered fps, re-cut if over ~150KB. Rive: interactive state machines.
- Lenis only if the feel is the product; it breaks anchors and focus. three.js only for genuinely 3D content.

## Timing and interaction
- One owner per animated property; one clock. Derive state from elapsed time (`renderAt(t)`), not accumulated deltas; keep it seekable for review and export.
- Retarget interactions from current value and velocity; test reversal and rapid repeats. Springs over fixed tweens for UI.
- Animate transform/opacity. Gate off-screen motion (IntersectionObserver, view()). Cancel rAF and timers on unmount; cap dt.
- Motion must never be the only carrier of state. Every effect needs a named job; decorative fade-ups are slop.

## Scroll storytelling
- Scroll is the playhead: map each scene to 0-1 progress with overlapping ranges, not serial A-then-B.
- Pinned scenes need scroll distance (300vh, or end "+=N"): too short is frantic, too long is stuck.
- Discrete states for coarse changes; restrained parallax; clip-path and masks for reveals.
- Image sequences: draw frames to one canvas, preload before play. Video scrub needs dense keyframes; test Safari.
- Native scroll by default; no scroll-jacking or pinning every section. Separate mobile timeline; use 100svh.
- QA: slow, fast, reversed scroll; resize; reduced motion; readable with JS off.

## Browser runtime and budgets
- Per property choose CSS transition, WAAPI, or rAF loop; keep the project's existing engine.
- Measure at target refresh rate and DPR; cap canvas DPR at 2; reallocate buffers on resize.
- Verify interruption, resize, seeking and teardown in a real browser.

## Three.js
- One animation loop; on resize update buffer, camera aspect and updateProjectionMatrix.
- Removing an object does not free GPU memory: dispose geometry, material, texture after last use; stop loops and late loads at teardown.
- One writer per character position (mixer, physics, controller): animate a child under a controller parent.
- Color maps are sRGB; normal/roughness/metalness are data. Black output: check camera, lights, normals, load errors.

## Procedural and physics math
- Define quantity, frame, units and duration first. Matching positions is not matching velocity: check derivatives at loop seams and joins.
- Constant speed needs arc-length parameterization; a linear Bezier parameter is not constant speed.
- Orientation: shortest-arc quaternion slerp; parallel transport to avoid flips along paths.
- Physics: one fixed timestep; compare several render rates; stability is not accuracy.

## SVG motion
- State units (user units vs CSS px) and convert explicitly; invert the CTM for pointer input.
- Cache native getTotalLength until geometry changes; pathLength="1" with dashoffset draws a line-in.
- Check intermediate morph frames: arcs as cubics, equal topology, stroke caps, moving pivots, filter bounds.

## Pixel-art scenes
- Canvas 2D at 320x180 to 640x360; imageSmoothingEnabled=false; CSS `image-rendering: pixelated`; round at render time; letterbox, never stretch.
- Order: composition, grayscale value, silhouettes, palette, props, motion. A frozen frame must already work.
- Draw back to front; painted glow, not blur; incomplete reflections; motion is 3-10% of the scene; seeded random state created once.
- Audio: start from a user click with resume(); ambience low; mute always visible.

## Visual FX
- One hero effect per screen, input-woken; its paused still must look finished on mobile.
- backdrop-filter re-rasters per frame: use an opaque scrim. No filter:url on moving text.
- WebGL/canvas: DPR cap; 0.5-0.75x on mobile; pause when hidden or off-screen; one context; handle webglcontextlost/restored; dispose.
- WCAG 2.3.1: at most 3 flashes/s (glitch/strobe needs a cap or reduced-motion kill). No effects under running text.

## Reduced motion
- `prefers-reduced-motion` is a branch, not a slowdown: still composition, posed frame, native scroll, no parallax. Content stays complete.

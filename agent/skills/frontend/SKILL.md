---
name: frontend
description: "Build, review and debug browser UI: visual systems, interaction and accessibility, JS/TS runtime bugs, React/Vue/Svelte/Next, libraries and CDNs, media, Core Web Vitals, mockup-to-code and in-browser ML (ONNX, WebGPU)."
---

## Visual system
- Identity is finiteness: one spacing scale, 3 type roles, 2-3 colors, 1 radius, 2 shadows; a stranger can list them.
- One gutter, card spec, primary button per view, one emphasis per element; no border+shadow+tint stacks.
- Derive palette and type from the subject; no default indigo-purple or cream-terracotta; no invented stats or logos.
- Audit: squint test, 5-second statement, remove test.
## Interaction
- Labels persist; validate on blur; on submit focus the first failed field and disable the button while saving.
- Destruction tiers: undo if reversible (8-10 s); named count-confirm mid-cost; type-to-confirm with scope org-wide.
- Four states: empty (no items vs no matches), loading (skeleton, nothing under 100 ms), error (request id), full.
## Accessibility
- Start from task states, not ARIA; native controls first; custom widgets follow APG keyboard patterns.
- Modals: accessible name, focus in and contained, Escape, focus back to trigger or a surviving neighbor.
- Test whole tasks by keyboard at 200% zoom, reduced motion; scanners miss focus order and names.
## JS runtime
- Batch DOM reads before writes; rAF for visual writes; no busy-waits.
- Untrusted text goes in textContent, never innerHTML.
- Abort superseded requests; guard with a generation counter; bound concurrency, never unbounded Promise.all.
- One teardown owner per listener, timer, observer; leak-check: diff heap snapshots over 20 open/close cycles.
- Server data belongs in a query cache (TanStack Query, SWR), not useEffect plus useState; validate external data as unknown.
## Frameworks
- Name the rendering model (SPA, SSR, SSG/ISR, islands); first HTML must equal first render (no Date.now/Math.random).
- Audit client bundles: a misplaced "use client" ships server code, sometimes secrets. Keep secrets out of bundles and URLs.
- Verify production builds against the real backend, throttled (dev overlays hide defects); proxy /api same-origin.
## Libraries
- Pick by architecture: headless (Radix, react-aria) = you own pixels; styled systems hit a theming ceiling; copy-in = you own upgrades.
- Map theming to your tokens; never hand-roll combobox, dialog or tab state machines; check `<dialog>` and Popover first.
- Pin exact versions, never `latest`; SRI plus crossorigin on CDN scripts; degrade on 404; self-host for privacy or intranet.
- Kill list: new jQuery, whole-library imports, 12 micro-libs, vanilla apps growing routers and stores.
## Media
- A still image beats video unless motion carries the message. Nothing autoplays with sound.
- Loops: `muted autoplay loop playsinline` (iOS needs playsinline), a poster, reduced-motion pause; preload metadata, never auto.
- Images: AVIF, WebP, JPEG via `<picture>`; crop to slot, cap ~1600 px, strip EXIF; hero is `<img>` with fetchpriority=high.
- width/height or aspect-ratio on images; descriptive alt (alt="" if decorative); no source and license in 30 s: remove.
## Performance
- Budgets: LCP <2.0 s, INP <200 ms, CLS <0.1, initial JS <150 KB gz (aim 100), route delta <50 KB; enforce in CI.
- Judge by field p75 (RUM), not lab Lighthouse; INP trouble is tasks over 50 ms; third-party tags are the top source.
## Mockup to code
- Read the reference with image_understand; recover landmarks, bands, repeated components, color roles; sample hex values.
- Text is HTML; boxes, gradients, shadows are CSS; icons SVG; logos need real files; photos are placeholder crops (image_crop).
- Snap to a system before coding: 4/8 spacing, 4-8 color roles, 4.5:1 body contrast, 2 radii max. No absolute positioning.
- Verify with render_see at 390/768/1280 px; fix vertical drift top-down; stop once structure, spacing, color match.
## CSS shapes
- Two stops at one position (`#fff 0 50%, #000 0`) give crisp edges; `border-radius:50%` on a non-square box is an ellipse; `repeating-conic-gradient` makes checkers and stars.
## Browser ML
- Start from ONNX; quantize int8 (~4x smaller, 1-2% loss); re-evaluate on your data (small-font OCR can drop 5-10%).
- transformers.js for small LLMs (~0.5-4B in browser); ONNX Runtime Web for vision, audio, classification.
- WebGPU when navigator.gpu exists, else WASM; test the WASM path; run in a Worker; keep first load under ~30 MB.

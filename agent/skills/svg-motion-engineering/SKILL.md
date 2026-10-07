---
name: svg-motion-engineering
description: Engineer animated SVG geometry, path drawing and morphing, coordinate transforms, and precise motion along curves. Use for SVG-specific motion correctness rather than general visual styling.
---

Treat SVG motion as geometry evaluated on a timeline. Establish whether distances are in local user units, viewport CSS pixels, or physical pixels; make conversions explicit before implementing pointer interaction or constant-speed motion.

Read [geometry and motion](references/geometry-and-motion.md) for CTM inversion, viewBox mapping, arc-length parameterization, dash reveals, path topology, and clipping calculations. It contains worked calculations and browser verification cases.

Use native path measurement for ordinary DOM SVG; cache measurements until geometry changes. Introduce custom integration only when transformed screen-space speed, offline export, or error control actually requires it. A parameter moving linearly along a Bézier curve rarely means constant spatial velocity.

Separate shape definition from animation state. Keep deterministic `renderAt(time)` or an explicitly seekable animation for debugging, export, and endpoint comparison. Preserve a meaningful stable reduced-motion state. Validate intermediate frames, not only matching endpoints: topology, stroke caps, moving pivots, and filter bounds can fail between them.

Check actual rendering at the intended sizes and zoom levels. Report numerical tolerances and observed frame costs separately from estimates; SVG APIs and compositor behavior do not guarantee a frame budget.

Use `svg_render` for real timestamped CSS/SMIL frames and MP4 export. Preflight requires well-formed XML, the SVG namespace and inert local content. Escape ampersands in text. Data tracks validate affine transform grammar, path commands and identical numeric topology; convert arc segments to cubics before morphing. Assign each property one owner: conflicting SMIL/data tracks reject during preflight and CSS/data tracks reject before capture. Diagnostics group repeated clipping with first/last frame and occurrence counts; use those timestamps to inspect the actual pixels, cadence and loop seams. Use transparent PNG frames for alpha delivery, and author a separate stable reduced-motion state.

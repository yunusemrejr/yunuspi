---
name: svg-images
description: "Create, judge, optimize and load SVG (icons, logos, illustrations, sprites, viewBox, currentColor, svgo, a11y, security), inspect image files (metadata, dimensions, color, OCR evidence), and edit animated GIFs with gifsicle, ImageMagick and FFmpeg."
---

## Making SVG
- Always set viewBox (24-grid, 2px stroke, ~20px live area). Size in em via CSS; a missing viewBox is the "icon is tiny" bug.
- Stroke icons: fill none, stroke currentColor, round caps and joins. Keep one stroke width, cap and corner radius per set.
- Prefer circle/rect/line primitives over traced paths. Use fill-rule evenodd for holes. Avoid SVG filters on icons.
- Prefix ids per icon: document-global ids collide when one SVG is inlined twice. Use symbol+use sprites for sets.
- Minimize with `svgo --multipass --precision=1`; read the diff. Keep viewBox, currentColor, title/aria, and referenced ids.

## Judging SVG
- File: functional icons with hardcoded fill/stroke colors fail (test in inverted color). Circle-as-path and >5KB simple glyphs mean bloat.
- Text stays text, not outlined letters, except in logo lockups. Gradients: objectBoundingBox, 2-3 stops.
- A11y: decorative gets aria-hidden; informative gets role=img with title (+desc); meaning survives without pixels.
- Set audit: same grid, stroke, caps, and optical weight. The row test: place it beside the set's three most common icons; the one that breaks rhythm is off-family.
- Score 10 points (viewBox, currentColor, primitives, filters, a11y, text, sharpness at 16/24/32, belongs, size, load method). 8+ ship; 6-7 fix two worst; below 6 redraw.

## Loading
- Inline for UI icons, animated or recolorable SVG under ~2KB; `<img>` for inert art (frozen, sandboxed); symbol+use sprites for large inert sets.
- Icon fonts: no. CSS mask only for pure recolor.
- Untrusted SVG (uploads, feeds): render via img or sanitize; never raw-inline. foreignObject and external use href are hostile.

## Analyzing images
- Pick the evidence: header for dimensions, decoded pixels for color/alpha, OCR for text, visual look for composition. Metadata alone proves nothing about appearance.
- Declare orientation (EXIF) and coordinate space; crops as [x0,x1) x [y0,y1) on stored or oriented pixels. Animated: name the frame and composited vs raw.
- Bound file bytes, decoded pixels, frame count and time; respect the ImageMagick policy. Never edit the original.
- Color: state the profile; average in linear light; transparent pixels distort dominant color unless ignored.
- OCR is a hypothesis: confidence is engine-specific; re-check digits, minus signs and decimals against the crop; unreadable stays unknown, not zero.
- Report header claims, decoded measurements and visual judgments separately.

## Editing GIFs
- Probe first: `gifsicle --info`, `identify`, `ffprobe`. Every edit re-encodes; keep the source and record commands and tool versions.
- Size levers: dimensions, frame rate, colors, dithering. Test on a short hard segment. Two-pass ffmpeg (palettegen, then paletteuse) beats one pass; gifsicle -O3 with --colors or --lossy.
- Coalesce before crop, composite or resize. Normalize dimensions and fps before concat; decide canvas size deliberately.
- Set loop count explicitly. Seamless loops need crossfade or ping-pong; GIF transparency is binary, so semi-transparent edges halo.
- Verify by decoding: frame count, duration, loop, dimensions, file size, and frames at motion peaks, text, and seams.

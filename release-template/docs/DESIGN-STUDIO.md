# Design studio: from reference images to code

Four tools help an agent turn a design reference (a mockup, a screenshot, a Figma or Dribbble export, or an image URL) into working code, and check the build against it. The `mockup-to-code` skill owns the workflow; the Observer Book's *Design to code* chapter carries the doctrine the session observer applies.

When a prompt clearly asks for image-to-code work ("turn this mockup into a website", "make the pricing page look more like this screenshot", an attached image plus a page to build), tool discovery puts these tools on the wire for the first model turn and skill routing suggests the skill. Other sessions discover them on demand with `tool_search`.

| Tool | What it does |
| --- | --- |
| `image_analyze` | Maps the reference into page bands with guessed roles (navigation, hero, feature grid, call to action, footer), blocks classified as text, flat or container (CSS), gradient (CSS), icon (SVG), image (raster) or divider, a palette with roles and contrast (background, text, heading, primary, surfaces, on-colors), a named type scale with line heights, the spacing unit, container width, columns and repeated components with their padding. Writes `design-map.json`, `overlay.png` (block ids drawn by kind) and `tokens.css`. `ocr:true` attaches recognized copy to text blocks when Tesseract is installed. |
| `image_crop` | Cuts assets at full source resolution by region, by map block id, or by kind (`kinds:["image"]` cuts every photograph). Optional padding, edge-connected background keying with de-fringing, trimming and format choice (PNG for flat or transparent art, WebP for photographs, JPEG on request). |
| `image_trace` | Vectorizes a flat icon, logo or simple illustration into a compact multi-color SVG with smooth curves and sharp corners. Reports fidelity (re-rasterized paths against pixel labels) and posterization error, and gives a verdict; photographs are flagged as unsuitable. |
| `visual_diff` | Compares a build with the reference at CSS resolution. The build is a screenshot or an HTML path or URL rendered at the reference width (long pages in 4,000 px slices). Reports a verdict, SSIM, changed share, the worst bands, bands displaced vertically (spacing drift), hot regions with zoomed reference/build crops and the reference blocks under them, and colors missing from or added by the build. Writes `compare.png` (reference, build, heat). |

## How it works

- Images are decoded by FFmpeg from stdin, so no filename reaches a demuxer (no sequence patterns, playlists or protocols); formats are recognized by content. Decodes are bounded (64 M pixels at the decoder, 40 MiB inputs) and analysis runs near CSS resolution.
- URLs download through the same SSRF validation and DNS pinning as `http_request`, follow at most three validated redirects, must return an image type, and are saved once for reuse. `PI_OFFLINE=1` refuses downloads.
- The reference's pixel ratio is inferred from common export widths (2880 px desktop exports are treated as @2x, tall 1125–1290 px images as @3x phones) and can be set with `scale`.
- Analysis is local and deterministic: band segmentation by background with just-noticeable-difference steps, subtle panels and outlined cards found separately from the ink mask, words and lines merged into text blocks, roles guessed from structure (button fills give the primary color, card fills and tinted bands the surfaces). No model call is made.
- Artifacts go to a fresh folder under `.pi/design/` in the workspace, which gets a `*` `.gitignore`, unless `outputDir` names another workspace folder.

## Limits

Everything returned is a measurement or a guess from pixels. Font sizes are ink-height estimates (about ±15%; all-caps text reads small); roles and component groupings are heuristics; the analyzer sees one viewport and one state, so hover, focus, motion, responsive behavior and fonts must be decided from the brief and design doctrine. Crops from a mockup are placeholders unless the user supplied final assets. A `close` diff is structural fidelity, not proof that the page is good: check other widths, states and accessibility too.

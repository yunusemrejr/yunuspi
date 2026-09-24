---
id: design-to-code
part: design
title: Design to code
summary: Turning mockups, screenshots and references into working interfaces: decompose before coding, decide CSS versus SVG versus raster per region, extract tokens, cut assets cleanly, build structure first, and compare renders to the reference.
terms: mockup mockups figma design screenshot reference image picture png jpg recreate replicate clone convert turn into website page implement pixel perfect match look like similar asset assets slice crop export svg icon icons illustration image to code design to code
files: .png .jpg .jpeg .webp .svg .fig
tools: image_analyze image_crop image_trace visual_diff render_see browser_session design_audit image_ocr web_asset_check
skills: mockup-to-code frontend-design custom-svg svg-assessment image-analysis visual-composition product-ui-verification
---

# Design to code

Implementing a design from an image is translation, not tracing. A mockup is a single frozen state at one viewport with invented content; the code must reproduce its intent across sizes, states and real data. The work goes fastest when the image is decomposed into decisions before any code is written.

## Decompose the image before writing code {#decompose}
<!-- terms: mockup screenshot reference image design figma decompose analyze sections regions layout structure grid inventory -->

**Principle.** First map the mockup into sections, a grid, repeated components, typography levels, colors and assets; then write code against that map.

**Why.** Coding top-to-bottom from a picture produces one-off CSS for every region and misses repetition (the same card five times, the same button style everywhere). A short inventory—sections, columns and gutters, spacing rhythm, type scale, palette, component list, asset list—turns the picture into a design system in miniature. It also reveals what the mockup does not specify (hover states, mobile layout), which must be decided rather than guessed silently.

**Signals.** Implementation started immediately from an image; many unique CSS values; repeated elements implemented separately.

**Ask.** Has the mockup been mapped into sections, grid, components, tokens and assets before coding (image_analyze drafts that map and an annotated overlay)?

**Traps.** Over-analysis of simple layouts; treating mockup pixel values as law when they are approximations.

## Decide per region: CSS, SVG, raster or text {#css-svg-raster}
<!-- terms: mockup screenshot image picture css svg raster photo illustration icon gradient shape background vector export cut decide -->

**Principle.** Build flat colors, gradients, borders, shadows and simple shapes in CSS; icons, logos and geometric illustrations as SVG; photos and complex painted art as optimized raster images; and all text as real text.

**Why.** Text baked into images is inaccessible, unsearchable, untranslatable and blurry at other densities. CSS reproduces flat and gradient surfaces exactly at any size for zero bytes. SVG keeps icons crisp and themeable. Photographs and textured illustrations cannot be rebuilt in code and should be extracted or sourced as images, sized for their display dimensions. Choosing per region avoids both extremes: a page that is one big screenshot, or a photo painstakingly faked with gradients.

**Signals.** Text rendered as part of images; icons exported as PNG; gradients or solid panels exported as images; attempts to redraw photographs in CSS.

**Ask.** For each visual region, is it being built with the cheapest faithful technique—CSS, SVG, raster or text?

**Traps.** Recreating complex illustrations as hand-written SVG paths at great cost when an extracted asset would do.

## Extract tokens from the reference {#tokens}
<!-- terms: palette colors sample eyedropper fonts font size spacing radius shadow tokens extract measure -->

**Principle.** Derive the palette, type scale, spacing unit, radii and shadows from the reference and define them once as tokens before building components.

**Why.** Sampling colors per element produces dozens of near-duplicates from compression artifacts and anti-aliasing. Clustering the reference into a small palette with roles (background, surface, text, accent) and snapping spacing to a base unit gives a coherent system that matches the design's intent better than literal pixels. Font identification from images is uncertain; choosing the closest available family with matching proportions is usually right.

**Signals.** Many slightly different hex values; spacing values like 23px and 25px side by side; fonts guessed without comparing metrics.

**Ask.** Were colors, spacing and type sizes consolidated into tokens rather than copied per element?

**Traps.** Snapping so aggressively that a deliberate design detail is lost.

## Cut assets cleanly and at the right resolution {#assets}
<!-- terms: crop cut slice extract asset trim padding transparent background remove resolution 2x retina optimize webp avif -->

**Principle.** Extract raster assets with tight crops, transparent backgrounds where the design implies them, and resolution matching their display size at high-density screens; then compress them.

**Why.** Assets cropped with stray background pixels, baked-in shadows or low resolution make the result look off even when the layout is right. Screenshots and mockups are often scaled, so extracted assets may need upscaling judgment or replacement with originals. Modern formats (WebP, AVIF) and explicit width and height attributes keep pages fast and stable.

**Signals.** Assets with visible halos or background fragments; images displayed larger than their pixel size; unoptimized multi-megabyte images.

**Ask.** Is each extracted asset tightly cropped, cleanly separated from its background, sharp at 2x and compressed (image_crop keys, trims and picks formats; image_trace vectorizes flat marks)?

**Traps.** Extracting assets that should have been rebuilt with CSS or SVG.

## Structure first, pixels last {#structure-first}
<!-- terms: semantic html structure layout flex grid responsive skeleton build order pixel perfect polish -->

**Principle.** Build semantic structure and responsive layout first, then typography and color, then details—not pixel-matching one region at a time.

**Why.** Pixel-matching early locks in absolute positioning and fixed sizes that collapse at other widths. Getting structure right (landmarks, headings, grid and flex layouts that adapt) makes later refinements local. The mockup's width is one sample; the code must produce sensible layouts at every width, including ones the designer never drew.

**Signals.** Absolute positioning to match the mockup; fixed widths and heights; layout broken at widths other than the mockup's.

**Ask.** Does the layout adapt sensibly between phone and wide desktop, not just at the mockup's width?

**Traps.** Declaring responsive behavior done without checking widths the mockup did not show.

## Compare renders to the reference, iterate on the biggest gap {#compare}
<!-- terms: mockup reference compare comparison diff visual diff screenshot overlay side by side match fidelity pixel iterate difference -->

**Principle.** Render the implementation at the reference's viewport, compare it side by side or as a diff, and fix the largest differences first.

**Why.** Eyeballing code cannot reveal whether spacing is 8 pixels off or a font renders heavier. A screenshot at the same width, compared with the reference region by region, shows exactly where fidelity is lost: misaligned sections, wrong colors, missing assets, different line breaks. Iterating on the largest measured difference converges faster than polishing whatever is noticed first. The final comparison is evidence for the claim that the implementation matches.

**Signals.** "Looks like the design" claimed without any screenshot comparison; iterations fixing tiny details while large sections differ.

**Ask.** Has the render been compared against the reference at the same width (visual_diff renders and scores it), and which region differs most?

**Traps.** Chasing sub-pixel anti-aliasing differences; comparing at different widths or zoom levels.

## When editing toward a reference, change the system, not the page {#restyle}
<!-- terms: restyle redesign look more like update style theme match reference existing site edit -->

**Principle.** When asked to make an existing site look more like a reference, identify the systematic differences (palette, type, spacing, radius, density) and change tokens and components, not individual page instances.

**Why.** A reference image usually differs from the current site in a few systemic dimensions. Changing them at the token and component level transforms every page consistently with small diffs. Patching individual elements to resemble the screenshot creates inconsistency between pages and a pile of overrides.

**Signals.** Many one-off style overrides added to match a reference; tokens untouched while pages change.

**Ask.** Which systemic properties differ between the current site and the reference, and can they be changed at the token level?

**Traps.** Rewriting the design system when only one page was meant to change.

## Generalize a few references into a system for every page {#generalize}
<!-- terms: whole site all pages other pages apply everywhere consistent pattern patterns infer generalize rest of site no example remaining pages design language -->

**Principle.** When a few images must restyle a whole site, extract the design language—tokens, component treatments, grid, density, imagery—and apply it to pages the references never showed, recording each inferred rule.

**Why.** References are samples of a system, not the system itself. Copying them page by page fails on every page they do not depict: forms, tables, settings, errors, empty states. Extracting rules (buttons are pill-shaped with the accent fill, cards have 16px radius and a soft shadow, sections breathe with 96px spacing, headings use the display face) lets each unseen page be derived consistently. Listing the inferred rules and the pages they were applied to makes the extrapolation reviewable and correctable in one place.

**Signals.** Only the pages shown in references restyled; other pages left in the old style or improvised; new variants invented per page.

**Ask.** Which rules were inferred from the references, and have they been applied to every page type, including ones without an example?

**Traps.** Over-applying a hero-page treatment to dense data pages; inventing rules the references do not support instead of flagging the gap.

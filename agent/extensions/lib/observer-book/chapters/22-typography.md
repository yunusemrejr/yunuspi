---
id: typography
part: design
title: Typography and font theory
summary: Type that reads and signals: font classification and pairing, modular scales, measure and leading, weight and hierarchy, numerals and details, web font loading and fluid type.
terms: typography type typeface font fonts serif sans-serif monospace display pairing pair scale modular ratio heading headings body text line height leading measure line length tracking letter spacing kerning weight bold x-height readability legibility font-display variable font clamp rem em
files: .css .scss .tsx .jsx .vue .svelte .html .woff .woff2 .ttf .otf
tools: design_audit render_see
skills: fonts design-systems frontend-design natural-editorial-writing
---

# Typography and font theory

Most interfaces are mostly text, so typography is most of the design. Good typography is legible (letters distinguishable), readable (text comfortable to read at length) and expressive (the voice fits the content). It is built from a few decisions made carefully: the faces, the scale, the measure and the spacing.

## Know what each type classification communicates {#classification}
<!-- terms: serif sans-serif slab geometric humanist grotesque monospace display script classification voice personality -->

**Principle.** Choose typefaces by what their structure communicates: humanist sans for warmth and readability, geometric sans for modernity, grotesque for neutrality, serifs for tradition and long reading, monospace for code and data.

**Why.** Typeface anatomy carries personality before any word is read. Humanist sans-serifs (derived from handwriting) feel friendly and read well at small sizes; geometric faces feel clean but can hurt legibility (ambiguous a/o shapes); old-style serifs feel literary; slab serifs feel sturdy; display faces are for headlines only. Legibility details matter in UI: distinguishable Il1 and O0, open apertures, generous x-height.

**Signals.** Display or script faces used for body text; typefaces chosen with no reference to brand voice; ambiguous characters in data-heavy interfaces.

**Ask.** What does this typeface's structure say about the product, and is it legible at the smallest size used?

**Traps.** Novelty fonts that date quickly; condensed faces for long text.

## Pair by contrast, limit the families {#pairing}
<!-- terms: pairing pair font combination two fonts families limit contrast superfamily heading body -->

**Principle.** Use at most two families—often one for headings and one for body, or a single superfamily—and pair faces that contrast clearly while sharing proportions.

**Why.** Each additional family adds weight to load and noise to the voice. Pairs that are too similar (two geometric sans-serifs) look like a mistake; pairs that contrast in classification (serif headings with sans body, or the reverse) but share x-height and proportion feel intentional. Superfamilies with serif and sans members pair automatically. Hierarchy can come from size and weight within one family, which is often enough.

**Signals.** Three or more font families; near-identical faces paired; headings and body with clashing x-heights.

**Ask.** Does each typeface have a distinct job, and do the pair's proportions agree?

**Traps.** Loading many weights of each family "just in case".

## Build sizes from a modular scale {#scale}
<!-- terms: modular scale ratio type scale 1.25 1.333 1.5 golden ratio heading sizes h1 h2 base 16px rem -->

**Principle.** Derive font sizes from a base size and a ratio (for example 16px × 1.25), using a few steps with clear differences.

**Why.** Arbitrary sizes produce muddy hierarchies where h3 and h4 look alike and body text competes with captions. A modular scale creates harmonious, clearly distinct levels. Smaller ratios (1.125–1.2) suit dense interfaces; larger ones (1.333–1.5) suit editorial pages and marketing. Five to seven steps cover most products.

**Signals.** Many distinct font sizes in CSS; headings barely larger than body; sizes differing by one or two pixels.

**Ask.** Do font sizes come from one scale with clearly distinguishable steps?

**Traps.** Huge ratios producing enormous headings on mobile.

## Measure and leading set readability {#measure-leading}
<!-- terms: line length measure characters per line line height leading paragraph readability max-width ch -->

**Principle.** Keep body text to about 45–75 characters per line, with line height around 1.4–1.6 for body and tighter (1.1–1.25) for large headings.

**Why.** Long lines make the eye lose its place returning to the next line; very short lines break reading rhythm. Line height must grow with line length and shrink with font size: large headings with body-text leading look loose and disconnected. Setting max-width in ch units ties measure to the font. Paragraph spacing should separate paragraphs without breaking the text's rhythm.

**Signals.** Full-width paragraphs on desktop; tight leading on long text; headings with airy leading that splits multi-line titles apart.

**Ask.** How many characters fit on a line of body text at desktop width, and does leading suit the size?

**Traps.** Centered long-form text; justified text without hyphenation creating rivers.

## Weight and case build hierarchy with restraint {#weight}
<!-- terms: weight bold semibold regular light uppercase caps small caps tracking letter spacing emphasis italic -->

**Principle.** Use a small set of weights (such as regular, medium or semibold, bold) and reserve uppercase for short labels with added tracking.

**Why.** Weight contrast is a strong hierarchy tool, but thin weights at small sizes vanish and too many weights blur distinctions. Uppercase text is harder to read in long runs and needs positive letter spacing to breathe; it suits short labels and overlines. Large display text often needs negative tracking. Italics signal emphasis or voice within text; bold within paragraphs should be rare.

**Signals.** Light weights for small body text; long uppercase sentences; many weights with small differences.

**Ask.** How many weights are in use, and does each carry a distinct level of meaning?

**Traps.** Faux bold and faux italic when real font files are missing.

## The details signal craft {#details}
<!-- terms: numerals tabular lining oldstyle quotes apostrophe dash ellipsis hyphen widows orphans ligatures optical sizes -->

**Principle.** Use tabular numerals for tables and changing numbers, real typographic quotes and dashes, and avoid widows in headings.

**Why.** Proportional numerals make columns of numbers jagged and counters jitter as they change; tabular figures align. Straight quotes and double hyphens look like typewriter text. A single word stranded on a heading's last line looks careless; text-wrap: balance fixes headings. Optical sizes and proper ligatures in good fonts improve text at every size. None of these are noticed when right; all are noticed subconsciously when wrong.

**Signals.** Numbers jumping in live counters or tables; straight quotes in marketing copy; orphaned words in headlines.

**Ask.** Are numbers, quotes, dashes and heading breaks set with typographic care?

**Traps.** Over-engineering typographic features on content nobody reads closely.

## Load fonts without hurting the page {#font-loading}
<!-- terms: font loading font-display swap fallback fout foit preload subset woff2 variable font performance cls -->

**Principle.** Subset and self-host fonts in WOFF2, preload the critical ones, use font-display deliberately, and tune fallbacks to reduce layout shift.

**Why.** Web fonts block text rendering or cause visible swaps and layout shift. Every family and weight is another request. Variable fonts can replace many static files; subsetting removes unused glyphs; size-adjust and ascent overrides on fallback fonts make the swap nearly invisible. System font stacks are a legitimate choice for product interfaces where speed matters more than voice.

**Signals.** Many font files loaded; no font-display strategy; noticeable text reflow when fonts arrive.

**Ask.** How many font files does the first view load, and does text shift when they arrive?

**Traps.** Invisible text for seconds on slow networks; licensing terms that forbid self-hosting.

## Fluid type respects the reader's settings {#fluid}
<!-- terms: fluid type clamp responsive typography rem viewport zoom user font size accessibility -->

**Principle.** Size text in rem, scale headings fluidly with clamp(), and never prevent user zoom or ignore their base font size.

**Why.** Users set larger default font sizes for good reasons; pixel-locked text ignores them. Fluid typography with clamp(min, preferred, max) scales headings smoothly between breakpoints without jumps, while rem-based bounds respect user settings. Pure viewport units break zoom, because zooming does not change the viewport width.

**Signals.** Font sizes in px throughout; headings sized only with vw; maximum-scale or user-scalable=no in the viewport meta tag.

**Ask.** Does text grow when the user increases their browser font size or zooms?

**Traps.** Fluid body text that becomes too small on narrow screens.

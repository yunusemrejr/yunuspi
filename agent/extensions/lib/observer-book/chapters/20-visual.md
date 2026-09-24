---
id: visual
part: design
title: Visual design fundamentals
summary: The grammar of visual design: Gestalt grouping, alignment and grids, spacing systems, contrast and emphasis, balance, repetition and consistency, imagery and icon style.
terms: visual design gestalt proximity similarity alignment align grid grids spacing space whitespace padding margin rhythm contrast emphasis balance symmetry consistency repetition layout composition icon icons imagery illustration polish polished aesthetic
files: .css .scss .tsx .jsx .vue .svelte .html .svg .fig
tools: design_audit render_see browser_session
skills: visual-composition design-systems frontend-design ui-ux-principles
---

# Visual design fundamentals

Good visual design is mostly invisible: things line up, related items group, important items stand out, and nothing competes for attention without reason. These fundamentals come from perception research (Gestalt psychology) and centuries of print practice, and they apply to every screen.

## Proximity and similarity create groups {#gestalt}
<!-- terms: gestalt proximity similarity grouping related spacing group common region continuity closure -->

**Principle.** Things that belong together should be closer together and look alike; unrelated things need clear separation.

**Why.** The visual system groups elements before conscious reading: close items form a group (proximity), similar items are read as related (similarity), enclosed items share a region (common region). A label equidistant from two fields is ambiguous; a card whose inner spacing equals the gap between cards dissolves into its neighbors. Using spacing rather than borders to group keeps layouts light while making structure obvious.

**Signals.** Equal spacing everywhere; labels floating between controls; borders and dividers used to fix grouping that spacing should express.

**Ask.** Does spacing alone make it obvious which elements belong together?

**Traps.** Over-grouping with boxes inside boxes; similarity that implies relationships that do not exist.

## Align everything to something {#alignment}
<!-- terms: alignment align left edge grid column baseline optical axis ragged -->

**Principle.** Every element should share an edge or axis with something else; stray positions read as mistakes.

**Why.** Alignment creates invisible lines that the eye follows, making layouts feel orderly and easy to scan. Mixed alignments (some centered, some left, some slightly off) create visual noise even when viewers cannot say why. Left alignment suits reading; centering suits short, isolated elements. Optical alignment sometimes requires nudging: round shapes and icons may need to extend slightly past the grid to look aligned.

**Signals.** Elements a few pixels off shared edges; center-aligned body text; inconsistent left edges between sections.

**Ask.** Which invisible lines does this layout use, and does every element sit on one?

**Traps.** Rigid mathematical alignment that looks wrong optically.

## Use a spacing scale, not arbitrary values {#spacing-scale}
<!-- terms: spacing scale 4px 8px grid rhythm padding margin gap tokens consistent vertical rhythm -->

**Principle.** Draw spacing from a small scale (for example 4, 8, 12, 16, 24, 32, 48, 64) and use larger steps between larger groupings.

**Why.** Arbitrary values (13px here, 17px there) accumulate into a subtly messy layout and make consistency impossible to maintain. A scale encodes hierarchy: tight spacing inside components, medium between related components, large between sections. Tokens make it enforceable in code. Vertical rhythm—consistent spacing tied to line height—makes long pages read calmly.

**Signals.** Many distinct pixel values in CSS; similar components with different paddings; section spacing no larger than item spacing.

**Ask.** Do spacing values come from one scale, and do larger groupings get larger gaps?

**Traps.** Treating the scale as a straitjacket where optical adjustment is needed.

## Contrast directs attention {#contrast}
<!-- terms: contrast emphasis focal point size weight color scale hierarchy dominant attention -->

**Principle.** Create emphasis through deliberate contrast in size, weight, color or space—and limit the number of emphasized things.

**Why.** The eye goes first to what differs most from its surroundings. Strong contrast used once creates a focal point; used everywhere it creates chaos. Timid contrast (16px vs 17px text, two nearly identical grays) looks like an error rather than hierarchy. Effective hierarchies use a few clear steps, for example a heading clearly larger and heavier than body text, with body text clearly darker than metadata.

**Signals.** Many elements competing for attention; near-identical sizes or colors used to distinguish levels; no clear focal point.

**Ask.** Where does the eye land first on this screen, and is that the intended focal point?

**Traps.** Using color as the only differentiator; contrast so high it becomes harsh.

## Balance and visual weight {#balance}
<!-- terms: balance visual weight symmetry asymmetry composition heavy light whitespace negative space -->

**Principle.** Distribute visual weight so compositions feel stable; asymmetric layouts need counterweights.

**Why.** Large, dark, saturated or detailed elements are visually heavy. A heavy image on one side unbalances a layout unless text, whitespace or color on the other side counters it. Symmetry feels formal and stable; asymmetry feels dynamic but requires care. Whitespace itself has weight: it isolates and elevates what it surrounds.

**Signals.** Layouts that feel lopsided or crowded to one side; dense regions next to empty ones without intent.

**Ask.** If the layout were a physical object, would it tip over—and is that intended?

**Traps.** Filling every empty area in the name of balance.

## Consistency is a feature {#consistency}
<!-- terms: consistency consistent repetition design system tokens components variants style reuse -->

**Principle.** Repeat the same solutions for the same problems: identical buttons, spacing, radii, shadows and patterns across the product.

**Why.** Consistency lets users transfer learning: once they know what a primary button looks like, they recognize it everywhere. Inconsistency signals carelessness and makes users wonder whether differences carry meaning. Design tokens and shared components make consistency the default. New variants should be added deliberately to the system, not improvised on a page.

**Signals.** Several border radii, shadow styles or button variants; one-off styles on individual pages; components duplicated with small visual differences.

**Ask.** Does this new element reuse existing tokens and components, or invent a variant?

**Traps.** Consistency that ignores genuinely different contexts.

## Imagery and icons share one style {#imagery}
<!-- terms: icon icons iconography imagery illustration photo photography style stroke fill consistent emoji -->

**Principle.** Use one icon family with consistent stroke, size and corner style, and imagery with a coherent treatment.

**Why.** Mixed icon sets (outline beside filled, different stroke widths, different metaphors) look assembled rather than designed. Icons need labels unless their meaning is universal. Photos and illustrations should share color treatment, perspective and level of detail. Decorative imagery should serve content, never push essential information below the fold.

**Signals.** Icons from different sets; emoji used as an icon system; stock images with clashing styles; decorative images dominating content.

**Ask.** Do all icons and images on this screen look like they came from the same hand?

**Traps.** Icons without text for non-obvious actions.

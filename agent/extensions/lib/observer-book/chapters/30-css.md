---
id: css
part: web
title: CSS and layout
summary: Robust styling: layout primitives (flow, flex, grid), intrinsic and container-driven sizing, the cascade and specificity, logical properties, modern CSS features, and debugging layout by inspection.
terms: css scss sass less tailwind flexbox flex grid layout position absolute sticky z-index stacking context overflow min-width minmax container query media query breakpoint responsive cascade specificity important custom properties variables logical properties clamp aspect-ratio
files: .css .scss .sass .less tailwind.config.js tailwind.config.ts .vue .svelte
tools: browser_session render_see design_audit
skills: web-patterns frontend-design css-battle animation-libraries
---

# CSS and layout

CSS is declarative constraint solving: you describe relationships and the browser computes positions. Most CSS pain comes from fighting that model—absolute positioning, magic numbers and escalating specificity—instead of choosing the right layout primitive and letting content determine size.

## Choose the right layout primitive {#layout-primitives}
<!-- terms: flex flexbox grid flow layout one dimension two dimension columns rows gap stack -->

**Principle.** Use normal flow for documents, flexbox for one-dimensional alignment and distribution, and grid for two-dimensional layouts; reach for positioning only for overlays.

**Why.** Each primitive solves a class of problems natively. Grid handles page layouts, card galleries and forms with aligned columns; flexbox handles toolbars, nav items and centering; gap replaces margin hacks. Absolute positioning removes elements from flow, so they stop responding to content and viewport changes—fine for badges and dropdowns, fragile for page structure.

**Signals.** Absolute positioning for main layout; nested flex containers imitating a grid; margins used to create gaps between siblings.

**Ask.** Is this layout one- or two-dimensional, and is the matching primitive being used?

**Traps.** Grid for simple rows; complex grid template areas nobody can maintain.

## Let content size things {#intrinsic-sizing}
<!-- terms: intrinsic sizing min-width 0 minmax fit-content max-content overflow text overflow shrink long content truncate -->

**Principle.** Prefer intrinsic sizing and flexible constraints (min, max, minmax, clamp) over fixed widths and heights; plan for long and short content.

**Why.** Fixed dimensions break with real content: long names, translations, larger user fonts. Flex and grid children have intrinsic minimum widths that cause overflow unless min-width: 0 or minmax(0, 1fr) allows shrinking. Testing with extreme content—very long words, empty strings, many items—reveals these failures before users do.

**Signals.** Fixed heights on text containers; overflow at narrow widths; layouts tested only with placeholder text.

**Ask.** What happens to this layout with text three times longer, or none at all?

**Traps.** Hiding overflow and silently clipping important content.

## Respond to containers, not just viewports {#container-queries}
<!-- terms: container queries container-type media queries breakpoints responsive component context -->

**Principle.** Components should adapt to the space they are given, using container queries, while page-level layout responds to the viewport.

**Why.** A card in a narrow sidebar and the same card in a wide main column need different layouts, but the viewport is the same. Media queries tie components to page context and break reuse. Container queries let each component respond to its actual available width, making components portable.

**Signals.** Component styles keyed to viewport breakpoints; the same component duplicated for sidebar and main areas.

**Ask.** Would this component look right if placed in a narrower or wider container at the same viewport?

**Traps.** Container query containment affecting layout in unexpected ways.

## Work with the cascade, keep specificity flat {#cascade}
<!-- terms: cascade specificity important override selector nesting layers @layer order inheritance reset -->

**Principle.** Keep selectors low and uniform in specificity, organize styles into ordered layers, and treat !important as a sign of architecture trouble.

**Why.** Specificity wars—ids, deep nesting, !important to beat !important—make styles unpredictable and changes risky. Cascade layers (@layer) control precedence explicitly: resets, then base, then components, then utilities. Flat class-based selectors make overrides predictable. Inheritance is a feature: set typography on containers rather than every element.

**Signals.** New !important declarations; deeply nested selectors; overrides that only work because of load order.

**Ask.** Why does this rule need its specificity, and could layer order express the priority instead?

**Traps.** Utility classes and component styles fighting without a defined order.

## Stacking contexts explain z-index surprises {#stacking}
<!-- terms: z-index stacking context overlay modal dropdown transform opacity isolation position fixed -->

**Principle.** When z-index "does not work", find the stacking context: transforms, opacity, filters and positioned ancestors create new contexts that cap their children.

**Why.** z-index only compares elements within the same stacking context. A dropdown inside a transformed card can never escape above a sibling card, no matter how large its z-index. The fix is structural—portal overlays to the document root, or restructure contexts—not bigger numbers. A small documented z-index scale (base, dropdown, sticky, modal, toast) prevents escalation.

**Signals.** z-index values like 9999; overlays clipped or hidden behind siblings; z-index changes that have no effect.

**Ask.** Which stacking context contains this element, and does the overlay need to live outside it?

**Traps.** Adding isolation or transforms that create new contexts accidentally.

## Use logical properties and modern features {#modern-css}
<!-- terms: logical properties margin-inline padding-block rtl clamp aspect-ratio has selector nesting subgrid view transitions color-mix oklch -->

**Principle.** Prefer logical properties for direction-aware spacing, and use widely supported modern CSS (clamp, aspect-ratio, :has, subgrid, color-mix) instead of JavaScript or hacks.

**Why.** Logical properties (margin-inline-start rather than margin-left) make layouts work in right-to-left languages automatically. Modern features remove whole categories of workarounds: aspect-ratio replaces padding hacks, clamp replaces media-query ladders for fluid sizes, :has replaces JavaScript for parent styling, subgrid aligns nested content. Checking support tables keeps usage safe.

**Signals.** JavaScript measuring and setting sizes that CSS can express; padding-top percentage hacks; physical properties in internationalized apps.

**Ask.** Is there a modern CSS feature that expresses this without JavaScript or hacks?

**Traps.** Using features unsupported by the product's actual browser matrix.

## Debug layout by inspection, not by guessing {#debug-css}
<!-- terms: debug devtools inspect computed style box model outline overflow layout shift why -->

**Principle.** Inspect computed styles, box models and layout overlays to see why an element is where it is before changing CSS.

**Why.** Guessing at CSS fixes produces layered overrides that fix one symptom and break another. Browser devtools show which rule wins, computed sizes, flex and grid overlays, and overflow sources. Temporarily outlining all elements finds the element causing horizontal scroll. For agents, rendering and measuring element boxes provides the same evidence.

**Signals.** Several speculative CSS edits for one layout bug; overflow bugs "fixed" with overflow: hidden on body.

**Ask.** Which rule actually determines this element's size or position, according to computed styles?

**Traps.** Fixing layout at one breakpoint while breaking others unnoticed.

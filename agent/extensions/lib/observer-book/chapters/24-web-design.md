---
id: web-design
part: design
title: Modern web design patterns
summary: Contemporary patterns and when they fit: landing page anatomy, bento grids, hero sections, sticky and command navigation, cards, micro-interactions, scroll storytelling, glass and gradients, design tokens and view transitions.
terms: landing page landing hero section bento grid cards card sticky navbar command palette micro-interaction micro-interactions scroll storytelling parallax glassmorphism gradient gradients blur modern website site homepage marketing page saas portfolio tailwind shadcn tokens view transitions animation section layout
files: .html .css .scss .tsx .jsx .vue .svelte .astro
tools: browser_session render_see design_audit web_asset_check
skills: frontend-design web-patterns modern-frontend-frameworks scroll-animated-websites web-effects component-libraries web-ui-stack-selection
---

# Modern web design patterns

Patterns are solutions that users already understand. Used well, they reduce cognitive load; used as decoration, they make every site look the same. The doctrine is to know why a pattern works, when it fits, and what its failure mode looks like.

## Landing pages follow promise, proof, path {#landing-anatomy}
<!-- terms: landing hero homepage value proposition social proof cta pricing faq footer section order marketing site -->

**Principle.** Structure a landing page as a promise (what you get), proof (why believe it) and path (how to start), in that order, with one primary call to action.

**Why.** Visitors decide within seconds whether a page is for them. The hero must state the specific value for a specific audience, not a vague slogan. Proof—product screenshots, demos, concrete numbers, recognizable customers, testimonials—converts interest into belief. The path removes friction: a clear primary action repeated at logical points, pricing clarity and answers to objections (FAQ). Sections that do none of these jobs dilute the page.

**Signals.** Heroes with abstract slogans and stock imagery; many competing calls to action; features listed without proof or product visuals.

**Ask.** Within five seconds, can a visitor tell what this is, who it is for, and what to do next?

**Traps.** Copying a famous company's page structure without its brand recognition.

## Bento grids organize, they do not decorate {#bento}
<!-- terms: bento grid tiles cards features asymmetric layout grid mosaic -->

**Principle.** Use bento-style grids to present several related features at a glance, with tile size reflecting importance and every tile carrying one clear idea.

**Why.** Bento layouts (popularized by product marketing pages) group diverse content into a coherent mosaic, allowing scanning and visual rhythm. They fail when tiles are filled with filler text, equal sizes erase hierarchy, or responsive collapse turns them into an endless column of cards. Designing the mobile stacking order deliberately is part of the pattern.

**Signals.** Bento tiles with vague copy; all tiles the same size; broken or awkward stacking on mobile.

**Ask.** Does each tile carry one distinct idea, and does tile size reflect importance?

**Traps.** Using bento because it is fashionable when a simple list communicates better.

## Heroes should show the product {#hero}
<!-- terms: hero section headline subheadline image screenshot demo video product shot above the fold -->

**Principle.** The best hero visual is the product in use—a real screenshot, short loop or interactive demo—not an abstract illustration.

**Why.** Abstract 3D blobs and stock photos communicate nothing specific and look like every other site. A clear product visual answers "what does it look like, and could I use it?" immediately. Performance matters: hero media is usually the largest contentful paint, so it must be optimized, sized and prioritized.

**Signals.** Hero with decorative illustration and no product; heavy autoplay video delaying load; text over busy images with poor contrast.

**Ask.** Does the hero visual show what the product actually does?

**Traps.** Screenshots too small or detailed to read; outdated product screenshots.

## Navigation patterns for scale: sticky headers and command palettes {#navigation-patterns}
<!-- terms: sticky header navbar command palette keyboard shortcut search cmd-k sidebar mega menu -->

**Principle.** Keep primary navigation reachable with a compact sticky header on content sites, and offer command palettes and search for power users of complex apps.

**Why.** Sticky headers keep orientation and calls to action available, but tall ones steal scarce vertical space, especially on mobile; shrinking on scroll is a common compromise. Command palettes (Cmd+K) give keyboard users direct access to every action without deep menus, scaling navigation as products grow. Both must be discoverable and accessible.

**Signals.** Tall sticky headers on mobile; complex apps where every action requires menu digging; command palettes with no visible hint.

**Ask.** How many clicks does a frequent action take, and could a palette or shortcut reduce it?

**Traps.** Sticky elements stacking until content has little room.

## Micro-interactions confirm, not entertain {#micro-interactions}
<!-- terms: micro-interaction hover state transition feedback animation button press toggle confetti delight -->

**Principle.** Small animations should confirm actions, show state changes and guide attention—fast, subtle and consistent.

**Why.** A button that depresses, a toggle that slides, a list item that animates into place: these make interfaces feel responsive and help users follow changes. Micro-interactions become noise when slow, bouncy everywhere, or decorative ("delight" that delays work). Durations around 150–250 ms with ease-out curves feel responsive.

**Signals.** Animations longer than half a second on frequent actions; inconsistent easing; animations with no functional purpose.

**Ask.** What does each animation here tell the user that they would otherwise miss?

**Traps.** Confetti and celebrations for routine actions.

## Scroll storytelling needs a story {#scroll-storytelling}
<!-- terms: scroll storytelling parallax scrollytelling reveal sticky scroll-driven animation pinned sections -->

**Principle.** Scroll-driven animation should reveal a narrative step by step; it must stay performant, skippable and usable with reduced motion.

**Why.** Scroll storytelling can explain complex products memorably—pinned sections that transform as the user scrolls, diagrams that build up. Done without a story it becomes scroll-jacking: fighting the user's scroll, hiding content, draining battery. CSS scroll-driven animations and IntersectionObserver keep it smooth; content must remain readable if animation is disabled.

**Signals.** Scroll-hijacking; content visible only after animations run; heavy JavaScript scroll listeners; no reduced-motion fallback.

**Ask.** Is there a narrative that scrolling reveals, and does the page work with animation off?

**Traps.** Parallax causing motion sickness; long pinned sections trapping users.

## Glass, gradients and glows need contrast discipline {#effects}
<!-- terms: glassmorphism glass blur backdrop filter gradient mesh glow neon shadow effect aurora -->

**Principle.** Visual effects like frosted glass, mesh gradients and glows can add depth, but text on them must keep contrast and the effect must not dominate content.

**Why.** Backdrop blur and translucent surfaces look elegant in mockups but produce unpredictable contrast over varying content, and blur is expensive to render on low-end devices. Gradients and glows age quickly as trends and can signal generic "AI startup" aesthetics. Effects should be accents: one hero gradient, glass for overlays that sit above real content.

**Signals.** Text on translucent or gradient backgrounds without contrast checks; many stacked blur layers; effects on every card.

**Ask.** Does this effect serve the content, and is text over it readable in all positions?

**Traps.** Performance cliffs from backdrop-filter on large areas.

## Tokens and components make patterns consistent {#design-tokens}
<!-- terms: design tokens component library shadcn tailwind variables system theme variants radius shadow -->

**Principle.** Express patterns through shared tokens and components—colors, spacing, radius, shadows, typography—so every page applies them consistently.

**Why.** Pages built with ad hoc values drift apart quickly. Tokens make brand changes and theming cheap; component libraries encode states and accessibility once. Utility-first CSS (like Tailwind) works best with a constrained configured scale rather than arbitrary values; copied component kits need adaptation to the brand to avoid the generic look.

**Signals.** Arbitrary values in utility classes; copied components left in default library styling; inconsistent radii and shadows.

**Ask.** Do these pages draw their visual values from shared tokens, or from local choices?

**Traps.** Over-abstracting components before patterns stabilize.

---
id: web-design
part: design
title: Modern web design patterns
summary: Contemporary patterns and when they fit: landing page anatomy, bento grids, hero sections, sticky and command navigation, cards, micro-interactions, scroll storytelling, glass and gradients, design tokens and view transitions.
terms: landing page landing hero section bento grid cards card sticky navbar command palette micro-interaction micro-interactions scroll storytelling parallax glassmorphism gradient gradients blur modern website site homepage marketing page saas portfolio tailwind shadcn tokens view transitions animation section layout necessity slop leakage meta theater
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

## A mentioned site is context, not a template {#reference-not-template}
<!-- terms: reference personal website link credit author portfolio existing site sibling copy mimic clone borrow template same fonts same palette inspiration identity original unique -->

**Principle.** A site, product or file named in the brief for a link, credit, deployment or shared conventions informs those things only; the new work gets its own visual identity unless the user explicitly asks to match something.

**Why.** Whatever is already in context is the path of least resistance, so agents quietly lift fonts, palettes and layouts from the nearest example. The result reads as a sibling of an unrelated site and ignores the new brand's own character. Deployment conventions or code structure can be reused legitimately; appearance is a design decision that deserves its own reasoning.

**Signals.** The agent read a referenced site's styles, fonts or templates before any design direction was chosen; design notes cite "matches the other site"; the brief asked only for a link or credit.

**Ask.** Was this site referenced for its look, or only for a link or convention, and what does the new brand itself call for?

**Traps.** Refusing legitimate reuse the user asked for (shared components, house style, a family of sites); treating code conventions as design sources.

## Diverge before you converge on an open brief {#diverge}
<!-- terms: new website landing page redesign open brief vague surprise concept direction directions explore options alternatives moodboard peers competitors inspiration unique distinctive elegant beautiful ai slop generic -->

**Principle.** When the user leaves the look to you, study a handful of strong peers in the domain, sketch several genuinely different directions, and choose one with explicit criteria before building.

**Why.** The first idea is usually the category average: the same hero, gradient and sans serif as everything else. A short divergence pass (audience and purpose in a line, three to five peers for patterns and gaps, three distinct concepts, a stated choice) costs minutes and is the difference between a distinctive product and generic output. Writing the choice down keeps later pages consistent and lets reviewers judge against intent.

**Signals.** A new site or interface is being built with no stated direction, no peer research and no alternatives considered; the brief says "elegant", "unique", "no AI slop" or "surprise me".

**Ask.** Which directions were considered, what peers informed them, and why does the chosen one fit this brand better than the others?

**Traps.** Endless exploration that delays shipping; copying one peer instead of learning from several; ignoring constraints the user did state.

## Every element earns its place for this reader {#necessity}
<!-- terms: necessity completeness theater scope overreach sprawl cards sections footer icons motion widget onboarding faq testimonial minimal cut remove unrequested invented -->

**Principle.** Build for contextual necessity, not visible completeness: every section, claim, widget and page must earn its place for this reader, or be cut.

**Why.** Agents equate more output with more finished, so unasked pages accumulate thin sections, card grids, badge rows, giant footers, icons beside every heading, tours, chatbots and FAQs nobody asked — completion theater. Each addition costs maintenance and dilutes what matters, while looking impressive in a screenshot. The removal test decides: take the element away and ask what the reader loses; if the answer is nothing, it was theater. Unrequested scope (agentic overreach) gets proposed, never silently built.

**Signals.** Pages, features, copy or categories appear that the request never mentioned; sections thinner than their own chrome; repeated identical shapes (cards, badges, stats) carrying thin content.

**Ask.** For each added element: what does the reader lose if it is removed — and was it requested or invented?

**Traps.** Cutting to barrenness; removing richness the user explicitly asked for.

## Reader pages never expose the backstage {#no-leakage}
<!-- terms: leakage implementation stack framework hosting repository pipeline schema AI-powered provenance transparency architecture meta backstage built-with docs -->

**Principle.** User-facing pages never expose implementation, process or provenance details unless the page exists to document them; every visible detail serves the reader's purpose.

**Why.** Stack badges, framework and hosting names, pipeline talk, "AI-assisted" labels and how-this-site-works sections narrate production instead of delivering value — the reader came for the outcome, not the backstage tour. Such leakage also dates the page and invites questions nobody can answer from marketing copy. The exception is pages whose purpose is the implementation (docs, changelog, status, engineering blog), where specificity is the virtue; marketing pages link to those instead of inlining the tour.

**Signals.** Framework, hosting, repo, pipeline or schema names in marketing and product copy; meta sections about the site itself; AI-production labels on non-AI products; process narration (generated, reviewed, deployed).

**Ask.** Does this line help the reader decide or do the next thing — or only prove how the thing was made?

**Traps.** Stripping legitimate docs; removing names the reader chose (payment rails on pricing).

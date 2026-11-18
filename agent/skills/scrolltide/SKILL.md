---
name: scrolltide
description: "Take influence from the scroll-driven sites, heroes, components, sections and shader backgrounds at scrolltide.co - 340 examples indexed by kind, with the moves that make them work. Use when building or improving a landing page, hero, product reveal, portfolio, storefront or any page that should move and be remembered, when a page feels static or like a template, and when asked for scroll animation, scroll storytelling, parallax or \"make it feel alive\". Not for dashboards and tools people work in all day, and never a source to copy."
---

# Scrolltide

[scrolltide.co](https://www.scrolltide.co/) shows pages that move with the scrollbar and the cursor. Its listings and preview films are public; they are the reference here. Its prompts and template code are a paid product and are not used: take the idea and the level of craft, and build the page from this product's own subject, content and brand.

## When to open it

Before you settle the concept of a landing page, hero, product reveal, portfolio or storefront. Read one or two of the files in `references/`, pick two or three entries close to the subject, and open their pages in the browser to watch the preview film. Then say in one line which move you are taking and why it fits this product.

| For | Read |
|---|---|
| A whole landing page told on the scrollbar | `references/landing-pages.md` (43) |
| A first screen that people remember | `references/heroes.md` (86) |
| A page built around a 3D scene | `references/3d-websites.md` (20) |
| Buttons, cards, loaders, navigation, text and input with a physical idea | `references/components.md` (98) |
| Features, pricing, contact, call to action, footer | `references/sections.md` (24) |
| App screens (dashboard, finance, commerce) | `references/ui-screens.md` (14) |
| Moving backgrounds: gradient, aurora, metal, halftone, swirl, voronoi, flame | `references/shaders.md` (55) |

## The moves these examples share

1. **One subject, one idea.** A watch taken apart, a penguin walking onto ice, a balloon flight up a canyon. A concrete thing from the product's own world carries the page, never an abstract gradient with a headline on it.
2. **One continuous shot on the scrollbar.** A single camera move is cut into frames (around 100 to 240) and drawn to a canvas as the page scrolls, so scrolling is playing the film. The copy arrives in chapters over it and leaves again.
3. **The page answers the hand.** A head that turns after the cursor, liquid poured by the pointer, grass that grows where it passes, a face you can pull. One such response, done precisely, beats ten hover effects.
4. **Depth from plates.** A scene cut into layers (six to eleven) that move at different speeds, with the nearest passing in front of the text only once.
5. **A clip that plays once and settles.** The motion lands on a still so exact that the join cannot be seen; the page is calm afterwards.
6. **Type that does the work.** A large headline whose key words change to an italic serif or to the accent color; the wordmark set huge behind the subject. Little text besides.
7. **A palette from the scene.** Colors are taken from the picture (oxblood, moss and granite, sumi ink), not from a framework.

## Building it here

- The moving picture has to come from somewhere: draw it in code (canvas, SVG, three.js, a shader), render a scene once to frames, or use the user's own footage or product photos. Never stock filler, and say plainly when the idea needs footage that does not exist yet.
- Scroll scrubbing: decode frames ahead, draw the nearest frame in `requestAnimationFrame`, keep the canvas sticky and the chapter text in normal flow. Lenis or CSS scroll-driven animations for smoothness, GSAP ScrollTrigger when timelines are needed.
- Phone first. Fewer and smaller frames on a phone (WebP or AVIF, 720 px wide is enough), no cursor effects where there is no cursor: give touch its own response or a still.
- `prefers-reduced-motion` gets the settled still and the full text.
- The first screen must be readable before any frame has loaded: a poster frame, real text, then the film.
- Budget: this laptop has no graphics card and visitors' phones are slower. Time the page, cap the pixel ratio, pause off screen (see `machine-limits` before rendering frame sequences).
- Look at it: scroll the real page at phone and desktop width and watch the whole length, not one screenshot.

Pairs with `web-design` (the page and its content), `motion-video` (motion that earns its place), `threejs-3d` (the 3D scene), `uncommon-web` (the libraries to build it with) and `color-type` (palette and fonts).

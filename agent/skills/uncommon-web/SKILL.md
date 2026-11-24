---
name: uncommon-web
description: "Find a web library with a strong point of view instead of the default stack - an index of 425 libraries (dither and ASCII, text effects, shaders and WebGL backdrops, 3D, generative art, maps as art, hand-drawn, retro OS themes, CSS-only effects, motion and scroll, physics, tactile widgets, component kits, creative coding, music, games), each with install command, licence and live demo. Use before choosing an approach for a page, hero, background, text effect, interaction, chart or toy that should be distinctive, when a design looks like every other one, or when asked for inspiration or \"something different\". Not for palettes or fonts (color-type)."
---

# Uncommon Web

A field guide to web libraries that have a look or a behaviour of their own, taken from [webdev.teknium.io](https://webdev.teknium.io/) (vol. 1, October 2026). Every entry there runs live in the page, so each line in the reference files ends in a demo link you can open and look at.

The first library that comes to mind is the one every other page uses. This index is where to look second.

## How to use it

1. Say in one sentence what the page or part is about and what it should feel like. The technique comes from that, not from the list.
2. Pick one or two families from the table and read only those files in `references/`.
3. Shortlist two or three libraries and open their demos in the browser. Choose from what you saw, not from the name. For a page built from scratch or a big improvement, pass over the library you would reach for by habit and look at two you have not used: the whole list on one page is in `../ui-design/references/bold-redesign.md`.
4. Check the licence on the line (some are free only for non-commercial use, GSAP has its own terms) and the current version of the package before installing: the versions here are from October 2026.
5. Build it with the real content, then look at it at phone and desktop width.

## Families

| When the part needs | Read |
|---|---|
| 1-bit screens, halftone, newsprint, CRT, live ASCII | `references/dither-pixel-ascii.md` (5) |
| Pictures made of characters: braille, glyph maps, banners, a terminal UI in the page | `references/text-mode-braille-graphics.md` (20) |
| Shader fills, filters and borders that drop into product UI | `references/paper-shaders-in-depth.md` (1 library, 7 demos) |
| Text that is split, scrambled, annotated, written by hand, or laid out like print | `references/typography-text.md` (50) |
| A GPU backdrop for a hero: globes, fluid, gradients with depth | `references/shaders-webgl-3d.md` (20) |
| Refracting glass, soft surfaces, gaussian splats, sequenced 3D scenes | `references/materials-3d-splats.md` (15) |
| A signature effect: glitch, generative patterns, low-poly fields | `references/visual-effects-generative-art.md` (15) |
| Music visualisers and feedback loops | `references/audio-visual-feedback.md` (13) |
| Code that draws: ink landscapes, plotter lines, pigment, procedural plants | `references/generative-art-plotters.md` (19) |
| Data as the picture: flight arcs, huge graphs, projections, wind maps | `references/data-maps-graphs-as-art.md` (13) |
| Wobbly, sketched shapes, charts and whiteboards | `references/hand-drawn-sketchy.md` (7) |
| A whole operating-system look as a stylesheet | `references/retro-os-themed-css.md` (25) |
| Effects in CSS alone: paint worklets, patterns, foil, typographic stylesheets | `references/css-only-stylesheets.md` (15) |
| Springs, timelines, layout transitions, smooth scroll | `references/motion-physics-interaction.md` (38) |
| How one view becomes the next: page curls, folds, zooming, scrollytelling | `references/scroll-pages-transitions.md` (16) |
| Things that behave like matter: water, cloth, rigid bodies | `references/physics-simulation.md` (10) |
| Widgets people remember: split-flap boards, knobs, counters, brushes | `references/tactile-odd-widgets.md` (46) |
| Copy-in React components and the usual primitives | `references/react-component-registries.md` (8) |
| Animated React components installed as editable source | `references/react-bits-in-depth.md` (1 library, 9 demos) |
| A component kit with an identity: 8-bit, neo-brutalist, with sound | `references/opinionated-component-kits.md` (39) |
| Sketchbooks, live-coded visuals, tiny engines | `references/creative-coding-sound.md` (8) |
| Synths, trackers, sheet music, tabs | `references/music-synths-notation.md` (28) |
| Small game engines, fantasy consoles, emulators | `references/games-consoles-emulators.md` (15) |

## Rules that still hold

- One strong idea per page. A second effect competes with the first; everything around it stays quiet.
- The look must come from the subject. A retro OS theme, ASCII, monospace or a dark terminal look is right when the product is about that, and a costume everywhere else.
- It has to run on a phone and on a laptop without a graphics card: lazy-load the heavy part, cap the pixel ratio, pause it off screen, and give `prefers-reduced-motion` a still version.
- Real text stays real text: readable, selectable, with enough contrast over any shader or pattern.
- An existing brand or design system wins. Use this index for the part that is free, not to replace what the product already is.
- Take the technique, not the demo: build with this product's content, colors and proportions.

Pairs with `web-design` (the page), `color-type` (palette and fonts), `motion-video` (motion that earns its place), `threejs-3d` (real 3D) and `illustration-svg` (drawn pictures).

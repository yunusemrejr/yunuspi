# Palette and type from the subject

## Palette

Choose a hue because the subject's world has one, not because a color looks nice. Sample it: the dominant hue of the real photography or product (`image_analyze` returns a palette with roles for a reference image), the color the thing is in real life, the color of its tools or its light. Then:

```
node scripts/palette.mjs --hue 165 --mood deep --bias cool --harmony split --dark
```

- `--mood vivid|soft|deep|muted` sets chroma and lightness of the accent.
- `--bias accent|warm|cool|<hue>` sets the hue the neutrals lean toward. Neutrals with a deliberate lean are what makes a page feel designed. Say in one line why this hue.
- `--harmony mono|analogous|complement|split|triad` produces up to two supporting hues, already adjusted to read on the background.
- `--target 4.5|7` is the contrast every text role must clear; the report lists each pair so you can quote it.
- It warns when the result lands on the indigo-to-purple or cream-and-terracotta defaults. Keep that only when the user asked or the subject truly owns it, and pass `--allow-default` to acknowledge it.

Use the accent for one job: the action, the link, the focus ring, the one highlight. `--accent-wash` is for selected and hover states. A second and third hue belong to data or a motif, not to decoration. Put every color in a token and use `color-mix(in oklab, …)` for tints instead of new hex values. Dark mode is rebuilt, not inverted; the generator does that when you pass `--dark`.

## Type

Type carries the voice before any image loads. Pick two faces by job:

1. **A voice face** for display: the one with character that fits the subject (a heavy condensed face for something loud and physical, a soft rounded one for something friendly, a sturdy serif for something trusted and old, a wide grotesque for something technical and young).
2. **A workhorse** for reading: neutral, sturdy at 16 to 18 px, with the language coverage you need (check the glyphs for the page's language, for example Turkish dotted and dotless i, ş, ğ).

Name the pairing's reason in one line. Reject Inter by default and the Space Grotesk, Instrument Serif and Geist rotation as a substitute for a decision. A catalogue to choose from by voice (all open licensed, on Google Fonts and Fontsource):

| Voice | Families |
| --- | --- |
| wide or technical grotesque | Archivo (has a width axis), Bricolage Grotesque, Schibsted Grotesk, Unbounded, Syne, Epilogue, Red Hat Display |
| humanist and legible | Atkinson Hyperlegible, Source Sans 3, Public Sans, Figtree, Albert Sans, Lexend, Be Vietnam Pro |
| friendly and rounded | Fredoka, Nunito, Quicksand, Baloo 2, Varela Round |
| serif with warmth | Fraunces, Newsreader, Source Serif 4, Literata, Young Serif, Spectral, Crimson Pro |
| serif with drama | DM Serif Display, Gloock, Bodoni Moda, Libre Caslon Display |
| condensed and loud | Anton, Bebas Neue, Oswald, League Gothic, Big Shoulders Display, Barlow Condensed |
| slab | Bitter, Zilla Slab, Arvo, Roboto Slab |
| mono | JetBrains Mono, IBM Plex Mono, Martian Mono, DM Mono, Spline Sans Mono |

A single family with several weights or a variable axis often beats a pair. Whatever you choose, check it renders at the real sizes in a capture.

## Loading and sizing

- Self-host `woff2`, subset to the languages used, `font-display: swap`, and preload only the one face above the fold. Add a fallback with `size-adjust`, `ascent-override` and `descent-override` so the swap does not shift layout.
- Fluid scale with `clamp()`: `--step-0: clamp(1rem, .95rem + .3vw, 1.125rem)` up through a display step, one ratio, roles named (display, heading, body, caption).
- Measure 60 to 75 characters, line height 1.5 to 1.7 for body and 1.05 to 1.2 for display. Tracking only on short uppercase labels.
- Tight display type is a design decision, not a default: if a headline is very large, check it at 390 px wide for overflow and orphaned words (`text-wrap: balance`).

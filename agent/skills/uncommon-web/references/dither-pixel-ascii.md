# Dither, pixel & ASCII

Ordered dithering, halftones, CRT phosphor and live ASCII. The look of 1-bit screens and newsprint, running on shaders.

5 libraries, from Uncommon Web (webdev.teknium.io, field guide vol. 1, October 2026). Versions are the ones shown there: check the current release before installing.

- **dithercn**: A Bayer dither engine plus examples, installed via the shadcn registry `npx shadcn@latest add https://dithercn.dev/r/dither-globe.json` ; `npx shadcn@latest add https://dithercn.dev/r/bar-chart.json https://dithercn.dev/r/gauge.json https://dithercn.dev/r/heatmap.json` · MIT vregistry (fetched 2026-10-22, shadcn 4.22.1) · [demo 1](https://webdev.teknium.io/d/dither/demos/dithercn-globe-hero/) [demo 2](https://webdev.teknium.io/d/dither/demos/dithercn-dashboard/)
- **Paper Shaders**: Zero-dependency WebGL shaders for React or vanilla JS `npm i @paper-design/shaders-react` · Apache-2.0 v0.0.82 · [source](https://github.com/paper-design/shaders) · [demo 1](https://webdev.teknium.io/d/dither/demos/paper-shaders-dithering/) [demo 2](https://webdev.teknium.io/d/dither/demos/paper-shaders-gallery/)
- **three.js AsciiEffect**: three.js add-on that renders any WebGL scene as text `npm i three` · MIT v0.186.1 · [source](https://github.com/mrdoob/three.js) · [demo](https://webdev.teknium.io/d/dither/demos/three-ascii-effect/)
- **pixi-filters**: Community WebGL filter collection for PixiJS v8 `npm i pixi.js pixi-filters` · MIT v6.1.5 · [source](https://github.com/pixijs/filters) · [demo](https://webdev.teknium.io/d/dither/demos/pixi-filters-crt/)
- **postprocessing**: pmndrs post-processing effect library for three.js `npm i three postprocessing` · Zlib v6.39.5 · [source](https://github.com/pmndrs/postprocessing) · [demo](https://webdev.teknium.io/d/dither/demos/postprocessing-pixel-ascii/)

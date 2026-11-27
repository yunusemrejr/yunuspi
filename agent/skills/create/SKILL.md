---
name: create
description: "UI, motion, 3D and images — one short method for visual work."
---

# Create — UI, motion, 3D, images

- One coherent system per surface: one spacing scale, few type roles, 2–3 colors, one radius.
- Prefer plain CSS/HTML/SVG first; reach for Blender/Three.js only when depth or physics needs it.
- Animate only transform/opacity; respect reduced motion; verify at 320px, tablet and desktop.
- Inspect rendered output (frames/contact sheet) before claiming visual quality.
- Tools are optional helpers (`blender`, the video and media tools, `image_understand`); plain `bash` always works.

## Writing one yourself

When nothing ready fits, these help a hand-written shader without deciding its look:

- **LYGIA** (lygia.xyz, github.com/patriciogonzalezvivo/lygia): small single-purpose functions for noise, SDFs, colour spaces, blending and lighting in GLSL, HLSL, WGSL and Metal. Read a function and copy the maths into the shader with a credit line, or include it through its resolver. The licence is Prosperity 3.0 (non-commercial; 30-day commercial trial) plus a paid patron licence, so for client or company work take the idea and write it, or ask before including the code.
- **Shadertoy** (shadertoy.com): the largest body of single-pass `mainImage(out vec4, in vec2)` shaders to learn a technique from. Code there belongs to its authors and is mostly non-commercial; learn the method, do not paste. The site blocks automated fetching, so open it in the browser.
- **Twigl** (twigl.app, MIT): a tiny editor for short GLSL, handy to try an idea in seconds and export a GIF or WebM still.
- **Hydra** (hydra.ojack.xyz, AGPL-3.0): live-coded video synthesis in chained JavaScript (`osc().kaleid().out()`); good for a quick generative backdrop or a music visual. AGPL: shipping its code in a page is distribution and brings source obligations, and a modified version used over a network must offer its source; for client work, take the idea and write it.

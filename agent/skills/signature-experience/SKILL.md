---
name: signature-experience
description: "Design and build ambitious, subject-specific web experiences: stunning, cinematic, immersive or awwwards-level sites with 3D heroes, WebGL and Three.js scenes, generated worlds, mascots, live product models and scroll storytelling."
---

# Signature experience

Pick the ambition level, derive one signature from the subject, build a static baseline first, then add layers that each get verified rendered.

## Ambition
- restrained (tools, dashboards, docs): ui-design rules. balanced (marketing, portfolio): one signature element. immersive (3D, cinematic, showcase): coherence and fallbacks over element counts.
- Constraints lower ambition, never quality; explicit user constraints win.

## One signature from the subject
- Name the subject's objects, materials, data and verbs; pick one hero signature, at most two motifs.
- Swap test: reject anything that fits an unrelated company. Avoid the median kit: floating orbs, aurora gradients, neon grids, glass over glow, drifting particles.
- Classes: generated world, live model, character, kinetic type, scroll narrative, shader field, data, sound.
- Write the poster frame (the paused look) before code. An empty still means failed design.

## Build order
- Baseline (accessible, no JS motion), tokens, signature as a frozen still, ambient life, interaction, scroll, sound (off by default), then measure and cut.
- Ambient life: low amplitude, signature only, paused when hidden or reduced motion; never on body text.
- Hover, tap, drag and keyboard hit the same actions; feedback under 100 ms.

## Palette and type
- `node scripts/palette.mjs --hue 165 --mood deep --bias cool --harmony split --dark` prints CSS tokens and a contrast report. Also --target 4.5|7, --json, --allow-default.
- Hue from the subject's photos or product; one accent for action and focus. Indigo and cream-terracotta are flagged; keep only if asked or owned.
- Display face with a voice matched to the subject; a neutral workhorse at 16-18px; self-host woff2 with a size-adjusted fallback.

## Motion
- Durations 120/220/400/700ms; ease-out in, ease-in-out travel; reduced motion sets all to 1ms.
- Animate transform and opacity only. Springs (stiffness k, damping c) for mascots, drag and magnetic hover, on one rAF loop that stops when settled.
- Reveals use IntersectionObserver; content shows without JS. Scroll-linked motion uses view() timelines with a fallback.
- One timeline owner per property. Split text keeps the full string in aria-label.
- Sound: Web Audio after a user gesture, visible toggle, choice remembered.

## Living things
- Character states: idle (blink every 2-6 s), look (pointer-tracked, clamped), react, rest. A focusable button with a visible ring; reduced motion shows the still pose.
- Live model: 3-5 inputs, seeded PRNG (mulberry32 in world-kit.mjs), heavy work in a Worker, SVG output, state in the URL hash, numbers mirrored in a table. Label it an example.

## Generated world (scripts/world-kit.mjs)
- Vendor a pinned three build beside the kit. Exports: generateTerrain, createDiorama, makeIsoCamera, bootScene. One plot per real destination; a seed keeps positions stable.
- Re-skin for the subject: palette roles (sky, water, sand, grass, rock, trunk, leaf, cloud, plots), subject decor.
- Canvas is aria-hidden; the link list is the interface; focus and click highlight the same plot.
- Poster: render_see still as AVIF or WebP, the first paint and no-WebGL fallback; reserve its box with aspect-ratio.

## Responsive, fallbacks, budgets
- Reframe, don't shrink: camera.userData.setFrame(aspect, zoom, offset) for phones; text on a calm region or scrim.
- Reduced motion: one still frame, no loops. No WebGL: poster plus links. Every pointer action has a keyboard path.
- 60 fps on a mid-range phone, else lower resolution: cap DPR, pause off screen, no per-frame allocation, dispose on teardown. LCP under 2.5 s.

## Verify rendered
- Capture poster and working state at 390, 768, 1440, dark and reduced motion; look at them. Software WebGL proves pixels, not frame rate.
- Two captures a second apart must differ for rAF or WebGL motion; reduced motion must freeze them. browser_session covers input and console.
- Blank canvas: size, lights, camera, getContext. Blurry: buffer vs CSS size and DPR. Unreadable copy: move it or add a scrim.
- Electron or Tauri: judge the real window too (bg_run, screenshot). GTK, Qt, Flutter: custom-painted signature; no repaint while hidden.

---
name: signature-experience
description: >-
  Design and build ambitious, subject-specific web experiences and apps: a stunning, immersive, cinematic or
  heavily animated site, a 3D or generated hero, a living scene or map, a mascot or character with behavior, an
  interactive preview of the product itself, kinetic typography, scroll storytelling, advanced motion graphics and
  sound. Use when the brief asks for wow, stunning, state-of-the-art, awwwards-level, 3D, WebGL, Three.js,
  scroll-driven or alive visuals, or when the page is looked at rather than used. Decides the ambition level,
  derives one signature from the subject's own world (never from a trend), builds a static baseline first, layers
  ambient life, interaction and scroll choreography, keeps every fallback, and verifies rendered at phone, tablet
  and desktop. Ships a contrast-guaranteed palette generator and a tested Three.js scene kit.
---

# Signature experience

`design-slop-prevention` and `frontend-design` keep a page from being generic. This skill is the other half: how to reach a page people remember. Their count caps (one flourish, one effect per screen, a page that is calm after load) are right for work that is used and wrong for work that is looked at. Pick the level first; the rest follows.

## 1. Choose the ambition level

| Level | Fits | Budget |
| --- | --- | --- |
| restrained | tools, dashboards, forms, docs, internal apps, anything dense or read for long | the finite-set rules in `frontend-design`, as written |
| balanced | most marketing pages, portfolios, product sites with no spectacle asked | one signature element; everything else quiet |
| immersive | the brief asks for stunning, cinematic, 3D, alive, advanced motion; brand, game, showcase, portfolio and launch pages | coherence, performance and fallbacks, not element counts |

Decide from four things: what the user asked in their own words, whether the page is looked at or used, the device and network the audience really has, and the assets you hold (real photos, a logo, a product, data). Constraints lower the level, never the quality: a restrained page still gets exact type, spacing and one considered detail. Say the level in the plan and record it with `creative_direct set` (`ambition`, `signature`, `motion.continuous`). An explicit user constraint (a palette, "minimalist", "no animation") always wins; ambition is a default, not an override.

## 2. Derive the signature from the subject

The signature is the one thing a visitor would describe afterwards. It must come from the subject's own world, which is why it cannot be pasted onto a competitor.

1. **Name the world.** List the subject's objects, spaces, materials, data and verbs. What does it do, where does it happen, what does it look like when it works?
2. **List what that world makes natural** from the repertoire below. Prefer candidates you can build and verify with the tools in hand.
3. **Score each candidate:** native fit (the swap test: would it work unchanged for an unrelated company? then reject it), buildability now, risk and weight, cost of its fallback, distinctiveness against peers you looked at.
4. **Choose one hero signature and at most two supporting motifs from the same world.** Every layer must be explainable by "because this is a ___".
5. **Record it** (`creative_direct set`) and write the poster frame (what it looks like paused) before any code.

Illustrations of the reasoning, never templates; a second subject of the same kind gets a different world: a catalogue of many small tools could become a place made of plots, a shelf, a workbench or a night sky of lit windows; a cooking assistant a table of ingredients, heat and steam, or a recipe card that rewrites itself; an estimator the spread of outcomes it computes, shown live; a person's brand with a mascot a character with moods; a studio a material the work is made of.

| Class | What it is | Native when | Build route | Fallback |
| --- | --- | --- | --- | --- |
| Generated world | procedural diorama, map, city, garden, terrain; places are real destinations | a hub, catalogue, location or collection | `scripts/world-kit.mjs` (Three.js, instanced), or canvas 2D/SVG when lighter | poster plus a real list of links |
| Live model of the product | an in-page working preview: simulator, calculator, configurator, chart that responds | tools, estimators, data products | vanilla JS, seeded PRNG, SVG or canvas | a precomputed example and an accessible table |
| Character with behavior | mascot or avatar with moods, eye tracking, springs, idle loops, reactions | personal brands, consumer, kids, community | SVG or CSS, Blender render sprites, canvas | the static pose |
| Art-directed imagery | controlled crops, a colour system, type over image, saturated blocks | food, travel, fashion, editorial, places | real photos or `image_generate`, AVIF/WebP with `srcset` | it is the baseline |
| Kinetic typography | headline that reacts: variable axes, per-letter motion, marquee | brands led by their name or words | variable fonts, CSS, small JS | static type |
| Scroll narrative | pinned scenes, scrubbed timelines, camera moves | launches, case studies, stories | CSS scroll-driven animation with an IntersectionObserver fallback, or GSAP ScrollTrigger | stacked sections |
| Shader atmosphere | a field of light, flow or noise | the subject is light, space, sound or water | fullscreen fragment shader | a CSS still of the same frame |
| Data as the hero | real data drawn large and alive | finance, science, civic, sport | SVG or canvas | the table |
| Sound | opt-in ambience and UI sounds, mute remembered | games, music, wellness | Web Audio | silence (the default) |

The shared median of AI "immersive" pages is a floating orb or blob, an aurora gradient, neon grid lines, glass cards over a glow and particles drifting for no reason. If your idea matches that list, it did not come from the subject.

## 3. Build in layers, verifying each

1. **Baseline.** Content, structure, tokens and responsive layout, fully styled and accessible with no JavaScript motion. This is what every fallback shows, so it must be good on its own.
2. **Tokens.** Palette from `scripts/palette.mjs` (hue, mood, bias, harmony; contrast is guaranteed and reported), a type pair chosen from the subject (`references/palette-and-type.md`), motion tokens (`references/motion-system.md`).
3. **Signature at one frozen state.** Render it and judge the still. If the still is empty, the effect is the design and the design failed.
4. **Ambient life.** Low amplitude, on the signature only, paused when hidden, off screen or reduced motion; never on body text.
5. **Interaction.** Hover, tap, drag and keyboard reach the same actions. Feedback within 100 ms.
6. **Scroll choreography.** Sections are scenes; progress is normalized; nothing scrubs layout properties.
7. **Sound (optional).** Off by default, one visible toggle, choice remembered.
8. **Performance and polish pass.** Measure, then cut.

## 4. Coherence replaces the count caps

- **One world model.** Palette, easing, timing, material and geometry all belong to the same imagined place. A layer that needs a separate justification is a second world.
- **Every layer has a job:** atmosphere, feedback, navigation or narrative. A layer with none fails the remove test.
- **Hierarchy of spend:** signature, then interactive elements, then transitions, then everything else.
- **Ambient motion is allowed** when it is the world being alive (water breathing, trees swaying) and bounded by the rules in step 4. It is not allowed as decoration over content.
- **One hero-grade effect per screen still holds**; immersive means the effect is rich and the rest of the page serves it.

## 5. Responsive art direction

Reframe, do not shrink. The signature gets a phone composition: a different crop, camera, density and zoom (`camera.userData.setFrame(aspect, zoom, offset)` in the kit), with text on a calm region or over a scrim. Pointer features degrade to tap (`@media (hover: hover)` for hover-only affordances). Check 390, 768 and 1440 wide, landscape phone, dark scheme and reduced motion. Touch targets stay at least 44 px.

## 6. Fallbacks and accessibility are not optional

Reduced motion renders one still frame and starts no loops. Without WebGL the poster and the real list of links remain. Every pointer interaction has a keyboard path, and a canvas is `aria-hidden` next to a real list, or `role="img"` with a label. Sound is opt-in. Contrast comes from the palette report. No JavaScript still gives the baseline.

## 7. Performance budgets

A mid-range phone holds 60 fps, or degrades resolution before features: cap the pixel ratio (the kit lowers it on sustained slow frames), pause rendering when hidden or off screen, instance repeated geometry, allocate nothing per frame, dispose what you built on teardown. Ship a poster so the largest paint is fast (aim for LCP under 2.5 s), preload and subset fonts, reserve the canvas box to avoid layout shift, vendor and pin libraries instead of loading unpinned CDNs.

## 8. Verify rendered

`render_see`, `ui_explore`, `visual_review`, `visual_diff` and `motion_inspect` capture WebGL pages in software, so the pixels are real while frame timing is not. Capture the poster and the working state at 390, 768 and 1440 wide, dark and reduced motion, and look at them. `motion_inspect` sees CSS and WAAPI only; confirm requestAnimationFrame or WebGL motion by capturing two frames apart in `browser_session` and checking they differ, and that reduced motion freezes them. Use `browser_session` for hover, click, drag, keyboard and console errors. Report performance as unmeasured on real hardware unless you measured it there.

## 9. Failure index

| Symptom | Cause | Fix |
| --- | --- | --- |
| blank or black canvas | no lights, camera outside the frame, canvas has no size, context failed | check size and `renderer.info`, add light, log `getContext` |
| blurry canvas | drawing buffer smaller than the CSS box, DPR ignored | resize buffer and camera together, cap but do not ignore DPR |
| scene hot or janky on phones | per-frame allocation, many draw calls, DPR 3 | instancing, merge static geometry, adaptive resolution |
| text unreadable over the scene | busy region under copy | move the camera or the copy, add a scrim, use the calm side |
| layout jumps when the scene mounts | canvas without a reserved box | fixed aspect or height before JS |
| page feels like a template | signature chosen before the subject | redo step 2, apply the swap test |
| animation fights itself | two systems own one property | one timeline owner per property |

## Files

- `scripts/palette.mjs`: `node palette.mjs --hue 165 --mood deep --bias cool --harmony split --dark` prints CSS tokens and a contrast report; `--json` for data. It flags the two house-default looks unless you pass `--allow-default`.
- `scripts/world-kit.mjs`: seeded terrain generator, diorama builder, isometric camera and a hardened renderer lifecycle. Copy it beside a vendored `three` build; see `references/three-world.md`.
- `references/three-world.md`: using the kit, customizing it for a subject, picking with a keyboard path, a shader-field recipe, and what to test.
- `references/motion-system.md`: tokens, springs, entrance and scroll choreography, kinetic type, view transitions, sound.
- `references/living-things.md`: characters with behavior and live product models.
- `references/palette-and-type.md`: palette method, type pairing from the subject, loading.

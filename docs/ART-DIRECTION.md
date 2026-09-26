# Art direction: the closed creative loop

Eight tools turn YunusPi's separate creative islands (UI, SVG, motion, image, audio) into one production loop: a shared direction steers implementation, real renders are inspected and critiqued, findings are fixed, and completion waits for evidence. The `design-direction` protocol and the Expert Director critics own the workflow; this document owns the machinery.

```text
            CREATIVE DIRECTION
                    │
                    ▼
              IMPLEMENTATION
                    │
                    ▼
            RENDER / SYNTHESIZE
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
     visual       motion       asset
      QA            QA         registry
        │           │           │
        └───────────┼───────────┘
                    ▼
              critique / fix
                    │
                    └───────↺
```

| Tool | What it does |
| --- | --- |
| `creative_direct` | Owns the structured brief: intent, focal hierarchy, visual bounds, avoid-list, motion and audio character, references. `set` validates and stores (session scope, or project scope in `.pi/creative-direction.json`); `brief` renders the compact context block every creative call reads. Parent owns mutation; children stay read-only. |
| `visual_review` | Reviews actual rendered output. `run` captures a source and returns rubric sections (accessibility, spacing, typography, composition, slop, hierarchy, distinctiveness, direction conformance) with deterministic evidence plus explicit `needsVision` gaps; pixels attach for vision models. `record` stores the judged verdict as a revision-sensitive receipt — `UNKNOWN` stays open, `FAIL` blocks completion until a clean re-review of the same revision lands. |
| `ui_explore` | Renders the viewport/state matrix (mobile/tablet/desktop × default, dark, reduced-motion, full-page; capped at 12 captures) with per-cell DOM facts: overflow elements, missing alt, controls, pattern findings, load errors. Writes `.pi/ui-review/` with `report.json`. |
| `motion_inspect` | Inventories main-frame CSS/WAAPI animations (target, timing, iterations, animated properties), renders an ASCII timeline, and flags concurrency, transform-owner collisions, layout-property animation, duration soup, infinite loops and ignored `prefers-reduced-motion`. Temporal QA samples deterministic clock frames and reports dead time, jump cuts and loop seams. |
| `svg_inspect` | Measures SVG engineering: viewBox, bounds, stroke language, fills, defs, id collisions, unresolved refs, transforms, accessibility, path complexity, optical center, padding and mass proxies. Multi-file calls add set-consistency review; `matrix` rasterizes representative sizes with ink-coverage proxies. |
| `asset_register` | Records asset provenance, roles (`hero-focal`, `editorial-support`, `diagram`, `texture`, `icon`, `illustration`, `background`, `product-shot`, `avatar`) with role constraints, parent/variant chains, usage, license and description in `.pi/assets/registry.json`. Search is lexical plus palette proximity; descriptions are kept for future vector indexing. |
| `image_generate` | Provider-agnostic generative imagery. `brief` merges prompt with direction avoid-list and role constraints without calling any backend; `status` reports configuration; `generate`/`edit` call the configured OpenAI-compatible backend, validate bytes, write receipted artifacts, auto-register provenance, and route back to `visual_review`. |
| `creative_compare` | Renders 2–4 direction variants at one width with a side-by-side strip and pairwise structural deltas (SSIM, changed share, palette) for design fusion. |

## How it works

- One direction, many media: `creative_direct` is the single brief UI, SVG, motion, image and audio work reads. QA tools check conformance against its avoid-list and report hits as possible boilerplate for the reviewer to judge, never as automatic failures.
- Evidence before completion: blocking `visual_review` verdicts, unresolved SVG geometry (active content, broken refs, duplicate ids) and ignored reduced-motion hold the completion gate through the `creative` verification source. Repeating the completion call after a refusal records an explicit waiver, like any other gate.
- Captures reuse the isolated browser: QA renders go through the same trusted `captureToFile` path as `visual_diff` (queued, sandboxed profiles, 20 MB artifact bound, pixels on disk). Animation inventory enumerates document-timeline animations without pausing them; sampling pauses each animation at its own local time.
- Image backends are configured, never hardcoded: `PI_IMAGE_BACKEND=openai-compatible`, `PI_IMAGE_API_URL` (default `https://api.openai.com/v1`), `PI_IMAGE_API_KEY` (fallback `OPENAI_API_KEY`), `PI_IMAGE_MODEL` (required, no invented default). API URLs must be https (http loopback only); keys never appear in outputs, receipts or logs. Unconfigured backends fail honestly; deterministic plates stay on `image_create`.
- Registration is content-hashed: assets dedupe by SHA-256, SVG/icons measure from source headers without external decoders, and receipts key on source revision so edits invalidate stale verdicts.

## Limits

- Deterministic verdicts cover what measurement can prove: contrast ratios, spacing/type counts, pattern hits, ink distribution, animation timing and geometry. Hierarchy, taste, distinctiveness and feel need vision judgment from the attached pixels — `UNKNOWN` must never be recorded as `PASS` without it.
- `ui_explore` renders states, not interactions: hover, focus, menus, loading/empty/error flows and keyboard behavior need `browser_session` passes. Content stress (long titles, missing images, 100 cards, RTL) is not auto-applied; probe representative states explicitly.
- Motion inventory sees the CSS/WAAPI document timeline only. JS/`requestAnimationFrame` systems, scroll timelines, cross-frame choreography and not-yet-created animations are out of scope and reported unknown. Sampled frames are not playback proof.
- SVG bounds apply translate/scale transforms; rotate/skew/matrix stay approximate and are disclosed per file. Ink share and optical center are deterministic proxies, not a designer's eye.
- A generated image is reviewed twice: once standalone, once integrated — an attractive asset can still fail inside the page.

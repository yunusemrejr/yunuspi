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
| `creative_direct` | Owns the structured brief: intent, ambition (restrained, balanced or immersive), the one signature element, focal hierarchy, visual bounds, avoid-list, motion and audio character, references. `set` validates and stores (session scope, or project scope in `.pi/creative-direction.json`); `brief` renders the compact context block every creative call reads. Parent owns mutation; children stay read-only. |
| `visual_review` | Reviews actual rendered output. `run` captures a source and returns rubric sections (accessibility, spacing, typography, composition, slop, hierarchy, distinctiveness, direction conformance) with deterministic evidence plus explicit `needsVision` gaps; pixels attach for vision models. `record` stores the judged verdict as a revision-sensitive receipt — `UNKNOWN` stays open, `FAIL` blocks completion until a clean re-review of the same revision lands. |
| `ui_explore` | Renders the viewport/state matrix (mobile/tablet/desktop × default, dark, reduced-motion, full-page; capped at 12 captures) with per-cell DOM facts: overflow elements, missing alt, controls, pattern findings, load errors. Writes `.pi/ui-review/` with `report.json`. |
| `motion_inspect` | Inventories main-frame CSS/WAAPI animations (target, timing, iterations, animated properties), renders an ASCII timeline, and flags concurrency, transform-owner collisions, layout-property animation, duration soup, infinite loops and possible shared-target property owners. Temporal QA samples each animation’s local clock. Reduced-motion failures require retained infinite transform timing plus actual moving reduced-state pixels; known loop periods get endpoint-parity evidence. See [motion/model preflight](MEDIA-PREFLIGHT.md). |
| `svg_inspect` | Measures SVG engineering: viewBox, bounds, stroke language, fills, defs, id collisions, unresolved refs, transforms, accessibility, path complexity, optical center, padding and mass proxies. Multi-file calls add set-consistency review; `matrix` rasterizes representative sizes with ink-coverage proxies. |
| `asset_register` | Records asset provenance, roles (`hero-focal`, `editorial-support`, `diagram`, `texture`, `icon`, `illustration`, `background`, `product-shot`, `avatar`) with role constraints, parent/variant chains, usage, license and description in `.pi/assets/registry.json`. Search is lexical plus palette proximity. `inspect` reads current local glTF/GLB resources, budgets, decoded mesh-local bounds and animation times; registration preserves source/creator/license URLs and compact advisory model metadata. Model fingerprints include dependencies. See [motion/model preflight](MEDIA-PREFLIGHT.md). |
| `image_generate` | Generative imagery through the native OpenRouter image client or an OpenAI-compatible backend. `status` lists available OpenRouter image models; `generate`/`edit` accept a `model`, decode-check returned pixels, register artifacts and route back to `visual_review`. `brief` prepares the prompt without inference. |
| `creative_compare` | Renders 2–4 direction variants at one width with a side-by-side strip and pairwise structural deltas (SSIM, changed share, palette) for design fusion. |

## How it works

- One direction, many media: `creative_direct` is the single brief UI, SVG, motion, image and audio work reads. QA tools check conformance against its avoid-list and report hits as possible boilerplate for the reviewer to judge, never as automatic failures.
- Evidence before completion: blocking `visual_review` verdicts, unresolved SVG geometry (active content, broken refs, duplicate ids) and ignored reduced-motion hold the completion gate through the `creative` verification source. Repeating the completion call after a refusal records an explicit waiver, like any other gate.
- Captures reuse the isolated browser: QA renders go through the same trusted `captureToFile` path as `visual_diff` (queued, sandboxed profiles, 20 MB artifact bound, pixels on disk).
- WebGL pages (a Three.js hero, a canvas scene) go through the same path. The first pass runs with WebGL off; a page that asks for it is captured once more in software (SwiftShader: CPU rasterization inside the sandbox, no GPU device access) within the same time budget. The pixels are real, frame timing and shader cost are not, and `webgl: "software"` appears in the capture conditions. WebGPU and worker rendering stay rejected, and the rasterizer's own performance notes are not reported as page errors. Animation inventory enumerates document-timeline animations without pausing them; sampling pauses each animation at its own local time.
- Existing OpenRouter environment or session credentials make its native image catalog available without extra setup. Run `image_generate {action:"status"}`, then pass a listed `model` with `generate` or `edit`; no model is silently selected. Explicit `PI_IMAGE_BACKEND` (`openrouter`, `openai-compatible`, or `off`) and `PI_IMAGE_MODEL` take precedence. `PI_IMAGE_API_URL` and `PI_IMAGE_API_KEY` remain optional overrides; each backend uses its own environment key fallback. Custom API URLs require an explicit backend. API URLs must be HTTPS (HTTP loopback only); keys never appear in outputs or receipts.
- OpenRouter reference edits use the existing native image client; masked edits retain the OpenAI-compatible multipart path. Model support for image configuration varies. Successful artifacts include decoded dimensions and `decodeVerified`; this establishes a readable image, not visual approval. Empty, truncated or oversized responses fail before publication. Deterministic plates stay on `image_create`.
- Registration is content-hashed: assets dedupe by SHA-256, SVG/icons measure from source headers without external decoders, and receipts key on source revision so edits invalidate stale verdicts.

## Ambition and the signature

The prompt discipline that keeps a dashboard calm also kept a "stunning, cinematic, 3D" brief from reaching the ambitious end: every count cap in the UI doctrine (one flourish, one effect per screen, calm after load) is right for work that is used and wrong for work that is looked at. A visual brief therefore carries an **ambition level**, read deterministically from its words and subject (`heuristicAmbition` in `lib/design-direction.ts`):

| Level | Read from | What the guidance permits |
| --- | --- | --- |
| restrained | minimalist, calm, "no animations", dashboards, forms, settings | the finite-set budget as written |
| balanced | no signal either way, or restraint and spectacle mixed | one signature element, everything else quiet |
| immersive | cinematic, 3D, WebGL, parallax, scroll-driven, motion graphics, "stunning" on a page that is looked at | coherence, performance and fallbacks replace the count caps |

An explicit refusal ("no animations") always wins, "stunning" on a tool reads as craft rather than spectacle, and the user's own constraints override the level. The level appears in the design-direction guidance and in `creative_direct` (`ambition`, `signature`, `motion.continuous`), so children and reviewers read the same decision. `visual_review` then asks for a pixel judgment that the signature is visible in the render and, for immersive work, judges coherence (one world model, every layer with a job, a fallback for reduced motion and no WebGL) rather than element count.

The `signature-experience` skill owns how to build above "restrained": deriving one signature from the subject's own world, a repertoire (generated world, live model of the product, character with behavior, art-directed imagery, kinetic typography, scroll narrative, shader atmosphere, data as the hero, sound), a baseline-first build order, responsive art direction, fallbacks and performance budgets. It ships `scripts/palette.mjs` (OKLCH palettes with contrast guaranteed and reported, and a flag for the two house-default looks) and `scripts/world-kit.mjs` (seeded terrain, instanced diorama, isometric camera and a renderer lifecycle that pauses, adapts resolution, survives context loss and disposes). Both are covered by `tests/signature-experience.test.mjs`, which renders the kit through the same software-WebGL capture the QA tools use.

## Limits

- Deterministic verdicts cover what measurement can prove: contrast ratios, spacing/type counts, pattern hits, ink distribution, animation timing and geometry. Hierarchy, taste, distinctiveness and feel need vision judgment from the attached pixels — `UNKNOWN` must never be recorded as `PASS` without it.
- `ui_explore` renders states, not interactions: hover, focus, menus, loading/empty/error flows and keyboard behavior need `browser_session` passes. Content stress (long titles, missing images, 100 cards, RTL) is not auto-applied; probe representative states explicitly.
- Motion inventory sees the CSS/WAAPI document timeline and discoverable SVG SMIL roots. JS/`requestAnimationFrame` systems, scroll timelines, cross-frame choreography and not-yet-created animations are out of scope and reported unknown. Sampled frames are not playback proof.
- SVG bounds apply translate, scale, centered rotation, skew and matrix transforms in SVG order. Lines and sampled path vertices are transformed before boxing; ellipse bounds use affine extrema. Unused definitions and display-none subtrees do not inflate visible bounds. Sampled curves, malformed transforms, nested viewports and unsupported paint features retain explicit approximation limits. Ink share and optical center remain geometric proxies.
- SVG matrix capture fits the source into a square white image viewport while preserving aspect ratio, then downsamples the retained master. Image-context loading leaves scripts and external resources unavailable. Failed captures remove partial artifacts. These pixel/coverage proxies still require visual review; native small-size hinting needs a separate capture.
- A generated image is reviewed twice: once standalone, once integrated — an attractive asset can still fail inside the page.

For generation/edit compatibility, direct vision inference, conversion, deterministic SVG export and narrated 2D/3D composition, see [media creation](MEDIA-CREATION.md).

# Autonomous UI engineering

The adaptive pipeline owner selects tools from the authored task and observed relevant source, manifests and dependencies. Main prompts, goals, continuing work and short steering follow-ups use the same policy. Tools become available within the host's existing ceiling; selection does not execute them, install dependencies, change the selected model or grant access. Live guidance points at unresolved stages and current receipts. A new source revision retires stale checks.

UI work starts from its real audience, content, existing component owners and design direction. References inform decisions about composition, hierarchy, subject imagery and motion; they do not supply a template or a brand to clone. A strong reference can use vivid color, rounded controls or immersive animation. Those choices need a job in this project. Neither a purple glass hero nor a beige editorial skin is the default, and invented proof, fake testimonials and decorative AI status are excluded.

## Tools and evidence

| Tool | Behavior |
| --- | --- |
| `motion_inspect` | `mode:"scroll"` observes forward/backward scroll; `mode:"time"` seeks CSS/WAAPI/SMIL; `mode:"render"` explicitly awaits the existing HTML video `window.renderFrame(seconds)` clock. Each temporal pass reuses one loaded page and its assets. Saved frames, coverage, errors and source/document changes remain visible. |
| `ui_explore` | Defaults to 320px/mobile/tablet/desktop coverage and adds touch, DPR, phone orientation and CSS breakpoint neighbors to the viewport/theme/reduced-motion matrix. The bounded plan reports omitted cells so a partial matrix cannot masquerade as device coverage. |
| `ui_consistency` | Compares named shared roles and selected CSS custom properties across 2–4 routes. Declared variants compare within their own group. Missing roles, failed captures and source changes remain explicit. Style drift is measured evidence for review, not a taste score. |
| `image_generate` | The existing image planner preserves exact selected models and validates image roles, references, capabilities and bounded cost. Review the asset alone and integrated into the page; a decoded image is not artistic approval. |

`creative_direct` remains the shared direction owner. `render_see`, `visual_review` and the interactive browser supply distinct kinds of evidence. A capture is not a completed user interaction, and a measured effect count is not a reason to redesign a valid interface. Use the normal served application, real content and project rules.

Visual reports keep findings and coverage inline and save full typography/spacing tables at `report`; use `detail:true` when those measurements are needed in context. For browser assertions, `verify` accepts exact text, an element state or `kind:"function"` with a script returning a boolean. A false predicate returns `matches:false` after one execution; it does not poll or certify a submission. Use `wait` separately when a bounded wait is needed.

UI verification uses current native run IDs and source revisions. Responsive measurements and inspected matrix pixels, every visual-review rubric section, and the representative keyboard/input task remain separate requirements. Generic technical receipts cannot replace them. The default-on verifier provides bounded follow-ups for missing evidence; `PI_UI_VERIFICATION=off` is an explicit user opt-out.

Inspect the real scroll sequence after integration, including reverse scrolling, focus, resize and reduced motion. Static frames demonstrate sampled output; they do not establish continuous smoothness, FPS or physical GPU cost.

Typography QA counts text-bearing elements rather than inherited fonts on empty layout wrappers. The visual rubric reports computed text sizes when available, discloses incomplete coverage and leaves typography judgment open for rendered review against the actual product. Pixel-ink clusters and font counts do not establish a good reading hierarchy or justify a uniform aesthetic.

## Motion inspection

The video renderer and `motion_inspect {mode:"render"}` set the existing `exporting` body class, await the supplied frame function and paint boundary, and preserve the host's clock. Optional `window.__renderReady=false` defers inspection while authored setup completes; an absent frame function fails explicitly.

Temporal inspection retains every captured PNG before renderer staging is removed. Partial clock application, unsupported timelines, runtime errors, source changes, changing served documents and incomplete reduced-state coverage cannot satisfy the native motion verification stage. A six-frame clock pass uses four captures when reduction needs a frame pair, rather than launching a browser for every sample and loop endpoint. This is reduced capture overhead, not a measured universal speed or token saving. Review actual encoded playback and audio synchronization separately.

## Failure and scope changes

Use current pipeline status and the tool's coverage or failure stage to choose the next check. Failed capture, unavailable WebGL, missing roles and incomplete matrices stay unresolved. Preserve successful cells and artifacts, do not repeat paid generation or fulfilled side effects, and do not label code as tested in an app merely because it parses.

Structural changes to shared UI owners use the existing source intelligence, symbol/impact inspection, audits and bounded edit planning. Relevant tools remain discoverable when task phases change. Explicit user exclusions, delegation limits and model choices continue to apply across follow-ups and goals. Skills remain optional reference guides.

# Autonomous UI engineering

The adaptive pipeline owner selects tools from the authored task and observed relevant source, manifests and dependencies. Main prompts, goals, continuing work and short steering follow-ups use the same policy. Tools become available within the host's existing ceiling; selection does not execute them, install dependencies, change the selected model or grant access. Live guidance points at unresolved stages and current receipts. A new source revision retires stale checks.

UI work starts from its real audience, content, existing component owners and design direction. References inform decisions about composition, hierarchy, subject imagery and motion; they do not supply a template or a brand to clone. A strong reference can use vivid color, rounded controls or immersive animation. Those choices need a job in this project. Neither a purple glass hero nor a beige editorial skin is the default, and invented proof, fake testimonials and decorative AI status are excluded.

## Tools and evidence

| Tool | Behavior |
| --- | --- |
| `ui_recipe` | `plan` describes mechanisms, inputs and checks without writes. `scaffold` writes an editable module and receipt in a fresh `.pi/design` folder; it never replaces target sources. Patterns are `scroll-reveal`, `scroll-story` and `three-model`. |
| `motion_inspect` | `mode:"scroll"` captures forward and backward normalized scroll positions in one persistent page. It reports actual positions, target observations, reduced-motion samples, failures and saved frames. Time-mode CSS/WAAPI inspection remains available. |
| `ui_explore` | Defaults to 320px/mobile/tablet/desktop coverage and adds touch, DPR, phone orientation and CSS breakpoint neighbors to the viewport/theme/reduced-motion matrix. The bounded plan reports omitted cells so a partial matrix cannot masquerade as device coverage. |
| `ui_consistency` | Compares named shared roles and selected CSS custom properties across 2–4 routes. Declared variants compare within their own group. Missing roles, failed captures and source changes remain explicit. Style drift is measured evidence for review, not a taste score. |
| `blender_export` | GLB/glTF exports automatically run current-file preflight and carry bundle/resource hashes, mesh counts, mobile budget warnings and decoder requirements. An export survives failed preflight. |
| `image_generate` | The existing image planner preserves exact selected models and validates image roles, references, capabilities and bounded cost. Review the asset alone and integrated into the page; a decoded image is not artistic approval. |

`creative_direct` remains the shared direction owner. `render_see`, `design_audit`, `visual_review` and the interactive browser supply distinct kinds of evidence. A capture is not a completed user interaction, and a measured effect count is not a reason to redesign a valid interface. Use the normal served application, real content and project rules.

UI verification uses current native run IDs and source revisions. Responsive measurements and inspected matrix pixels, every visual-review rubric section, and the representative keyboard/input task remain separate requirements. Prepared recipes or generic technical receipts cannot replace them. The default-on verifier provides bounded follow-ups for missing evidence; `PI_UI_VERIFICATION=off` is an explicit user opt-out.

## Scroll mechanics

For a restrained entrance, scaffold `scroll-reveal` with the actual target selector and shared timing values. The observer reveals each element once, makes focused content immediately visible and retains static content when reduced motion is requested or animation support is absent. No stylesheet hides the page before JavaScript starts.

`scroll-story` accepts explicit section-relative tracks:

```json
{
  "action": "scaffold",
  "pattern": "scroll-story",
  "section": "#process",
  "stickySelector": ".process-stage",
  "mobileBelow": 768,
  "tracks": [{
    "selector": ".process-object",
    "start": 0.1,
    "end": 0.8,
    "keyframes": [{"transform": "translateX(-40px)"}, {"transform": "translateX(40px)"}]
  }]
}
```

Adapt the selectors and values to existing content. One owner drives each target; transforms and opacity avoid layout-property animation. Updates coalesce into one animation frame, and invisible/hidden pages skip drawing. The optional sticky CSS applies only at wider widths with normal motion; the mobile and reduced-motion path retains normal flow. Keep essential copy and controls outside fading layers. Mount once, refresh after target changes and dispose before route replacement.

Inspect the real scroll sequence after integration, including reverse scrolling, focus, resize and reduced motion. Static frames demonstrate sampled output; they do not establish continuous smoothness, FPS or physical GPU cost.

## Blender to Three.js

Create or edit the asset through the existing guarded Blender tools, inspect the scene, then export GLB/glTF. Reuse a successful export if its preflight fails; repair the reported resources rather than rendering it again. A `ui_recipe` `three-model` scaffold requires `assetPath` for current local preflight and `modelUrl` for the actual served asset. It does not guess asset routing or choose a CDN version.

The host supplies matching `THREE` and `GLTFLoader` imports from its existing installed version or import map:

```js
const handle = mount(container, { THREE, GLTFLoader });
await handle.ready;
// Before route replacement, including while the asset is loading:
handle.dispose();
```

The generated renderer fits the model, bounds DPR, redraws on demand, honors reduced motion and disposes owned textures, materials, geometry and skeletons. The host retains real static imagery and accessible text when model loading or WebGL fails. Compressed assets require explicit matching decoder setup; plain-model scaffolding rejects unconfigured decoder requirements. Preflight does not establish rendered appearance, animation playback or device performance.

Runtime contracts follow the installed Three.js APIs and the [GLTFLoader documentation](https://threejs.org/docs/pages/GLTFLoader.html). Entrances use the [Intersection Observer API](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API); section choreography uses observable page scroll and WAAPI without assuming [ScrollTimeline support](https://developer.mozilla.org/en-US/docs/Web/API/ScrollTimeline).

## Failure and scope changes

Use current pipeline status and the tool's coverage or failure stage to choose the next check. Failed capture, unavailable WebGL, missing roles and incomplete matrices stay unresolved. Preserve successful cells and artifacts, do not repeat paid generation or fulfilled side effects, and do not label a recipe as tested in an app merely because its code parses.

Structural changes to shared UI owners use the existing source intelligence, symbol/impact inspection, audits and bounded edit planning. Relevant tools remain discoverable when task phases change. Explicit user exclusions, delegation limits and model choices continue to apply across follow-ups and goals. Skills remain optional reference guides.

# Async execution and creative tools in 0.2.0

YunusPi keeps its existing agent, session, model-routing, skill, hook and tool-discovery interfaces. This release strengthens their execution boundaries and adds seven native tool names, plus `service_detail` and `journal` actions on the existing `sys_probe`. The new tools are discovered with `tool_search`, so their schemas do not expand every initial prompt.

## Async execution

The design review examined [Unreal Agent at b7c9bf1](https://github.com/unreallabsai/unreal-agent/tree/b7c9bf1c5c2fa4127255c07727a7c8413e23944a). Its explicit input identities, asynchronous operation boundaries and bounded model-facing process output informed independent changes to YunusPi's existing owners. No Unreal Agent source or Go runtime is bundled. Its default context builder was not evidence of automatic context compression, so no such claim or replacement was adopted.

- **Persisted delivery receipts.** Custom messages can acknowledge acceptance after the session entry is written, separately from completion of the model turn. Disk-backed sessions flush acknowledged receipts to storage; explicitly in-memory SDK sessions acknowledge only their volatile history. Background wait subscriptions retain unaccepted deliveries and recover accepted tokens from the current session branch. A failed model response after acceptance does not justify sending the event again. Retry attempts are bounded and session-generation fences reject stale completions.
- **Coalesced activity.** A burst of wait events schedules one reconciliation per microtask. Existing timers remain a recovery fallback. Completion wakes drain arrivals that overlap an earlier delivery; a rejected delivery does not create an immediate retry loop.
- **Mixed tool batches.** Consecutive parallel tools run together; sequential tools remain exclusive barriers between groups. Results retain original model order, hooks retain their existing validation and result stages, and globally sequential operation still works.
- **Background admission identity.** Concurrent delivery of the same session/tool-call ID and arguments shares one launch. Conflicting reuse fails explicitly. An abort during admission cannot create a new shell process. Up to 4,096 admission identities are retained without eviction; at capacity, new identities fail explicitly while retained identities remain usable. This deduplication is process-local; it does not claim crash-safe exactly-once shell execution.
- **Bounded shell context.** `bash` accepts optional `maxOutputBytes` (256–51200) and `outputMode: "head-tail"`. The default remains the existing tail view. For verbose checks, request 8192 bytes to retain opening context and final errors. When output is truncated, the full stream is saved in a fresh mode-0600 artifact. Owned process pipes respect disk backpressure. Capture failures are explicit; a partial or collided file is never advertised as complete.

```js
bash({ command: "npm test", maxOutputBytes: 8192, outputMode: "head-tail" })
```

Finite background completions use a fixed 200 ms grace window after the first accepted durable receipt. Further completions join that batch without extending its deadline. Busy sessions resume through their existing settled/compaction events; cancellation, new user input and shutdown fence old continuations. This independently implements the useful fixed-deadline batching idea in [Unreal Agent's coordinator](https://github.com/unreallabsai/unreal-agent/blob/b7c9bf1c5c2fa4127255c07727a7c8413e23944a/harness/coordinator/grace_test.go). It adds no polling or new orchestration layer. A regression with eight separate-tick completions records one model wake; this fixture does not imply a universal reduction in model bills.

## 3D, sound and motion

| Tool | Produces |
| --- | --- |
| `scene_create` | Editable, validated scene JSON and a self-contained Three.js HTML preview with its MIT license. Start from `orbital`, `kinetic` or `sculpture`, or supply a scene. |
| `scene_render` | An actual WebGL PNG still or H.264 MP4, plus a poster and render metrics. Video includes up to three sample frames and probe/decode evidence; optional local audio becomes AAC. |
| `video_compose` | A normalized local video timeline with cut, fade, wipe-left or fade-to-black transitions, clip sound and optional music/voice/effects tracks. |
| `audio_mix` | Stereo 48 kHz WAV from local tracks with trims, offsets, gain, balance, fades, filters, echo and a latency-compensated sample-peak limiter. |

Scene styles are `studio`, `clay`, `toon` and `wireframe`. Objects include primitives, a torus knot, and hierarchical groups, with editable materials, lights and camera. Absolute-time keyframes animate position, rotation in radians, scale and camera properties; easing is linear, smooth or hold. Each render starts from the same clock state, making repeat frames stable on the same renderer. Cross-platform bit-identical GPU output is not promised.

```js
tool_search({ names: ["scene_create", "scene_render", "music_compose", "audio_mix", "video_compose"] })
scene_create({ preset: "sculpture", style: "clay" })
// Edit the returned scene JSON to fit the shot. Use the actual returned path.
scene_render({ path: "./media-<returned-id>/scene.json", mode: "frame", time: 1 })
// After inspecting the preview, render video and optionally supply a local audio path.
scene_render({ path: "./media-<returned-id>/scene.json", mode: "video" })
```

Use existing `music_compose` for score synthesis, `audio_analyze` for signal/loudness evidence and `video_frames` for further frame inspection. Existing animation, Three.js, Blender, audio and composition skills support art direction and more elaborate authored work. A preset is a starting point, not a completed visual brief. Inspect camera framing, materials, representative frames, motion continuity and audible playback before delivering a video.

Scene limits are 64 objects, 512 keys, 30 seconds, 900 frames and 900 million pixel-frames, with a 180-second render deadline. Defaults are 1280×720, six seconds and 24 fps. Timelines accept up to eight clips and eight audio tracks, 120 seconds and 1.5 billion pixel-frames. Fractional clip boundaries are rounded cumulatively to actual output frames, with requested and rendered timings reported. Original inputs are preserved; outputs use fresh workspace directories and cancellation cleans incomplete artifacts.

The renderer uses pinned Three.js 0.180.0 and the existing sandboxed Playwright browser. `ffmpeg`/`ffprobe` must be installed. Scene input is data-only: arbitrary scripts, external textures, URLs, glTF imports and hosted generation are outside this tool's contract. Browser requests are confined to generated content. These tools support procedural 3D and audiovisual finishing, not a replacement for every Blender feature.

## Design and delivery evidence

`design_audit` shares the existing `render_see` browser path. It returns bounded evidence about rendered typography, spacing, surfaces, overflow and motion. `output:"text"` returns measurements without a screenshot; `output:"both"` also saves a screenshot and delivers its pixels only to a vision-capable model. Use local HTML or SVG, or an HTTP(S) page serving HTML, XHTML or SVG. Raster images and PDFs require `render_see` and cannot establish page-style measurements. Solid-color text contrast is measured only where foreground and effective background can be resolved conservatively. Gradients, overlays, masks, alternate text paints and other ambiguous cases are explicitly indeterminate. Use design skills and the actual pixels for visual judgment; this is neither an aesthetic score nor an accessibility certification. It scans the main document, not every iframe or shadow tree.

Each existing HTML capture also checks for literal placeholder copy and exact adjacent duplicate headings, labels for the same input, or links to the same complete destination. These are locations worth inspecting, not an instruction to remove intentional repetition. The scan returns at most six candidates from 600 elements or 40 ms, excludes hidden/transparent content, input values and code/quotation examples, and performs no extra render or model call. Clean automatic checks add no response payload; explicit `design_audit` includes the bounded coverage receipt. Nested labels and ambiguous action semantics are left for human or visual review.

`syntax_check` also returns advisory AST evidence for comments that exactly restate a following return and undocumented empty catches. Successful native `write`/`edit` tools run the same local WASM parser automatically on at most four source files per turn, up to 64 KiB per file, 20,000 AST nodes, 20 ms of traversal and three findings. Edit advice is restricted to an unambiguous replacement span. Explained catches, JSDoc, reasons and quoted source are exempt. Source revisions are deduplicated within the current session; activity notes report actual parser completions. Findings never fail a syntax check, launch another model or impose a repair loop. These narrow checks do not infer authorship or certify overall code/design quality.

```js
tool_search({ names: ["design_audit", "workflow_probe", "web_asset_check", "sys_probe"] })
design_audit({ source: "./index.html", width: 1280, height: 800, output: "both" })
design_audit({ source: "./index.html", width: 390, height: 844, reducedMotion: "reduce", output: "both" })
workflow_probe({ path: ".github/workflows/checks.yml" })
web_asset_check({ files: ["dist/index.html", "dist/app.css"], asset_root: "dist", public_path: "/" })
sys_probe({ action: "service_detail", unit: "example.service", user: true })
sys_probe({ action: "journal", unit: "example.service", user: true, limit: 20 })
```

`workflow_probe` inspects explicit Actions YAML, job dependencies, cycles, literal matrix cardinality and local action/workflow references. Runtime expressions and `$/` repository-bound references remain unresolved; remote actions are not fetched. Local actions require `action.yml` or `action.yaml`, and reusable workflows must be directly inside `.github/workflows`. It does not run CI or prove that a workflow succeeds. `web_asset_check` checks local references in explicit HTML, CSS and web manifests, including case mismatches and hosting prefixes; it does not crawl, execute scripts or emulate a bundler. Both use the existing read-only utility worker and source evidence hashes.

`sys_probe` service and journal actions use fixed read-only systemd commands. Journal responses contain bounded metadata, not arbitrary log message bodies. The first page defaults to the last hour; pass its `next_cursor` as `cursor` to resume after the last returned entry. `lookbackSeconds` selects an explicit window of up to one day. They neither restart services nor invoke sudo. Existing Git, package, environment, source and browser tools remain available for maintenance, deployment and Ubuntu application work.

## Verification and limits

Regressions exercise real owned SDK dispatch, native tool discovery, persisted-session failure injection, cancellation, exclusive tool barriers, duplicate background launches, UTF-8 truncation, slow output capture, real Chromium pixels and real FFmpeg audio/video decoding. Independent reviews caught and repaired fractional timeline rounding that dropped the last clip, startup cancellation races, capture-file collision cleanup, uncertain contrast measurement, initialized zero counters misreported as known zero usage, and explicit tool error flags discarded before session hooks and transcript recording.

An aborted launched helper with no usage evidence now stays unknown. Explicit pre-launch no-child evidence, actual provider-reported zero and complete known-free pricing remain distinct. The logical ledger, `/used` and footer agree.

See the [Guardian implementation audit](GUARDIAN-IMPLEMENTATION-AUDIT.md) and [session recovery audit](SESSION-RECOVERY-AUDIT.md) for earlier repairs, measured Guardian overhead and remaining architectural limits. Passing deterministic tests does not establish availability or semantic quality of every external provider. Final published CI checks the release source; installation checks additionally verify the active core and preserved private state.

## Measured release overhead

A local Node 22.22.3/Linux run of `node --expose-gc scripts/guardian/benchmark.mjs` measured a classifier median/p95 of 2.38/3.70 microseconds, 96,000 events across 64 sessions in 446.31 ms wall time (552.32 ms process CPU), and 0.70 ms process CPU during a 250.64 ms idle sample. Four processes produced exactly 32 expected isolated interventions across 48,000 events. These are bounded offline fixtures, not whole-agent latency or a long-run energy study.

After first flush, 500 ordinary append operations through the new write lock took 51.47 ms total, with a median of 0.093 ms and p95 of 0.132 ms on the local filesystem. Ordinary appends and explicitly fsynced delivery acknowledgments have different durability/cost; this measurement covers ordinary appends only. Locks serialize short transactions, never evict live owners by age and recover positively identified dead process owners. Unknown or ownerless lock state fails closed and needs inspection.

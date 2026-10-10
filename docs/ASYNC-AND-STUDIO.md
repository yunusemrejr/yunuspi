# Async execution, operations and creative tools

YunusPi keeps its existing agent, session, model-routing, skill, hook and tool-discovery interfaces. Versions 0.2–0.4 strengthen their execution boundaries and add creative, operations and evidence tools, plus `service_detail` and `journal` actions on the existing `sys_probe`. The new tools are discovered with `tool_search`, so their schemas do not expand every initial prompt.

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

### Disposable work and command selection

Use `sandbox_run` for small reproductions, uncertain scripts and destructive fixtures. Supply only explicit source copies and fixtures. Default foreground operation remains available in tool-limited children; the parent can already run those children asynchronously. Where the existing background service is loaded, `sandbox_run({background:true,name:"Parser repro",command:"node fixture.mjs",files:[{path:"fixture.mjs",source:"tests/fixture.mjs"}]})` returns its normal background task ID. Continue independent work or yield; completion arrives through the existing notification path. Inspect `bg_logs` for the sandbox result and use `bg_kill` to cancel.

Background sandbox input is limited to 48 KiB; explicit source files are copied at actual helper launch, and inline fixtures are the request's bytes. The same namespace, network, memory, process, timeout and cleanup restrictions apply. One session/tool-call identity admits one experiment; conflicting reuse is rejected. Failure, timeout and refusal produce failing background exits, not successful transport receipts. Missing background service fails explicitly and leaves foreground use available; missing OS isolation never falls back to host execution.

For independent long-running project commands, use existing `bg_run`; keep dependent steps in their required order. Use bounded `bash` output for short commands whose result is needed immediately. Do not detach unknown commands automatically, poll for completion or start duplicate checks solely because a result is slow. This preserves existing shell authorization and result ordering while allowing useful work to overlap.

## Sound and motion

For complete narrated videos built from code (storyboard, master timeline, Remotion scenes, local narration, procedural audio and a visual QA loop), see [code-first video studio](VIDEO-STUDIO.md). The `audio_mix` tool below remains the quick path for local audio mixes.

| Tool | Produces |
| --- | --- |
| `audio_mix` | Stereo 48 kHz WAV from local tracks with trims, offsets, gain, balance, fades, filters, echo and a latency-compensated sample-peak limiter. |

Use existing `music_compose` for score synthesis, `audio_analyze` for signal/loudness evidence and `video_frames` for further frame inspection. Existing motion, 3D, audio and video skills support art direction and more elaborate authored work. Inspect camera framing, materials, representative frames, motion continuity and audible playback before delivering a video.

## Design and delivery evidence

Each existing HTML capture also checks for literal placeholders, exact adjacent equivalent labels/links, short status capsules with an actually repeating animated dot, dense copy around controls, four or more repeatedly used primary CSS font families, and three or more panels with a heavy left edge. Measurements identify locations and give a reason to inspect; they do not establish that a design choice is wrong. Meaningful live/status regions and state controls are exempt from decorative-motion findings. Density and font counts use wholly visible text elements in the current viewport; font declarations do not prove which font rendered. Article, code, quotation, hidden/transparent and marked user-content regions are excluded. Use `data-user-content` for user-authored content or `data-yunuspi-noise="ignore"` for an intentionally exempt subtree. Inputs count as controls without returning their values.

Narrow quantified marketing patterns, such as performance multipliers, uptime percentages and customer counts, produce `factual-claim-evidence` candidates. These are a request to inspect and scope the claim against its source, not a finding that the statement is false or unsupported. Inspect context, dates and units, and qualify or remove unsupported assertions. Ordinary UI numbers, tables, figures and article/user content are exempt.

Automatic capture receipts return at most six findings. They share a 600-element, 40 ms scan budget and inspect at most 100 animations. Clean automatic checks add no response payload. They perform no extra render or model call, do not start repair loops, and never rewrite the page. Compare the actual mobile/desktop and reduced-motion states; nested copy, ambiguous semantics, frames, shadow roots and canvas still need separate review.

The WASM syntax check also returns advisory AST evidence for comments that exactly restate a following return and undocumented empty catches. Successful native `write`/`edit` tools run the same local WASM parser automatically on at most four source files per turn, up to 64 KiB per file, 20,000 AST nodes, 20 ms of traversal and three findings. Edit advice is restricted to an unambiguous replacement span. Explained catches, JSDoc, reasons and quoted source are exempt. Source revisions are deduplicated within the current session; activity notes report actual parser completions. Findings never fail a syntax check, launch another model or impose a repair loop. These narrow checks do not infer authorship or certify overall code/design quality.

```js
tool_search({ names: ["web_asset_check", "sys_probe"] })
web_asset_check({ files: ["dist/index.html", "dist/app.css"], asset_root: "dist", public_path: "/" })
sys_probe({ action: "service_detail", unit: "example.service", user: true })
sys_probe({ action: "journal", unit: "example.service", user: true, limit: 20 })
```

`web_asset_check` checks local references in explicit HTML, CSS and web manifests, including case mismatches and hosting prefixes; it does not crawl, execute scripts or emulate a bundler. It uses the existing read-only utility worker and source evidence hashes.

`sys_probe` service and journal actions use fixed read-only systemd commands. Journal responses contain bounded metadata, not arbitrary log message bodies. The first page defaults to the last hour; pass its `next_cursor` as `cursor` to resume after the last returned entry. `lookbackSeconds` selects an explicit window of up to one day. They neither restart services nor invoke sudo. Existing Git, package, environment, source and browser tools remain available for maintenance, deployment and Ubuntu application work.

## Verification and limits

Regressions exercise real owned SDK dispatch, native tool discovery, persisted-session failure injection, cancellation, exclusive tool barriers, duplicate background launches, UTF-8 truncation, slow output capture, real Chromium pixels and real FFmpeg audio/video decoding. Independent reviews caught and repaired startup cancellation races, capture-file collision cleanup, initialized zero counters misreported as known zero usage, and explicit tool error flags discarded before session hooks and transcript recording.

An aborted launched helper with no usage evidence now stays unknown. Explicit pre-launch no-child evidence, actual provider-reported zero and complete known-free pricing remain distinct. The logical ledger, `/used` and footer agree.

Passing deterministic tests does not establish availability or semantic quality of every external provider. Final published CI checks the release source; installation checks additionally verify the active core and preserved private state.

## Measured release overhead

A local Node 22.22.3/Linux run of `node --expose-gc scripts/guardian/benchmark.mjs` measured a classifier median/p95 of 2.38/3.70 microseconds, 96,000 events across 64 sessions in 446.31 ms wall time (552.32 ms process CPU), and 0.70 ms process CPU during a 250.64 ms idle sample. Four processes produced exactly 32 expected isolated interventions across 48,000 events. These are bounded offline fixtures, not whole-agent latency or a long-run energy study.

After first flush, 500 ordinary append operations through the new write lock took 51.47 ms total, with a median of 0.093 ms and p95 of 0.132 ms on the local filesystem. Ordinary appends and explicitly fsynced delivery acknowledgments have different durability/cost; this measurement covers ordinary appends only. Locks serialize short transactions, never evict live owners by age and recover positively identified dead process owners. Unknown or ownerless lock state fails closed and needs inspection.

## Bounded operations and factual evidence

`workspace_search` searches an explicit project root by literal path or content, including directories, with bounded scans and paginated source hashes. Narrow the root when a scan is partial; no matches never establishes absence outside the reported scope. Continuation requires the returned snapshot so changed sources cannot silently mix pages.

Mail is handled by the `agentmail` tool, which remains the owner for authorized account operations.

`ssh_plan` prepares inert SSH argv with explicit host/user/port and strict host-key checking. It does not read credentials or run connection configuration. Use `net_probe` with `action: "ssh"` to inspect one explicitly authorized server's identification banner; a banner proves neither identity nor authentication. Execute approved remote operations through the existing shell policy.

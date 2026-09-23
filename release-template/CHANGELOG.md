# Changelog

## 0.5.2 — 2026-09-23

The session observer reviews chronological chunks during active work, with a 30-second minimum review gap and visible checks within 120 seconds. It remains a conversational reviewer with no tools or execution authority. Advice is consumed once, repeated suggestions are suppressed, and stale or incomplete evidence is identified. Its packet includes current work, actual tool availability, source-backed council/swarm/fusion capabilities, configured model preferences and measured usage. Long foreground commands prompt conditional background-work advice, not automatic interruption.

Initial and follow-up prompt analysis shows task interpretation, route/fallback outcomes and an expandable copy of the exact advisory delivered to the main agent. The original prompt remains unchanged. Reusable mindset preambles no longer become the fallback task. Large inputs are excerpted visibly and user-constraint scanning remains incremental.

Independent sessions can discover and explicitly address peers across projects through `session_coordinate`. Messages are visible to both main agents and their observers, with owner-scoped Guardian receipts. Session epochs reject stale deliveries; peer text remains untrusted advice and does not merge tasks, permissions or private state.

Guardian supervision registers long requests instead of silently disabling the task. Oversized raw-span constraint checks abstain explicitly while tool monitoring and conservative retry detection continue. JEV and Needle admission/fallback outcomes are visible; routine Smol eligibility and lexical-match notices are deduplicated without dropping recorded metrics. Fuzzy counts describe actual lexical matches, and a Smol `UNKNOWN` response is an abstention that preserves the original output.

Read-only council helpers no longer require code edits to count as completed. Native and wrapper child records share their task identity, failed council peers retain useful labels, and owned cleanup after a final response no longer creates a false process failure. Real provider errors and unavailable inference remain visible failures or fallbacks.

Symbol search now reloads an initially missing word index after its background build completes. Long quality-review retry explanations are reduced to a disclosed head/tail excerpt instead of being rejected by a 600-character schema limit; the original tool call retains the full rationale.

## 0.5.1 — 2026-09-23

Model routing now distinguishes local catalog/startup errors from provider failures. Historical exclusions created by the CLI's own missing-model diagnostics are reconciled automatically; real provider failures retain their exclusions. Concurrent sessions update the latest exclusion state instead of overwriting it with stale snapshots.

Preference matching accepts provider separator aliases, colon/dot prefixes before vendor namespaces, and model word/number formatting differences. Exact namespace matches take priority, ambiguous aliases remain unresolved, and explicit model revisions, provider boundaries, thinking settings and backend pins remain intact. Dispatch uses the exact catalog ID.

Isolated helpers preserve models explicitly configured in `models.json` when their cached catalog lacks the selected route. Native child startup regressions verify both reported Friendli and OrcaRouter model identities without network requests or inference tokens.

Idle callbacks retain exclusive lane ownership across nested calls, including cancellation and failures. Workflow child abort listeners are disposed after completion, duplicate signals share one listener, and health-log shutdown invalidates pending asynchronous startup.

Image usage accounting preserves independent cache reads and writes, bounds malformed counters, uses shared tiered pricing and honors charges reported by the official OpenRouter endpoint. Missing pricing remains explicitly incomplete.

Prompt analysis now keeps a literal instruction when the same wording first appears inside a quoted example. Subagent thinking choices follow the owned core's supported levels, so unmapped `xhigh` and nonreasoning routes cannot be presented as supported. Unused model-editor helpers were removed.

## 0.5.0 — 2026-09-23

A periodic session observer offers short tool, skill and process advice during active main-agent work. It runs asynchronously about every 4½ minutes, defaults to official DeepSeek Flash with high thinking, and is configured through the existing `/models` role editor or JSON. Idle and unchanged sessions do not trigger inference; requests have bounded context, a deadline and no retry cascade.

Observer notes appear in the TUI. Only the current advisory enters the next normal model request, without waking an idle agent or interrupting tools. Session changes invalidate pending advice, and actual auxiliary usage is accounted separately from spawned agents. See [the observer's behavior and limits](docs/SESSION-OBSERVER.md).

## 0.4.1 — 2026-09-23

Isolated skill helpers restore only their selected provider's cached model metadata, preserving tool isolation and provider routing constraints. Reasoning models retain a bounded allowance for both reasoning and an answer; a consumed, textless attempt no longer triggers additional provider attempts. Direct prompt-analysis requests enforce proven free-route price caps at dispatch. Foreground and background child receipts preserve output-limit causes. Guardian notes distinguish a standby failure detector from unavailable WASM, and output limits are displayed as limits rather than broken models.

Automatic project intelligence now follows the current file even when the graph revision is unchanged. Entity inspection includes versioned declaration provenance from the same graph used by `/graph`, within the existing output budget.

The [async integration review](docs/UNREAL-INTEGRATION-REVIEW.md) maps Unreal Agent-inspired behavior to executed YunusPi paths and tests, including completion batching, parallel tool barriers, cache stability and OS-isolated experiments. It documents foreground steering limits and makes no unmeasured billing-savings claim.

## 0.4.0 — 2026-09-23

Agents gain bounded workspace and local-mail search, hash-checked message reading, inert SSH connection planning and explicit SSH banner inspection. `claim_check` verifies exact quotations and current file provenance; interpretations remain subject to review. Tools stay behind existing discovery, utility workers and authority boundaries.

Rendered UI checks add animated status capsules, copy density, primary font proliferation, repeated heavy borders and narrow quantified marketing evidence candidates. Checks use existing captures, expose scope and exclusions, and introduce no model calls or repair loops.

Concurrent identical Needle3 operations share existing queued inference with separate consumer results and honest TUI telemetry. Voluntary coordination receipts observe normal authorized shell execution against explicit input hashes; stale or unverifiable evidence cannot be advertised as a current check. Signal-terminated native shell commands now fail explicitly.

Disposable experiments can opt into the existing background-task registry, retaining OS isolation, bounded output, terminal notifications and cleanup. Foreground use remains compatible. Details and limits: [operations audit](docs/OPERATIONS-EVIDENCE-AUDIT.md), [async, operations and studio](docs/ASYNC-AND-STUDIO.md).

## 0.3.0 — 2026-09-23

Slow independent reviews now show aspect progress and elapsed/deadline information in the existing tool display. Repair rounds receive prior blockers and changed-source context. Exhausted review rounds ask for an honest assessment of remaining gaps; stopping a session no longer requires manufacturing a review or child run.

Actual intelligence activity appears immediately as display-only session notes, including during long-running tools. Notes distinguish remote JEV, local Needle3/WASM, cached selections, returned excerpts and evidence added to model context. They remain outside provider input and compaction; concurrent child notes preserve session ownership. Closely timed background completions share one fixed 200 ms grace window before waking the model.

`obs_read` gains optional local query ranking with exact source ranges, hashes, bounded prefix coverage and unchanged full-original pagination. It reuses existing lexical retrieval and Needle3, without sending raw observations to a remote judge or rewriting cached history. Actual parser/render hooks now report narrow, advisory code and UI noise findings using existing WASM parsing and browser captures, with no added model calls or mandatory repair loops.

Details and verification limits: [session recovery audit](docs/SESSION-RECOVERY-AUDIT.md), [micro-intelligence](docs/MICRO-INTELLIGENCE.md), [async and studio](docs/ASYNC-AND-STUDIO.md).

## 0.2.0 — 2026-09-23

YunusPi gains persisted asynchronous delivery receipts, coalesced background wait events, mixed parallel/exclusive tool batches, duplicate-safe background admission and backpressured shell capture with optional head/tail context. These changes extend the existing runtime and preserve normal session, model, provider, skill and hook usage.

Seven native tools add editable 3D scene creation, sandboxed WebGL animation rendering with sound, video transitions, audio mixing, rendered design evidence, GitHub Actions inspection and hosting asset checks. Ubuntu service/journal inspection extends `sys_probe`. Three.js is pinned to 0.180.0 with preserved MIT attribution.

The release also includes the independent Guardian/routing/intent audit and subsequent session repairs: native helper startup, slash completion, accounting evidence, bounded verification follow-ups, browser alias/diagnostic behavior, local render routes and genuine intelligence visibility. Additional review fixed uncertain contrast claims, fractional video frame loss, shell startup cancellation and capture-file collision ownership, and structured tool errors incorrectly recorded as successful executions.

Product metadata, six owned core packages and the workspace lock now use the same release version. CI requires real isolation, browser and audiovisual checks and creates release notes only after a version tag passes checks. Pi 0.85.1 remains the immutable historical origin.

Deployment checks also synchronize standalone extension dependency locks, preserve the changelog through installation and public export, retain the installed browser location inside isolated sessions, and keep Linux CLI command arguments available for active-installation protection.

Details and limits: [async and studio](docs/ASYNC-AND-STUDIO.md), [Guardian audit](docs/GUARDIAN-IMPLEMENTATION-AUDIT.md), [session recovery audit](docs/SESSION-RECOVERY-AUDIT.md).

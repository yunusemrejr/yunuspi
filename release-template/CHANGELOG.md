# Changelog

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

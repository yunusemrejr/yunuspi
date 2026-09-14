---
name: harness-self-maintenance
description: Maintain the running Pi harness itself—extensions, patches, tools, routing, skills and release machinery—using launch-scoped authority, current ownership discovery and focused regression checks.
---

# Harness self-maintenance

Use this workflow when changing the harness that runs the session. A similarly named application or a separate public checkout is not automatically the active harness. Discover its actual root and installed runtime before editing.

Maintenance authority comes from the human's original launch directory: inside the actual harness root (the root itself or a descendant). Launching from home, `/`, any other ancestor, or a similarly named sibling does not grant authority. Changing directory, resuming an old conversation, spawning a child or setting an environment variable does not grant permission. Respect the enforced boundary; if denied, explain that the human must start an appropriately located maintenance session. Never disable protection to finish a task. Global skill stores and configured shared skill paths are also protected; launching inside a shared skill directory does not grant harness maintenance authority. Ordinary project-local skill files retain project scope.

Read the current maintenance map and extension manifest when present; use bounded searches to find the entrypoint, shared policy owner, consumers and tests. Inventory changes over time: follow imports and registration rather than assuming a fixed list of extensions. Distinguish authored source, installed dependencies, generated assets and runtime state. Patch the durable source and use its existing deployment path; editing an installed dependency alone can disappear on update.

Before changing behavior, identify the invariant and reproduce the relevant failure. Preserve manual reminders, credentials, active sessions and unrelated edits. Prefer reversible focused changes; avoid restarting the session that owns unfinished work. Read [verification and public releases](references/verification-release.md) when touching patches, process execution, permissions, exports or publishing.

Verify the changed path and its most consequential failure case. Report source changes separately from installed or live behavior, including any restart still needed. Never describe an untested integration as working or promise that no failure is possible.

## Repositories

If the discovered harness has a Git remote — check, do not assume — keep it updated as you change the harness: after the change verifies, commit and push the durable source you edited, keeping runtime state, credentials, caches and private fixtures out of the commit. If harness rules forbid Git in the live tree, use its supported export path instead.

A public repository demands more care: publish only through the sanitized exporter into a fresh staging directory, inspect the diff, run the repository's public scanner and tests, and stage reviewed public paths. Never push the live tree wholesale; commit messages and history are public too, and deleting sensitive content later does not make it safe. Rotate and remediate anything that reaches a remote. See [verification and public releases](references/verification-release.md); this installation: `PUBLIC-RELEASE.md` and `public-template/docs/PUBLISHING.md`.

## Self-editing reliability

Workdir gating: harness authority comes only from a human-started session whose launch directory is the harness root itself or a descendant (here: `~/.pi`). The guard denies writes to harness-protected paths from outside sessions; it must never block ordinary project work — a normal session editing its own project files outside the harness root proceeds unaffected. When touching the guard, verify both sides: a harness write from an outside launch stays denied, and a project-local edit from a project launch stays allowed. Never weaken the guard to finish a task.

Know the harness before editing: read the maintenance map (`HARNESS-MAINTENANCE.md`, newest entries first), the extension manifest (`extensions/manifest.json`, the single source of truth for the verifier), and `PUBLIC-RELEASE.md` plus `public-template/docs/PUBLISHING.md` before any export. Follow imports and registration to find the entrypoint, shared policy owner, consumers and tests; never assume a fixed component list.

Document every change: append a dated entry to the maintenance map describing what changed, why, and what verified it; note any restart still needed. Report source changes separately from installed or live behavior.

Verify and publish in order: `scripts/verify-harness.mjs`, then the relevant focused suites, then `scripts/publish-public.mjs --verify-only`. Structural verification alone is not behavioral proof — say which coverage ran. Export only through the sanitized exporter into a fresh directory, inspect the diff, run the public scanner and tests, and commit/push only reviewed non-sensitive paths from the public checkout (`~/yunuspi`); the live tree stays non-Git and is never pushed. Known bottleneck: the public scanner walks full Git history, so diagnose tree/index findings first and treat history-scan slowness as expected, not as a hang.

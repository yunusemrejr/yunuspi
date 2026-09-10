---
name: harness-self-maintenance
description: Maintain the running Pi harness itself—extensions, patches, tools, routing, skills and release machinery—using launch-scoped authority, current ownership discovery and focused regression checks.
---

# Harness self-maintenance

Use this workflow when changing the harness that runs the session. A similarly named application or a separate public checkout is not automatically the active harness. Discover its actual root and installed runtime before editing.

Maintenance authority comes from the human's original launch directory: the harness root or an ancestor. Changing directory, resuming an old conversation, spawning a child or setting an environment variable does not grant permission. Respect the enforced boundary; if denied, explain that the human must start an appropriately located maintenance session. Never disable protection to finish a task.

Read the current maintenance map and extension manifest when present; use bounded searches to find the entrypoint, shared policy owner, consumers and tests. Inventory changes over time: follow imports and registration rather than assuming a fixed list of extensions. Distinguish authored source, installed dependencies, generated assets and runtime state. Patch the durable source and use its existing deployment path; editing an installed dependency alone can disappear on update.

Before changing behavior, identify the invariant and reproduce the relevant failure. Preserve manual reminders, credentials, active sessions and unrelated edits. Prefer reversible focused changes; avoid restarting the session that owns unfinished work. Read [verification and public releases](references/verification-release.md) when touching patches, process execution, permissions, exports or publishing.

Verify the changed path and its most consequential failure case. Report source changes separately from installed or live behavior, including any restart still needed. Never describe an untested integration as working or promise that no failure is possible.

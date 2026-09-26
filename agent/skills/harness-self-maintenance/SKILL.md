---
name: harness-self-maintenance
description: Maintain the running Pi harness itself—extensions, patches, tools, routing, skills and release machinery—using launch-scoped authority, current ownership discovery and focused regression checks.
---

# Harness self-maintenance

Use this workflow when changing the harness that runs the session. Discover its actual root and installed runtime; a similarly named application or public checkout is not automatically the live harness.

Maintenance authority comes from the human's original launch directory, inside the actual harness root or a descendant. Home, ancestors and sibling directories grant no authority. Changing directory, resuming, spawning children or setting environment variables cannot grant it. Preserve this guard and protection of global/shared skills; ordinary project-local edits must remain allowed. If denied, explain the required maintenance launch instead of bypassing protection.

Read the extension manifest and newest relevant maintenance entries with bounded reads. Before reopening an intentional choice (for example the 80% compaction threshold or the publish lock), read the durable decision registry in `HARNESS-DECISIONS.md` at the harness root; it records what was decided, why, and what would change it. Follow registration and imports to find the policy owner, consumers and existing tests. Distinguish durable source, installed dependencies, generated assets and runtime state. Patch durable source and apply its supported deployment path; dependency-only edits disappear on updates.

Reproduce the behavior before changing it. Preserve credentials, manual reminders, active sessions and unrelated work. Verify the changed behavior and its consequential failure path with focused tests and the read-only structural verifier; expand coverage when shared dependencies or failures justify it. For permissions, verify both denied harness mutation and allowed project mutation. Read [verification and releases](references/verification-release.md) for process, permission, patch or publication changes.

Keep temporary public exports, dependency installations and validation checkouts outside the live harness root, for example under a private directory in `/var/tmp`. Every guarded project command checks protected files for outside hard-link aliases; accumulating old dependency trees inside the harness makes ordinary shell calls repeatedly scan them. Keep private artifacts private, and archive verified inactive generated copies before removing them; preserve source changes, worktree registrations and live runtime dependencies.

Append a dated maintenance entry with rationale, coverage and any required restart. Separate source validation from live behavior; do not restart sessions owning unfinished work.

Check for a Git remote. Commit and push verified durable changes when authorized. A private non-Git installation must use its sanitized exporter and public checkout: follow `PUBLIC-RELEASE.md` and public `docs/PUBLISHING.md`. Review the export diff; publication runs distribution tests and scans before commit/push. Never publish runtime data, private backups or sessions, and never bypass a scanner finding.

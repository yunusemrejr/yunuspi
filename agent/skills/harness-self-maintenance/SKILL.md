---
name: harness-self-maintenance
description: "Maintain the running Pi harness itself (extensions, patches, tools, routing, skills, tests, public release) under launch-scoped authority, with ownership discovery and focused regression checks."
---

# Harness self-maintenance

## Authority and discovery
- Find the actual harness root and installed runtime. A similarly named or public checkout is not the live harness.
- Authority comes from the human's original launch directory, inside the harness root or a descendant. Home, ancestors, siblings, `cd`, resume, fanout children and env vars grant none. If denied, state the required maintenance launch; never bypass protection.
- Global and shared skills stay protected; project-local edits stay allowed.
- Before reopening an intentional choice (e.g. the 80% compaction threshold or the publish lock), read `HARNESS-DECISIONS.md` at the root.
- Read the extension manifest and recent maintenance entries with bounded reads. Follow registration and imports to the policy owner, consumers and tests.
- Patch durable source and use its supported deployment path. Dependency-only edits vanish on update.

## Change and verify
- Reproduce the behavior first. Preserve credentials, manual reminders, active sessions and unrelated work.
- Trace each change from registration through execution and cleanup. Permission changes need direct tools, shell and interpreter runs, background jobs, workflows, symlink paths, nonexistent descendants and fanout child launches. Test denied harness mutation and allowed project mutation.
- Process wrappers fail closed when required isolation is missing; label the real boundary.
- Reminders and skill routing: test positive and unrelated negative requests, bounded delivery, read-receipt dedup and fanout child delivery.
- Provider changes: verify request serialization and usage accounting with fixtures before any live inference.
- Core changes: check the build identity. Never install an upstream package or reapply core patches.
- Run focused suites; broaden only for failures or shared dependencies. Do not run paid smoke tests or restart active services for a green report.
- Select tests with `node scripts/test-harness.mjs --match NAME --list` (drop `--list` to run) where the private runner exists; in the public checkout use `node --test tests/NAME.test.mjs` and `npm test`. Name matching is not dependency analysis; follow imports.
- Keep one canonical fixture per installed behavior. Regressions target observable failures, not prose.
- Run the read-only `verify-harness.mjs`; use `--fix` only for diagnosed local drift.
- After deploying a skill, confirm the model reads that copy. User `settings.json` skill paths shadow shipped copies silently: `node ~/.pi/agent/scripts/skill-mirrors.mjs` lists shadows; `--apply` refreshes uncustomized copies with a backup.
- Report what was measured and what remains unverified.

## Workspace hygiene
- Keep temporary exports, dependency installs and validation checkouts outside the harness root, e.g. a private dir under `/var/tmp`. Old dependency trees inside it slow every guarded shell call.
- Archive verified inactive generated copies before removing them. Keep source changes, worktree registrations and live dependencies.
- Append a dated maintenance entry: rationale, coverage, required restart. Do not restart sessions with unfinished work.

## Release
- Check for a Git remote. Commit and push verified durable changes only when authorized.
- Without Git, export through the sanitized exporter to the public checkout, following `PUBLIC-RELEASE.md` and `docs/PUBLISHING.md`. Review the export diff.
- `publish-public.mjs` runs distribution tests and scans before commit and push; `--verify-only` validates without publishing. Do not run it twice unchanged. Never bypass a scanner finding.
- Private backups may hold credentials and history: keep them private and verify restore structure and permissions.
- Exports exclude runtime data, sessions, private datasets, credentials and machine config. Never copy the live harness wholesale or rely on `.gitignore` to clean history. Preserve third-party notices.

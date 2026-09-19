# YunusPi source updates and recovery

YunusPi owns its core source under `core/`. Pi 0.85.1 is its historical origin, not a runtime package or release authority. There is no upstream version check, background release notification, latest-Pi install, patch-after-install step or automatic compatibility probe against future Pi versions.

A bare `yunuspi update` explains the policy without network access or mutation. To update, obtain and review a YunusPi release checkout, stop active sessions, then run:

```sh
yunuspi update --source /path/to/reviewed/yunuspi
```

The command invokes that explicitly selected checkout's installer with `--apply --install-deps --backup-existing --preserve-state`. It never selects a remote revision on your behalf. The source must identify the core as `@yunuspi/coding-agent`; review the checkout and installer before executing it. The installer stages the owned runtime and public harness, installs the exact root lockfile, builds the core, then replaces the installation. Dependency or build failure leaves the existing installation intact. Session leases prevent replacing an active maintained-launcher session. Direct SDK hosts and processes bypassing that launcher must also be stopped before an update. A complete private backup preserves the previous core, configuration and credentials together.

Use `--offline --skip-needle` when all third-party dependencies are already cached. Offline mode never checks a registry or downloads optional model assets. A missing cache entry rejects the install before activation. Online mode downloads lockfile-selected third-party dependencies and optionally pinned Needle assets; it never downloads a Pi implementation.

Updates carry forward private settings, credentials, provider state, sessions, memory, local helper data and custom source files inside the installation. Managed-file SHA256 hashes distinguish public source from local additions. A local change to a managed file is preserved when the incoming release leaves that file unchanged; conflicting incoming/local edits reject the update before activation. Locally deleted source stays deleted unless the incoming release also changes it, which requires review. Symlinks and special files in carried state are rejected; generated dependency links are recreated. Local changes inside `runtime/core` must first be ported into the reviewed source checkout; core source hashes reject an update that would discard those changes. Build outputs and dependencies are rebuilt from that source.

An installation without a valid managed-file receipt needs an explicit reviewed migration; the updater does not guess ownership. The standalone installer with `--backup-existing` retains its documented fresh-install semantics and initializes public settings/models. Private state is never copied into the public checkout. Validate the updated installation:

```sh
node ~/.pi/agent/scripts/verify-harness.mjs
yunuspi --version
```

For rollback, stop sessions, move the new `~/.pi/agent` directory aside, and rename the preserved adjacent `agent.backup-*` directory to `agent`. The launcher uses its directory's runtime, so the core and harness roll back together. Keep private backups outside Git. The installer restores the previous directory if final activation fails; a machine crash between directory renames may require this same manual rollback. No private state is silently merged.

The old `auto-update.sh` entrypoint remains for existing user timers. It performs local verification only. It never modifies a core, resolves a version, installs packages, reapplies code patches or prunes session history. Optional old systemd update/repair watchers are no longer installed by the verifier; users may disable obsolete timers locally.

Maintainers may deliberately review and port individual upstream changes using [the upstream porting policy](../UPSTREAM-PORTING.md). Such a change becomes a reviewed YunusPi commit with YunusPi tests and release identity. Upstream publication alone does nothing.

## Regression coverage

```sh
node --test tests/install.test.mjs tests/update-safety.test.mjs tests/update-preservation.test.mjs
```

These synthetic tests cover owned-source launch, offline dependency commands, active-session refusal, failed-build preservation, private-state carry-forward, local source conflicts and explicit core ports, generated dependency links, unsafe state links, invalid inventories and hypothetical upstream release announcements. Behavioral compatibility scripts in `agent/scripts/compatibility/` import the owned build directly and run offline; the recovery suite additionally uses loopback-only root and worker sessions. None of these tests establish live-provider availability.

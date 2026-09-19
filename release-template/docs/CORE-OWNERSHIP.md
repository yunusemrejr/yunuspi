# YunusPi core ownership

YunusPi owns its runtime core. An upstream Pi release causes no installation change, background version query, notification, or package upgrade.

## Origin and versions

- Historical origin: Pi **0.85.1**, tag `v0.85.1`, commit `d981de1229ef899957bbe968bc8dcda02a21f477` in `earendil-works/pi`.
- Product version: root `package.json`.
- Fork version: `core/identity.json` and the six `@yunuspi/*` package manifests, initially **0.1.0**.
- Source identity: `core/build.json` records the source Git commit when available and a deterministic SHA-256 over the owned source and manifests. A source digest distinguishes uncommitted changes from the base commit.
- `yunuspi --core-info` reports all of these separately. The origin number is immutable provenance, not an update target.

## Owned packages

| Directory | Package | Responsibility |
| --- | --- | --- |
| `core/ai` | `@yunuspi/ai` | Provider APIs, model catalogs, retries, usage and pricing |
| `core/agent` | `@yunuspi/agent-core` | Agent loop, tools, session and harness contracts |
| `core/tui` | `@yunuspi/tui` | Terminal UI |
| `core/coding-agent` | `@yunuspi/coding-agent` | CLI, SDK, sessions, extensions, compaction |
| `core/chord` | `@yunuspi/chord` | Composition and RPC runtime required by the core |
| `core/telemetry` | `@yunuspi/telemetry` | Vendor-neutral telemetry types and contracts |

The relevant published packages all used 0.85.1. Their original tarball SHA-512 integrity values are preserved in `core/identity.json`. This repository includes MIT notices from the exact source tag. The original authors retain their copyrights; YunusPi maintains the subsequent modifications.

## Source and build

The canonical runtime is readable, unbundled ESM JavaScript plus declarations in each package's `src/`. It descends from the published 0.85.1 unbundled implementation. Existing runtime modifications were applied once during migration and incorporated into those source files. This avoids a second, inconsistent CLI bundle and preserves the existing JavaScript adaptations without pretending that unmodified upstream TypeScript contains them.

Edit `src/` directly. `npm run build:core` parses JavaScript/JSON, checks package ownership, copies validated source/assets to disposable `dist/` directories and records a source digest. It does not download, generate model catalogs, or patch an installed dependency. Declarations must be maintained with API changes; the current build is not a TypeScript type check.

All six package dependency edges use exact 0.1.0 workspace versions. The root lockfile contains local links for these packages and registry integrity pins for ordinary third-party dependencies. There are no external Pi runtime packages. `agent/npm` shares the root workspace dependency tree. Installation always uses `npm ci --ignore-scripts` before the explicit source build.

## Install and update policy

The installer stages a complete owned runtime under the agent's `runtime/`, verifies/builds it before activation, and installs `bin/yunuspi`. Existing installation backup and active-session exclusion remain explicit. The launcher binds child processes to the same owned core. Offline installation uses a complete dependency cache; an empty cache cannot provide third-party packages.

`yunuspi update --source /path/to/reviewed/yunuspi` applies an explicitly selected YunusPi checkout. Bare `yunuspi update` describes that policy. The former scheduled upstream updater now performs local validation only. No upstream release endpoint is consulted. Provider model catalogs and explicitly requested third-party extension operations are separate from core releases.

See [installation](INSTALL.md), [updates](CORE-UPDATES.md), [patch migration](PATCH-MIGRATION.md), and [manual upstream porting](../UPSTREAM-PORTING.md).

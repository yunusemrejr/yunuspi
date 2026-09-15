# Harness structure (`~/.pi`)

`~/.pi` holds the installed harness plus live session state. Paths below are
loading-path sensitive: several are hardcoded with `PI_CODING_AGENT_DIR` as
the only override. Do not rename or relocate them without updating every
owner and keeping a compatibility fallback.

## Top level

| Path | Owner | Notes |
| --- | --- | --- |
| `agent/` | installer | Installed public tree: `extensions/`, `scripts/`, `skills/`, plus live `settings.json`, `models.json`, caches and runtime state. Never edited in place for public changes; see [Public release](PUBLISHING.md). |
| `settings/` | user + harness | User configuration. `llm_preferences.json` lives here (see [Model preferences](LLM-PREFERENCES.md)). Created on demand; absent files mean defaults. |
| `reminders/` | reminders extension | Per-session reminder/scheduling state (`state-<sid>.json`) and once-per-session orientation receipts. Hardcoded in `lib/reminders-state.ts` and `lib/harness-orientation.ts`. |
| `checkpoints/` | checkpoints extension | Conversation recovery state. Hardcoded in `extensions/checkpoints.ts`. |
| `tasks/`, `work/`, `backups/` | various | Historical task records, maintenance logs and private backups. Runtime artifacts, not loading paths; never published. |
| `sibling-bridge/`, `inference-slots/`, `web-search-*` | various | Coordination and cache state. Runtime artifacts. |

## Inside `agent/`

| Path | Owner | Notes |
| --- | --- | --- |
| `extensions/` | public tree | All extensions plus `lib/` pure-policy modules and the `pi-*` forks. `manifest.json` is the canonical inventory (`verify-harness.mjs` derives its truth tables from it). |
| `extensions/node_modules` | installer | Symlink to `../npm/node_modules` for fork runtime dependencies. |
| `scripts/` | public tree | Maintenance, export, verification and compatibility scripts. |
| `skills/` | public tree | Installed skill workflows. |
| `settings.json`, `models.json` | user + harness | Canonical configuration (created from `config/*.example.json` at install). Private; never published. |
| `sessions/`, `memory/`, `logs/`, `cache/`, `artifacts/`, `worktrees/`, `missions/`, `local-models/`, `project-intelligence/` | harness runtime | Live state. Private; never published. |
| `provider-health.json`, `free-route-evidence.json`, `live-model-catalog.json`, `models-store.json`, `run-history.jsonl`, `auth.json` | harness runtime | Provider and accounting state. Private; never published. |

## Public repository mirrors

The public checkout keeps `docs/`, `config/*.example.json`, `scripts/`,
`tests/` and root files mirrored under `release-template/` (the export
scaffolding excludes `agent/`, which the exporter assembles from the live
tree). When changing any mirrored file, update both copies so subsequent
exports preserve the safeguards.

## Cleanup rules

- Prefer modifying one existing source of truth over adding a second
  implementation. If two components overlap, migrate callers toward the
  owner instead of moving files around.
- Never delete, overwrite or repurpose session-owned state to tidy the tree.
  Regenerable caches (`node_modules`, build output) are the exception.
- Runtime state accumulates by design (per-session reminder files, run
  history, checkpoints). Retention changes need explicit ownership, expiry
  rules and recovery behavior — not ad-hoc deletion.

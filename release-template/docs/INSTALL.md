# Install a public release

Use Linux, Windows with WSL2 Ubuntu, or an Ubuntu VM on macOS; see [platform details](PLATFORMS.md). This source distribution owns the YunusPi core and its maintained extensions. Pi 0.85.1 is the historical fork origin; upstream releases never control installation or updates. Do not install over a running Pi session.

## Prerequisites

In Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y git curl ca-certificates bash tar gzip util-linux ripgrep python3 build-essential bubblewrap
```

Install Node.js 22.19 or later and its matching npm from a trusted Node distribution or version manager. Node.js 24 or later is recommended and is the version used by public CI. Check `node --version` and `npm --version`. Use a user-writable npm installation; avoid running the harness or installer with sudo.

## Review and install

```sh
git clone https://github.com/yunusemrejr/yunuspi.git
cd yunuspi
node scripts/install.mjs
node scripts/install.mjs --apply --install-deps
export PATH="$HOME/.pi/agent/bin:$PATH"
yunuspi --version
```

The first invocation is a read-only preview. The second copies public `agent/` files and the repository-owned `core/` packages into `~/.pi/agent`, installs the exact root workspace lockfile with npm lifecycle scripts disabled, and runs `build:core`. The core is built from local source; no upstream Pi package or version endpoint is consulted. Third-party dependencies still download from npm. Review their lockfile changes before installing a release.

The installation contains `runtime/core/`, `runtime/node_modules/`, and `bin/yunuspi` (with `bin/pi` as a compatibility alias). Both extension dependency links select that same workspace, so core imports resolve to the owned packages. Add the `bin` directory to your shell's PATH permanently after validating the installation. An unrelated globally installed `pi` is not modified; invoke `yunuspi` to make selection explicit.

Private settings/models are initialized from public templates. Keys, sessions, reminders, local models and private state are never copied from a working installation. An existing target is refused by default. After stopping sessions, `--backup-existing` renames the complete old installation into an adjacent private backup and installs a fresh tree. Active maintained-launcher sessions block replacement. Restore your credentials deliberately from that private backup after reviewing the new configuration; never commit the backup.

`--target /some/empty/path` is supported for staging and CLI checks. The full harness still expects `~/.pi/agent` for several subsystem paths. Omitting `--install-deps` copies source only; the launcher explains that the core needs a build. For an offline installation with a populated npm cache, use `--apply --offline`. This passes `--offline` to npm and skips optional Needle downloads. An incomplete cache fails before replacing the previous installation. Neither mode contacts an upstream Pi release service.

## Validate the owned core

```sh
node ~/.pi/agent/scripts/verify-harness.mjs
```

Read every failure before using YunusPi. Verification checks the owned core, extension inventory, configuration and local safety controls. It does not patch the core or retrieve another Pi version. Maintainers change `core/*/src` and rebuild under YunusPi review and tests. See [updates and recovery](CORE-UPDATES.md).

## Bring your own credentials

Launch `yunuspi` and use its login/provider setup for a provider you control. Alternatively configure provider environment variables or the documented local authentication file outside the Git checkout. Keep credentials out of skills, examples, prompts, shell commands saved to transcripts, screenshots and public issues. Do not copy a private `auth.json`, `models.json`, `.env`, provider receipt cache or entire `.pi` directory into this repository.

Select a model actually available to your account before starting work. Catalog metadata and displayed pricing are estimates, not billing guarantees. Free routes may have limits or disappear. Start with a small task and inspect tool results and costs before enabling autonomous workflows.

## Harness maintenance authority

Start ordinary tasks in their project directory. Those sessions cannot use guarded write/edit or executable tools to modify the active harness. Maintenance requires a new human-started Pi session whose process starts inside the active harness root (`~/.pi` in the standard installation) or one of its descendants. Starting Pi from the home directory, `/`, or another parent/sibling directory does not grant maintenance authority. Child agents and later directory changes do not grant it either. Keep ordinary projects outside `~/.pi` so project sessions remain outside the maintenance boundary.

The eight utility inspection tools start automatically in one local
`yunuspi-utility-mcp` process per session, including built-in helper sessions.
They require no MCP configuration, API keys or manual startup. The harness owns
startup, reuse, bounded restart and shutdown; normal tool guidance and Bash
routing keep the tools discoverable. SQLite/archive inspection uses Python 3.11+
standard-library modules already provided by Ubuntu 24.04+; no Python package
installation is needed. See the [utility tool contracts and limits](../agent/extensions/lib/utility-mcp/README.md).

Linux executable isolation requires working Bubblewrap user namespaces and Python 3. Unsupported environments refuse guarded commands rather than run them without protection. Scripted workflows that execute arbitrary JavaScript inside the Pi process are unavailable outside maintenance sessions; use declarative subagent chains, parallel tasks, swarm or fusion instead. See [security boundaries](SECURITY.md) before enabling third-party extensions.

Ubuntu 24.04+ may restrict unprivileged user namespaces through AppArmor. A `bwrap: setting up uid map: Permission denied` error can indicate that policy. An administrator can review `config/bwrap.apparmor`, check for an existing Bubblewrap profile, and load an appropriate per-executable policy with `sudo apparmor_parser -r config/bwrap.apparmor`. For persistence, install the reviewed profile under `/etc/apparmor.d/`. The supplied profile permits namespace creation for `/usr/bin/bwrap`; it does not globally disable AppArmor or its namespace restrictions. Do not replace a stricter existing organizational policy without review. See [Ubuntu's namespace restrictions](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces). The harness installer never makes this administrator-level policy change itself.

## Optional browser tooling

```sh
cd ~/.pi/agent/npm
npx --no-install playwright install chromium
```

On Linux, Playwright may also require system packages; install them using its documented OS dependency procedure. Download browsers only when browser tasks are needed. Other tools mentioned in skills are installed separately. No local model download, API subscription, service or scheduled task is silently enabled by this bootstrap.

## Optional local micro-models

Model weights are not bundled. A normal `--apply` attempts to install pinned, checksummed Needle3 WASM assets; `--skip-needle` and `--offline` skip this optional download. A failed download warns and leaves local semantics unavailable until repair. Smol and Kompress require separately configured local servers. Inspect availability with `micro_status`:

- Needle3: pinned WASM assets are fetched by
  `node agent/extensions/lib/needle-assets.mjs install [--revision …]`;
  `verify`, `repair`, and `smoke` keep the cache healthy.
- Smol / Kompress: point at local llama.cpp-style servers serving the
  SmolLM2 and Qwen3-1.7B-GGUF weights described in
  `docs/MICRO-INTELLIGENCE.md`, or the stock-Ollama convenience names
  when using Ollama.
- Jev: no install step; it activates inside sandbox-guarded processes
  using pinned dependencies.

Direct semantic retrieval uses the `needle-query.mjs` helper. See
`docs/MICRO-INTELLIGENCE.md` for the full pipeline, budgets, and
observer controls (`PI_NEEDLE`, `PI_NEEDLE_SHADOW`, `PI_MICRO_ADVISORY`,
`PI_MICRO_INTELLIGENCE`).

## Updates and recovery

Review the new public release and security changes first. Stop Pi, keep a private backup, then use the explicit backup installation workflow above. Reconfigure your own credentials locally; never merge an old private tree into a release checkout. If installation fails before activation, the previous target remains; if activation fails after its rename, the installer attempts to restore it and reports failure. To roll back an activated install, stop Pi, move the new directory aside and rename the preserved backup to `~/.pi/agent`. The owned core is inside the agent directory and rolls back with it. Upstream Pi releases have no effect. An explicit reviewed-source update preserving private state and compatible local customizations is available as `yunuspi update --source /path/to/reviewed/yunuspi`; see [the update policy](CORE-UPDATES.md).

# Install a public release

Use Linux, Windows with WSL2 Ubuntu, or an Ubuntu VM on macOS; see [platform details](PLATFORMS.md). This is a source distribution with a pinned Pi core and locally maintained extensions. Do not install over a running Pi session.

## Prerequisites

In Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y git curl ca-certificates bash tar gzip util-linux ripgrep python3 build-essential
```

Install Node.js 24 or later and its matching npm from a trusted Node distribution or version manager. Check `node --version` and `npm --version`. Use a user-writable npm installation; avoid running the harness or installer with sudo.

## Review and install

```sh
git clone https://github.com/yunusemrejr/yunuspi.git
cd yunuspi
node scripts/install.mjs
node scripts/install.mjs --apply --install-deps
npm install --global --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@0.85.1
```

The first installer invocation is a read-only preview. The second copies only the release's public `agent/` tree to `~/.pi/agent`, installs the exact dependency lockfile with npm lifecycle scripts disabled, creates its relative dependency link, and initializes private local settings/models from the public `config/*.example.json` templates. It does not copy keys, sessions, private reminders, local models or personal state. Dependency packages are downloaded from the npm registry; review package and lockfile changes before installing updates.

An existing target is refused by default. After stopping Pi, `--backup-existing` explicitly renames the old installation to a private adjacent backup before activation. It does not merge credentials or overwrite individual files. That backup can contain secrets and must never be committed. `--target /some/empty/path` is available for inspecting a staged copy; the runtime and patch machinery expect `~/.pi/agent`, so an arbitrary target is not a supported live runtime relocation.

## Validate the patched core

After installing the pinned core, apply and verify the release's patches:

```sh
node ~/.pi/agent/scripts/verify-harness.mjs --fix
node ~/.pi/agent/scripts/verify-harness.mjs
```

Read the results and resolve every failure before using Pi. The harness's patch modules are version-sensitive: keep core 0.85.1 until a later version has been validated with this harness. Do not silently continue after failed patch checks, or run an unattended global update. The public installation must not rely on the original author's credentials, machine paths or systemd units.

The installer itself does not patch an unrelated globally installed core or run a model request. Core verification and repair are separate steps because they modify installed application code. The first verification command modifies the installed core; the second checks the resulting installation.

## Bring your own credentials

Launch `pi` and use its login/provider setup for a provider you control. Alternatively configure provider environment variables or the documented local authentication file outside the Git checkout. Keep credentials out of skills, examples, prompts, shell commands saved to transcripts, screenshots and public issues. Do not copy a private `auth.json`, `models.json`, `.env`, provider receipt cache or entire `.pi` directory into this repository.

Select a model actually available to your account before starting work. Catalog metadata and displayed pricing are estimates, not billing guarantees. Free routes may have limits or disappear. Start with a small task and inspect tool results and costs before enabling autonomous workflows.

## Optional browser tooling

```sh
cd ~/.pi/agent/npm
npx --no-install playwright install chromium
```

On Linux, Playwright may also require system packages; install them using its documented OS dependency procedure. Download browsers only when browser tasks are needed. Other tools mentioned in skills are installed separately. No local model download, API subscription, service or scheduled task is silently enabled by this bootstrap.

## Updates and recovery

Review the new public release and security changes first. Stop Pi, keep a private backup, then use the explicit backup installation workflow above. Reconfigure your own credentials locally; never merge an old private tree into a release checkout. If installation fails before activation, the previous target remains; if activation fails after its rename, the installer attempts to restore it and reports failure. To roll back an activated install, stop Pi, move the new directory aside and rename the preserved backup to `~/.pi/agent`. Pinned core upgrades and rollback are separate from the agent directory.

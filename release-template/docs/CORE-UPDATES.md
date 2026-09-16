# Core updates and customization preservation

After `verify-harness.mjs --fix` succeeds, the maintained `pi` launcher routes
core updates through `scripts/auto-update.sh`. Use `pi update` from a shell after
closing active Pi sessions. `pi update --all` also runs the native extension
update command afterward. Local extension forks remain owned by the harness;
the normal configuration contains no third-party extension packages to update.

The updater installs a candidate with npm lifecycle scripts disabled. Bubblewrap
exposes it at the expected core path in a private filesystem, process and network
namespace. The existing core, harness files and configured skills remain
read-only there. Patch repair, full extension loading and every synthetic offline
compatibility suite listed by `agent/scripts/lib/core-compatibility.mjs` must pass
before activation. The suite list is code-owned so documentation does not drift
when checks are added or retired. These checks ship in `agent/scripts/compatibility`;
private benchmarks and sessions are excluded. No paid inference is used. Missing
checks or unavailable isolation fail the update.

The launcher holds a shared session lock for the process lifetime. Updates and
patch repair require the exclusive lock: maintenance defers during sessions,
and a new session waits until maintenance releases it. A customization digest
also detects concurrent edits to extensions, scripts, skills, linked skill
targets, settings, models and dependency manifests before activation.

A recovery journal records the old and new directory identities. Activation
retains the previous patched core; validation failure restores that directory.
An interruption with incomplete recovery blocks startup. Run:

```sh
bash ~/.pi/agent/scripts/auto-update.sh --repair-only
```

Inspect `~/.pi/agent/logs/auto-update.log`, `update-staged-repair.log`,
`update-staged-verify.log` and the individual `update-*-test.mjs.log` files for
failures. If recovery reports missing or replaced rollback data, preserve the
journal and directories and resolve their identities before continuing. Do not
delete a journal merely to bypass the startup check.

These protections cover the maintained CLI and updater. Direct SDK hosts and
raw npm installers can bypass them. Avoid global reinstalls over active
sessions; after an outside reinstall, restore and verify the launcher with the
documented repair command before use. No finite test suite establishes safety
for every future upstream release or live provider response. An unfamiliar
upstream layout must be reviewed when the gate rejects it. Linux with working
Bubblewrap user namespaces is required.

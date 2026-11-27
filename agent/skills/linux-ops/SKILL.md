---
name: linux-ops
description: "Linux and Ubuntu administration and debugging (/proc, strace, perf, journalctl, systemd, permissions, disk, DNS, safe shell), running Windows apps through Wine and WineCharm, and safe file organization (inventory, plan, journal, undo)."
disable-model-invocation: true
---

# Linux and Ubuntu operations

This is the owner's daily laptop. A careless change to a package, service or dotfile can break the desktop or other sessions: change only what the task needs and leave a way back.

## Before changing anything
- Establish where you are: `hostname`, `whoami`, `lsb_release -d`, `uname -r`, the working directory, local or remote or container. Read the state: tool version (`--version`, `apt policy`), `systemctl [--user] status`, recent logs, the config actually in use, who else uses it. Check what is already running before a heavy or long job. Search project notes for the same problem first.

## Making a change
- Smallest change: an app setting, then a user-level file (`~/.config`, `~/.local`, `systemd --user`), then system level; drop-ins (`systemctl edit`) instead of editing a packaged unit. `sudo` only when unavoidable, and say why; never run an unread script as root.
- Packages from the distro or a vendor's signed repository, source and key checked. A web install script is downloaded to its own folder and read, never piped into a shell.
- Secrets stay in mode-600 files, out of printed commands, logs, notes and git. Scripts: quote paths, arrays or `--`, `set -euo pipefail`, a dry run first for deletes and moves (`rsync -n`, `find -print` before `-delete`).
- Back up only what a risky edit needs, as one copy beside it or a git commit; keep the last few and delete the rest. For config already in git read `git status` and `git diff` first: it may hold the owner's uncommitted edits.

## Reversing it
- Before the change record the prior state: package version (`apt-cache policy`), a unit's enabled and active state separately and its scope, a file's content or a git commit. Put the exact undo command in the report; for lasting changes (service, repository, kernel parameter, driver) leave a short note: what, when, why, how to reverse.
- Remove only packages this change newly installed; never `apt autoremove` as a reversal without reading `apt-get -s autoremove`. Restore exactly the recorded enabled and active states (`disable --now` would stop a unit that was running before). Revert only your hunks, not a whole `git restore` of a file with other edits.

## Verify with the real thing
- Exit 0 is not proof. Check `systemctl status`, `journalctl -u UNIT -n 50 --no-pager`, the port answering, the file's content, the application doing its job. Test that it starts from its unit, not only your shell, and survives a restart.
- Stop what you started and check with `ps`. Stop by unit or a verified PID, never `pkill -f` by pattern.

## Diagnosing
- Disk: `df -h ~`, `df -i`, `du -xh --max-depth=1 ~ | sort -h | tail`; `df` and `du` disagreeing means deleted open files (`lsof +L1`); `/tmp` is memory here. Ports: `ss -ltnp`, then `curl -sS -m 5 -I` the address. Logs: `journalctl --user -u NAME -n 100 --no-pager`, `-p err`, `-k` for OOM kills; read the last error before the first warning. Processes and syscalls: `/proc`, `strace -p`, `perf` with bounded runs. Network faults: name resolution, route, TLS, HTTP, one layer at a time.
- Dotfile: read the file and any include or drop-in directory, back up if not in git, change one thing, check syntax with the program's own test (`bash -n`, `sshd -t`, `nginx -t`, `systemd-analyze verify`), reload that program, confirm, note the reverse.
- User service: `~/.config/systemd/user/NAME.service` with `ExecStart` absolute, `Restart=on-failure`, `WantedBy=default.target`, then `daemon-reload` and `enable --now`; undo with `disable --now` and delete the file; add `MemoryMax=` for anything that can grow. Timer: a oneshot service plus a `.timer` (`OnCalendar`, `Persistent=true`); enable the timer.
- File organization: inventory, plan, journal, undo; never move or delete without the journal. Sizing and detaching long jobs follows the machine-limits skill.

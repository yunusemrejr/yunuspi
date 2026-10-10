---
name: linux-ops
description: "Linux and Ubuntu administration and debugging (/proc, strace, perf, journalctl, systemd, permissions, disk, DNS, safe shell), running Windows apps through Wine and WineCharm, and safe file organization (inventory, plan, journal, undo)."
---

# Linux operations

## Method
- Confirm distro, user, cwd, container/WSL boundary and commands; a path or root prompt does not name the intended host.
- Inspect read-only first. Before restarting, find the owner: systemd unit, user session, cron, container or terminal.
- Verify the affected process or artifact, not the exit code. Check a PID's identity before signaling; PIDs recycle.
- Keep an access path open before changing SSH or network services remotely.

## First tools by symptom
- D state or stuck: `cat /proc/PID/wchan`, `strace -p PID`. High load is not CPU busy; count with `ps -eo stat | grep -c '^D'`.
- CPU: `top -H -p PID`, then `perf record -p PID`. Memory: MemAvailable in `/proc/meminfo`; OOM in `journalctl -k`.
- Disk: `df` vs `du` mismatch means deleted-but-open (`lsof +L1`); `df -i` for inodes; `iostat -xz 1`; `/proc/pressure/*`.
- Network: `ip route get DEST`, `ss -tnp`, `nft list ruleset` (counters show hits), `ethtool -S`, `resolvectl status`, `getent hosts` vs `dig @server`.
- Service: `journalctl -u UNIT --since -1h`, `systemctl status --lines=200`, `systemd-analyze critical-chain`.

## systemd and packages
- Override with `systemctl edit UNIT` (drop-in), not by editing the unit. `daemon-reload` reloads units, not application code.
- Set `MemoryMax=`, `CPUQuota=`, `TasksMax=`; "the box ran out" usually means a unit had no limit.
- Timers replace cron; `Persistent=true` catches up after downtime.
- Check apt candidates and origins before installing. Respect dpkg locks: find the owner, never delete lock files. Keep Python deps in a venv, never replace distro Python.

## Permissions and disks
- Traversal needs `x` on every ancestor: use `namei -l`, not `chmod -R 777`. Check `umask`, `getfacl`, and `getcap` instead of setuid.
- Root works but user fails: check `getenforce`, `dmesg | grep -i denial`, and `lsattr` (immutable files).
- `findmnt -T PATH` for options; a /home path may be a remote mount. Run `fsck` only unmounted.
- Destructive commands: list exact targets first; use `--`, NUL-delimited lists and arrays; never parse `ls`; symlinks defeat lexical path checks.
- Traps: profile-set `LD_PRELOAD`/PATH (`env -i bash -c` shows a service's view); replace running binaries by copy-and-rename (ETXTBSY).
- Backups: distinguish copied bytes, filesystem-consistent and application-consistent. A restore rehearsal is the completion test.

## Windows apps through Wine
- Kernel-mode anti-cheat/DRM and boot-time services have no Wine fix; stop and report.
- Default DLLs to builtin. Override one module at a time via `WINEDLLOVERRIDES` (order matters: `d3d11,dxgi=n,b`), recording each symptom; never blanket-override.
- One prefix per app, pinned runner, matching bitness. Shared prefixes cross-contaminate.
- Loader failure: `WINEDEBUG=+loaddll` shows builtin vs native; keep the loader error verbatim. Black window: check `vulkaninfo` and DXVK version first.
- Record per prefix: arch, runner version, winetricks verbs, overrides, launch command. Upgrade a runner on a clone; keep the old prefix until green.
- WineCharm (`winecharm FILE.exe|.charm|.wzt`): check prefix/runner pairing first; diff `Settings.yaml` against a template. Never delete the last good `.prefix`/`.bottle`/`.wzt` backup before its replacement restores.

## File organization (plain bash)
- Resolve loose names ("my Downloads") with `ls`/`find` first. Refuse home itself, system dirs, dot-config dirs and projects.
- Inventory: types, sizes, duplicates. Leave hidden files, symlinks and unfinished downloads (`*.part`, `*.crdownload`) alone.
- Plan: write `from<TAB>to` lines to a file and review them before any `mv`.
- Never overwrite: `mv -n`. Never delete: park duplicates in `Duplicates/` for the user to decide.
- Journal each move so undo is the reverse `mv`. Compare file counts before and after. Ask before removing or merging folders.

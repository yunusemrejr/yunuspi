---
id: linux
part: operations
title: Linux and the shell
summary: Operating Linux safely: shell quoting and strict mode, exit codes and pipelines, processes and signals, permissions and ownership, systemd and logs, disk, memory and network inspection, and package management.
terms: linux ubuntu debian fedora arch shell bash zsh sh script scripts command terminal cli pipe pipeline exit code quoting permission permissions chmod chown sudo root process processes signal kill systemd service journalctl cron disk df du memory free port netstat ss apt dnf package environment path
files: .sh .bash .zsh .service .timer Makefile .bashrc .profile
tools: bash sys_probe env_audit
skills: linux ubuntu-operations linux-host-defense linux-network-engineering linux-desktop-ui-ux
---

# Linux and the shell

The shell is the most powerful and least forgiving interface an agent has. A missing quote can delete the wrong directory; an ignored exit code can report success after failure. Fluency means knowing the few rules that prevent most disasters and the few tools that answer most questions about a system.

## Quote every expansion, use strict mode in scripts {#quoting}
<!-- terms: quoting quotes variable expansion word splitting glob set -euo pipefail strict mode shellcheck spaces -->

**Principle.** Quote variable and command expansions ("$var", "$(cmd)"), and start scripts with set -euo pipefail so errors stop execution.

**Why.** Unquoted expansions split on whitespace and expand globs, so a filename with a space becomes two arguments and an empty variable can turn rm -rf "$dir/" into rm -rf /. Without errexit, scripts continue after failures; without pipefail, a pipeline's failure is masked by its last command; without nounset, typos in variable names silently expand to nothing. ShellCheck catches most of these mechanically.

**Signals.** Unquoted $variables in commands that touch files; scripts without strict mode; rm or mv with variable paths.

**Ask.** What happens to this command if the variable is empty or contains spaces?

**Traps.** set -e surprises inside conditionals and subshells; using shell for logic that deserves a real language.

## Exit codes and pipelines tell the truth {#exit-codes}
<!-- terms: exit code status $? pipefail pipeline grep tail head tee error output stderr redirect -->

**Principle.** Check exit codes explicitly, remember that pipelines report only the last command's status unless pipefail is set, and keep stderr visible.

**Why.** "cmd | tail" hides cmd's failure; "cmd > /dev/null 2>&1" hides its error message; grep returns 1 for "no match", which is not an error in many contexts. Agents frequently read the last lines of output and conclude success. Explicit status checks and preserved stderr make failures visible.

**Signals.** Pipelines ending in tail, head or tee in verification commands; stderr redirected away; success concluded from partial output.

**Ask.** What was the exit status of the command that matters in this pipeline?

**Traps.** Treating any stderr output as failure (many tools log progress there).

## Know processes, signals and ownership {#processes}
<!-- terms: process pid signal sigterm sigkill kill ps top htop zombie orphan background nohup daemon job -->

**Principle.** Find processes precisely (by pid or unique match), stop them gracefully with SIGTERM before SIGKILL, and know which processes a task started.

**Why.** pkill with a broad pattern kills unrelated processes, including other users' sessions or the tooling itself. SIGKILL prevents cleanup, leaving lock files and corrupted state. Background processes started in a session continue after it and hold ports and files. Process trees matter: killing a parent may orphan children.

**Signals.** pkill or killall with generic names; kill -9 as a first resort; servers left running from earlier steps.

**Ask.** Exactly which process is being signaled, and did this task start it?

**Traps.** Killing processes owned by the user's own work outside this task.

## Permissions: least privilege, no reflexive sudo {#permissions}
<!-- terms: permission permissions chmod chown sudo root owner group 777 755 644 umask acl -->

**Principle.** Grant the minimum permissions needed, avoid sudo unless the task truly requires system changes, and never use chmod 777 as a fix.

**Why.** Permission errors are information: the process is running as the wrong user or writing to the wrong place. sudo turns mistakes into system-wide damage and creates root-owned files that break later unprivileged runs. chmod 777 makes files writable by anyone, a security hole. Correct fixes: change ownership of project files to the user, write to user-owned directories, use groups deliberately.

**Signals.** sudo used to fix permission errors in project directories; chmod 777; root-owned files in a user's project.

**Ask.** Why was permission denied, and what is the least-privileged fix?

**Traps.** Running package managers with sudo in language-level environments.

## systemd and journals for services {#systemd}
<!-- terms: systemd service unit systemctl journalctl status restart enable logs timer boot -->

**Principle.** Manage long-running services with systemd units: inspect with systemctl status, read logs with journalctl -u, and use restart policies and timers instead of ad hoc loops.

**Why.** Services started by hand die with the terminal, restart nowhere and log into the void. systemd supervises, restarts on failure with backoff, captures logs with timestamps and orders startup dependencies. journalctl -u name --since shows exactly what happened. Timers replace cron with logging and dependency handling.

**Signals.** Services started with nohup or screen; restart loops in shell scripts; logs lost after crashes.

**Ask.** Is this service supervised, restarted on failure and logging somewhere inspectable?

**Traps.** User versus system units confusion; editing unit files without daemon-reload.

## Inspect the system before theorizing {#inspect}
<!-- terms: disk full df du memory free swap oom cpu load port listening ss lsof network dns ping curl -->

**Principle.** Answer resource questions with direct measurements: df and du for disk, free and the OOM log for memory, ss or lsof for ports, uptime and top for load.

**Why.** Many mysterious failures are resource exhaustion: a full disk makes writes fail with unrelated-looking errors; the OOM killer silently terminates processes; a port already in use blocks a server; DNS failures look like network outages. A handful of commands answers these in seconds.

**Signals.** "No space left", killed processes, address-in-use errors or timeouts investigated by reading code.

**Ask.** What do disk, memory, port and network measurements say right now?

**Traps.** Deleting large files without checking what they are.

## Packages: the system's package manager for the system, language managers for projects {#packages}
<!-- terms: apt dnf pacman package install pip npm global local virtualenv venv nvm pyenv version -->

**Principle.** Install system tools with the system package manager, project dependencies with the project's language manager in local or virtual environments, and avoid mixing them.

**Why.** pip installing into the system Python can break OS tools; global npm installs create version conflicts between projects; mixing apt-installed and pip-installed versions of one library causes baffling errors. Virtual environments and project-local dependencies isolate projects. Version managers handle multiple runtime versions.

**Signals.** sudo pip install; global installs of project dependencies; different runtime versions between shell and scripts.

**Ask.** Is this dependency being installed into the right scope for its purpose?

**Traps.** Assuming the same package names across distributions.

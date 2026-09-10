# Platform support

The complete harness targets Linux with Bash and GNU utilities. The portable installer uses Node.js, relative dependency links, and atomic installation. This does not make every extension or background service portable.

| Host | Recommended environment | Status |
| --- | --- | --- |
| Linux | Ubuntu 24.04 or later, Node.js 24+ | Primary implementation; focused automated tests run on Linux |
| Windows 11 | WSL2 Ubuntu, Node installed inside Ubuntu | Linux compatibility route; no native Windows validation |
| macOS Intel or Apple Silicon | Ubuntu Linux virtual machine matching the host CPU | Linux compatibility route; no macOS VM hardware validation |
| Native Windows | None | Unsupported: Bash, signals, process inspection, links and service assumptions differ |
| Native macOS | Optional development experimentation | Not full parity: `/proc`, GNU `flock`, systemd and some command flags are Linux-specific |

## Windows with WSL2

In an administrator PowerShell window, run `wsl --install -d Ubuntu`, reboot if requested, then open Ubuntu and create your Linux user. Run every command in INSTALL.md inside Ubuntu. Clone into `~/src/yunuspi` inside the Linux filesystem; avoid `/mnt/c` for the working harness, dependency installation and session files. Install Node inside WSL rather than reusing a Windows executable. Windows credentials and Linux credentials are separate; configure keys inside Ubuntu.

Interactive usage does not require systemd. Optional Linux user services require a WSL installation with systemd enabled. The public installer does not install services, enable boot tasks or change system settings. Closing or shutting down WSL stops its processes.

## macOS with a Linux VM

Create an Ubuntu 24.04+ VM using a hypervisor compatible with your Mac (for example UTM). Use Ubuntu ARM64 on Apple Silicon and AMD64 on Intel. Give it at least 4 CPU cores, 8 GiB RAM and 20 GiB disk for the harness, browser dependencies and projects; heavy model or media workflows require more. Complete the Ubuntu installer, open its terminal, and follow INSTALL.md there. Keep `~/.pi` on the VM's native disk. Share or clone project files as appropriate; do not share credential directories into a public repository.

The VM route runs the same Linux commands and process model. It has not been exercised on every hypervisor or CPU architecture. Native npm binaries must exist for your architecture; installation errors are reported rather than ignored.

## Optional capabilities

Playwright needs a separate browser download and OS libraries. FFmpeg, LibreOffice, Blender, CAD tools, compilers, LSP servers and Python packages are optional; skills describe how to use them but do not install applications. The local mini-model weights and credentials are not distributed or enabled by default. Background update services and Linux desktop notifications are also optional. A missing optional capability must be reported as unavailable, not represented as a successful tool run.

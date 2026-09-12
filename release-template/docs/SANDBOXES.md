# Disposable sandboxes

Use `sandbox_run` for small reproductions, script experiments, compiler checks and disposable test fixtures. It is available to the main agent and every built-in subagent, including reviewers. Custom agents with strict allowlists must include `sandbox_run` in `tools` and load `sandbox.ts` through `extensions` or `subagentOnlyExtensions`. Existing user/project exclusions still apply. Reload an existing Pi session to load the new extension.

Each call creates a fresh environment, runs one multiline Bash script in `/workspace`, returns `stdout`, `stderr`, `exitCode`, `started`, `timedOut`, `cancelled`, `truncated`, duration and limits, and disposes its files and processes. Combine related steps in one call. There are no persistent handles to forget or shared writable project directories. Nonzero exit, refusal, timeout and cancellation are tool errors; check their results. A launcher transport failure can return `started: null`: execution state is unknown, not a successful run. Bash keeps its normal exit-status semantics: use `set -eu` when a failed intermediate step should stop the experiment.

```json
{
  "command": "set -eu\npython3 -m unittest test_example.py",
  "files": [
    {"path": "example.py", "source": "src/example.py"},
    {"path": "test_example.py", "content": "import unittest\nfrom example import add\nclass Example(unittest.TestCase):\n def test_add(self): self.assertEqual(add(2, 3), 5)\n"}
  ],
  "timeoutMs": 10000
}
```

`files` is optional: an empty sandbox works for inline scripts. Each file specifies a relative destination and exactly one of UTF-8 `content` or a relative `source` in the current project. Sources copy the current bytes, including uncommitted edits. They are editable private copies, never bind mounts or hard links. Only explicit regular files are accepted; directories, symbolic links (including ancestors), hard links, special files, traversal and conflicting destinations are rejected. Up to 128 files, 256 KiB each and 2 MiB total may be supplied. Only include data the experiment needs. Source copies are checked for changes while each file is read; a multi-file snapshot is not an atomic project transaction.

The script has system software from read-only `/usr` and the distribution's binary/library paths. The harness's current Node executable is mounted separately at `/runtime/node`, so Node installed through NVM is available without exposing its home directory or global packages. The host project, home, `/run`, environment credentials and network are absent. `/workspace`, `/tmp` and `/home/sandbox` are separate temporary filesystems. The shell reads no login configuration. Dependencies installed only in a user's home or project are not automatically available. Network access and package downloads cannot be enabled by tool arguments. Print needed results before the call ends; no files are copied back. Run project integration checks separately after applying reviewed changes.

| Bound | Value |
| --- | --- |
| Memory, including temporary file pages | 256 MiB per sandbox; swap disabled |
| Processes and threads | 32 per sandbox |
| CPU | One CPU worth of time per sandbox |
| Writable scratch | 64 MiB per scratch mount, also charged to memory |
| Simultaneous sandboxes | Four per OS user; additional calls return busy |
| Deadline | 30 seconds by default, configurable from 1–120 seconds |
| Combined stdout/stderr | 16 KiB by default, configurable from 1–64 KiB; excess is drained and discarded |

This uses existing Linux components; it needs no container image download, persistent daemon of its own, root execution or writable project clone. Four tiny empty lock files in the user's runtime directory coordinate concurrency; they contain no input or output and are deliberately retained so locks never split across different inodes. The payload travels through pipes and anonymous sealed memory files. Bubblewrap temporary mounts disappear with the namespace. systemd kills the service's whole cgroup of descendants on termination, including detached children, and imposes an independent deadline if the launcher disappears.

## Requirements and refusal

Linux, Python 3, Bubblewrap with `--disable-userns` and `--size`, a running systemd user manager with syscall filtering, and cgroup v2 memory, swap, PIDs and CPU controls are required. The launcher checks actual kernel limit files before starting user code. Normal interactive Pi use does not require these optional sandbox controls. WSL2 needs systemd enabled; on macOS use the documented Linux VM route. No native macOS or Windows sandbox backend is claimed.

Follow [installation](INSTALL.md) for Bubblewrap and Ubuntu's per-executable AppArmor policy. Do not disable host security controls automatically to make a sandbox work. If namespaces, resource controllers or the user manager are unavailable, `started` is false and the command is refused. There is no ordinary-shell or temporary-directory fallback. Return that limitation to the parent/user instead of running an unsafe experiment on the host.

`node --test tests/sandbox.test.mjs` always checks validation and capability wiring. Real OS checks explicitly skip on incapable hosts. `PI_SANDBOX_REQUIRE=1 node --test tests/sandbox.test.mjs` requires real isolation and exercises source immutability, missing credentials/host PIDs/network, fresh calls, output limits, failure, cancellation, detached processes, resource exhaustion and concurrency. Run that required check on a supported Linux host before claiming the backend was verified.

## Threat boundary

The protected assets are host/project files, credentials, sibling work and host availability. Untrusted experiment code runs behind mount, user, PID, network, IPC, UTS and cgroup namespaces, dropped capabilities, disabled nested user namespaces, a new session and enforced whole-tree resource limits. systemd limits socket address families to Unix, IPv4, IPv6 and netlink inside the isolated namespace and restricts execution to the native syscall architecture; VM host-facing VSOCK sockets are excluded. Only selected input copies and read-only system software are exposed; no host IPC sockets or arbitrary environment/mount options are accepted.

This is process isolation on the host's Linux kernel, not a virtual machine or protection against kernel exploits, a hostile same-user host process, malicious installed extensions, or secrets deliberately included in fixtures/system software. The harness and its installed launcher are trusted. CPU/memory contention is bounded, not eliminated. Keep the host kernel and Bubblewrap patched. [Bubblewrap's security model](https://github.com/containers/bubblewrap#sandbox-security) explains why the mounted resources and flags define its boundary; [systemd resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html) describe the kernel cgroup limits.

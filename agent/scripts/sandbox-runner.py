#!/usr/bin/env python3
"""Trusted one-shot launcher. User code runs only after cgroup + bwrap setup.

Host reads are explicit bounded regular-file snapshots through directory FDs.
No writable host mounts, disk staging, arbitrary env, daemons or copy-back.
"""
import base64
import fcntl
import json
import os
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid

MEMORY = 256 * 1024 * 1024
SCRATCH = 64 * 1024 * 1024
FILE_BYTES = 256 * 1024
INPUT_BYTES = 2 * 1024 * 1024
LIMITS = {"memoryBytes": MEMORY, "scratchBytesPerMount": SCRATCH,
          "tasks": 32, "cpus": 1, "concurrentPerUser": 4}
HERE = os.path.abspath(__file__)


def integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{label} must be an integer in {low}..{high}")
    return value


def relative(value):
    if (not isinstance(value, str) or not value or len(value) > 512
            or value.startswith('/') or '\\' in value or '\0' in value
            or any(p in ('', '.', '..') for p in value.split('/'))):
        raise ValueError("File paths must be explicit relative paths without ., .. or empty components")
    return value


def read_source(root, source):
    """No realpath/check-then-open race, symlink ancestors, FIFO waits or aliases."""
    parts = relative(source).split('/')
    fd = os.dup(root)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        item = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            info = os.fstat(item)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > FILE_BYTES:
                raise ValueError("Sources must be regular, single-link files of at most 256 KiB")
            with os.fdopen(os.dup(item), 'rb') as stream:
                data = stream.read(FILE_BYTES + 1)
            after = os.fstat(item)
            if len(data) > FILE_BYTES or (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError("Source changed during snapshot or exceeded 256 KiB; retry an explicit file")
            return data
        finally:
            os.close(item)
    finally:
        os.close(fd)


def prepare(request, cwd):
    if not isinstance(request, dict) or set(request) - {'command', 'files', 'timeoutMs', 'maxOutputBytes'}:
        raise ValueError("Invalid sandbox request fields")
    command = request.get('command')
    if not isinstance(command, str) or not command or '\0' in command or len(command.encode()) > 65536:
        raise ValueError("command must contain 1..65536 UTF-8 bytes without NUL")
    timeout = integer(request.get('timeoutMs', 30000), 1000, 120000, 'timeoutMs')
    output = integer(request.get('maxOutputBytes', 16384), 1024, 65536, 'maxOutputBytes')
    files = request.get('files', [])
    if not isinstance(files, list) or len(files) > 128:
        raise ValueError("At most 128 files may be supplied")
    root = os.open(cwd, os.O_RDONLY | os.O_DIRECTORY)
    normalized, seen, total = [], set(), 0
    try:
        for entry in files:
            if not isinstance(entry, dict) or set(entry) - {'path', 'source', 'content'}:
                raise ValueError("Invalid file fields")
            dest = relative(entry.get('path'))
            if any(dest == p or dest.startswith(p + '/') or p.startswith(dest + '/') for p in seen):
                raise ValueError("Duplicate or overlapping destination paths")
            seen.add(dest)
            if ('source' in entry) == ('content' in entry):
                raise ValueError("Choose exactly one of source or content for each file")
            if 'source' in entry:
                data = read_source(root, entry['source'])
            else:
                if not isinstance(entry['content'], str):
                    raise ValueError("content must be a UTF-8 string")
                data = entry['content'].encode()
            total += len(data)
            if len(data) > FILE_BYTES or total > INPUT_BYTES:
                raise ValueError("Input limit: 256 KiB per file, 2 MiB total")
            normalized.append({'path': dest, 'data': base64.b64encode(data).decode()})
    finally:
        os.close(root)
    return {'command': command, 'files': normalized, 'timeoutMs': timeout, 'maxOutputBytes': output}


def verify_cgroup():
    with open('/proc/self/status') as stream:
        status = dict(line.strip().split(':', 1) for line in stream if ':' in line)
    if status.get('Seccomp', '').strip() != '2':
        raise RuntimeError("Required systemd syscall filtering is unavailable")
    with open('/proc/self/cgroup') as stream:
        group = next((line.strip()[3:] for line in stream if line.startswith('0::')), None)
    if not group or not os.path.basename(group).startswith('pi-sandbox-') or not group.endswith('.service'):
        raise RuntimeError("Sandbox must run in its own systemd cgroup v2 service")
    directory = '/sys/fs/cgroup/' + group.lstrip('/')
    def value(name):
        with open(directory + '/' + name) as stream:
            return stream.read().strip()
    if int(value('memory.max')) > MEMORY or int(value('memory.swap.max')) != 0 or int(value('pids.max')) > 32:
        raise RuntimeError("Required memory, swap or task limits are not enforced")
    quota, period = map(int, value('cpu.max').split())
    if quota > period:
        raise RuntimeError("Required CPU limit is not enforced")


def acquire_slot():
    # User-runtime files contain no payload. Kernel flock releases after crashes;
    # never unlink lock files, which would create independent inode locks.
    directory = f'/run/user/{os.getuid()}/pi-sandbox-slots'
    try:
        os.mkdir(directory, 0o700)
    except FileExistsError:
        pass
    root = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(root)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("Unsafe sandbox slot directory")
        for i in range(4):
            fd = os.open(str(i), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=root)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
                os.close(fd)
                raise RuntimeError("Unsafe sandbox slot file")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fd
            except BlockingIOError:
                os.close(fd)
        raise RuntimeError("All four sandbox slots are busy; retry after an existing call completes")
    finally:
        os.close(root)


def sealed_data(data, descriptors):
    fd = os.memfd_create('pi-sandbox-input', os.MFD_ALLOW_SEALING)
    descriptors.append(fd)
    with os.fdopen(os.dup(fd), 'wb') as stream:
        stream.write(data)
    os.lseek(fd, 0, os.SEEK_SET)
    fcntl.fcntl(fd, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
    return str(fd)


def worker(payload):
    verify_cgroup()  # Verify the actual kernel controls, not just command flags.
    slot = acquire_slot()
    descriptors = []
    try:
        args = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-net',
                '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--disable-userns',
                '--cap-drop', 'ALL', '--new-session', '--die-with-parent',
                '--hostname', 'sandbox', '--clearenv', '--ro-bind', '/usr', '/usr']
        for name in ('bin', 'sbin', 'lib', 'lib64'):
            source = '/' + name
            if os.path.islink(source):
                args += ['--symlink', os.readlink(source), source]
            elif os.path.isdir(source):
                args += ['--ro-bind', source, source]
        args += ['--proc', '/proc', '--dev', '/dev', '--dir', '/etc']
        if payload.get('nodeBinary'):
            args += ['--ro-bind', payload['nodeBinary'], '/runtime/node']
        if os.path.isfile('/etc/ld.so.cache'):
            args += ['--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache']
        for directory in ('/workspace', '/tmp', '/home/sandbox'):
            args += ['--size', str(SCRATCH), '--tmpfs', directory]
        for entry in payload['files']:
            # --file copies bytes into tmpfs: source inodes are never mounted.
            args += ['--perms', '0600', '--file', sealed_data(base64.b64decode(entry['data'], validate=True), descriptors), '/workspace/' + relative(entry['path'])]
        args += ['--ro-bind-data', sealed_data(payload['command'].encode(), descriptors), '/command.sh',
                 '--remount-ro', '/', '--chdir', '/workspace',
                 '--setenv', 'HOME', '/home/sandbox', '--setenv', 'TMPDIR', '/tmp',
                 '--setenv', 'PATH', '/runtime:/usr/bin:/bin:/usr/sbin:/sbin',
                 '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'LC_ALL', 'C.UTF-8',
                 '--', '/bin/bash', '--noprofile', '--norc', '-c',
                 'printf "%s\\n" "$1" && exec /bin/bash --noprofile --norc /command.sh',
                 'sandbox', payload['marker']]
        return subprocess.call(args, pass_fds=descriptors, stdin=subprocess.DEVNULL)
    finally:
        for fd in descriptors:
            os.close(fd)
        os.close(slot)


def stop_unit(unit):
    # Kill the entire cgroup, including setsid/double-fork descendants. The
    # service's RuntimeMaxSec is the independent fallback if this client dies.
    try:
        subprocess.run(['/usr/bin/systemctl', '--user', 'kill', '--signal=SIGKILL', '--kill-whom=all', unit],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        pass


def launch(payload):
    unit = 'pi-sandbox-' + uuid.uuid4().hex + '.service'
    payload['marker'] = 'PI_SANDBOX_STARTED_' + uuid.uuid4().hex
    timeout = payload['timeoutMs'] / 1000
    argv = ['/usr/bin/systemd-run', '--user', '--quiet', '--pipe', '--wait', '--collect',
            '--service-type=exec', '--unit=' + unit,
            '-p', 'MemoryMax=' + str(MEMORY), '-p', 'MemorySwapMax=0', '-p', 'TasksMax=32',
            '-p', 'CPUQuota=100%', '-p', 'RuntimeMaxSec=' + str(timeout + 1),
            # Exclude host-facing families such as VSOCK on VM/WSL hosts.
            # Native-only execution prevents a compat ABI bypass of the filter.
            '-p', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
            '-p', 'SystemCallArchitectures=native',
            '-p', 'TimeoutStopSec=1', '-p', 'KillMode=control-group', '-p', 'SendSIGKILL=yes',
            '-p', 'LimitCORE=0', '-p', 'LimitNOFILE=256', '-p', 'UMask=0077',
            '--', '/usr/bin/python3', '-I', HERE, '--worker']
    start = time.monotonic()
    cancelled = False
    def cancel(_sig, _frame):
        nonlocal cancelled
        cancelled = True
    previous = {sig: signal.signal(sig, cancel) for sig in (signal.SIGTERM, signal.SIGINT)}
    child = None
    timed_out, truncated, started = False, False, False
    launcher_error = None
    chunks, used = {'stdout': bytearray(), 'stderr': bytearray()}, 0
    prefix = bytearray()
    try:
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        with selectors.DefaultSelector() as selector:
            pending = memoryview(json.dumps(payload).encode())
            for stream, label in ((child.stdin, 'input'), (child.stdout, 'stdout'), (child.stderr, 'stderr')):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_WRITE if label == 'input' else selectors.EVENT_READ, label)
            while selector.get_map():
                if cancelled or time.monotonic() - start >= timeout:
                    timed_out = not cancelled
                    break
                for key, _ in selector.select(0.05):
                    if key.data == 'input':
                        try:
                            count = os.write(key.fd, pending[:65536])
                            pending = pending[count:]
                        except BrokenPipeError:
                            pending = pending[len(pending):]
                        if not pending:
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                        continue
                    data = os.read(key.fd, 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    if key.data == 'stdout' and not started:
                        prefix.extend(data)
                        marker = (payload['marker'] + '\n').encode()
                        if len(prefix) < len(marker) and marker.startswith(prefix):
                            continue
                        if prefix.startswith(marker):
                            started = True
                            data = bytes(prefix[len(marker):])
                        else:
                            data = bytes(prefix)
                        prefix.clear()
                    remaining = payload['maxOutputBytes'] - used
                    chunks[key.data].extend(data[:remaining])
                    used += min(len(data), remaining)
                    truncated |= len(data) > remaining
        # Always reap descendants, including after a successful shell exits.
    except Exception as error:
        launcher_error = str(error)
        if child is not None and not started:
            started = None  # Transport failure is not proof the command never ran.
    finally:
        if child is not None:
            stop_unit(unit)
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            for stream in (child.stdin, child.stdout, child.stderr):
                stream.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    result = {'started': started, 'exitCode': child.returncode if child else None, 'timedOut': timed_out,
              'cancelled': cancelled, 'truncated': truncated, 'durationMs': round((time.monotonic() - start) * 1000),
              'stdout': chunks['stdout'].decode('utf-8', errors='replace'),
              'stderr': chunks['stderr'].decode('utf-8', errors='replace'), 'limits': LIMITS}
    if launcher_error:
        result['error'] = 'Sandbox launcher failed: ' + launcher_error
    elif not started:
        result['error'] = 'No sandbox start was observed. Requires Linux, Bubblewrap with user namespaces, cgroup v2 controllers and a systemd user manager. No host fallback.'
    return result


def main():
    raw = sys.stdin.buffer.read(3 * 1024 * 1024 + 1)
    if len(raw) > 3 * 1024 * 1024:
        raise ValueError("Sandbox request exceeds 3 MiB")
    payload = json.loads(raw)
    if len(sys.argv) == 2 and sys.argv[1] == '--worker':
        return worker(payload)
    if sys.platform != 'linux' or os.getuid() == 0:
        raise RuntimeError("Sandbox requires Linux and a non-root user")
    if len(sys.argv) not in (2, 3) or not os.path.isabs(sys.argv[1]):
        raise ValueError("Expected an absolute workspace path")
    prepared = prepare(payload, sys.argv[1])
    if len(sys.argv) == 3:
        # Trusted extension argument (process.execPath), never a tool parameter.
        # Share just this executable so NVM installations need no home mount.
        node = os.path.realpath(sys.argv[2])
        info = os.stat(node)
        if not stat.S_ISREG(info.st_mode) or not os.access(node, os.X_OK):
            raise ValueError("Harness Node executable is unavailable")
        prepared['nodeBinary'] = node
    print(json.dumps(launch(prepared)))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        if len(sys.argv) == 2 and sys.argv[1] == '--worker':
            print('Sandbox refused: ' + str(error), file=sys.stderr)
            sys.exit(126)
        print(json.dumps({'started': False, 'error': str(error)}))
        sys.exit(1)

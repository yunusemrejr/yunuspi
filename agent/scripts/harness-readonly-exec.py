#!/usr/bin/env python3
"""Apply inherited Linux read-only mount restrictions, then exec without a shell.
No path/command regex is a security boundary. Unavailable namespaces fail closed.
Only executable children are restricted; Pi's own session/log writes are unaffected.
"""
import os
import fcntl
import glob
import hashlib
import json
import platform
import selectors
import stat
import subprocess
import sys
import time

# The hard-link inventory walks every protected tree (hundreds of thousands of
# files under a real harness root: 2-4 s of CPU) and used to run before every
# guarded command. A passing inventory is remembered for this long; failures are
# never remembered. PI_HARDLINK_SCAN_TTL_S=0 restores a fresh scan per command.
INVENTORY_TTL_S = 120
INVENTORY_MARKER = 'hardlink-inventory.json'
GUARD_READY_FD = 3
INVENTORY_WORKERS = 4
INVENTORY_MIN_CHILDREN = 12
INVENTORY_MAX_CHILDREN = 256
INVENTORY_ERROR = ('protected hard-link inventory failed; check unreadable or changing '
                   'protected paths (files changing during the scan are transient: '
                   'run the same command once more before changing approach)')


def ssh_config_mounts():
    """Preserve trusted system SSH config bytes across the one-user UID map.

    Host uid 0 is otherwise unmapped and appears as nobody, which OpenSSH rejects
    for Include files. Private read-only copies belong to the mapped caller;
    no host ownership, SSH options or host-key checking is changed.
    """
    mounts = []
    descriptors = []
    candidates = ['/etc/ssh/ssh_config', *sorted(glob.glob('/etc/ssh/ssh_config.d/*.conf'))]
    seen = set()
    try:
        for candidate in candidates:
            previous_descriptors = len(descriptors)
            try:
                target = os.path.realpath(candidate)
                if target in seen or not os.path.isfile(target):
                    continue
                seen.add(target)
                if len(seen) > 128:
                    break
                # Never turn an untrusted config into an apparently trusted one.
                current = target
                trusted = True
                while current != '/':
                    info = os.stat(current)
                    if info.st_uid != 0 or info.st_mode & 0o022:
                        trusted = False
                        break
                    current = os.path.dirname(current)
                if not trusted:
                    continue
                source = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    info = os.fstat(source)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                        continue
                    if info.st_size > 1024 * 1024:
                        continue
                    with os.fdopen(os.dup(source), 'rb') as stream:
                        data = stream.read(1024 * 1024 + 1)
                    if len(data) > 1024 * 1024:
                        continue
                finally:
                    os.close(source)
                descriptor = os.memfd_create('pi-system-ssh-config', 0)
                descriptors.append(descriptor)
                with os.fdopen(os.dup(descriptor), 'wb') as stream:
                    stream.write(data)
                os.lseek(descriptor, 0, os.SEEK_SET)
                os.set_inheritable(descriptor, True)
                mounts.extend(['--perms', '0400', '--ro-bind-data', str(descriptor), target])
            except OSError:
                # Leave unavailable configs untouched. SSH may still reject
                # their unmapped ownership, but unrelated commands can run.
                for descriptor in descriptors[previous_descriptors:]:
                    os.close(descriptor)
                del descriptors[previous_descriptors:]
        return mounts, descriptors
    except Exception:
        for descriptor in descriptors:
            os.close(descriptor)
        raise


def check_hardlinks(protected):
    return check_protected_hardlinks([protected])


def inventory_stamp(info):
    return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns)


def inventory_paths(roots, workers):
    """Split only bounded directory listings; large or small roots still use find."""
    paths, split = [], {}
    for root in sorted(roots):
        try:
            info = os.lstat(root)
        except FileNotFoundError:
            continue
        if workers > 1 and stat.S_ISDIR(info.st_mode):
            try:
                with os.scandir(root) as entries:
                    children = []
                    for entry in entries:
                        children.append(entry.path)
                        if len(children) > INVENTORY_MAX_CHILDREN:
                            break
            except OSError as error:
                raise RuntimeError(INVENTORY_ERROR) from error
            if INVENTORY_MIN_CHILDREN <= len(children) <= INVENTORY_MAX_CHILDREN:
                paths.extend(sorted(children))
                split[root] = inventory_stamp(info)
                continue
        paths.append(root)
    return paths, split


def scan_linked_files(paths, workers):
    """Merge all find streams before deciding whether any link leaves the union."""
    linked, scans = {}, []
    count = min(workers, len(paths))
    with selectors.DefaultSelector() as streams:
        try:
            for index in range(count):
                shard = paths[index::count]
                command = ['/usr/bin/find', '-P', *shard, '-ignore_readdir_race',
                           '-type', 'f', '-links', '+1', '-printf', r'%D %i %n %p\0']
                scan = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
                scans.append(scan)
                streams.register(scan.stdout, selectors.EVENT_READ, scan)
            pending = {}
            while streams.get_map():
                for key, _ in streams.select():
                    chunk = os.read(key.fd, 65536)
                    previous = pending.pop(key.fd, b'')
                    if not chunk:
                        streams.unregister(key.fileobj)
                        if previous or key.data.wait() != 0:
                            raise RuntimeError(INVENTORY_ERROR)
                        continue
                    records = (previous + chunk).split(b'\0')
                    pending[key.fd] = records.pop()
                    for record in records:
                        device, inode, links, candidate = record.split(b' ', 3)
                        identifier = (int(device), int(inode))
                        entry = linked.setdefault(identifier, {'links': 0, 'paths': set()})
                        entry['links'] = max(entry['links'], int(links))
                        entry['paths'].add(candidate)
        finally:
            for scan in scans:
                if scan.poll() is None:
                    scan.kill()
            for scan in scans:
                scan.wait()
                scan.stdout.close()
    return linked


def check_protected_hardlinks(protected_roots):
    """Reject multiply-linked files with names outside the read-only union."""
    roots = set(protected_roots)
    roots = {root for root in roots if not any(
        parent != root and os.path.commonpath([parent, root]) == parent
        for parent in roots)}
    try:
        workers = min(INVENTORY_WORKERS, len(os.sched_getaffinity(0)))
    except (AttributeError, OSError):
        workers = 1
    paths, split = inventory_paths(roots, workers)
    linked = scan_linked_files(paths, workers if split else 1)
    # Splitting uses one directory listing to divide work. If it changed, that
    # inventory cannot certify the files currently reachable from the root.
    try:
        if any(inventory_stamp(os.lstat(root)) != before for root, before in split.items()):
            raise RuntimeError(INVENTORY_ERROR)
    except OSError as error:
        raise RuntimeError(INVENTORY_ERROR) from error
    if any(len(entry['paths']) < entry['links'] for entry in linked.values()):
        raise RuntimeError('harness has hard-linked files with aliases outside protected roots; a maintenance session must replace them with independent copies before guarded execution')


def inventory_ttl():
    raw = os.environ.get('PI_HARDLINK_SCAN_TTL_S')
    if raw is None:
        return INVENTORY_TTL_S
    try:
        return max(0, min(3600, int(raw)))
    except ValueError:
        return INVENTORY_TTL_S


def inventory_key(protected_roots):
    parts = []
    for root in sorted(set(protected_roots)):
        try:
            info = os.lstat(root)
            parts.append('%s:%d:%d' % (root, info.st_dev, info.st_ino))
        except FileNotFoundError:
            parts.append('%s:missing' % root)
    return hashlib.sha256('\0'.join(parts).encode()).hexdigest()


def inventory_marker(protected):
    """<agent>/cache/<marker>, only where that directory sits inside the protected root."""
    cache = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'cache'))
    if not os.path.isdir(cache) or os.path.commonpath([protected, cache]) != protected:
        return None
    return os.path.join(cache, INVENTORY_MARKER)


def inventory_passed(marker, key, ttl):
    try:
        fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                    and not info.st_mode & 0o022 and info.st_size < 4096):
                record = json.loads(stream.read(4096))
                age = time.time() - float(record['at'])
                return record.get('key') == key and 0 <= age < ttl
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        pass
    return False


def lock_inventory(marker):
    path = marker + '.lock'
    fd = None
    try:
        # Guarded payloads cannot open a write-only inode on their read-only
        # mount. A readable file would let them acquire an advisory lock.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o200)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o200):
            raise OSError('untrusted inventory lock')
        fcntl.flock(fd, fcntl.LOCK_EX)
        current = os.stat(path, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise OSError('inventory lock replaced')
        return fd
    except OSError:
        if fd is not None:
            os.close(fd)
        return None


def remember_inventory(marker, key):
    temporary = '%s.%d.tmp' % (marker, os.getpid())
    created = False
    try:
        with open(temporary, 'x', opener=lambda path, flags: os.open(path, flags | os.O_NOFOLLOW, 0o600)) as stream:
            created = True
            json.dump({'key': key, 'at': time.time()}, stream)
        os.replace(temporary, marker)
    except OSError:
        # A read-only or full harness root only costs the next command a scan.
        if created:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def verified_hardlink_inventory(protected, protected_roots):
    """Reuse only a recent pass for the same complete set of protected roots.

    The marker stays inside the read-only tree. A guarded command cannot
    forge it or create a cross-mount hard link while it is valid.
    """
    ttl = inventory_ttl()
    marker = inventory_marker(protected) if ttl else None
    if marker is None:
        check_protected_hardlinks(protected_roots)
        return
    key = inventory_key(protected_roots)
    if inventory_passed(marker, key, ttl):
        return
    fd = lock_inventory(marker)
    try:
        # Another launcher can publish while we wait for its cold scan.
        key = inventory_key(protected_roots)
        if fd is not None and inventory_passed(marker, key, ttl):
            return
        check_protected_hardlinks(protected_roots)
        if inventory_key(protected_roots) != key:
            raise RuntimeError('protected roots changed during hard-link inventory; retry the command')
        if fd is not None:
            remember_inventory(marker, key)
    finally:
        if fd is not None:
            os.close(fd)


def writable_mounts(protected_roots):
    """Keep every protected branch and its ancestors read-only.

    Unlike overlaying independent single-root policies, this union never rebinds
    another protected tree writable. Missing roots retain their existing parent
    boundary, so a command cannot create a new global skill destination there.
    """
    protected = set(protected_roots)
    ancestors = set()
    for root in protected:
        current = os.path.dirname(root)
        while True:
            ancestors.add(current)
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
    mounts = []
    for current in sorted(ancestors, key=lambda item: (item.count('/'), item)):
        if any(os.path.commonpath([root, current]) == root for root in protected):
            continue
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    if entry.path in ancestors or entry.path in protected:
                        continue
                    if entry.path in ('/proc', '/sys', '/dev') or entry.is_symlink():
                        continue
                    mounts.extend(['--bind-try', entry.path, entry.path])
        except FileNotFoundError:
            continue
    return mounts


def main():
    if platform.system() != 'Linux':
        raise RuntimeError('Linux bubblewrap runtime required')
    if not os.access('/usr/bin/bwrap', os.X_OK):
        raise RuntimeError('required executable unavailable: /usr/bin/bwrap; install bubblewrap before running guarded commands')
    if len(sys.argv) < 4:
        raise RuntimeError('invalid guarded command')
    protected = os.path.realpath(sys.argv[1])
    if protected == '/' or not os.path.isdir(protected):
        raise RuntimeError('invalid harness root')
    roots = {protected}
    at = 2
    gpu = False
    ready = False
    mounted_ready = None
    while at < len(sys.argv) and sys.argv[at] in ('--protect', '--gpu', '--ready-pipe', '--mounted-ready'):
        if sys.argv[at] == '--ready-pipe':
            mode = os.fstat(GUARD_READY_FD).st_mode
            if ready or mounted_ready or not (stat.S_ISSOCK(mode) or stat.S_ISFIFO(mode)):
                raise RuntimeError('invalid harness readiness pipe')
            ready = True
            at += 1
            continue
        if sys.argv[at] == '--mounted-ready':
            token = sys.argv[at + 1] if at + 1 < len(sys.argv) else ''
            if ready or mounted_ready or len(token) != 32 or any(c not in '0123456789abcdef' for c in token):
                raise RuntimeError('invalid mounted readiness token')
            mounted_ready = token
            at += 2
            continue
        if sys.argv[at] == '--gpu':
            # Opt-in GPU render nodes for Vulkan/GL compute (Brush, Blender). Not the
            # default: a virtual DRM device changes headless browser rendering.
            gpu = True
            at += 1
            continue
        if at + 1 >= len(sys.argv) or not os.path.isabs(sys.argv[at + 1]):
            raise RuntimeError('invalid protected skill path')
        # Keep link entries AND referents. The trusted parent supplied this
        # launch-scoped list; environment edits in descendants cannot remove it.
        value = os.path.abspath(sys.argv[at + 1])
        if value == '/':
            raise RuntimeError('protected skill path is too broad')
        roots.update([value, os.path.realpath(value)])
        at += 2
    if at >= len(sys.argv) - 1 or sys.argv[at] != '--':
        raise RuntimeError('invalid guarded command')
    # An already-existing alias outside the protected tree would otherwise have
    # the outside path's permissions. Refuse instead of pretending path rules
    # protect inode aliases. This bounded-by-tree scan is intentional; a pass is
    # reused briefly (see verified_hardlink_inventory), never a failure.
    verified_hardlink_inventory(protected, roots)
    os.environ['PI_HARNESS_MUTATION_DENIED'] = '1'
    # A separate PID namespace and fresh procfs prevent /proc/<host-pid>/root
    # aliases to the parent's writable mounts. Capabilities are removed after
    # namespace setup; scripts cannot remount the harness writable.
    # Keep protected ancestors read-only too: renaming an ancestor must not
    # move the host harness. Bind existing sibling subtrees writable so normal
    # project builds retain their filesystem access.
    writable = writable_mounts(roots)
    ssh_mounts, ssh_descriptors = ssh_config_mounts()
    command = sys.argv[at + 1:]
    if mounted_ready:
        # Only this fixed trampoline can write before the user command. It runs
        # after mount setup, then replaces itself with the original argv.
        command = ['/bin/sh', '-c', r'/usr/bin/printf "\036%s\n" "$1" || exit 126; shift; exec "$@"',
                   'yunuspi-mount-ready', mounted_ready, *command]
    arguments = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid',
                 '--ro-bind', '/', '/', *writable,
                 *ssh_mounts,
                 '--proc', '/proc', '--dev', '/dev',
                 *(['--dev-bind-try', '/dev/dri', '/dev/dri'] if gpu else []),
                 '--cap-drop', 'ALL', '--die-with-parent', '--', *command]
    try:
        if ready:
            # Report admission on the private parent pipe after preparing the
            # mounts, before launching bubblewrap. The payload never inherits it.
            os.write(GUARD_READY_FD, b'\x01')
            os.close(GUARD_READY_FD)
        os.execv(arguments[0], arguments)
    finally:
        for descriptor in ssh_descriptors:
            os.close(descriptor)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Harness write isolation refused command: ' + str(error), file=sys.stderr)
        sys.exit(126)

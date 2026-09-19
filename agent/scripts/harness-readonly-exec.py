#!/usr/bin/env python3
"""Apply inherited Linux read-only mount restrictions, then exec without a shell.
No path/command regex is a security boundary. Unavailable namespaces fail closed.
Only executable children are restricted; Pi's own session/log writes are unaffected.
"""
import os
import glob
import platform
import stat
import sys


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


def check_protected_hardlinks(protected_roots):
    """Only aliases outside the union of read-only roots are unsafe.

    Count directory entries once, including explicit file roots. Reject any
    linked inode whose filesystem link count exceeds the protected inventory.
    """
    roots = set(protected_roots)
    roots = {root for root in roots if not any(
        parent != root and os.path.commonpath([parent, root]) == parent
        for parent in roots)}
    linked = {}
    def scan_error(error):
        if not isinstance(error, FileNotFoundError):
            raise error
    def inspect(candidate):
        try:
            info = os.lstat(candidate)
        except FileNotFoundError:
            return
        if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
            key = (info.st_dev, info.st_ino)
            entry = linked.setdefault(key, {'links': info.st_nlink, 'paths': set()})
            entry['links'] = max(entry['links'], info.st_nlink)
            entry['paths'].add(candidate)
    for root in roots:
        inspect(root)
        try:
            if not stat.S_ISDIR(os.lstat(root).st_mode):
                continue
        except FileNotFoundError:
            continue
        for directory, dirs, files in os.walk(root, followlinks=False, onerror=scan_error):
            for name in files:
                inspect(os.path.join(directory, name))
    if any(len(entry['paths']) < entry['links'] for entry in linked.values()):
        raise RuntimeError('harness has hard-linked files with aliases outside protected roots; a maintenance session must replace them with independent copies before guarded execution')


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
    while at < len(sys.argv) and sys.argv[at] == '--protect':
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
    # protect inode aliases. This bounded-by-tree scan is intentional.
    check_protected_hardlinks(roots)
    os.environ['PI_HARNESS_MUTATION_DENIED'] = '1'
    # A separate PID namespace and fresh procfs prevent /proc/<host-pid>/root
    # aliases to the parent's writable mounts. Capabilities are removed after
    # namespace setup; scripts cannot remount the harness writable.
    # Keep protected ancestors read-only too: renaming an ancestor must not
    # move the host harness. Bind existing sibling subtrees writable so normal
    # project builds retain their filesystem access.
    writable = writable_mounts(roots)
    ssh_mounts, ssh_descriptors = ssh_config_mounts()
    arguments = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid',
                 '--ro-bind', '/', '/', *writable,
                 *ssh_mounts,
                 '--proc', '/proc', '--dev', '/dev',
                 '--cap-drop', 'ALL', '--die-with-parent', '--', *sys.argv[at + 1:]]
    try:
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

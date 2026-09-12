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
    def scan_error(error):
        # Runtime lock directories can disappear between scandir calls. Their
        # absence is not an unreadable subtree; permission/I/O errors still fail.
        if not isinstance(error, FileNotFoundError):
            raise error
    for directory, dirs, files in os.walk(protected, followlinks=False, onerror=scan_error):
        for name in files:
            candidate = os.path.join(directory, name)
            try:
                info = os.lstat(candidate)
            except FileNotFoundError:
                continue
            if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                raise RuntimeError('harness has hard-linked files; a maintenance session must replace them with independent copies before guarded execution')


def main():
    if platform.system() != 'Linux':
        raise RuntimeError('Linux bubblewrap runtime required')
    if not os.access('/usr/bin/bwrap', os.X_OK):
        raise RuntimeError('required executable unavailable: /usr/bin/bwrap; install bubblewrap before running guarded commands')
    if len(sys.argv) < 4 or sys.argv[2] != '--':
        raise RuntimeError('invalid guarded command')
    protected = os.path.realpath(sys.argv[1])
    if protected == '/' or not os.path.isdir(protected):
        raise RuntimeError('invalid harness root')
    # An already-existing alias outside the protected tree would otherwise have
    # the outside path's permissions. Refuse instead of pretending path rules
    # protect inode aliases. This bounded-by-tree scan is intentional.
    check_hardlinks(protected)
    os.environ['PI_HARNESS_MUTATION_DENIED'] = '1'
    # A separate PID namespace and fresh procfs prevent /proc/<host-pid>/root
    # aliases to the parent's writable mounts. Capabilities are removed after
    # namespace setup; scripts cannot remount the harness writable.
    # Keep protected ancestors read-only too: renaming an ancestor must not
    # move the host harness. Bind existing sibling subtrees writable so normal
    # project builds retain their filesystem access.
    writable = []
    current = '/'
    for part in protected.strip('/').split('/'):
        branch = os.path.join(current, part)
        with os.scandir(current) as entries:
            for entry in entries:
                if entry.path != branch and entry.path not in ('/proc', '/sys', '/dev') and not entry.is_symlink():
                    # Sibling temp/lock directories can disappear after the
                    # inventory. Missing optional mounts must not fail normal
                    # execution; the protected branch is never optional/writable.
                    writable.extend(['--bind-try', entry.path, entry.path])
        current = branch
    ssh_mounts, ssh_descriptors = ssh_config_mounts()
    arguments = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid',
                 '--ro-bind', '/', '/', *writable,
                 *ssh_mounts,
                 '--proc', '/proc', '--dev-bind', '/dev', '/dev',
                 '--cap-drop', 'ALL', '--die-with-parent', '--', *sys.argv[3:]]
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

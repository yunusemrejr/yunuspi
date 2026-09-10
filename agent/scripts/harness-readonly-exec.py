#!/usr/bin/env python3
"""Apply inherited Linux read-only mount restrictions, then exec without a shell.
No path/command regex is a security boundary. Unavailable namespaces fail closed.
Only executable children are restricted; Pi's own session/log writes are unaffected.
"""
import os
import platform
import stat
import sys


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
                    writable.extend(['--bind', entry.path, entry.path])
        current = branch
    arguments = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid',
                 '--ro-bind', '/', '/', *writable,
                 '--proc', '/proc', '--dev-bind', '/dev', '/dev',
                 '--cap-drop', 'ALL', '--die-with-parent', '--', *sys.argv[3:]]
    os.execv(arguments[0], arguments)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Harness write isolation refused command: ' + str(error), file=sys.stderr)
        sys.exit(126)

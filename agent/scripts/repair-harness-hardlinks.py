#!/usr/bin/env python3
"""Break regular-file inode sharing without following symlinks. Dry-run by default."""
import argparse
import hashlib
import os
import shutil
import stat
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('root')
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
root = os.path.realpath(args.root)
if root == '/' or not os.path.isdir(root):
    parser.error('an existing non-root harness directory is required')
count = total = 0
for directory, dirs, files in os.walk(root, followlinks=False):
    for name in files:
        source = os.path.join(directory, name)
        try:
            info = os.lstat(source)
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink < 2:
            continue
        count += 1
        total += info.st_size
        if not args.apply:
            continue
        # Content and mode stay identical. Replacement is atomic per file;
        # abort if a concurrently changed source no longer matches the snapshot.
        fd, temporary = tempfile.mkstemp(prefix='.hardlink-repair-', dir=directory)
        os.close(fd)
        try:
            def digest(filename):
                with open(filename, 'rb') as stream:
                    return hashlib.file_digest(stream, 'sha256').digest()
            before = digest(source)
            shutil.copy2(source, temporary, follow_symlinks=False)
            after = os.lstat(source)
            if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) or digest(temporary) != before or digest(source) != before:
                raise RuntimeError('source changed during hardlink repair')
            os.replace(temporary, source)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)
print(f'{"Repaired" if args.apply else "Would repair"} {count} hard-linked regular files ({total} bytes); no symlinks followed.')

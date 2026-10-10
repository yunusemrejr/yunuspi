"""Read-only local discovery; runs only inside the existing bounded probe process."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from html.parser import HTMLParser

SCAN_ENTRIES = 5000
SCAN_BYTES = 16 * 1024 * 1024
MESSAGE_BYTES = 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def signature(info):
    return [info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode]


def directory(root, name):
    lexical = Path(os.path.abspath(root / name))
    if not lexical.is_relative_to(root):
        raise ValueError('Path outside workspace')
    real = lexical.resolve(strict=True)
    if not real.is_relative_to(root):
        raise ValueError('Symlink outside workspace')
    fd = os.open(real, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if not Path(os.path.realpath(f'/proc/self/fd/{fd}')).is_relative_to(root):
            raise ValueError('Opened directory outside workspace')
        # scandir(fd) is anchored to the opened directory, including during renames.
        # Keep enumeration bounded before sorting; huge directories are explicit errors.
        with os.scandir(fd) as iterator:
            entries = []
            for entry in iterator:
                if len(entries) >= SCAN_ENTRIES:
                    raise ValueError('Directory exceeds 5000 entries; choose a narrower root')
                entries.append((entry.name, entry.stat(follow_symlinks=False)))
        return real, sorted(entries), signature(os.fstat(fd))
    finally:
        os.close(fd)


def read_bytes(root, name, regular, cap, boundary=None):
    source, real = regular(boundary or root, str(root / name))
    with source:
        before = signature(os.fstat(source.fileno()))
        if before[1] > cap:
            raise ValueError('File exceeds operation byte limit')
        data = source.read(cap + 1)
        if len(data) > cap or signature(os.fstat(source.fileno())) != before:
            raise ValueError('Source changed during inspection; retry')
    return data, str(real.relative_to(root))


def checked_page(items, args, evidence, scope):
    query = {k: v for k, v in args.items() if k not in ('offset', 'limit', 'snapshot')}
    snapshot = sha(json.dumps([query, evidence], sort_keys=True).encode())
    if args.get('offset', 0) and not args.get('snapshot'):
        raise ValueError('Continuation requires snapshot from first page')
    if args.get('snapshot') and args['snapshot'] != snapshot:
        raise ValueError('Stale snapshot; restart from offset 0')
    offset, limit = args.get('offset', 0), args.get('limit', 30)
    if offset > len(items):
        raise ValueError('Offset exceeds result count')
    selected = items[offset:offset + limit]
    more = offset + len(selected) < len(items)
    return dict(items=selected, total=len(items), offset=offset, next_offset=offset + len(selected) if more else None,
                truncated=more, snapshot=snapshot, input_hash=snapshot, scope=scope, cacheable=False)


def workspace_search(root, args, regular):
    base, _, _ = directory(root, args['root'])
    mode = args.get('mode', 'path')
    query = args['query'] if args.get('case_sensitive') else args['query'].casefold()
    stack = [(base, 0)]
    evidence, matches, examined, scanned_bytes = [], [], 0, 0
    omitted = dict(hidden=0, dependency=0, symlink=0, binary=0, oversized=0, unreadable=0, depth=0)
    limited = False
    while stack:
        current, depth = stack.pop()
        try:
            real, entries, info = directory(base, str(current))
        except OSError:
            omitted['unreadable'] += 1
            continue
        evidence.append([str(real.relative_to(root)), info])
        for name, entry_info in entries:
            if examined >= SCAN_ENTRIES:
                limited = True
                break
            examined += 1
            child = real / name
            relative = str(child.relative_to(root))
            evidence.append([relative, signature(entry_info)])
            if stat.S_ISLNK(entry_info.st_mode):
                omitted['symlink'] += 1
                continue
            if not args.get('include_hidden') and name.startswith('.'):
                omitted['hidden'] += 1
                continue
            if stat.S_ISDIR(entry_info.st_mode) and name in ('node_modules', '.git', '.venv', '__pycache__'):
                omitted['dependency'] += 1
                continue
            kind = 'directory' if stat.S_ISDIR(entry_info.st_mode) else 'file' if stat.S_ISREG(entry_info.st_mode) else None
            if kind == 'directory':
                if depth < args.get('max_depth', 12):
                    stack.append((child, depth + 1))
                else:
                    omitted['depth'] += 1
            if not kind or args.get('kind', 'all') not in ('all', kind):
                continue
            if mode == 'path':
                candidate = relative if args.get('case_sensitive') else relative.casefold()
                if query in candidate:
                    matches.append(dict(path=relative, kind=kind, bytes=entry_info.st_size if kind == 'file' else None))
                continue
            if kind != 'file':
                continue
            if entry_info.st_size > MESSAGE_BYTES:
                omitted['oversized'] += 1
                continue
            if scanned_bytes + entry_info.st_size > SCAN_BYTES:
                limited = True
                break
            try:
                data, source_path = read_bytes(root, relative, regular, MESSAGE_BYTES, base)
                scanned_bytes += len(data)
                source_hash = sha(data)
                evidence.append([source_path, source_hash])
                if b'\x00' in data:
                    omitted['binary'] += 1
                    continue
                text = data.decode('utf-8', errors='strict')
            except UnicodeError:
                omitted['binary'] += 1
                continue
            except OSError:
                omitted['unreadable'] += 1
                continue
            for line_number, line in enumerate(text.splitlines(), 1):
                candidate = line if args.get('case_sensitive') else line.casefold()
                at = candidate.find(query)
                if at >= 0:
                    # Casefold offsets are not source offsets (e.g. ß); line provenance remains exact.
                    start = max(0, at - 80) if args.get('case_sensitive') else 0
                    matches.append(dict(path=source_path, kind='file', line=line_number, source_hash=source_hash,
                                        text=line[start:start + 320], snippet_truncated=start > 0 or len(line) > start + 320))
                    if len(matches) >= 1000:
                        limited = True
                        break
            if limited:
                break
        if limited:
            break
    matches.sort(key=lambda item: (item['path'], item.get('line', 0)))
    result = checked_page(matches, args, evidence, dict(root=str(base.relative_to(root)) or '.', mode=mode,
                          entries_examined=examined, bytes_read=scanned_bytes, excluded=omitted))
    result.update(scan_complete=not limited and not any(omitted[k] for k in ('unreadable', 'depth', 'oversized')),
                  limits=dict(entries=SCAN_ENTRIES, bytes=SCAN_BYTES, file_bytes=MESSAGE_BYTES, matches=1000),
                  evidence_note='Literal matches within the reported scope; omitted or unscanned content is not evidence of absence.')
    return result


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'head'):
            self.hidden += 1
        elif tag in ('br', 'p', 'div', 'li', 'tr') and not self.hidden:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'head') and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)

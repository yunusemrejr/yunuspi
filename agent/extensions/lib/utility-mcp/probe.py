"""Stdlib-only SQLite/archive executor. Invoked by the one utility MCP server.

Input/output are bounded JSON; no shell, extraction, project writes or extensions.
The independent alarm survives cancellation of the parent worker thread.
"""
import fnmatch
import importlib.util
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import signal
import sqlite3
import stat
import sys
import tarfile
import tempfile
import time
import zipfile

FILE_CAP = 256 * 1024 * 1024
TEXT_CAP = 16 * 1024
MEMBERS_CAP = 20000
PRAGMAS = {'table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'database_list', 'compile_options', 'page_count', 'page_size', 'freelist_count', 'schema_version', 'user_version', 'encoding'}
TABLE_PRAGMAS = {'table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list'}
FUNCTIONS = set('abs avg char coalesce concat concat_ws count format glob hex if ifnull iif instr length like likelihood likely lower ltrim max min nullif octet_length printf quote replace round rtrim sign soundex sqlite_source_id sqlite_version substr substring sum total trim typeof unicode unhex unlikely upper zeroblob date datetime julianday strftime time timediff unixepoch row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value group_concat string_agg'.split())


def regular(root, filename):
    lexical = Path(os.path.abspath(root / filename))
    if not lexical.is_relative_to(root):
        raise ValueError('Path outside workspace')
    p = lexical.resolve(strict=True)
    if not p.is_relative_to(root):
        raise ValueError('Symlink outside workspace')
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > FILE_CAP:
            raise ValueError('Expected bounded regular file')
        if sys.platform == 'linux' and not Path(os.path.realpath(f'/proc/self/fd/{fd}')).is_relative_to(root):
            raise ValueError('Opened file outside workspace')
        return os.fdopen(fd, 'rb'), p
    except BaseException:
        os.close(fd)
        raise


def page(items, args):
    offset, limit = args.get('offset', 0), args.get('limit', 50)
    return dict(items=items[offset:offset + limit], total=len(items), offset=offset,
                truncated=len(items) > offset + limit,
                next_offset=offset + limit if len(items) > offset + limit else None)


def sqlite_probe(root, args):
    # Snapshot DB + WAL into private temporary storage. Opening mode=ro directly
    # on a workspace WAL DB can still create a -shm file. Never do that here.
    source, p = regular(root, args['path'])
    source.close()
    journal = Path(str(p) + '-journal')
    if journal.exists() and journal.stat().st_size:
        raise ValueError('Rollback journal present; retry after the writer finishes')
    inputs, checks, total_bytes = {}, [], 0
    with tempfile.TemporaryDirectory(prefix='yunuspi-sqlite-') as temp:
        target = Path(temp) / 'snapshot.sqlite'
        for suffix in ('', '-wal'):
            member = Path(str(p) + suffix)
            if not member.exists():
                checks.append((member, None))
                continue
            f, resolved = regular(root, str(member))
            with f, open(str(target) + suffix, 'wb') as out:
                before = os.fstat(f.fileno())
                signature = (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                sha = hashlib.sha256()
                while True:
                    data = f.read(1024 * 1024)
                    if not data:
                        break
                    total_bytes += len(data)
                    if total_bytes > FILE_CAP:
                        raise ValueError('SQLite snapshot byte limit exceeded')
                    sha.update(data)
                    out.write(data)
                checks.append((resolved, signature))
                inputs[suffix or 'database'] = sha.hexdigest()
        for member, expected in checks:
            info = member.stat() if member.exists() else None
            observed = (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) if info else None
            if expected != observed:
                raise ValueError('Database changed during snapshot; retry')
        if journal.exists() and journal.stat().st_size:
            raise ValueError('Writer started during snapshot; retry')
        db = sqlite3.connect(target.as_uri() + '?mode=ro', uri=True, timeout=0.1)
        try:
            db.execute('PRAGMA query_only=ON')
            db.execute('PRAGMA trusted_schema=OFF')
            db.enable_load_extension(False)
            db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 1024 * 1024)
            db.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 32768)
            db.setlimit(sqlite3.SQLITE_LIMIT_COLUMN, 500)
            deadline = time.monotonic() + 3
            db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            volatile = False

            def authorize(action, a, b, _database, _trigger):
                nonlocal volatile
                if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_RECURSIVE):
                    return sqlite3.SQLITE_OK
                if action == sqlite3.SQLITE_FUNCTION:
                    name = (b or a or '').lower()
                    if name in {'date', 'datetime', 'julianday', 'strftime', 'time', 'timediff', 'unixepoch'}:
                        volatile = True  # These can read the clock via "now" or no arguments.
                    return sqlite3.SQLITE_OK if name in FUNCTIONS or re.fullmatch(r'json[b]?_(?:array|array_length|extract|insert|object|patch|pretty|quote|remove|replace|set|type|valid|group_array|group_object|error_position)', name) or name in ('json', 'jsonb') else sqlite3.SQLITE_DENY
                if action == sqlite3.SQLITE_PRAGMA and (a or '').lower() in PRAGMAS:
                    return sqlite3.SQLITE_OK if b is None or a.lower() in TABLE_PRAGMAS else sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_DENY

            db.set_authorizer(authorize)
            action, table = args['action'], args.get('table')
            params = args.get('params', [])
            if action == 'tables':
                sql = "SELECT name,type FROM sqlite_schema WHERE type IN ('table','view') ORDER BY name"
                params = []
            elif action == 'schema':
                sql = 'SELECT type,name,tbl_name,sql FROM sqlite_schema'
                if table:
                    sql += ' WHERE tbl_name=?'
                sql += ' ORDER BY type,name'
                params = [table] if table else []
            elif action == 'describe':
                if not table:
                    raise ValueError('describe requires table')
                literal = "'" + table.replace("'", "''") + "'"
                result = {}
                for key, pragma in [('columns', 'table_xinfo'), ('indexes', 'index_list'), ('foreign_keys', 'foreign_key_list')]:
                    cur = db.execute(f'PRAGMA {pragma}({literal})')
                    names = [c[0] for c in cur.description]
                    rows = cur.fetchmany(201)
                    result[key] = [dict(zip(names, row)) for row in rows[:200]]
                    if len(rows) > 200:
                        result['truncated'] = True
                return dict(result, cacheable=True, input_hash=hashlib.sha256(json.dumps([sqlite3.sqlite_version, inputs, args], sort_keys=True).encode()).hexdigest())
            else:
                sql = args.get('sql', '')
                # Authorizer is authoritative; this gate also excludes EXPLAIN
                # of mutating statements and multi-statement shell dot commands.
                clean = re.sub(r'/\*.*?\*/|--[^\n]*', ' ', sql, flags=re.S).lstrip()
                prefix = re.sub(r'^EXPLAIN\s+(?:QUERY\s+PLAN\s+)?', '', clean, flags=re.I)
                if not re.match(r'^(SELECT|WITH|PRAGMA)\b', prefix, re.I):
                    raise ValueError('Only SELECT, safe PRAGMA and read-only EXPLAIN are allowed')
                if action == 'explain' and not re.match(r'^EXPLAIN\b', clean, re.I):
                    sql = 'EXPLAIN QUERY PLAN ' + sql
            cur = db.execute(sql, params)
            offset, limit = args.get('offset', 0), args.get('limit', 50)
            for _ in range(offset):
                if cur.fetchone() is None:
                    break
            rows = cur.fetchmany(limit + 1)

            def cell(value):
                if value == str(target):
                    return str(p)  # PRAGMA database_list must identify the source, not a random temp path.
                if isinstance(value, bytes):
                    return dict(type='blob', bytes=len(value))
                if isinstance(value, str) and len(value) > 2048:
                    return dict(type='text', text=value[:2048], truncated=True, characters=len(value))
                return value

            return dict(columns=[c[0] for c in cur.description or []], rows=[[cell(v) for v in row] for row in rows[:limit]],
                        offset=offset, truncated=len(rows) > limit, next_offset=offset + limit if len(rows) > limit else None,
                        cacheable=not volatile, input_hash=hashlib.sha256(json.dumps([sqlite3.sqlite_version, inputs, args], sort_keys=True).encode()).hexdigest())
        finally:
            db.close()


def safe_member(name):
    p = PurePosixPath(name)
    return bool(name) and not p.is_absolute() and '..' not in p.parts and '\\' not in name and not re.match(r'^[A-Za-z]:', name) and '\x00' not in name


def archive_probe(root, args):
    source, _ = regular(root, args['path'])
    with source:
        before = os.fstat(source.fileno())
        sha = hashlib.sha256()
        read_bytes = 0
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            read_bytes += len(chunk)
            if read_bytes > FILE_CAP:
                raise ValueError('Archive byte limit exceeded')
            sha.update(chunk)
        source.seek(0)
        rows, matched, names, expanded = [], [], set(), 0
        is_zip = zipfile.is_zipfile(source)
        source.seek(0)
        archive = zipfile.ZipFile(source) if is_zip else tarfile.open(fileobj=source, mode='r:*')
        with archive:
            members = archive.infolist() if is_zip else archive
            for index, member in enumerate(members):
                if index >= MEMBERS_CAP:
                    raise ValueError('Archive member count limit exceeded')
                name = member.filename if is_zip else member.name
                size = member.file_size if is_zip else member.size
                mode = member.external_attr >> 16 if is_zip else member.mode
                directory = member.is_dir() if is_zip else member.isdir()
                link = stat.S_ISLNK(mode) if is_zip else member.issym() or member.islnk()
                regular_member = (not directory and not link and (stat.S_IFMT(mode) in (0, stat.S_IFREG))) if is_zip else member.isfile()
                unsafe = not safe_member(name) or link or not (regular_member or directory)
                expanded += size
                if expanded > 512 * 1024 * 1024:
                    raise ValueError('Archive expanded byte limit exceeded')
                if name in names:
                    raise ValueError('Duplicate archive member names are ambiguous')
                names.add(name)
                row = dict(name=name, size=size, type='link' if link else 'directory' if directory else 'file' if regular_member else 'special', unsafe=unsafe)
                if is_zip:
                    row.update(compressed_size=member.compress_size, encrypted=bool(member.flag_bits & 1))
                rows.append(row)
                if name == args.get('member'):
                    matched.append((member, row))
            action = args['action']
            if action in ('stat', 'read'):
                if len(matched) != 1:
                    raise ValueError('Exact member not found')
                member, row = matched[0]
                if action == 'stat':
                    result = row
                else:
                    if row['unsafe'] or row['type'] != 'file' or row.get('encrypted'):
                        raise ValueError('Unsafe, linked, encrypted or non-file member')
                    if row['size'] > TEXT_CAP:
                        raise ValueError('Text member exceeds 16 KiB limit')
                    with archive.open(member) if is_zip else archive.extractfile(member) as stream:
                        data = stream.read(TEXT_CAP + 1)
                    if len(data) > TEXT_CAP or b'\x00' in data:
                        raise ValueError('Binary or oversized text member')
                    result = dict(row, text=data.decode('utf-8', errors='strict'))
            else:
                if action == 'find':
                    if not args.get('pattern'):
                        raise ValueError('find requires pattern')
                    rows = [r for r in rows if fnmatch.fnmatchcase(r['name'], args['pattern'])]
                result = page(rows, args)
            after = os.fstat(source.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('Archive changed during inspection; retry')
            return dict(result, input_hash=hashlib.sha256(json.dumps([sha.hexdigest(), args], sort_keys=True).encode()).hexdigest())


def main():
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('Utility deadline exceeded')))
    signal.alarm(5)
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (FILE_CAP, FILE_CAP))
    try:
        request = json.loads(sys.stdin.buffer.read(512 * 1024 + 1))
        root = Path(request['root']).resolve(strict=True)
        if request['name'] in ('workspace_search', 'local_mail_search', 'local_mail_read'):
            sys.dont_write_bytecode = True
            spec = importlib.util.spec_from_file_location('yunuspi_local_operations', Path(__file__).with_name('local_operations.py'))
            operations = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(operations)
            result = getattr(operations, request['name'])(root, request['args'], regular)
        else:
            result = {'sqlite_probe': sqlite_probe, 'archive_probe': archive_probe}[request['name']](root, request['args'])
        encoded = json.dumps(result, ensure_ascii=True, allow_nan=False)
        if len(encoded) > 2 * 1024 * 1024:
            raise ValueError('Result byte limit exceeded; narrow request')
        print(encoded)
    except Exception as error:
        # Parser/SQLite exceptions can contain input values. Only our explicit
        # validation messages are emitted; never relay backend exception text.
        message = str(error) if type(error) in (ValueError, TimeoutError) and not isinstance(error, json.JSONDecodeError) else 'Inspection failed (invalid, unsupported, unsafe or over-limit input)'
        if isinstance(error, UnicodeError):
            message = 'Member is not UTF-8 text'
        print(json.dumps({'error': message[:200]}))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Read-only, text-only JSONL structure/overlap audit; no third-party dependencies."""
import argparse
import hashlib
import json
import sys
from collections import Counter

MAX_LINE = 1024 * 1024
MAX_ROWS = 200000


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError('non-finite JSON constant')


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def payload(row):
    if not isinstance(row, dict):
        raise ValueError('row must be an object')
    for key in ('id', 'group_id'):
        if key in row and not nonempty(row[key]):
            raise ValueError(key + ' must be a nonempty string')
    families = [key for key in ('text', 'messages', 'prompt') if key in row]
    if len(families) != 1:
        raise ValueError('choose one text/messages/prompt schema')
    family = families[0]
    if family == 'messages':
        if any(k in row for k in ('completion', 'chosen', 'rejected')):
            raise ValueError('conflicting target fields')
        messages = row['messages']
        if not isinstance(messages, list) or not messages:
            raise ValueError('messages must be a nonempty list')
        for m in messages:
            if not isinstance(m, dict) or m.get('role') not in ('system', 'developer', 'user', 'assistant') or not nonempty(m.get('content')):
                raise ValueError('unsupported or empty text-only message')
            if 'tool_calls' in m or 'tool_call_id' in m:
                raise ValueError('tool traces require a model-specific validator')
        if not any(m['role'] == 'user' for m in messages) or messages[-1]['role'] != 'assistant':
            raise ValueError('chat requires a user turn and final assistant target')
        clean = [{'role': m['role'], 'content': m['content']} for m in messages]
        return {'messages': clean}, {'messages': clean[:-1]}
    if not nonempty(row[family]):
        raise ValueError(family + ' must be nonempty text')
    if family == 'text':
        if any(k in row for k in ('completion', 'chosen', 'rejected')):
            raise ValueError('conflicting target fields')
        return {'text': row['text']}, None
    preference = 'chosen' in row or 'rejected' in row
    if preference:
        if 'completion' in row or not all(nonempty(row.get(k)) for k in ('chosen', 'rejected')):
            raise ValueError('preference requires chosen/rejected and no completion')
        if row['chosen'] == row['rejected']:
            raise ValueError('identical preference alternatives')
        return {k: row[k] for k in ('prompt', 'chosen', 'rejected')}, {'prompt': row['prompt']}
    if not nonempty(row.get('completion')):
        raise ValueError('prompt requires a nonempty completion')
    return {k: row[k] for k in ('prompt', 'completion')}, {'prompt': row['prompt']}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).digest()


def audit(files):
    counts = Counter()
    issues = []
    indexes = {kind: {} for kind in ('example', 'prompt', 'group', 'id')}
    total = 0
    for split, filename in files:
        counts[split + '_rows'] = 0
        with open(filename, 'rb') as source:
            line_number = 0
            while True:
                raw = source.readline(MAX_LINE + 1)
                if not raw:
                    break
                line_number += 1
                total += 1
                if len(raw) > MAX_LINE or total > MAX_ROWS:
                    raise ValueError('resource limit exceeded; shard the corpus')
                counts[split + '_rows'] += 1
                location = {'split': split, 'line': line_number}
                try:
                    row = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object, parse_constant=reject_constant)
                    content, prompt = payload(row)
                    keys = [(kind, digest(value)) for kind, value in (('example', content), ('prompt', prompt), ('group', row.get('group_id')), ('id', row.get('id'))) if value is not None]
                except (ValueError, UnicodeError, RecursionError):
                    counts['invalid_rows'] += 1
                    if len(issues) < 20:
                        issues.append({**location, 'issue': 'invalid JSON or unsupported text schema'})
                    continue
                for kind, key in keys:
                    previous = indexes[kind].get(key)
                    if previous:
                        cross = previous['split'] != split
                        if cross or kind in ('example', 'id'):
                            label = ('cross_split_' if cross else 'within_split_') + kind
                            counts[label] += 1
                            if len(issues) < 20:
                                issues.append({**location, 'issue': label, 'first': previous})
                    else:
                        indexes[kind][key] = location
        if counts[split + '_rows'] == 0:
            counts['empty_splits'] += 1
            if len(issues) < 20:
                issues.append({'split': split, 'issue': 'empty split'})
    errors = counts['empty_splits'] + counts['invalid_rows'] + counts['within_split_id'] + sum(n for k, n in counts.items() if k.startswith('cross_split_'))
    return {'ok': errors == 0, 'counts': dict(counts), 'issues': issues, 'issueSamplesLimitedTo': 20,
            'scope': 'Structural text-only and exact overlaps; not token, semantic, privacy or correctness validation.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for split in ('train', 'validation', 'test'):
        parser.add_argument('--' + split)
    args = parser.parse_args()
    files = [(split, getattr(args, split)) for split in ('train', 'validation', 'test') if getattr(args, split)]
    if not files:
        parser.error('provide at least one explicit split file')
    try:
        result = audit(files)
    except (OSError, ValueError, RecursionError) as error:
        print(json.dumps({'ok': False, 'error': type(error).__name__, 'reason': 'Input unreadable or resource limit exceeded'}))
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())

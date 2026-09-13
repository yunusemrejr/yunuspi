import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DOMParser } from 'linkedom';
import { within, paginate } from './files.mjs';
const exec = promisify(execFile);

export async function coverageProbe(files, args) {
  const sourceRoot = files.resolve(args.source_root ?? '.', true), records = new Map();
  const canonical = name => {
    const p = path.resolve(sourceRoot, name);
    if (!within(files.root, p)) return null;
    return path.relative(files.root, p).replaceAll(path.sep, '/');
  };
  const requested = args.files.map(file => {
    const absolute = path.resolve(files.root, file);
    if (!within(files.root, absolute)) throw Error('Coverage target outside workspace');
    return path.relative(files.root, absolute).replaceAll(path.sep, '/');
  });
  const want = new Set(requested);
  function record(filename) {
    const key = canonical(filename);
    if (!key || !want.has(key)) return null;
    if (!records.has(key)) records.set(key, { lines: new Map(), functions: new Map(), branches: new Map() });
    return records.get(key);
  }
  const hit = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const put = (map, key, value) => {
    const old = map.get(key);
    if (!old || old.hits < value.hits) map.set(key, value);
  };
  for (const artifact of args.artifacts) {
    const text = files.read(artifact);
    if (text.trimStart().startsWith('{')) {
      let data; try { data = JSON.parse(text); } catch { throw Error('Invalid Istanbul JSON'); }
      let entries = 0;
      for (const [filename, coverage] of Object.entries(data)) {
        const r = record(coverage.path ?? filename); if (!r) continue;
        if (!coverage.statementMap || !coverage.s || !coverage.fnMap || !coverage.f || !coverage.branchMap || !coverage.b) throw Error('Expected Istanbul coverage-final data, not a coverage summary');
        for (const [id, loc] of Object.entries(coverage.statementMap)) {
          if (++entries > 200000) throw Error('Coverage entry limit exceeded');
          put(r.lines, loc.start.line, { line: loc.start.line, hits: hit(coverage.s[id]) });
        }
        for (const [id, fn] of Object.entries(coverage.fnMap)) {
          const line = fn.loc?.start.line ?? fn.decl?.start.line;
          put(r.functions, `${line}:${fn.name}`, { name: fn.name, line, end: fn.loc?.end.line ?? line, hits: hit(coverage.f[id]) });
        }
        for (const [id, branch] of Object.entries(coverage.branchMap)) for (const [index, loc] of (branch.locations ?? []).entries()) {
          const line = loc.start?.line ?? branch.line;
          put(r.branches, `${line}:${branch.type}:${id}:${index}`, { line, end: loc.end?.line ?? line, type: branch.type, id, branch: index, hits: hit(coverage.b[id]?.[index]) });
        }
      }
    } else if (text.trimStart().startsWith('<')) {
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw Error('XML document types/entities are not allowed');
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      if (!doc.querySelector('coverage')) throw Error('Expected Cobertura XML');
      const sources = [...doc.querySelectorAll('sources > source')].map(n => n.textContent.trim()).filter(Boolean);
      for (const cls of doc.querySelectorAll('class')) {
        const filename = cls.getAttribute('filename'); if (!filename) continue;
        let r = record(filename);
        if (!r) for (const source of sources) { r = record(path.resolve(sourceRoot, source, filename)); if (r) break; }
        if (!r) continue;
        for (const line of cls.querySelectorAll('lines > line')) {
          // Methods repeat class lines; merge line hits rather than double count.
          const n = Number(line.getAttribute('number')), hits = hit(line.getAttribute('hits'));
          put(r.lines, n, { line: n, hits });
          const conditions = line.getAttribute('condition-coverage')?.match(/\((\d+)\/(\d+)\)/);
          if (conditions) {
            const covered = Number(conditions[1]), total = Number(conditions[2]);
            if (total > 1000) throw Error('Branch count limit exceeded');
            for (let i = 0; i < total; i++) put(r.branches, `${n}:cobertura:${i}`, { line: n, end: n, branch: i, hits: i < covered ? 1 : 0, identity: 'aggregate-only' });
          }
        }
        for (const method of cls.querySelectorAll('method')) {
          const lines = [...method.querySelectorAll('line')];
          const numbers = lines.map(l => Number(l.getAttribute('number')));
          const line = numbers.length ? Math.min(...numbers) : null;
          const name = method.getAttribute('name');
          put(r.functions, `${line}:${name}:${method.getAttribute('signature')}`, { name, line, end: numbers.length ? Math.max(...numbers) : null, hits: lines.some(l => hit(l.getAttribute('hits')) > 0) ? 1 : 0, inferred_from_lines: true });
        }
      }
    } else {
      if (!/^SF:/m.test(text)) throw Error('Expected LCOV, Istanbul or Cobertura artifact');
      let r = null, functionNames = new Map();
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('SF:')) { r = record(line.slice(3)); functionNames = new Map(); continue; }
        if (line === 'end_of_record') { r = null; continue; }
        if (!r) continue;
        let m;
        if ((m = /^DA:(\d+),(\d+)/.exec(line))) put(r.lines, +m[1], { line: +m[1], hits: +m[2] });
        else if ((m = /^FN:(\d+),(?:(\d+),)?(.+)$/.exec(line))) {
          functionNames.set(m[3], +m[1]);
          put(r.functions, `${m[1]}:${m[3]}`, { name: m[3], line: +m[1], end: m[2] ? +m[2] : +m[1], hits: 0, end_known: !!m[2] });
        } else if ((m = /^FNDA:(\d+),(.+)$/.exec(line))) {
          const n = functionNames.get(m[2]);
          const key = `${n}:${m[2]}`, old = r.functions.get(key);
          put(r.functions, key, { ...old, name: m[2], line: n ?? null, end: old?.end ?? n ?? null, hits: +m[1] });
        } else if ((m = /^BRDA:(\d+),([^,]+),([^,]+),(-|\d+)/.exec(line))) put(r.branches, `${m[1]}:${m[2]}:${m[3]}`, { line: +m[1], end: +m[1], block: m[2], branch: m[3], hits: m[4] === '-' ? 0 : +m[4] });
      }
    }
  }
  let changed;
  if (args.changed) changed = await changedLines(files, args, requested);
  const summary = entries => ({ covered: entries.filter(x => x.hits > 0).length, total: entries.length,
    percent: entries.length ? Math.round(entries.filter(x => x.hits > 0).length / entries.length * 10000) / 100 : null });
  const results = requested.map(file => {
    const r = records.get(file), changedSet = changed?.get(file) ?? new Set();
    const lines = [...(r?.lines.values() ?? [])].sort((a, b) => a.line - b.line);
    const functions = [...(r?.functions.values() ?? [])], branches = [...(r?.branches.values() ?? [])];
    const intersects = row => [...changedSet].some(n => n >= row.line && n <= row.end);
    const result = { file, present: !!r, lines: summary(lines), functions: summary(functions), branches: summary(branches),
      uncovered_lines: lines.filter(l => !l.hits).map(l => l.line), uncovered_functions: functions.filter(f => !f.hits), uncovered_branches: branches.filter(b => !b.hits) };
    if (args.changed) result.changed = { added_or_modified_lines: [...changedSet].sort((a, b) => a - b),
      instrumented: summary(lines.filter(l => changedSet.has(l.line))), uncovered_lines: lines.filter(l => changedSet.has(l.line) && !l.hits).map(l => l.line),
      uninstrumented_lines: [...changedSet].filter(n => !r?.lines.has(n)).sort((a, b) => a - b),
      uncovered_functions: functions.filter(f => !f.hits && intersects(f)), uncovered_branches: branches.filter(b => !b.hits && intersects(b)) };
    return result;
  });
  return { ...paginate(results, args), changed: args.changed ?? null,
    evidence: 'Existing artifacts only; freshness relative to current source is unknown. Hits are merged by maximum. Cobertura branch identities and function hits may be aggregate/inferred; LCOV without end lines intersects functions at their entry only.' };
}

async function changedLines(files, args, requested) {
  const git = async argv => (await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...argv], { cwd: files.root, timeout: 2500, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })).stdout;
  const root = (await git(['rev-parse', '--show-toplevel'])).trim();
  let revisions = [];
  if (args.changed === 'staged') revisions = ['--cached'];
  if (args.changed === 'all') {
    try { revisions = [(await git(['rev-parse', '--verify', 'HEAD'])).trim()]; }
    catch { throw Error('changed=all requires a HEAD commit; use staged/working on an unborn repository'); }
  }
  if (args.changed === 'ref') {
    if (!args.base || args.base.startsWith('-')) throw Error('changed=ref requires a Git commit/ref');
    revisions = [(await git(['rev-parse', '--verify', '--end-of-options', args.base + '^{commit}'])).trim()];
  } else if (args.base) throw Error('base is only valid with changed=ref');
  const result = new Map();
  // Per explicit file avoids ambiguous quoted diff filenames, rename inference
  // and unbounded repository discovery. A single request has at most 100 files.
  for (const file of requested) {
    const absolute = path.resolve(files.root, file), repoRelative = path.relative(root, absolute).replaceAll(path.sep, '/');
    const literal = `:(top,literal)${repoRelative}`;
    const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--unified=0', ...revisions, '--', literal]);
    files.inputs.set(`git-diff:${file}`, (await import('./files.mjs')).digest(diff));
    const lines = new Set();
    for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const from = +m[1], count = m[2] === undefined ? 1 : +m[2];
      if (count > 200000) throw Error('Changed line limit exceeded');
      for (let i = from; i < from + count; i++) lines.add(i);
    }
    if (args.changed !== 'staged') {
      const tracked = await git(['ls-files', '--', literal]);
      if (!tracked.trim() && fs.existsSync(absolute)) {
        const text = files.read(absolute), count = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
        if (count > 200000) throw Error('Changed line limit exceeded');
        for (let i = 1; i <= count; i++) lines.add(i);
      }
    }
    result.set(file, lines);
  }
  return result;
}

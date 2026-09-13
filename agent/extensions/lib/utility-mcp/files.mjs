import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';

export const FILE_CAP = 16 * 1024 * 1024;
export const OUTPUT_CAP = 24 * 1024;
export const digest = value => createHash('sha256').update(value).digest('hex');
export const within = (root, file) => file === root || file.startsWith(root + path.sep);
export class Files {
  constructor(root) { this.root = fs.realpathSync(root); this.inputs = new Map(); this.bytes = 0; }
  resolve(file, directory = false) {
    const lexical = path.resolve(this.root, file);
    if (!within(this.root, lexical)) throw Error('Path outside workspace');
    const real = fs.realpathSync(lexical);
    if (!within(this.root, real)) throw Error('Symlink outside workspace');
    const stat = fs.statSync(real);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error('Expected a regular file or directory');
    return real;
  }
  read(file) {
    const real = this.resolve(file);
    const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      // Check the opened descriptor too, closing the common symlink-swap race.
      if (process.platform === 'linux' && !within(this.root, fs.realpathSync(`/proc/self/fd/${fd}`))) throw Error('Opened file outside workspace');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > FILE_CAP || this.bytes + stat.size > 32 * 1024 * 1024) throw Error('Input file byte limit exceeded');
      const data = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < data.length) { const n = fs.readSync(fd, data, length, data.length - length, null); if (!n) break; length += n; }
      if (length > stat.size) throw Error('Input changed while reading');
      const bytes = data.subarray(0, length); this.bytes += length;
      this.inputs.set(path.relative(this.root, real), digest(bytes));
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally { fs.closeSync(fd); }
  }
  document(file) {
    const text = this.read(file);
    try {
      if (file.endsWith('.json') || /^[\s]*[\[{]/.test(text)) return JSON.parse(text);
      const doc = parseDocument(text, { version: '1.2', uniqueKeys: true, strict: true, customTags: [] });
      if (doc.errors.length) throw Error('parse');
      return doc.toJS({ maxAliasCount: 50 });
    } catch { throw Error('Invalid JSON/YAML document (parser details omitted)'); }
  }
  fingerprint(name, args) { return digest(JSON.stringify([1, name, this.root, args, [...this.inputs].sort()])); }
}
export function paginate(items, args) {
  const offset = args.offset ?? 0, limit = args.limit ?? 50;
  return { items: items.slice(offset, offset + limit), total: items.length, offset, truncated: offset + limit < items.length, next_offset: offset + limit < items.length ? offset + limit : null };
}
export function bounded(value) {
  let shortened = false, nodes = 0;
  function walk(v, depth = 0) {
    if (++nodes > 12000 || depth > 25) { shortened = true; return { truncated: true }; }
    if (typeof v === 'string' && v.length > 2048) { shortened = true; return v.slice(0, 2048) + '…[truncated]'; }
    if (Array.isArray(v)) { if (v.length > 200) shortened = true; return v.slice(0, 200).map(x => walk(x, depth + 1)); }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v); if (entries.length > 200) shortened = true;
      return Object.fromEntries(entries.slice(0, 200).map(([k, x]) => [k, walk(x, depth + 1)]));
    }
    return v;
  }
  const result = walk(value);
  if (shortened) result.output_truncated = true;
  let serialized = JSON.stringify(result);
  // Preserve valid, structured JSON. Never return a cut JSON string as evidence.
  while (Buffer.byteLength(serialized) > OUTPUT_CAP) {
    let largest, size = 0;
    function scan(v) {
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v)) {
        const n = JSON.stringify(x)?.length ?? 0;
        if ((Array.isArray(x) && x.length > 1 || typeof x === 'string' && x.length > 100) && n > size) { largest = [v, k]; size = n; }
        if (typeof x === 'object') scan(x);
      }
    }
    scan(result);
    if (!largest) return JSON.stringify({ output_truncated: true, error: 'Result exceeds output limit; narrow the request or paginate' });
    const [parent, key] = largest, x = parent[key];
    parent[key] = Array.isArray(x) ? x.slice(0, Math.ceil(x.length / 2)) : x.slice(0, Math.ceil(x.length / 2)) + '…';
    if (parent === result && (key === 'items' || key === 'rows')) {
      result.truncated = true; result.next_offset = (result.offset ?? 0) + parent[key].length;
    }
    result.output_truncated = true; serialized = JSON.stringify(result);
  }
  return serialized;
}

const OUTPUT_CAP = 24 * 1024;

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

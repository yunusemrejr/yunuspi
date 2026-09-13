import { paginate } from './files.mjs';
import { childPath, payloadShape, schemaShape } from './shapes.mjs';

export function contractDiff(files, args) {
  const inline = Object.hasOwn(args, 'before_value') || Object.hasOwn(args, 'after_value');
  if (inline ? !Object.hasOwn(args, 'before_value') || !Object.hasOwn(args, 'after_value') || args.before || args.after : !args.before || !args.after) throw Error('Provide two files OR before_value and after_value');
  const before = inline ? args.before_value : files.document(args.before), after = inline ? args.after_value : files.document(args.after);
  const shape = args.mode === 'schema' ? schemaShape : payloadShape;
  const left = shape(before), right = shape(after), changes = [], removed = [], added = [];
  function collect(target, row, value) {
    target.push([row, value]);
    for (const [key, child] of Object.entries(value.properties ?? {})) collect(target, { path: childPath(row.path, key) }, child);
    if (value.items && !Array.isArray(value.items)) collect(target, { path: row.path + '/*' }, value.items);
  }
  function visit(a, b, at = '') {
    if (changes.length > 20000) throw Error('Contract change count limit exceeded');
    const types = s => JSON.stringify([s.type ?? null, s.nullable ?? false, s.allows ?? null, s.anyOf ?? null, s.oneOf ?? null, s.allOf ?? null]);
    if (types(a) !== types(b)) changes.push({ kind: 'type_change', path: at || '/', before: a.type ?? a.anyOf ?? a.oneOf ?? a.allOf ?? a.allows, after: b.type ?? b.anyOf ?? b.oneOf ?? b.allOf ?? b.allows, nullable_before: !!a.nullable, nullable_after: !!b.nullable });
    const ap = a.properties ?? {}, bp = b.properties ?? {};
    const ar = new Set(a.required ?? []), br = new Set(b.required ?? []);
    for (const key of [...new Set([...Object.keys(ap), ...Object.keys(bp)])].sort()) {
      const p = childPath(at, key);
      if (!Object.hasOwn(ap, key)) { const row = { kind: 'added_field', path: p, type: bp[key].type ?? 'union', required: br.has(key) }; changes.push(row); collect(added, row, bp[key]); }
      else if (!Object.hasOwn(bp, key)) { const row = { kind: 'removed_field', path: p, type: ap[key].type ?? 'union', required: ar.has(key) }; changes.push(row); collect(removed, row, ap[key]); }
      else {
        if (ar.has(key) !== br.has(key)) changes.push({ kind: 'optionality_change', path: p, required_before: ar.has(key), required_after: br.has(key) });
        visit(ap[key], bp[key], p);
      }
    }
    if (JSON.stringify(a.items ?? a.prefixItems) !== JSON.stringify(b.items ?? b.prefixItems)) {
      changes.push({ kind: 'array_shape_change', path: at || '/', before: a.items ?? a.prefixItems ?? null, after: b.items ?? b.prefixItems ?? null });
      if (a.items && b.items && !Array.isArray(a.items) && !Array.isArray(b.items)) visit(a.items, b.items, at + '/*');
    }
    if (JSON.stringify(a.additionalProperties) !== JSON.stringify(b.additionalProperties)) changes.push({ kind: 'type_change', path: at || '/', field: 'additionalProperties', before: a.additionalProperties ?? 'unspecified', after: b.additionalProperties ?? 'unspecified' });
    if (a.truncated || b.truncated) changes.push({ kind: 'unresolved', path: at || '/', reason: 'Schema depth limit' });
  }
  visit(left, right);
  // Moves are inferred only when the leaf name and full shape match uniquely.
  for (const [r, s] of removed) {
    const matches = added.filter(([a, t]) => a.path.split('/').at(-1) === r.path.split('/').at(-1) && JSON.stringify(s) === JSON.stringify(t));
    if (matches.length === 1 && removed.filter(([q, t]) => q.path.split('/').at(-1) === r.path.split('/').at(-1) && JSON.stringify(s) === JSON.stringify(t)).length === 1) changes.push({ kind: 'nesting_change', from: r.path, to: matches[0][0].path, inferred: true });
  }
  return { mode: args.mode ?? 'payload', ...paginate(changes, args), identical_shape: changes.length === 0,
    optionality_basis: args.mode === 'schema' ? 'Schema required arrays' : 'Observed presence across array objects; a single example cannot prove requiredness' };
}

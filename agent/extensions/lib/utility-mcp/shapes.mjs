const escape = key => key.replaceAll('~', '~0').replaceAll('/', '~1');
export const childPath = (parent, key) => parent + '/' + escape(key);
export function pointer(document, ref) {
  if (!ref.startsWith('#/')) throw Error('Expected internal JSON pointer');
  let at = document;
  for (const token of ref.slice(2).split('/')) {
    const key = decodeURIComponent(token).replaceAll('~1', '/').replaceAll('~0', '~');
    if (!at || typeof at !== 'object' || !Object.hasOwn(at, key)) throw Error('Internal reference not found');
    at = at[key];
  }
  return at;
}
export function schemaShape(schema, document = schema, seen = new Set(), depth = 0) {
  if (depth > 16) return { truncated: true };
  if (typeof schema === 'boolean') return { allows: schema };
  if (!schema || typeof schema !== 'object') return { type: 'unknown' };
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) return { $ref: schema.$ref, external: true };
    if (seen.has(schema.$ref)) return { $ref: schema.$ref, recursive: true };
    const next = new Set(seen); next.add(schema.$ref);
    const { $ref, ...siblings } = schema;
    const resolved = schemaShape({ ...pointer(document, $ref), ...siblings }, document, next, depth + 1);
    return { ...resolved, $ref };
  }
  const result = {};
  result.type = schema.type ?? (schema.properties ? 'object' : schema.items || schema.prefixItems ? 'array' : 'unknown');
  if (Array.isArray(result.type)) result.type = [...result.type].sort();
  for (const key of ['nullable', 'required', 'readOnly', 'writeOnly', 'additionalProperties']) {
    if (schema[key] !== undefined) result[key] = key === 'additionalProperties' && typeof schema[key] === 'object' ? schemaShape(schema[key], document, seen, depth + 1) : key === 'required' ? [...schema[key]].sort() : schema[key];
  }
  if (schema.enum) result.enum_types = [...new Set(schema.enum.map(v => v === null ? 'null' : typeof v))].sort();
  if (schema.properties) result.properties = Object.fromEntries(Object.keys(schema.properties).sort().map(key => [key, schemaShape(schema.properties[key], document, seen, depth + 1)]));
  if (schema.items !== undefined) result.items = Array.isArray(schema.items) ? schema.items.map(s => schemaShape(s, document, seen, depth + 1)) : schemaShape(schema.items, document, seen, depth + 1);
  for (const key of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) if (schema[key]) {
    result[key] = schema[key].map(s => schemaShape(s, document, seen, depth + 1));
    if (key !== 'prefixItems') result[key].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
export function payloadShape(value, depth = 0, budget = { nodes: 0 }) {
  if (depth > 24 || ++budget.nodes > 30000) throw Error('Contract shape complexity limit exceeded');
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    if (!value.length) return { type: 'array', items: { type: 'unknown' } };
    const variants = [...new Map(value.map(v => { const s = payloadShape(v, depth + 1, budget); return [JSON.stringify(s), s]; })).values()];
    if (variants.every(s => s.type === 'object')) {
      const keys = [...new Set(variants.flatMap(s => Object.keys(s.properties)))].sort();
      const properties = Object.fromEntries(keys.map(key => {
        const shapes = [...new Map(variants.filter(s => s.properties[key]).map(s => [JSON.stringify(s.properties[key]), s.properties[key]])).values()];
        return [key, shapes.length === 1 ? shapes[0] : { anyOf: shapes }];
      }));
      return { type: 'array', items: { type: 'object', properties, required: keys.filter(k => variants.every(s => s.properties[k])) } };
    }
    return { type: 'array', items: variants.length === 1 ? variants[0] : { anyOf: variants.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } };
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return { type: 'object', properties: Object.fromEntries(keys.map(k => [k, payloadShape(value[k], depth + 1, budget)])), required: keys };
  }
  return { type: typeof value };
}

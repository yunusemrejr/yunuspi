// Shared by the MCP server and the automatically loaded harness extension.
export const UTILITY_CONCURRENCY = 2;
const str = (description) => ({ type: 'string', minLength: 1, maxLength: 4096, description });
const choice = (...values) => ({ type: 'string', enum: values });
const paths = { type: 'array', minItems: 1, maxItems: 100, items: str('Explicit workspace-relative file path; no globs or directory walks.') };
const page = { limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0, maximum: 100000 } };
function tool(name, description, properties, required) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
}
export const TOOLS = [
  tool('workspace_search', 'Find files/folders by literal path or bounded UTF-8 content matches under one explicit workspace directory. No shell, regex, symlink following or global index. Default excludes hidden/dependency directories; reports scan limits and exact source lines/hashes. Follow snapshot + next_offset; incomplete scans cannot prove absence.',
    { root: str('Explicit directory inside workspace; use . only when whole-workspace discovery is intended'), query: { type: 'string', minLength: 2, maxLength: 256 }, mode: choice('path', 'content'), kind: choice('all', 'file', 'directory'), case_sensitive: { type: 'boolean' }, include_hidden: { type: 'boolean' }, max_depth: { type: 'integer', minimum: 0, maximum: 20 }, snapshot: { type: 'string', minLength: 64, maxLength: 64 }, ...page }, ['root', 'query']),
  tool('sqlite_probe', 'Inspect a workspace-local SQLite DB: tables, schema, describe, query or explain. Use instead of sqlite3/Python snippets. SELECT, allowlisted read PRAGMAs and EXPLAIN only; no writes, ATTACH or extensions. 200 rows, 5 seconds, bounded cells/output.',
    { path: str('SQLite file'), action: choice('tables', 'schema', 'describe', 'query', 'explain'), table: str('Table/view name for describe or schema'), sql: { type: 'string', maxLength: 32768 }, params: { type: 'array', maxItems: 100, items: { type: ['string', 'number', 'null', 'boolean'] } }, ...page }, ['path', 'action']),
];

export function validate(name, args) {
  const spec = TOOLS.find(t => t.name === name)?.inputSchema;
  if (!spec || !args || typeof args !== 'object' || Array.isArray(args)) throw Error('Invalid tool or arguments');
  for (const key of spec.required) if (!(key in args)) throw Error(`Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(spec.properties, key)) throw Error('Unknown argument');
    check(spec.properties[key], value);
  }
  return args;
}
function check(s, v) {
  if (s.enum && !s.enum.includes(v)) throw Error('Unsupported action or option');
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some(t => t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'integer' ? Number.isSafeInteger(v) : typeof v === t && (t !== 'number' || Number.isFinite(v)))) throw Error('Invalid argument type');
  }
  if (typeof v === 'string' && (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? 65536) || v.includes('\0'))) throw Error('Invalid string argument');
  if (typeof v === 'number' && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) throw Error('Argument outside limits');
  if (Array.isArray(v)) {
    if (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? 200)) throw Error('Array outside limits');
    v.forEach(x => check(s.items ?? {}, x));
  }
}

// Shared by the MCP server and the automatically loaded harness extension.
const str = (description) => ({ type: 'string', minLength: 1, maxLength: 4096, description });
const choice = (...values) => ({ type: 'string', enum: values });
const paths = { type: 'array', minItems: 1, maxItems: 100, items: str('Explicit workspace-relative file path; no globs or directory walks.') };
const page = { limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0, maximum: 100000 } };
function tool(name, description, properties, required) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: name === 'net_probe' } };
}
export const TOOLS = [
  tool('sqlite_probe', 'Inspect a workspace-local SQLite DB: tables, schema, describe, query or explain. Use instead of sqlite3/Python snippets. SELECT, allowlisted read PRAGMAs and EXPLAIN only; no writes, ATTACH or extensions. 200 rows, 5 seconds, bounded cells/output.',
    { path: str('SQLite file'), action: choice('tables', 'schema', 'describe', 'query', 'explain'), table: str('Table/view name for describe or schema'), sql: { type: 'string', maxLength: 32768 }, params: { type: 'array', maxItems: 100, items: { type: ['string', 'number', 'null', 'boolean'] } }, ...page }, ['path', 'action']),
  tool('package_probe', 'Inspect the physically installed Node package, nearest project declaration and npm/pnpm/Yarn lock resolution. Returns version, location, exports, types, binaries, peers, scripts and direct/transitive status. Never installs, imports package code or contacts a registry.',
    { package: str('npm package name, including optional @scope; no version selector'), project: str('Explicit project directory within workspace; default .') }, ['package']),
  tool('openapi_probe', 'Inspect JSON/YAML OpenAPI 3.x or Swagger 2 without loading the whole spec into context. Internal refs resolve with depth/cycle caps; external refs are reported, never fetched. Use request_shape/response_shape for compact structural schemas.',
    { path: str('Spec file'), action: choice('list_endpoints', 'operation', 'schema', 'request_shape', 'response_shape', 'auth'), endpoint: str('Exact endpoint, e.g. /users/{id}'), method: choice('get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'), operation_id: str('Operation ID instead of endpoint/method'), name: str('Schema component name or internal JSON pointer'), status: str('Response status code, e.g. 200 or default'), ...page }, ['path', 'action']),
  tool('coverage_probe', 'Read existing LCOV, Istanbul coverage-final JSON or Cobertura XML artifacts. Returns file coverage and uncovered lines/functions/branches; optionally intersects Git added/modified lines. Does not run tests. Missing instrumentation is unknown, not covered. Use explicit files and artifacts.',
    { artifacts: paths, files: paths, changed: choice('working', 'staged', 'all', 'ref'), base: str('Git ref for changed=ref; compares ref to working tree'), source_root: str('Coverage filename base directory within workspace; default .'), ...page }, ['artifacts', 'files']),
  tool('contract_diff', 'Compare two explicit JSON/YAML files or two inline JSON payloads structurally. Reports added/removed fields, type, optionality, array-shape and nesting changes, never scalar values. mode=schema compares JSON Schema/OpenAPI schema properties and required lists; default payload infers observed shapes.',
    { before: str('Before file'), after: str('After file'), before_value: {}, after_value: {}, mode: choice('payload', 'schema'), ...page }, []),
  tool('env_audit', 'Extract environment-variable NAMES from explicit source files and example/Compose/deployment configs. Returns required-but-undocumented, documented-but-unused and referenced-across-files. Never reads process environment or returns values/source snippets; dynamic accesses are reported as unresolved. No crawling or env_file following.',
    { sources: paths, configs: paths, ...page }, ['sources', 'configs']),
  tool('net_probe', 'Bounded diagnostics for one explicit host: dns records, one tcp host:port connection and latency, or tls certificate subject/SAN/issuer/expiry/chain validation errors. No scanning, port ranges or application payloads. Network evidence is live and is never cached.',
    { action: choice('dns', 'tcp', 'tls'), host: str('One hostname or IP; no URL/CIDR/wildcards'), port: { type: 'integer', minimum: 1, maximum: 65535 }, record_type: choice('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'SRV', 'CAA'), servername: str('Optional TLS SNI hostname') }, ['action', 'host']),
  tool('archive_probe', 'Inspect ZIP/TAR (including gzip/bzip2/xz TAR) without extraction: list, stat, find or read one bounded UTF-8 text member. Links, traversal members, encrypted files and binary reads are rejected. Archive/member/decompression/time/output limits apply.',
    { path: str('Archive file'), action: choice('list', 'stat', 'find', 'read'), member: str('Exact member name for stat/read'), pattern: str('Member-name glob for find; no filesystem traversal'), ...page }, ['path', 'action']),
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

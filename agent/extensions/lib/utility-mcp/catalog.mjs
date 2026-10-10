// Shared by the MCP server and the automatically loaded harness extension.
export const UTILITY_CONCURRENCY = 2;
const str = (description) => ({ type: 'string', minLength: 1, maxLength: 4096, description });
const choice = (...values) => ({ type: 'string', enum: values });
const paths = { type: 'array', minItems: 1, maxItems: 100, items: str('Explicit workspace-relative file path; no globs or directory walks.') };
const page = { limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0, maximum: 100000 } };
function tool(name, description, properties, required) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: name === 'net_probe' } };
}
export const TOOLS = [
  tool('workspace_search', 'Find files/folders by literal path or bounded UTF-8 content matches under one explicit workspace directory. No shell, regex, symlink following or global index. Default excludes hidden/dependency directories; reports scan limits and exact source lines/hashes. Follow snapshot + next_offset; incomplete scans cannot prove absence.',
    { root: str('Explicit directory inside workspace; use . only when whole-workspace discovery is intended'), query: { type: 'string', minLength: 2, maxLength: 256 }, mode: choice('path', 'content'), kind: choice('all', 'file', 'directory'), case_sensitive: { type: 'boolean' }, include_hidden: { type: 'boolean' }, max_depth: { type: 'integer', minimum: 0, maximum: 20 }, snapshot: { type: 'string', minLength: 64, maxLength: 64 }, ...page }, ['root', 'query']),
  tool('ssh_plan', 'Produce an explicit-target SSH argv plan without executing SSH, reading configuration/credentials or connecting. Disables config files, proxies, local commands, forwarding and interactive authentication; requires an already trusted host key. Does not prove credentials or connectivity work. Existing authorized shell policy owns execution.',
    { host: str('One literal hostname or IP, never an SSH configuration alias'), user: { type: 'string', minLength: 1, maxLength: 64 }, port: { type: 'integer', minimum: 1, maximum: 65535 } }, ['host', 'user', 'port']),
  tool('web_asset_check', 'Check local asset references in explicit HTML, CSS and web manifest files. Reports present/missing/case mismatches with source lines; external and dynamic references remain unverified. No crawling, network or JavaScript execution. Query values omitted. Explicit asset root and public URL prefix support hosted subpaths.',
    { files: { ...paths, maxItems: 30 }, asset_root: str('Directory mapped to public_path, within workspace; default .'), public_path: str('Literal URL prefix beginning and ending with /; default /, e.g. /app/'), ...page }, ['files']),
  tool('sqlite_probe', 'Inspect a workspace-local SQLite DB: tables, schema, describe, query or explain. Use instead of sqlite3/Python snippets. SELECT, allowlisted read PRAGMAs and EXPLAIN only; no writes, ATTACH or extensions. 200 rows, 5 seconds, bounded cells/output.',
    { path: str('SQLite file'), action: choice('tables', 'schema', 'describe', 'query', 'explain'), table: str('Table/view name for describe or schema'), sql: { type: 'string', maxLength: 32768 }, params: { type: 'array', maxItems: 100, items: { type: ['string', 'number', 'null', 'boolean'] } }, ...page }, ['path', 'action']),
  tool('package_probe', 'Inspect the physically installed Node package, nearest project declaration and npm/pnpm/Yarn lock resolution. Returns version, location, exports, types, binaries, peers, scripts and direct/transitive status. Never installs, imports package code or contacts a registry.',
    { package: str('npm package name, including optional @scope; no version selector'), project: str('Explicit project directory within workspace; default .') }, ['package']),
  tool('net_probe', 'Diagnose one explicit endpoint in one call: ordered DNS/TCP/TLS/HTTP phase evidence, failing layer and safe next checks. diagnose uses one resolved address and one connection; protocol defaults to tcp. http/https require an explicit public path and send only a fixed HEAD request, no credentials, body or redirects; untrusted TLS stops before HTTP. Existing dns/tcp/tls/ssh actions remain available. No scanning or config access; metadata/link-local/multicast targets blocked; live results never cached.',
    { action: choice('dns', 'tcp', 'tls', 'ssh', 'diagnose'), host: str('One explicitly authorized hostname or IP; no URL/CIDR/wildcards'), port: { type: 'integer', minimum: 1, maximum: 65535 }, record_type: choice('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'SRV', 'CAA'), servername: str('Optional TLS SNI hostname'), protocol: choice('tcp', 'tls', 'http', 'https'), path: { type: 'string', minLength: 1, maxLength: 512, description: 'Explicit public HTTP pathname beginning /; no query, fragment, encoded characters or credentials. Required for http/https.' }, timeout_ms: { type: 'integer', minimum: 100, maximum: 4500 } }, ['action', 'host']),
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

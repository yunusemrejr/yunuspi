import { paginate } from './files.mjs';
import { pointer, schemaShape } from './shapes.mjs';
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export function openapiProbe(files, args) {
  const doc = files.document(args.path);
  if (!doc || !(/^(3\.)/.test(doc.openapi ?? '') || doc.swagger === '2.0')) throw Error('Expected OpenAPI 3.x or Swagger 2.0');
  const deref = value => {
    const seen = new Set();
    while (value?.$ref) {
      if (!value.$ref.startsWith('#/')) return { $ref: value.$ref, external: true };
      if (seen.has(value.$ref) || seen.size > 16) throw Error('Reference cycle or depth limit');
      seen.add(value.$ref); value = pointer(doc, value.$ref);
    }
    return value;
  };
  if (args.action === 'schema') {
    if (!args.name) {
      return paginate(Object.keys(doc.components?.schemas ?? doc.definitions ?? {}).sort(), args);
    }
    const schema = args.name.startsWith('#/') ? pointer(doc, args.name) : (doc.components?.schemas ?? doc.definitions ?? {})[args.name];
    if (schema === undefined) throw Error('Schema not found');
    return { name: args.name, shape: schemaShape(schema, doc) };
  }
  const operations = [];
  for (const endpoint of Object.keys(doc.paths ?? {}).sort()) {
    const item = deref(doc.paths[endpoint]);
    if (item?.external) { operations.push({ endpoint, external_ref: item.$ref }); continue; }
    for (const method of Object.keys(item ?? {}).sort()) if (methods.has(method)) operations.push({ endpoint, method, operation_id: item[method].operationId ?? null, summary: item[method].summary ?? null });
  }
  if (args.action === 'list_endpoints') return paginate(operations, args);
  const matches = operations.filter(o => args.operation_id ? o.operation_id === args.operation_id : o.endpoint === args.endpoint && o.method === args.method);
  const globalAuth = args.action === 'auth' && !args.operation_id && !args.endpoint && !args.method;
  if (!globalAuth && matches.length !== 1) throw Error('Specify one unique operation_id or exact endpoint and method');
  const selected = matches[0];
  const item = selected ? deref(doc.paths[selected.endpoint]) : {};
  const op = selected ? item[selected.method] : {};
  if (args.action === 'auth') {
    const requirements = op.security ?? doc.security ?? [];
    const schemes = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {};
    return { requirements, schemes: Object.fromEntries([...new Set(requirements.flatMap(r => Object.keys(r)))].sort().map(key => [key, deref(schemes[key]) ?? { missing: true }])), anonymous_allowed: !requirements.length || requirements.some(r => !Object.keys(r).length) };
  }
  const params = new Map();
  for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
    const p = deref(raw);
    params.set(p.external ? p.$ref : `${p.in}:${p.name}`, p.external ? p : { name: p.name, in: p.in, required: !!p.required || p.in === 'path', shape: schemaShape(p.schema ?? p, doc) });
  }
  const contentShapes = content => Object.fromEntries(Object.entries(content ?? {}).map(([mime, media]) => [mime, schemaShape(media.schema ?? {}, doc)]));
  const body = deref(op.requestBody);
  const request = { parameters: [...params.values()], body: body ? body.external ? body : { required: !!body.required, content: contentShapes(body.content) } : null, consumes: op.consumes ?? doc.consumes ?? null };
  if (args.action === 'request_shape') return { ...selected, ...request };
  const responses = {};
  for (const code of Object.keys(op.responses ?? {}).sort()) {
    if (args.status && code !== args.status) continue;
    const response = deref(op.responses[code]);
    responses[code] = response.external ? response : { content: response.content ? contentShapes(response.content) : response.schema ? Object.fromEntries((op.produces ?? doc.produces ?? ['application/json']).map(m => [m, schemaShape(response.schema, doc)])) : {},
      headers: Object.fromEntries(Object.entries(response.headers ?? {}).map(([key, value]) => { const header = deref(value); return [key, header.external ? header : schemaShape(header.schema ?? header, doc)]; })) };
  }
  if (args.status && !Object.hasOwn(responses, args.status)) throw Error('Response status not found');
  if (args.action === 'response_shape') return { ...selected, responses };
  return { ...selected, tags: op.tags ?? [], deprecated: !!op.deprecated, request, responses, security: op.security ?? doc.security ?? [], servers: op.servers ?? item.servers ?? doc.servers ?? null };
}

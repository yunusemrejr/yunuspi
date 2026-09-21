import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compat = await import(pathToFileURL(path.join(root, 'core/ai/src/utils/request-compat.js')));
const { projectWireSchema, checkToolWire, getBackendProfile, listBackendProfiles, registerBackendProfile, unregisterBackendProfile } = compat;

// Representative built-in child-tool schemas: constrained strings, unions,
// nested objects, arrays — the shapes that break strict backends.
const TOOL_FIXTURES = [
  { name: 'read_file', schema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', maximum: 2000 } }, required: ['path'], additionalProperties: false } },
  { name: 'search', schema: { type: 'object', properties: { pattern: { type: 'string', minLength: 1 }, mode: { anyOf: [{ type: 'string', enum: ['regex', 'literal'] }, { type: 'null' }] } }, required: ['pattern'] } },
  { name: 'bash', schema: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'number' }, cwd: { type: 'string', pattern: '^/' } }, required: ['command'] } },
  { name: 'write_file', schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', maxLength: 1000000 } }, required: ['path', 'content'] } },
  { name: 'web_fetch', schema: { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] } },
  { name: 'query_data', schema: { type: 'object', properties: { sql: { type: 'string' }, params: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'object' }] } }, required: ['sql'] } },
];

test('canonical schemas are never mutated by projection', () => {
  const before = JSON.stringify(TOOL_FIXTURES);
  for (const backend of ['openrouter', 'orcarouter', 'friendli', 'deepseek', 'together', 'openai-compatible']) {
    checkToolWire(TOOL_FIXTURES, backend);
    checkToolWire(TOOL_FIXTURES, backend, { strict: true });
  }
  assert.equal(JSON.stringify(TOOL_FIXTURES), before, 'projection must not mutate canonical schemas');
});

test('lenient backends keep canonical schemas verbatim', () => {
  for (const backend of ['openrouter', 'orcarouter', 'together', 'openai-compatible']) {
    const report = checkToolWire(TOOL_FIXTURES, backend);
    assert.equal(report.ok, true, backend);
    assert.deepEqual(report.incompatible, []);
    for (const result of report.results) assert.deepEqual(result.dropped, [], `${backend}/${result.tool}`);
  }
});

test('flatten backends project unions and report every drop', () => {
  for (const backend of ['friendli', 'deepseek']) {
    const report = checkToolWire(TOOL_FIXTURES, backend);
    assert.equal(report.ok, true, backend);
    const search = report.results.find((r) => r.tool === 'search');
    assert.ok(search.dropped.some((d) => d.includes('union-flattened')), `${backend} flattens search union`);
    assert.ok(search.schema && typeof search.schema === 'object', 'projected schema returned');
  }
});

test('strict mode drops strict keywords and imposes closed objects', () => {
  const report = checkToolWire(TOOL_FIXTURES, 'openrouter', { strict: true });
  assert.equal(report.ok, true);
  const read = report.results.find((r) => r.tool === 'read_file');
  assert.ok(read.dropped.some((d) => d.endsWith('minLength')), 'minLength projected out');
  const search = report.results.find((r) => r.tool === 'search');
  assert.ok(search.dropped.some((d) => d.includes('additionalProperties')), 'closed object imposed');
  const bash = report.results.find((r) => r.tool === 'bash');
  assert.ok(bash.dropped.some((d) => d.endsWith('pattern')), 'pattern projected out');
});

test('reject-union backends fail closed before any inference spend', () => {
  registerBackendProfile({ id: 'strict-test-backend', unions: 'reject' });
  try {
    const report = checkToolWire(TOOL_FIXTURES, 'strict-test-backend');
    assert.equal(report.ok, false);
    assert.ok(report.incompatible.some((i) => i.tool === 'search' && i.reason.includes('union')));
    assert.ok(report.incompatible.every((i) => i.field && i.field.length > 0), 'every incompatibility names its field');
  } finally {
    unregisterBackendProfile('strict-test-backend');
  }
});

test('unknown backends fail closed to strict-flatten, never permissive', () => {
  const profile = getBackendProfile('no-such-backend-xyz');
  assert.equal(profile.provenance, 'unknown-fallback');
  const report = checkToolWire(TOOL_FIXTURES, 'no-such-backend-xyz');
  assert.equal(report.ok, true, 'flatten still projects');
  assert.ok(report.results.some((r) => r.dropped.length > 0), 'conservative projection drops keywords');
});

test('backend profiles carry provenance; overrides win', () => {
  const ids = listBackendProfiles().map((p) => p.id);
  for (const id of ['openrouter', 'orcarouter', 'friendli', 'deepseek', 'together']) assert.ok(ids.includes(id), id);
  assert.equal(getBackendProfile('deepseek').provenance, 'curated');
  registerBackendProfile({ id: 'deepseek', unions: 'allow' });
  try {
    assert.equal(getBackendProfile('deepseek').provenance, 'override');
    const report = checkToolWire(TOOL_FIXTURES, 'deepseek');
    assert.ok(report.results.every((r) => r.dropped.length === 0), 'override allows unions');
  } finally {
    unregisterBackendProfile('deepseek');
  }
  assert.equal(getBackendProfile('deepseek').provenance, 'curated');
});

test('extension adapter delegates to the canonical core service', async () => {
  const adapter = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/request-compat.ts')));
  assert.ok(adapter.requestCompatSource().length > 0);
  const report = adapter.checkToolWire(TOOL_FIXTURES.slice(0, 2), 'deepseek');
  assert.equal(report.ok, true);
  assert.ok(report.results.some((r) => r.dropped.length > 0));
});

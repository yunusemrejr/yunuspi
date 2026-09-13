import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'extensions/lib/session-report.ts')));
const { buildSessionReport, collectContextTraffic } = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-report.ts')));
const { collectSessionDiagnostics, failureCategory } = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-diagnostics.ts')));
const { createToolJsonCompactor } = await import(pathToFileURL(path.join(agent, 'extensions/lib/compact-tool-json.ts')));
const { makeCapsule, addCompactionSalience } = await import(pathToFileURL(path.join(agent, 'extensions/pi-memory/context-salience.ts')));
const message = (role, data) => ({ type: 'message', message: { role, ...data } });
const failure = id => message('toolResult', { toolName: 'web_search', toolCallId: id, isError: true, content: [{ type: 'text', text: '429 capacity unavailable' }] });

test('failure totals and groups survive the bounded excerpt limit and replay', () => {
  assert.equal(failureCategory('Blocked: budget exceeded').category, 'budget');
  assert.equal(failureCategory('Blocked: invalid argument').category, 'input');
  assert.equal(failureCategory('Blocked: read the required skill first').category, 'guard');
  const entries = Array.from({ length: 20 }, (_, id) => failure(String(id)));
  const report = collectSessionDiagnostics([...entries, entries[0]], { excerpts: false });
  assert.equal(report.count, 12); assert.equal(report.total, 20); assert.equal(report.omitted, 8);
  assert.equal(report.groups[0].count, 20); assert.equal(report.groups[0].category, 'capacity');
  assert.ok(report.failures.every(row => !('error' in row)));
  assert.equal(collectSessionDiagnostics(Array.from({ length: 2200 }, (_, id) => failure(String(id)))).total, 2000);
  const diverse = entries.map((entry, index) => ({ ...entry, message: { ...entry.message, toolName: `tool_${index}` } }));
  const bounded = collectSessionDiagnostics(diverse);
  assert.equal(bounded.total, 20); assert.equal(bounded.groups.length, 16); assert.equal(bounded.omittedGroups, 4);
});

test('panel separates current branch evidence from cumulative totals and sanitizes terminal controls', () => {
  const report = buildSessionReport([failure('old'), failure('new')], [failure('new')], undefined, ['project_report']);
  assert.equal(report.diagnostics.total, 1);
  assert.ok(report.lines.some(line => line.includes('2 tool + 0 model')));
  assert.ok(report.lines.some(line => line.includes('active project_report')));
  const injected = failure('escape'); injected.message.content[0].text = '\x1b[2J\x07 failure';
  assert.ok(buildSessionReport([injected], [injected]).lines.every(line => !/[\x00-\x1f\x7f-\x9f]/.test(line)));
  assert.ok(buildSessionReport([], []).lines.some(line => line.includes('not a pass')));
});

test('late generic child failure receipts retain category and attempts from the compact ledger', () => {
  const entries = [
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'child', results: [{ index: 0, exitCode: 1, error: 'child-error', evidence: { version: 1, outcomeReason: 'invalid-output', attemptCount: 2, output: 'absent' } }] } },
    { type: 'custom', customType: 'subagent-lifecycle-v1', data: { runId: 'child', mode: 'single', results: [{ index: 0, status: 'failed' }] } },
  ];
  const report = collectSessionDiagnostics(entries);
  assert.equal(report.total, 1); assert.equal(report.failures[0].category, 'output');
  assert.equal(report.failures[0].attempts, 2); assert.equal(report.failures[0].outputPresence, 'absent');
  assert.ok(buildSessionReport(entries, entries).lines.some(line => line.includes('2 attempts · output absent')));
});

test('repetition needs exact complete request and result and excludes replayed receipts', () => {
  const pair = (id, value = 'x'.repeat(600), arguments_ = { path: 'source.ts' }) => [
    message('assistant', { content: [{ type: 'toolCall', id, name: 'read', arguments: arguments_ }] }),
    message('toolResult', { toolName: 'read', toolCallId: id, content: [{ type: 'text', text: value }] }),
  ];
  const rows = [...pair('1'), ...pair('2'), ...pair('3', 'x'.repeat(600), { path: 'other.ts' }), ...pair('4', 'y'.repeat(600))];
  const repeated = collectContextTraffic([...rows, rows[1]]).tools[0];
  assert.equal(repeated.calls, 4); assert.equal(repeated.repeated, 1); assert.equal(repeated.repeatedChars, 600);
  const image = pair('5'); image[1].message.content.push({ type: 'image', data: 'fixture' });
  assert.equal(collectContextTraffic([...pair('1'), ...image]).tools[0].repeated, 0);
});

test('new structured tools compact losslessly in block and string forms', () => {
  const text = JSON.stringify({ evidence: Array.from({ length: 40 }, (_, i) => ({ i, note: 'two  spaces stay' })) }, null, 2);
  const compact = createToolJsonCompactor();
  for (const toolName of ['quality_review', 'skill_review', 'handoff_capsule', 'context_score', 'dependency_plan', 'data_query']) {
    const original = { role: 'toolResult', toolCallId: toolName, toolName, content: text };
    const [result] = compact.transform([original]);
    assert.deepEqual(JSON.parse(result.content), JSON.parse(text));
    assert.ok(result.content.length < text.length); assert.equal(original.content, text);
  }
});

test('capsules deduplicate only equivalent protected evidence', () => {
  const item = { id: 'first', text: 'Preserve the API contract. '.repeat(12), kind: 'constraint', source: 'requirements.md' };
  const capsule = makeCapsule([item, { ...item, id: 'second', timestamp: Date.now() }], 'Fix parser', 1000);
  assert.equal(capsule.constraints.length, 1); assert.equal(capsule.omitted, 1);
  assert.equal(makeCapsule([item, { ...item, source: 'other.md' }], 'Fix parser', 2000).constraints.length, 2);
  assert.equal(makeCapsule([item, { ...item, unresolved: true }], 'Fix parser', 2000).constraints.length, 2);
});

test('compaction retries append retention priorities once without changing originals', () => {
  const original = { role: 'user', content: 'Keep the public API stable' };
  const event = { branchEntries: [{ type: 'message', id: 'u', message: original }], preparation: { messagesToSummarize: [original], previousSummary: 'Existing summary' } };
  assert.equal(addCompactionSalience(event), true); assert.equal(addCompactionSalience(event), false);
  assert.equal(event.preparation.messagesToSummarize.length, 2);
  assert.equal(event.preparation.messagesToSummarize[0], original);
  assert.equal(event.preparation.previousSummary, 'Existing summary');
});

test('utility and HTTP JSON histories compact without changing evidence or replay bytes', () => {
  const text = JSON.stringify({rows:Array.from({length:80},(_,id)=>({id,detail:'keep  spacing'}))},null,2);
  const compactor = createToolJsonCompactor();
  for (const toolName of ['sqlite_probe','package_probe','openapi_probe','coverage_probe','contract_diff','env_audit','net_probe','archive_probe','http_request','sys_probe']) {
    const original = {role:'toolResult',toolName,toolCallId:'fixture',content:[{type:'text',text}]};
    const messages = [original];
    const result = compactor.transform(messages);
    assert.deepEqual(JSON.parse(result[0].content[0].text),JSON.parse(text));
    assert.ok(result[0].content[0].text.length < text.length * .8);
    assert.equal(original.content[0].text,text);
    assert.equal(result[0].toolCallId,'fixture');
    compactor.reset();
    assert.equal(JSON.stringify(compactor.transform(messages)),JSON.stringify(result));
  }
});

test('diagnostics classify validation echoes and actual workflow guards correctly', () => {
  assert.equal(failureCategory('Validation failed for tool "todo": action required; fields: acceptance, budget, evidence').category,'input');
  assert.equal(failureCategory('Before edit on "index.php", read the matching workflow(s): PHP').category,'guard');
  assert.equal(failureCategory('Current independent reviews and their missing evidence must be resolved; record blocked when unavailable.').category,'verification');
});

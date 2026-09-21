import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/lib/diagnostic-provenance.ts')),
);
assert.ok(agent, 'agent tree with diagnostic-provenance.ts is present');
const lib = pathToFileURL(path.join(agent, 'extensions/lib/')).href;
const { collectRuntimeProvenance, buildNormalizedExport, buildReviewRecord } = await import(lib + 'diagnostic-provenance.ts');
const { buildSessionJsonExport } = await import(lib + 'session-export-json.ts');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { reduceChildEvents, projectTranscriptChildren } = await import(shared + 'child-ledger.ts');

test('runtime provenance pins the exact code under test', () => {
  const provenance = collectRuntimeProvenance({ repoRoot: root });
  assert.match(provenance.gitSha ?? '', /^[a-f0-9]{40}$/);
  assert.ok(provenance.coreName && provenance.coreVersion);
  assert.ok(provenance.extensionManifestHash);
  assert.ok(provenance.schemaVersions['child-ledger']);
  assert.ok(Number.isFinite(provenance.collectedAt));
});

test('missing provenance stays missing, never invented', () => {
  const provenance = collectRuntimeProvenance({ repoRoot: path.join(os.tmpdir(), 'no-such-dir-xyz') });
  assert.equal(provenance.gitSha, undefined);
  assert.equal(provenance.coreName, undefined);
});

test('normalized export pairs ledgers with raw events', () => {
  const provenance = collectRuntimeProvenance({ repoRoot: root });
  const exported = buildNormalizedExport({ provenance, sections: { children: { tasks: 1 } }, raw: [1, 2] });
  assert.equal(exported.version, 1);
  assert.deepEqual(exported.sections.children, { tasks: 1 });
  assert.deepEqual(exported.raw, [1, 2]);
  assert.ok(exported.disclaimer.includes('never quality metrics'));
});

test('reviews declare evidence ids and coverage', () => {
  const review = buildReviewRecord({ id: 'qr-1', kind: 'quality_review', evidenceIds: ['src/a.ts', 'test/b'], coverage: 'partial' });
  assert.deepEqual(review.evidenceIds, ['src/a.ts', 'test/b']);
  assert.equal(review.coverage, 'partial');
  const unknown = buildReviewRecord({ id: 'qr-2' });
  assert.equal(unknown.coverage, 'unknown');
});

test('session export carries provenance plus normalized ledgers', () => {
  const branch = [
    { type: 'message', message: { role: 'assistant', provider: 'q', model: 'm', content: [{ type: 'text', text: 'hi' }], usage: { input: 10, output: 5 } } },
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'c1', results: [{ index: 0, status: 'completed', exitCode: 0, model: 'q/m' }] } },
  ];
  const report = buildSessionJsonExport({
    header: {}, scope: 'branch', branch, retained: branch,
    provenance: collectRuntimeProvenance({ repoRoot: root }),
  });
  assert.ok(report.provenance.gitSha, 'provenance attached');
  assert.ok(report.normalized, 'normalized sections attached');
  assert.equal(report.normalized.children.summary.completed, 1);
  assert.equal(report.normalized.attempts.length, 1);
  assert.ok(report.normalized.cost.state, 'cost state classified');
  assert.ok(Array.isArray(report.events), 'raw events retained');
});

// Deterministic replay: redacted event sequences reduce to exact ledgers.
const REPLAY_EVENTS = [
  { type: 'launch', taskId: 'replay-1', label: 'replay audit', attempt: 1, runId: 'rr-a', route: 'q/m' },
  { type: 'completion', taskId: 'replay-1', runId: 'rr-a', row: { status: 'failed', stopReason: 'length' } },
  { type: 'recovery', taskId: 'replay-1', reason: 'resume', replacementAttempt: 2 },
  { type: 'launch', taskId: 'replay-1', attempt: 2, runId: 'rr-b', route: 'q/m' },
  { type: 'completion', taskId: 'replay-1', runId: 'rr-b', row: { status: 'completed', exitCode: 0, acceptance: { status: 'passed' } } },
];

test('replay is deterministic across runs and entry points', () => {
  const a = reduceChildEvents(REPLAY_EVENTS);
  const b = reduceChildEvents(JSON.parse(JSON.stringify(REPLAY_EVENTS)));
  assert.deepEqual(a, b);
  assert.equal(a.tasks[0].state, 'completed');
  assert.equal(a.tasks[0].attempts[0].execution.cause.category, 'output-truncated');

  const entries = [
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'c9', results: [{ index: 0, status: 'completed', exitCode: 0, model: 'q/m' }] } },
  ];
  assert.deepEqual(reduceChildEvents(projectTranscriptChildren(entries)), reduceChildEvents(projectTranscriptChildren(entries)));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

function provenanceFixture(t, { git = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provenance-source-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, 'core'));
  fs.mkdirSync(path.join(repo, 'agent/extensions'), { recursive: true });
  // Exercise the production collector with exact release metadata and an
  // explicit synthetic Git repository. A source archive legitimately has no
  // .git directory and must never invent a repository SHA to satisfy a test.
  const identity = fs.readFileSync(path.join(root, 'core/identity.json'));
  const manifest = fs.readFileSync(path.join(agent, 'extensions/manifest.json'));
  fs.writeFileSync(path.join(repo, 'core/identity.json'), identity);
  fs.writeFileSync(path.join(repo, 'agent/extensions/manifest.json'), manifest);
  const sha = '1234567890abcdef1234567890abcdef12345678';
  if (git) {
    fs.mkdirSync(path.join(repo, '.git/refs/heads'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git/HEAD'), 'ref: refs/heads/fixture\n');
    fs.writeFileSync(path.join(repo, '.git/refs/heads/fixture'), `${sha}\n`);
  }
  return {
    repo, sha, identity: JSON.parse(identity),
    manifestHash: createHash('sha256').update(manifest).digest('hex').slice(0, 32),
    collect: () => collectRuntimeProvenance({ repoRoot: repo, agentDir: path.join(repo, 'agent') }),
  };
}

test('runtime provenance pins the exact repository and source metadata supplied to the collector', (t) => {
  const fixture = provenanceFixture(t);
  const provenance = fixture.collect();
  assert.equal(provenance.gitSha, fixture.sha);
  assert.equal(provenance.coreName, fixture.identity.name);
  assert.equal(provenance.coreVersion, fixture.identity.version);
  assert.equal(provenance.extensionManifestHash, fixture.manifestHash);
  assert.ok(provenance.schemaVersions['child-ledger']);
  assert.ok(Number.isFinite(provenance.collectedAt));
});

test('a source distribution without Git retains exact source metadata and no invented commit', (t) => {
  const fixture = provenanceFixture(t, { git: false });
  assert.equal(fs.existsSync(path.join(fixture.repo, '.git')), false);
  const provenance = fixture.collect();
  assert.equal(provenance.gitSha, undefined);
  assert.equal(provenance.coreName, fixture.identity.name);
  assert.equal(provenance.coreVersion, fixture.identity.version);
  assert.equal(provenance.extensionManifestHash, fixture.manifestHash);
});

test('missing provenance stays missing, never invented', () => {
  const provenance = collectRuntimeProvenance({ repoRoot: path.join(os.tmpdir(), 'no-such-dir-xyz') });
  assert.equal(provenance.gitSha, undefined);
  assert.equal(provenance.coreName, undefined);
});

test('runtime provenance resolves linked worktree refs from shared packed-refs', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provenance-worktree-'));
  const repo = path.join(base, 'checkout');
  const common = path.join(base, 'git-common');
  const gitDir = path.join(common, 'worktrees', 'checkout');
  fs.mkdirSync(path.join(repo), { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${path.relative(repo, gitDir)}\n`);
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature/worktree\n');
  const sha = 'a'.repeat(40);
  fs.writeFileSync(path.join(common, 'packed-refs'), `# pack-refs with: peeled fully-peeled\n${sha} refs/heads/feature/worktree\n`);
  try {
    assert.equal(collectRuntimeProvenance({ repoRoot: repo }).gitSha, sha);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('runtime provenance accepts detached worktree HEAD and rejects unsafe refs', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provenance-head-'));
  const gitDir = path.join(base, 'metadata');
  fs.mkdirSync(gitDir);
  const repo = path.join(base, 'checkout');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${path.relative(repo, gitDir)}\n`);
  const sha = 'b'.repeat(40);
  fs.writeFileSync(path.join(gitDir, 'HEAD'), `${sha}\n`);
  assert.equal(collectRuntimeProvenance({ repoRoot: repo }).gitSha, sha);
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/../../outside\n');
  assert.equal(collectRuntimeProvenance({ repoRoot: repo }).gitSha, undefined);
  fs.rmSync(base, { recursive: true, force: true });
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

test('session export carries provenance plus normalized ledgers', (t) => {
  const fixture = provenanceFixture(t);
  const provenance = fixture.collect();
  const branch = [
    { type: 'message', message: { role: 'assistant', provider: 'q', model: 'm', content: [{ type: 'text', text: 'hi' }], usage: { input: 10, output: 5 } } },
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'c1', results: [{ index: 0, status: 'completed', exitCode: 0, model: 'q/m' }] } },
  ];
  const report = buildSessionJsonExport({
    header: {}, scope: 'branch', branch, retained: branch,
    provenance,
  });
  assert.equal(report.provenance.gitSha, fixture.sha, 'the exact collected commit remains attached');
  assert.deepEqual(report.provenance, provenance, 'session export preserves every provenance field');
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

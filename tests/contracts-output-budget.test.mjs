import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/output-budget.ts')),
);
assert.ok(agent, 'agent tree with output-budget.ts is present');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { resolveOutputCapacity, planEvidenceBudget, planArtifactHandoff, planResume, CONSERVATIVE_OUTPUT_FALLBACK } = await import(shared + 'output-budget.ts');

test('fallbacks are labeled, never presented as capability', () => {
  const fallback = resolveOutputCapacity({});
  assert.equal(fallback.effective, CONSERVATIVE_OUTPUT_FALLBACK);
  assert.equal(fallback.effectiveSource, 'conservative-fallback');
  assert.equal(fallback.isFallback, true);

  const advertised = resolveOutputCapacity({ advertised: 64000, catalog: 32000 });
  assert.equal(advertised.effective, 64000);
  assert.equal(advertised.effectiveSource, 'provider-advertised');
  assert.equal(advertised.isFallback, false);
});

test('ceilings narrow from above in provenance order', () => {
  const capped = resolveOutputCapacity({ advertised: 64000, childCap: 4096, hookCap: 8192, wireCap: 2048 });
  assert.equal(capped.effective, 2048);
  assert.equal(capped.effectiveSource, 'wire-cap');
  const override = resolveOutputCapacity({ advertised: 64000, override: 4096 });
  assert.equal(override.effectiveSource, 'local-override');
});

test('evidence budgets split reading, reasoning, and answering', () => {
  const small = planEvidenceBudget({ reportShape: 'findings', fileCount: 5, contextWindow: 128000, promptTokens: 4000 });
  assert.equal(small.needsStaging, false);
  assert.equal(small.stagedArtifacts, 0);
  assert.ok(small.reading > 0 && small.reasoning > 0 && small.answer > 0);

  const huge = planEvidenceBudget({ reportShape: 'audit', fileCount: 2000, contextWindow: 32000, promptTokens: 8000 });
  assert.equal(huge.needsStaging, true);
  assert.ok(huge.stagedArtifacts >= 1);
});

test('artifact handoff keeps direct returns when they fit', () => {
  const direct = planArtifactHandoff(planEvidenceBudget({ reportShape: 'findings', fileCount: 3 }));
  assert.equal(direct.strategy, 'direct');
  const staged = planArtifactHandoff(planEvidenceBudget({ reportShape: 'audit', fileCount: 2000, contextWindow: 32000, promptTokens: 8000 }), { artifactPath: '/tmp/evidence.json' });
  assert.ok(['artifact-plus-summary', 'staged-summaries'].includes(staged.strategy));
  assert.equal(staged.artifact, '/tmp/evidence.json');
  assert.equal(staged.summary.includeEvidenceIds, true);
});

test('truncated productive work resumes synthesis-only', () => {
  const resume = planResume({ hasArtifacts: true, hasSessionState: true, hasPartialResults: true, truncation: 'length-stop', acceptance: 'pending' });
  assert.equal(resume.resumable, true);
  assert.equal(resume.continuationScope, 'synthesis-only');

  const empty = planResume({ hasArtifacts: false, hasSessionState: false, hasPartialResults: false, truncation: 'length-stop', acceptance: 'none' });
  assert.equal(empty.resumable, false);
  assert.equal(empty.continuationScope, 'full-restart');

  const clean = planResume({ hasArtifacts: true, hasSessionState: true, hasPartialResults: true, truncation: 'none', acceptance: 'passed' });
  assert.equal(clean.resumable, false, 'nothing to resume without truncation or rejection');
});

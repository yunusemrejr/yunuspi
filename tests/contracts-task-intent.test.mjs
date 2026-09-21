import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/task-intent-model.ts')),
);
assert.ok(agent, 'agent tree with task-intent-model.ts is present');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { extractTaskIntent } = await import(shared + 'task-intent-model.ts');
const { taskQuality } = await import(shared + 'model-quality.ts');
const { classifyTaskMutationIntent, taskMayMutate } = await import(shared + 'task-intent.ts');

test('prohibitions constrain execution, never retype the task', () => {
  const intent = extractTaskIntent('Review the auth module for bugs. Never deploy anything; do not modify production.');
  assert.equal(intent.requestedAction, 'review');
  assert.equal(intent.mutationPermission, 'forbidden');
  assert.equal(intent.environmentSensitivity, 'production-mention');
  assert.equal(intent.decisionCriticality, 'advisory');
  assert.deepEqual(intent.prohibitedActions.sort(), ['implement', 'operate']);
  assert.ok(intent.safetyNotes.length >= 2);
});

test('requested production targets stay critical', () => {
  for (const task of [
    'Deploy the new build to production now.',
    'Migrate the production database to the new schema.',
    'Restart prod to clear the stuck queue.',
  ]) {
    const intent = extractTaskIntent(task);
    assert.equal(intent.environmentSensitivity, 'production-target', task);
    assert.equal(intent.decisionCriticality, 'critical', task);
  }
});

test('mentions of production in read-only work stay advisory', () => {
  for (const task of [
    'Summarize production architecture from the docs.',
    'Research the production outage timeline and list contributing factors.',
    'Fix the deploy script so staging releases work.',
    'Investigate why login fails; see deployment docs for background.',
  ]) {
    const intent = extractTaskIntent(task);
    assert.notEqual(intent.environmentSensitivity, 'production-target', task);
    assert.ok(['advisory', 'standard'].includes(intent.decisionCriticality), task);
  }
});

test('scoped constraints keep the requested implementation', () => {
  for (const task of ['Do not modify tests; implement the fix', 'Do not modify tests but implement the fix']) {
    const intent = extractTaskIntent(task);
    assert.equal(intent.requestedAction, 'implement', task);
    assert.equal(intent.mutationPermission, 'required', task);
  }
});

test('quoted and example text is never intent', () => {
  const intent = extractTaskIntent("The prompt says 'implement x' as an example; just review the code.");
  assert.equal(intent.requestedAction, 'review');
  assert.equal(intent.mutationPermission, 'forbidden');
  assert.ok(intent.segments.quotedSpans.length > 0);
});

test('taskQuality delegates to structured intent', () => {
  assert.deepEqual(taskQuality('Review the auth module. Never deploy; do not modify production.'), { domain: 'coding', level: 'advisory' });
  assert.deepEqual(taskQuality('Deploy the new build to production now.'), { domain: 'general', level: 'critical' });
  assert.deepEqual(taskQuality('Implement the fix for the login bug and add tests.'), { domain: 'coding', level: 'critical' });
});

test('mutation classifier masks quoted spans before cue matching', () => {
  assert.equal(classifyTaskMutationIntent('reviewer', "The docs say 'implement x'; review only, suggest fixes.").kind, 'read-only');
  assert.equal(classifyTaskMutationIntent('worker', 'Do not modify tests; implement the fix').kind, 'implementation');
  assert.equal(taskMayMutate('Review only; do not modify anything.'), false);
  assert.equal(taskMayMutate('Implement the fix and update tests.'), true);
});

test('adversarial: filenames, nominals, and not-just constructions', () => {
  const fix = extractTaskIntent('Review fix.py for style issues');
  assert.equal(fix.requestedAction, 'review');
  assert.equal(fix.mutationPermission, 'forbidden');

  const nominal = extractTaskIntent('The deployment failed; investigate the cause');
  assert.equal(nominal.requestedAction, 'investigate');
  assert.equal(nominal.mutationPermission, 'forbidden');

  const notJust = extractTaskIntent("Don't just review it, implement the fix");
  assert.equal(notJust.requestedAction, 'implement');
  assert.equal(notJust.mutationPermission, 'required');
  assert.ok(notJust.segments.requestedVerbs.includes('implement'), 'Y clause is requested, not swallowed');

  const docs = extractTaskIntent('Update the deployment documentation');
  assert.equal(docs.requestedAction, 'implement', 'docs edit is code work, not an operation');

  const scoped = extractTaskIntent('Audit config.json; the file deploy.yaml is out of scope');
  assert.equal(scoped.requestedAction, 'review');

  const versioned = extractTaskIntent('Release v2.3 to staging now');
  assert.equal(versioned.requestedAction, 'operate');
  assert.equal(versioned.environmentSensitivity, 'production-target');
});

test('required evidence follows the deliverable', () => {
  const review = extractTaskIntent('Audit the login flow and report findings.');
  assert.ok(review.requiredEvidence.includes('source-refs'));
  const impl = extractTaskIntent('Implement the login fix.');
  assert.ok(impl.requiredEvidence.includes('tests'));
  const op = extractTaskIntent('Deploy the build to production.');
  assert.ok(op.requiredEvidence.includes('approval'));
});

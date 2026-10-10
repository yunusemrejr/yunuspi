import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { completionReport, staticCompletionSteps } from '../agent/extensions/lib/completion-check.ts';
import { createGoal, goalCompletionGate, goalCompletionReceipts } from '../agent/extensions/lib/goal-state.ts';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
const repo = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'ok.js'), 'export const ok = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
};

test('a clean change set produces no static completion receipts', async t => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, 'ok.js'), 'export const ok = 2;\n');
  assert.deepEqual(await staticCompletionSteps(dir), []);
});

test('without a Git baseline the static steps stay silent instead of blocking completion', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-check-nogit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'bad.js'), 'export const = ;\n');
  assert.deepEqual(await staticCompletionSteps(dir), []);
});

test('a changed file that does not parse reopens completion with a syntax receipt', async t => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, 'ok.js'), 'export const = ;\n');
  const receipts = await staticCompletionSteps(dir);
  const syntax = receipts.find(receipt => receipt.source === 'syntax');
  assert.ok(syntax, JSON.stringify(receipts));
  assert.equal(syntax.state, 'unresolved');
  assert.match(syntax.line, /ok\.js/);
});

test('the report lists criteria first and every open step after them', () => {
  const goal = createGoal('Make the exporter handle unicode filenames');
  const steps = [{ source: 'syntax', id: 'parse-failure', state: 'unresolved', line: 'syntax: 1 changed file(s) do not parse: ok.js.' }];
  const report = completionReport(goal.criteria, steps);
  assert.equal(report.clear, false);
  assert.match(report.lines[0], /^\[ \] C1 /);
  assert.equal(report.lines.at(-1), '[!] syntax: 1 changed file(s) do not parse: ok.js.');
  const settled = goal.criteria.map(criterion => ({ ...criterion, status: 'met', evidence: 'npm test: 3 passed, exit 0' }));
  assert.equal(completionReport(settled, []).clear, true);
  assert.equal(completionReport(settled, steps).clear, false);
});

test('static steps gate goal completion once and a repeated call is a recorded waiver', () => {
  const goal = { ...createGoal('Ship the fix'), criteria: createGoal('Ship the fix').criteria.map(criterion => ({ ...criterion, status: 'met', evidence: 'npm test: ok exit 0' })) };
  const step = { source: 'static-audit', id: 'high-severity', state: 'unresolved', count: 1, line: 'static audit: 1 high-severity finding(s) in changed files: a.js:3 sql-injection.' };
  assert.deepEqual(goalCompletionReceipts(goal, { unverifiedWrites: 0 }), []);
  const refused = new Set();
  const first = goalCompletionGate(goal, { unverifiedWrites: 0, refused, verification: [step] });
  assert.equal(first.block, true);
  assert.match(first.reason, /static audit/);
  refused.add(first.key);
  const second = goalCompletionGate(goal, { unverifiedWrites: 0, refused, verification: [step] });
  assert.deepEqual([second.block, second.waived], [false, true]);
});

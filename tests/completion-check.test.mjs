import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { completionReport, createStaticCompletionCheck, staticAdvisories, staticCompletionSteps } from '../agent/extensions/lib/completion-check.ts';
import { checkSourceText } from '../agent/extensions/lib/source-check.ts';
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

test('only tracked config files are parse-checked: a new untracked .json is arbitrary output, a broken tracked one is a regression', async t => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'config');
  fs.writeFileSync(path.join(dir, 'run-output.json'), '{"event":1}\n{"event":2}\n');
  assert.deepEqual(await staticCompletionSteps(dir), []);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":');
  const syntax = (await staticCompletionSteps(dir)).find(receipt => receipt.source === 'syntax');
  assert.ok(syntax);
  assert.match(syntax.line, /package\.json/);
  assert.doesNotMatch(syntax.line, /run-output/);
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

test('source-quality advisories name duplicated blocks in changed files and stay silent otherwise', async t => {
  const dir = repo(t);
  assert.deepEqual(await staticAdvisories(dir), [], 'a clean tree has nothing to say');
  const block = name => `export function ${name}(items) {\n  let sum = 0;\n  for (const item of items) {\n    if (item.price > 0 && item.qty > 0) { sum += item.price * item.qty * (1 - (item.discount || 0)); }\n  }\n  return Math.round(sum * 100) / 100;\n}\n`;
  fs.writeFileSync(path.join(dir, 'ok.js'), `${block('total')}\n${block('total2')}`);
  const notes = await staticAdvisories(dir);
  assert.ok(notes.some(note => /duplicated block group/.test(note)), JSON.stringify(notes));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-check-nogit-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bare, 'ok.js'), `${block('a')}\n${block('b')}`);
  assert.deepEqual(await staticAdvisories(bare), [], 'no Git baseline, no advisories');
});

test('completion reuses current parse results but catches same-size same-mtime edits and cached failures', async t => {
  const dir=repo(t), parsed=[];
  const check=createStaticCompletionCheck((...args)=>{parsed.push(args[0]);return checkSourceText(...args);});
  const file=path.join(dir,'ok.js');
  fs.writeFileSync(file,'export const ok = 2;\n');
  assert.deepEqual(await check(dir),[]);
  assert.deepEqual(await check(dir),[]);
  assert.deepEqual(parsed,['ok.js'],'check followed by complete parses identical source once');
  const stat=fs.statSync(file);
  fs.writeFileSync(file,'export const == 2;\n  ');
  fs.utimesSync(file,stat.atime,stat.mtime);
  assert.equal(fs.statSync(file).size,stat.size);
  const broken=(await check(dir)).find(r=>r.source==='syntax');
  assert.equal(broken?.state,'unresolved');
  assert.deepEqual((await check(dir)).find(r=>r.source==='syntax'),broken,'a repeated call retains the content-bound failure');
  assert.equal(parsed.length,2);
  fs.writeFileSync(file,'export const === 2;\n ');
  assert.notEqual((await check(dir)).find(r=>r.source==='syntax')?.revision,broken.revision,'a new defect cannot inherit the old refusal/waiver identity');
  fs.writeFileSync(file,'export const ok = 3;\n');
  assert.deepEqual(await check(dir),[]);
  assert.equal(parsed.length,4,'a repair is parsed again');
});

test('unavailable parsers are explicit gaps and are retried instead of cached as success', async t => {
  const dir=repo(t);fs.writeFileSync(path.join(dir,'ok.js'),'export const ok = 2;\n');
  let calls=0;
  const check=createStaticCompletionCheck(async()=>++calls===1?{status:'unavailable',checker:'fixture',diagnostics:['missing']}:{status:'passed',checker:'fixture',diagnostics:[]});
  assert.equal((await check(dir)).find(r=>r.source==='static-check')?.state,'unknown');
  assert.deepEqual(await check(dir),[]);
  assert.equal(calls,2);
});

test('bounded syntax coverage is disclosed and caller cancellation does not become a passing receipt', async t => {
  const dir=repo(t);
  for(let i=0;i<21;i++)fs.writeFileSync(path.join(dir,`extra-${i}.js`),`export const x=${i};\n`);
  assert.equal((await staticCompletionSteps(dir)).find(r=>r.source==='static-check')?.state,'unknown');
  const abort=new AbortController();
  const check=createStaticCompletionCheck(async()=>{abort.abort();abort.signal.throwIfAborted();});
  await assert.rejects(check(dir,abort.signal),/abort/i);
  await assert.rejects(staticCompletionSteps(dir,abort.signal),/abort/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { QUICK_TESTS, testConcurrency, testPlan } from '../scripts/test.mjs';

const root = path.resolve(import.meta.dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`).sort();
const plan = options => testPlan({ files, quick: true, ...options });

test('routine checks are bounded, prerequisite-free, and include every changed or newly added test', () => {
  const fresh = 'tests/new-feature.test.mjs';
  const result = plan({ files: [...files, fresh], changed: [fresh, 'tests/goal-state.test.mjs', 'docs/INSTALL.md'] });
  assert.equal(result.full, false);
  assert.deepEqual(result.selected, [...new Set([...QUICK_TESTS, fresh])].sort());
  assert.ok(result.selected.length < files.length / 8);
  assert.equal(plan({ changed: ['tests/deleted.test.mjs'] }).selected.includes('tests/deleted.test.mjs'), false);
});

test('release, shared safety, dependency, test infrastructure and unknown-base changes require every test', () => {
  for (const changed of ['core/agent/src/index.js', 'package.json', 'package-lock.json', '.github/workflows/public-safety.yml', 'scripts/test.mjs', 'config/bwrap.apparmor', 'tests/bytes.mjs', 'agent/extensions/manifest.json', 'agent/scripts/pi-launch.sh', 'tests/source-syntax.test.mjs']) {
    assert.deepEqual(plan({ changed: [changed] }), { full: true, selected: files }, changed);
  }
  for (const event of ['schedule', 'workflow_dispatch']) assert.equal(plan({ event }).full, true);
  assert.equal(plan({ knownBase: false }).full, true);
  assert.equal(plan({ quick: false }).full, true);
  assert.throws(() => plan({ files: [] }), /Missing registered test/);
});

test('test concurrency cannot silently turn a typo into unbounded process spawning', () => {
  assert.equal(testConcurrency(undefined, 64), 4);
  assert.equal(testConcurrency(undefined, 1), 1);
  assert.equal(testConcurrency('2'), 2);
  for (const value of ['0', '99', '-1', '2oops', '']) assert.throws(() => testConcurrency(value), /CONCURRENCY/);
});

test('the test CLI rejects unknown tests and falls back to full checks for unavailable Git history', () => {
  const run = args => spawnSync(process.execPath, [path.join(root, 'scripts/test.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const selected = run(['--quick', '--base', '0'.repeat(40), '--plan']);
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(JSON.parse(selected.stdout).selected.length, files.length);
  assert.equal(run(['tests/absent.test.mjs', '--list']).status, 1);
  assert.equal(run(['--test-concurrency=999', '--list']).status, 1);
});

test('syntax checks fail visibly when the runtime parser is unavailable', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'syntax-dependency-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'scripts'));
  fs.cpSync(path.join(root, 'scripts/check-syntax.mjs'), path.join(fixture, 'scripts/check-syntax.mjs'));
  fs.writeFileSync(path.join(fixture, 'probe.ts'), 'export const valid = true;');
  const checked = spawnSync(process.execPath, [path.join(fixture, 'scripts/check-syntax.mjs'), 'probe.ts'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /jiti is not installed/);
  assert.doesNotMatch(checked.stdout, /parse\.|skipped/);
});

test('failed tests reach the shell and disposable fixture roots are cleaned on failure', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'test-cli-failure-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const file of ['scripts/test.mjs', 'agent/scripts/publish-public.mjs']) {
    fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    fs.cpSync(path.join(root, file), path.join(fixture, file));
  }
  fs.mkdirSync(path.join(fixture, 'tests'));
  fs.writeFileSync(path.join(fixture, 'tests/failure.test.mjs'), `import test from 'node:test';import os from 'node:os';console.log('FIXTURE_TEMP='+os.tmpdir());test('fails',()=>{throw Error('expected fixture failure');});`);
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/test.mjs')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /expected fixture failure/);
  const tempRoot = /FIXTURE_TEMP=([^\r\n]+)/.exec(result.stdout)?.[1];
  assert.ok(tempRoot);
  assert.equal(fs.existsSync(tempRoot), false, 'failure must not leave a fixture directory behind');
});

test('CI separates short checks from full evidence and keeps recurring/manual/release verification', () => {
  const workflow = parse(fs.readFileSync(path.join(root, '.github/workflows/public-safety.yml'), 'utf8'));
  assert.ok(workflow.on.schedule.length);
  assert.ok('workflow_dispatch' in workflow.on);
  assert.match(workflow.jobs.safety.if, /outputs.full == 'true'/);
  assert.ok(workflow.jobs.safety.needs.includes('minimum-node'));
  const quick = workflow.jobs['minimum-node'].steps.map(step => step.run ?? '').join('\n');
  assert.match(quick, /scripts\/test\.mjs --quick --base/);
  assert.match(quick, /generate-capabilities-doc\.mjs.*--check/);
  assert.match(quick, /check-syntax\.mjs/);
  assert.doesNotMatch(quick, /apt-get|playwright install/);
  assert.match(workflow.concurrency.group, /github.event_name/);
});

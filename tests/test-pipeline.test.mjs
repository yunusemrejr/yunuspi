import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { QUICK_TESTS, SLOW_FIRST, orderForRun, shardFiles, testConcurrency, testPlan } from '../scripts/test.mjs';
import { annotation } from '../scripts/ci-failure-reporter.mjs';

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
  assert.equal(testConcurrency(undefined, 64, true), 4, 'CI runners stay at four');
  assert.equal(testConcurrency(undefined, 1, true), 1);
  assert.equal(testConcurrency(undefined, 64, false), 8, 'a local machine is capped at eight');
  assert.equal(testConcurrency(undefined, 12, false), 8);
  assert.equal(testConcurrency(undefined, 6, false), 4, 'two cores stay free for the machine');
  assert.equal(testConcurrency(undefined, 1, false), 1);
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

test('shards partition the selected tests exactly once and stay balanced by size', () => {
  const sizes = new Map(files.map((file, index) => [file, 100 + (index * 37) % 900]));
  const sizeOf = file => sizes.get(file);
  const parts = [1, 2, 3, 4].map(index => shardFiles(files, index, 4, sizeOf));
  assert.deepEqual(parts.flat().sort(), files);
  const loads = parts.map(part => part.reduce((sum, file) => sum + sizeOf(file), 0));
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 1000, `unbalanced shards: ${loads}`);
  for (const bad of [[0, 4], [5, 4], [1, 0], [1, 33], [1.5, 4]]) assert.throws(() => shardFiles(files, ...bad, sizeOf), /--shard/);
});

test('CI plans first, runs the complete suite as parallel shards and keeps one stable safety job for releases', () => {
  const workflow = parse(fs.readFileSync(path.join(root, '.github/workflows/public-safety.yml'), 'utf8'));
  assert.ok(workflow.on.schedule.length);
  assert.ok('workflow_dispatch' in workflow.on);
  assert.match(workflow.jobs.plan.steps.map(step => step.run ?? '').join('\n'), /scripts\/test\.mjs --quick --base .* --plan/);
  assert.deepEqual(workflow.jobs.shard.needs, ['plan']);
  assert.match(workflow.jobs.shard.if, /outputs.full == 'true'/);
  const count = workflow.jobs.shard.strategy.matrix.index.length;
  assert.ok(count >= 4 && workflow.jobs.shard.strategy['fail-fast'] === false);
  assert.match(workflow.jobs.shard.steps.map(step => step.run ?? '').join('\n'), new RegExp(`scripts/test\\.mjs --shard \\$\\{\\{ matrix.index \\}\\}/${count}`));
  // Release verification looks for a completed job named exactly "safety".
  assert.ok(workflow.jobs.safety.needs.includes('shard'));
  assert.match(workflow.jobs.safety.if, /outputs.full == 'true'/);
  const quick = workflow.jobs['minimum-node'].steps.map(step => step.run ?? '').join('\n');
  assert.match(quick, /scripts\/test\.mjs --quick --base/);
  assert.match(quick, /generate-capabilities-doc\.mjs.*--check/);
  assert.match(quick, /check-syntax\.mjs/);
  assert.doesNotMatch(quick, /apt-get|playwright install/);
  assert.match(workflow.concurrency.group, /github.event_name/);
});

test('a failed test becomes one escaped GitHub annotation naming its file', () => {
  const line = annotation({ name: 'handles: odd, names\n100%', file: path.join(root, 'tests/x.test.mjs'), details: { error: { cause: { message: 'expected 1, got 2\nstack' } } } }, root);
  assert.equal(line, '::error file=tests/x.test.mjs,title=handles%3A odd%2C names%0A100%25::expected 1%2C got 2\n');
});

test('a crashed child annotates its error line, not the Node source location printed before it', () => {
  const crash = 'node:internal/fs/cp/cp-sync:138\n    throw new ERR_FS_CP_EEXIST({\n    ^\n\nError [ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (/tmp/x/stage/a.txt already exists)\n    at checkPathsSync';
  const line = annotation({ name: 'installs', file: path.join(root, 'tests/x.test.mjs'), details: { error: { message: crash } } }, root);
  assert.match(line, /::Error \[ERR_FS_CP_EEXIST\]%3A Target already exists/);
  assert.doesNotMatch(line, /cp-sync/);
  assert.equal(annotation({ name: 'plain', details: { error: { message: 'expected 1, got 2' } } }, root), '::error title=plain::expected 1%2C got 2\n');
});

test('known slow files start first and every registered slow file exists', () => {
  const all = ['tests/a.test.mjs', ...SLOW_FIRST.slice(0, 2).reverse(), 'tests/b.test.mjs'];
  const ordered = orderForRun(all, file => file === 'tests/b.test.mjs' ? 10 : 1);
  assert.deepEqual(ordered.slice(0, 2), SLOW_FIRST.slice(0, 2), 'slow files lead, in their listed order');
  assert.deepEqual(ordered.slice(2), ['tests/b.test.mjs', 'tests/a.test.mjs'], 'the rest follows largest first');
  for (const file of SLOW_FIRST) assert.ok(fs.existsSync(path.join(root, file)), `${file} must exist so a rename updates the list`);
});

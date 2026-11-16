import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'yaml';
import { QUICK_TESTS, shardFiles, testConcurrency, testPlan } from '../scripts/test.mjs';
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

test('only a run without --quick selects every test, whatever changed', () => {
  for (const changed of ['core/agent/src/index.js', 'package.json', '.github/workflows/public-safety.yml', 'scripts/test.mjs']) assert.equal(plan({ changed: [changed] }).full, false, changed);
  assert.deepEqual(plan({ quick: false }), { full: true, selected: files });
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

test('the test CLI rejects unknown tests and keeps to the short catalogue for unavailable Git history', () => {
  const run = args => spawnSync(process.execPath, [path.join(root, 'scripts/test.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const selected = run(['--quick', '--base', '0'.repeat(40), '--list']);
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(selected.stdout.trim().split('\n'), [...QUICK_TESTS].sort());
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

function runnerFixture(t, source) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'test-cli-fixture-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const file of ['scripts/test.mjs', 'agent/scripts/publish-public.mjs']) {
    fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    fs.cpSync(path.join(root, file), path.join(fixture, file));
  }
  fs.mkdirSync(path.join(fixture, 'tests'));
  fs.writeFileSync(path.join(fixture, 'tests/fixture.test.mjs'), source);
  return fixture;
}

test('failed tests reach the shell and disposable fixture roots are cleaned on failure', t => {
  const fixture = runnerFixture(t, `import test from 'node:test';import os from 'node:os';console.log('FIXTURE_TEMP='+os.tmpdir());test('fails',()=>{throw Error('expected fixture failure');});`);
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/test.mjs')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /expected fixture failure/);
  const tempRoot = /FIXTURE_TEMP=([^\r\n]+)/.exec(result.stdout)?.[1];
  assert.ok(tempRoot);
  assert.equal(fs.existsSync(tempRoot), false, 'failure must not leave a fixture directory behind');
});

test('a targeted SIGTERM reaps test descendants and the disposable test root', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const grandchild = `
    const fs = require('node:fs'), os = require('node:os');
    const file = process.env.YUNUSPI_TEST_FIXTURE_READY;
    process.on('SIGTERM', () => {});
    fs.writeFileSync(file + '.tmp', JSON.stringify({ testPid: process.ppid, workerPid: process.pid, tempRoot: os.tmpdir() }));
    fs.renameSync(file + '.tmp', file);
    setTimeout(() => {}, 14000);
  `;
  const fixture = runnerFixture(t, `
    import test from 'node:test';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    test('runs a nested job', async () => {
      await once(spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }), 'close');
    });
  `);
  const ready = path.join(fixture, 'ready.json');
  const launcher = spawn(process.execPath, [path.join(fixture, 'scripts/test.mjs')], {
    cwd: fixture, stdio: 'ignore', env: { ...process.env, YUNUSPI_TEST_FIXTURE_READY: ready },
  });
  const closed = once(launcher, 'close');
  const processIsAlive = pid => {
    try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)[0] !== 'Z'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  };
  let job;
  t.after(() => {
    launcher.kill('SIGKILL');
    if (!job) return;
    for (const pid of [job.workerPid, job.testPid]) {
      if (!processIsAlive(pid)) continue;
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    fs.rmSync(job.tempRoot, { recursive: true, force: true });
  });
  const limit = Date.now() + 10000;
  while (!fs.existsSync(ready) && Date.now() < limit && launcher.exitCode === null) await delay(20);
  assert.ok(fs.existsSync(ready), 'nested test job started');
  job = JSON.parse(fs.readFileSync(ready, 'utf8'));
  assert.ok(processIsAlive(job.workerPid));
  assert.ok(fs.existsSync(job.tempRoot));
  launcher.kill('SIGTERM');
  assert.deepEqual(await closed, [143, null]);
  const reapLimit = Date.now() + 1000;
  while ((processIsAlive(job.workerPid) || processIsAlive(job.testPid)) && Date.now() < reapLimit) await delay(20);
  assert.equal(processIsAlive(job.workerPid), false, 'nested job that ignores SIGTERM is gone');
  assert.equal(processIsAlive(job.testPid), false, 'test process is gone');
  assert.equal(fs.existsSync(job.tempRoot), false, 'interruption removes the disposable test root');
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

test('a push runs only the quick checks; the complete suite runs as shards weekly or on demand', () => {
  const workflow = parse(fs.readFileSync(path.join(root, '.github/workflows/public-safety.yml'), 'utf8'));
  assert.ok(workflow.on.schedule.length);
  assert.ok('workflow_dispatch' in workflow.on);
  assert.equal(workflow.on.push.tags, undefined, 'no tag starts a workflow');
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['minimum-node', 'shard']);
  assert.equal(workflow.jobs.shard.needs, undefined);
  assert.match(workflow.jobs.shard.if, /'schedule'.*'workflow_dispatch'/);
  assert.doesNotMatch(workflow.jobs.shard.if, /push|pull_request/);
  const count = workflow.jobs.shard.strategy.matrix.index.length;
  assert.ok(count >= 4 && workflow.jobs.shard.strategy['fail-fast'] === false);
  assert.match(workflow.jobs.shard.steps.map(step => step.run ?? '').join('\n'), new RegExp(`scripts/test\\.mjs --shard \\$\\{\\{ matrix.index \\}\\}/${count}`));
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

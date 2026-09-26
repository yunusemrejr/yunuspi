import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { releasePlan, publishRelease, verifiedMainRun } from '../scripts/publish-github-release.mjs';

const root = path.resolve(import.meta.dirname, '..');
test('release metadata check detects lock drift and repairs only owned versions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-version-'));
  try {
    for (const file of ['package.json', 'package-lock.json', 'core/identity.json', 'scripts/version-release.mjs', 'release-template/package.json', 'release-template/package-lock.json', ...['agent', 'ai', 'chord', 'coding-agent', 'telemetry', 'tui'].map(name => `core/${name}/package.json`)]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(dir, file));
    }
    const run = (...args) => spawnSync(process.execPath, ['scripts/version-release.mjs', ...args], { cwd: dir, encoding: 'utf8' });
    const current = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).version;
    assert.equal(run(current).status, 0);
    const before = fs.readFileSync(path.join(dir, 'core/identity.json'), 'utf8');
    for (const args of [['00.2.0'], ['0.2.0-01'], ['0.2.0', '0.3.0'], ['0.2.0', '--write', '--write']]) {
      const invalid = run(...args, '--write');
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /Usage:/);
      assert.equal(fs.readFileSync(path.join(dir, 'core/identity.json'), 'utf8'), before);
    }
    assert.equal(run('0.0.99').status, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'core/identity.json'), 'utf8'), before);
    const mirror = path.join(dir, 'release-template/package-lock.json');
    const mirrorBefore = fs.readFileSync(mirror, 'utf8');
    fs.writeFileSync(mirror, '{invalid');
    assert.notEqual(run('0.0.99', '--write').status, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'core/identity.json'), 'utf8'), before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).version, current);
    fs.writeFileSync(mirror, mirrorBefore);
    const lockBefore = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json')));
    assert.equal(run('0.0.99', '--write').status, 0);
    assert.equal(run('0.0.99').status, 0);
    const lockAfter = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json')));
    for (const [name, data] of Object.entries(lockBefore.packages)) if (name.startsWith('node_modules/') && !name.startsWith('node_modules/@yunuspi/')) assert.deepEqual(lockAfter.packages[name], data);
    const oldIdentity = JSON.parse(before), newIdentity = JSON.parse(fs.readFileSync(path.join(dir, 'core/identity.json')));
    delete oldIdentity.version; delete newIdentity.version; assert.deepEqual(newIdentity, oldIdentity);
    lockAfter.packages['core/agent'].version = '0.0.1';
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lockAfter));
    assert.equal(run('0.0.99').status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const releaseInput = { version: '0.2.0', ref: 'refs/tags/v0.2.0', sha: 'a'.repeat(40), repository: 'example/project', changelog: '# Changelog\n\n## 0.2.0 — 2026-09-23\n\nRead [details](docs/ASYNC-AND-STUDIO.md) and [changelog](CHANGELOG.md).\n\n## 0.1.0 — old\nOld notes.' };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
test('release reuse requires the latest exact main push and its successful safety job', async () => {
  const valid = { id: 20, workflow_id: 10, path: '.github/workflows/public-safety.yml', head_sha: releaseInput.sha,
    head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
    repository: { full_name: releaseInput.repository }, head_repository: { full_name: releaseInput.repository } };
  const service = ({ rows = [valid], job = { name: 'safety', status: 'completed', conclusion: 'success' }, status = 200 } = {}) => async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.github.com'); assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.headers.Authorization, 'Bearer fixture');
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/workflows/public-safety.yml')) return response({ id: 10, path: valid.path }, status);
    if (parsed.pathname.endsWith('/workflows/10/runs')) {
      assert.equal(parsed.searchParams.get('head_sha'), releaseInput.sha);
      assert.equal(parsed.searchParams.get('branch'), 'main'); assert.equal(parsed.searchParams.get('event'), 'push');
      assert.equal(parsed.searchParams.has('status'), false, 'a newer failed attempt must not be hidden');
      return response({ total_count: rows.length, workflow_runs: rows });
    }
    assert.equal(parsed.pathname, '/repos/example/project/actions/runs/20/jobs');
    assert.equal(parsed.searchParams.get('filter'), 'latest');
    return response({ jobs: [job] });
  };
  const verify = options => verifiedMainRun(releaseInput.repository, releaseInput.sha, 'fixture', service(options));
  assert.deepEqual(await verify(), { id: 20, url: 'https://github.com/example/project/actions/runs/20' });
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'v0.2.0' }, { event: 'pull_request' }, { workflow_id: 11 },
    { path: '.github/workflows/other.yml' }, { repository: { full_name: 'other/project' } }, { head_repository: { full_name: 'fork/project' } },
    { status: 'in_progress', conclusion: null }, { conclusion: 'failure' }, { conclusion: 'skipped' }, { conclusion: 'cancelled' }])
    await assert.rejects(verify({ rows: [{ ...valid, ...patch }] }), /no successful main safety run/);
  await assert.rejects(verify({ rows: [] }), /no successful main safety run/);
  await assert.rejects(verify({ rows: [valid, { ...valid, id: 21, conclusion: 'failure' }] }), /no successful main safety run/);
  await assert.rejects(verify({ job: { name: 'safety', status: 'completed', conclusion: 'skipped' } }), /required safety job/);
  await assert.rejects(verify({ status: 403 }), /lookup failed/);
});

function releaseService(plan, { annotated = false, existing, moveDuringLookup = false, moveAfterCreate = false } = {}) {
  let release = existing;
  let target = plan.target_commitish;
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith(`/git/ref/tags/${plan.tag_name}`)) return response({ ref: `refs/tags/${plan.tag_name}`, object: { type: annotated ? 'tag' : 'commit', sha: annotated ? 'b'.repeat(40) : target, url: 'https://untrusted.invalid/never-follow-this' } });
    if (pathname.endsWith(`/git/tags/${'b'.repeat(40)}`)) return response({ sha: 'b'.repeat(40), object: { type: 'commit', sha: target } });
    if (pathname.endsWith(`/releases/tags/${plan.tag_name}`)) {
      if (moveDuringLookup) target = 'c'.repeat(40);
      return release ? response(release) : response({}, 404);
    }
    assert.ok(pathname.endsWith('/releases'));
    assert.equal(options.method, 'POST');
    if (release) return response({}, 422);
    release = { ...JSON.parse(options.body), html_url: `https://github.com/example/project/releases/tag/${plan.tag_name}` };
    if (moveAfterCreate) target = 'c'.repeat(40);
    return response(release, 201);
  };
  return { calls, request };
}

test('tag publishing checks the exact existing tag, document links, and immutable retry', async () => {
  const plan = releasePlan(releaseInput);
  assert.match(plan.body, /blob\/a{40}\/docs\/ASYNC/);
  assert.match(plan.body, /blob\/a{40}\/CHANGELOG\.md\)/);
  assert.doesNotMatch(plan.body, /Old notes/);
  for (const changes of [{ ref: 'refs/heads/main' }, { version: '0.3.0' }, { version: '00.2.0' }, { sha: 'main' }, { repository: '../repo' }, { changelog: '' }]) assert.throws(() => releasePlan({ ...releaseInput, ...changes }));
  for (const annotated of [false, true]) {
    const service = releaseService(plan, { annotated });
    assert.equal((await publishRelease(plan, releaseInput.repository, 'test-token', service.request)).status, 'published');
    const created = service.calls.filter(call => call.options.method === 'POST');
    assert.equal(created.length, 1);
    assert.deepEqual(JSON.parse(created[0].options.body), plan);
    assert.equal((await publishRelease(plan, releaseInput.repository, 'test-token', service.request)).status, 'already-published');
    assert.equal(service.calls.filter(call => call.options.method === 'POST').length, 1);
    await assert.rejects(publishRelease({ ...plan, body: 'changed' }, releaseInput.repository, 'test-token', service.request), /refusing/);
    for (const { url, options } of service.calls) {
      assert.equal(new URL(url).origin, 'https://api.github.com');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.ok(options.signal instanceof AbortSignal);
      assert.ok(!options.body || !options.body.includes('test-token'));
      assert.ok(!options.method || options.method === 'POST');
    }
  }
});

test('a missing, invalid, moved, or mismatched remote tag never reports publication success', async () => {
  const plan = releasePlan(releaseInput);
  const run = request => publishRelease(plan, releaseInput.repository, 'test-token', request);
  await assert.rejects(run(async () => response({}, 404)), /tag lookup failed/);
  await assert.rejects(run(async () => response({ ref: 'refs/tags/v9.9.9', object: { type: 'commit', sha: plan.target_commitish } })), /reference disagrees/);
  for (const object of [{ type: 'commit', sha: 'c'.repeat(40) }, { type: 'tree', sha: plan.target_commitish }, { type: 'tag', sha: '../host' }]) {
    let calls = 0;
    await assert.rejects(run(async () => { calls++; return response({ ref: `refs/tags/${plan.tag_name}`, object }); }));
    assert.equal(calls, 1);
  }
  let cycleCalls = 0;
  await assert.rejects(run(async () => {
    cycleCalls++;
    return response(cycleCalls === 1 ? { ref: `refs/tags/${plan.tag_name}`, object: { type: 'tag', sha: 'b'.repeat(40) } } : { sha: 'b'.repeat(40), object: { type: 'tag', sha: 'b'.repeat(40) } });
  }), /annotated release tag/);
  assert.equal(cycleCalls, 2);
  for (const options of [{ moveDuringLookup: true }, { moveAfterCreate: true }, { moveDuringLookup: true, existing: { ...plan } }]) {
    const service = releaseService(plan, options);
    await assert.rejects(run(service.request), /exact tested commit/);
    assert.equal(service.calls.filter(call => call.options.method === 'POST').length, options.moveAfterCreate ? 1 : 0);
  }
});

test('concurrent publishers reconcile one creation without overwrites or repeated POSTs', async () => {
  const plan = releasePlan(releaseInput);
  const service = releaseService(plan);
  let initialLookups = 0;
  let releaseLookups;
  const bothLookedUp = new Promise(resolve => { releaseLookups = resolve; });
  const request = async (url, options) => {
    if (url.includes('/releases/tags/') && initialLookups < 2) {
      initialLookups++;
      if (initialLookups === 2) releaseLookups();
      await bothLookedUp;
      return response({}, 404);
    }
    return service.request(url, options);
  };
  const results = await Promise.all([publishRelease(plan, releaseInput.repository, 'test-token', request), publishRelease(plan, releaseInput.repository, 'test-token', request)]);
  assert.deepEqual(results.map(result => result.status).sort(), ['already-published', 'published']);
  assert.equal(service.calls.filter(call => call.options.method === 'POST').length, 2);
  assert.equal(service.calls.filter(call => call.options.method === 'PATCH').length, 0);
  const conflict = releaseService(plan, { existing: { ...plan, body: 'other release' } });
  let firstLookup = true;
  await assert.rejects(publishRelease(plan, releaseInput.repository, 'test-token', async (url, options) => {
    if (url.includes('/releases/tags/') && firstLookup) { firstLookup = false; return response({}, 404); }
    return conflict.request(url, options);
  }), /refusing/);
});

test('publication rejects unsafe identities before sending credentials and does not leak error responses', async () => {
  const plan = releasePlan(releaseInput);
  let calls = 0;
  const request = async () => { calls++; return response({ secret: 'test-token' }, 403); };
  await assert.rejects(publishRelease(plan, releaseInput.repository, '', request), /requires/);
  await assert.rejects(publishRelease(plan, 'example/project?redirect=other', 'test-token', request), /Invalid repository/);
  await assert.rejects(publishRelease({ ...plan, tag_name: '../other' }, releaseInput.repository, 'test-token', request), /exact version/);
  assert.equal(calls, 0);
  await assert.rejects(publishRelease(plan, releaseInput.repository, 'test-token', request), error => /lookup failed/.test(error.message) && !error.message.includes('test-token'));
  assert.equal(calls, 1);
});

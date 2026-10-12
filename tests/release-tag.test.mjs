import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {safetyState,rateLimitWait,fullSafetyPassed,waitForReleaseChecks} from '../scripts/release-tag.mjs';

const sha='a'.repeat(40);
const run=(over)=>({id:1,head_sha:sha,head_branch:'main',event:'push',status:'completed',conclusion:'success',...over});

test('a tag waits for the exact commit\'s main push run and only a success releases it',()=>{
  assert.equal(safetyState([run({})],sha),'passed');
  assert.equal(safetyState([run({status:'in_progress',conclusion:null})],sha),'pending');
  assert.equal(safetyState([run({status:'queued',conclusion:null})],sha),'pending');
  assert.equal(safetyState([run({conclusion:'failure'})],sha),'failed');
  assert.equal(safetyState([],sha),'missing');
  assert.equal(safetyState(undefined,sha),'missing');
});

test('runs for other commits, branches or events never count as evidence',()=>{
  assert.equal(safetyState([run({head_sha:'b'.repeat(40)})],sha),'missing');
  assert.equal(safetyState([run({head_branch:'v1.0.0'})],sha),'missing');
  assert.equal(safetyState([run({event:'pull_request'})],sha),'missing');
});

test('manual and recurring main checks are reusable, while skipped full checks never authorize a tag',()=>{
  for(const event of ['workflow_dispatch','schedule']) assert.equal(safetyState([run({event})],sha),'passed');
  assert.equal(fullSafetyPassed([{name:'safety',status:'completed',conclusion:'success'}]),true);
  for(const jobs of [undefined,[],[{name:'minimum-node',status:'completed',conclusion:'success'}],[{name:'safety',status:'completed',conclusion:'skipped'}],[{name:'safety',status:'in_progress',conclusion:null}]])assert.equal(fullSafetyPassed(jobs),false);
});

test('the newest run for the commit decides, so a rerun can recover a failure',()=>{
  assert.equal(safetyState([run({id:1,conclusion:'failure'}),run({id:2})],sha),'passed');
  assert.equal(safetyState([run({id:1}),run({id:2,conclusion:'failure'})],sha),'failed');
});

test('a used-up rate limit is waited out, any other refusal still stops the tag',()=>{
  const headers=(h)=>new Headers(h), now=1_000_000;
  assert.equal(rateLimitWait(403,headers({'x-ratelimit-remaining':'0','x-ratelimit-reset':String(now/1000+30)}),now),32_000,'waits until the reset plus a margin');
  assert.equal(rateLimitWait(403,headers({'x-ratelimit-remaining':'0','x-ratelimit-reset':String(now/1000-5)}),now),1000,'a reset already past retries after a second');
  assert.equal(rateLimitWait(429,headers({'retry-after':'7'}),now),7000);
  assert.equal(rateLimitWait(403,headers({'x-ratelimit-remaining':'12'}),now),undefined,'a 403 with budget left is a real refusal');
  assert.equal(rateLimitWait(404,headers({'x-ratelimit-remaining':'0'}),now),undefined);
  assert.equal(rateLimitWait(500,headers({}),now),undefined);
});

function workflowService({ states = ['completed'], beforeResponse } = {}) {
  const calls = [], repository = 'example/project';
  let desktopReads = 0;
  const request = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    calls.push({ url, options });
    const override = beforeResponse?.(url, calls);
    if (override) return override;
    const pathname = new URL(url).pathname;
    let value;
    if (pathname.endsWith('/workflows/public-safety.yml')) value = { id: 10, path: '.github/workflows/public-safety.yml' };
    else if (pathname.endsWith('/workflows/desktop.yml')) value = { id: 30, path: '.github/workflows/desktop.yml' };
    else if (pathname.endsWith('/workflows/10/runs') || pathname.endsWith('/workflows/30/runs')) {
      const desktop = pathname.endsWith('/workflows/30/runs');
      const status = desktop ? states[Math.min(desktopReads++, states.length - 1)] : 'completed';
      const row = { ...run({}), id: desktop ? 40 : 20, workflow_id: desktop ? 30 : 10,
        path: `.github/workflows/${desktop ? 'desktop' : 'public-safety'}.yml`,
        repository: { full_name: repository }, head_repository: { full_name: repository },
        status: status === 'failure' ? 'completed' : status,
        conclusion: status === 'completed' ? 'success' : status === 'failure' ? 'failure' : null };
      value = { total_count: 1, workflow_runs: [row] };
    } else if (pathname.endsWith('/runs/20/jobs') || pathname.endsWith('/runs/40/jobs')) {
      value = { jobs: [{ name: pathname.endsWith('/runs/20/jobs') ? 'safety' : 'desktop', status: 'completed', conclusion: 'success' }] };
    } else throw Error(`Unexpected fixture lookup: ${pathname}`);
    return new Response(JSON.stringify(value), { status: 200 });
  };
  return { calls, request };
}

test('tagging waits for desktop too, refreshes both runs and defers job lookups until both finish', async () => {
  const service = workflowService({ states: ['in_progress', 'completed'] });
  const sleeps = [], logs = []; let time = 0;
  const evidence = await waitForReleaseChecks('example/project', sha, { token: 'fixture', request: service.request,
    now: () => time, sleep: async ms => { assert.ok(!service.calls.some(call => call.url.includes('/jobs?'))); sleeps.push(ms); time += ms; }, log: line => logs.push(line) });
  assert.deepEqual(sleeps, [20_000]);
  assert.match(logs[0], /desktop run pending/);
  assert.equal(evidence.safety.id, 20); assert.equal(evidence.desktop.id, 40);
  assert.equal(service.calls.filter(call => call.url.endsWith('/workflows/public-safety.yml')).length, 1);
  assert.equal(service.calls.filter(call => call.url.endsWith('/workflows/desktop.yml')).length, 1);
  assert.equal(service.calls.filter(call => call.url.includes('/workflows/10/runs')).length, 2);
  assert.equal(service.calls.filter(call => call.url.includes('/workflows/30/runs')).length, 2);
  assert.ok(service.calls.every(call => call.options.headers.Authorization === 'Bearer fixture'));
});

test('unauthenticated tagging retains minute polling and its deadline', async () => {
  const service = workflowService({ states: ['queued'] }), sleeps = []; let time = 0;
  await assert.rejects(waitForReleaseChecks('example/project', sha, { timeoutMinutes: 1, request: service.request,
    now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; }, log() {} }), /desktop run is still pending/);
  assert.deepEqual(sleeps, [60_000]);
  assert.ok(service.calls.every(call => !('Authorization' in call.options.headers)));
});

test('rate limiting a desktop job lookup waits and retries that lookup without losing either check', async () => {
  let refused = false, time = 0; const sleeps = [];
  const service = workflowService({ beforeResponse: url => {
    if (!refused && url.includes('/runs/40/jobs')) { refused = true; return new Response('{}', { status: 429, headers: { 'retry-after': '7' } }); }
  } });
  const evidence = await waitForReleaseChecks('example/project', sha, { token: 'fixture', request: service.request,
    now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; }, log() {} });
  assert.deepEqual(sleeps, [7000]); assert.equal(evidence.desktop.id, 40);
  assert.equal(service.calls.filter(call => call.url.includes('/runs/40/jobs')).length, 2);
});

test('failed GUI checks, unsafe identities and rate limits beyond the deadline fail before tagging', async () => {
  const failed = workflowService({ states: ['failure'] });
  await assert.rejects(waitForReleaseChecks('example/project', sha, { request: failed.request, log() {} }), /desktop run failed/);
  assert.ok(!failed.calls.some(call => call.url.includes('/jobs?')));
  let calls = 0;
  const request = async () => { calls++; return new Response('{"private":"fixture"}', { status: 429, headers: { 'retry-after': '900' } }); };
  for (const [repository, commit] of [['../other', sha], ['example/project', 'main']])
    await assert.rejects(waitForReleaseChecks(repository, commit, { request, log() {} }), /repository and exact commit/);
  assert.equal(calls, 0);
  await assert.rejects(waitForReleaseChecks('example/project', sha, { timeoutMinutes: 1, request, sleep: async () => { throw Error('must not sleep past deadline'); }, log() {} }), /lookup failed \(429\)/);
  assert.equal(calls, 1);
});

for (const scenario of ['desktop-failure', 'existing-tag', 'passed']) test(`tag CLI preserves release side effects: ${scenario}`, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-tag-gate-'));
  try {
    fs.mkdirSync(path.join(directory, 'scripts')); fs.mkdirSync(path.join(directory, 'bin'));
    fs.copyFileSync(new URL('../scripts/release-tag.mjs', import.meta.url), path.join(directory, 'scripts/release-tag.mjs'));
    fs.writeFileSync(path.join(directory, 'package.json'), '{"version":"0.2.0"}');
    const gitLog = path.join(directory, 'git.jsonl');
    fs.writeFileSync(path.join(directory, 'bin/git'), `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);\nfs.appendFileSync(process.env.YUNUSPI_TEST_GIT_LOG,JSON.stringify(args)+'\\n');\nif(args[0]==='rev-parse')console.log('${sha}');\nif(args[0]==='remote')console.log('https://github.com/example/project.git');\nif(args[0]==='ls-remote'&&process.env.YUNUSPI_TEST_SCENARIO==='existing-tag')console.log('${sha}\\trefs/tags/v0.2.0');\n`, { mode: 0o755 });
    const preload = path.join(directory, 'fixture.mjs');
    fs.writeFileSync(preload, `globalThis.fetch=async(url)=>{const p=new URL(url).pathname;let data;\nif(p.endsWith('/workflows/public-safety.yml'))data={id:10,path:'.github/workflows/public-safety.yml'};\nelse if(p.endsWith('/workflows/desktop.yml'))data={id:30,path:'.github/workflows/desktop.yml'};\nelse if(p.endsWith('/workflows/10/runs')||p.endsWith('/workflows/30/runs')){const desktop=p.endsWith('/workflows/30/runs');data={total_count:1,workflow_runs:[{id:desktop?40:20,workflow_id:desktop?30:10,path:'.github/workflows/'+(desktop?'desktop':'public-safety')+'.yml',head_sha:'${sha}',head_branch:'main',event:'push',status:'completed',conclusion:desktop&&process.env.YUNUSPI_TEST_SCENARIO==='desktop-failure'?'failure':'success',repository:{full_name:'example/project'},head_repository:{full_name:'example/project'}}]};}\nelse if(p.endsWith('/runs/20/jobs')||p.endsWith('/runs/40/jobs'))data={jobs:[{name:p.endsWith('/runs/20/jobs')?'safety':'desktop',status:'completed',conclusion:'success'}]};\nelse throw Error('Unexpected fixture HTTP lookup');\nreturn new Response(JSON.stringify(data),{status:200});};\n`);
    const env = { ...process.env, PATH: path.join(directory, 'bin') + path.delimiter + process.env.PATH,
      YUNUSPI_TEST_GIT_LOG: gitLog, YUNUSPI_TEST_SCENARIO: scenario, GITHUB_TOKEN: 'fixture' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--import', preload, path.join(directory, 'scripts/release-tag.mjs')], { cwd: directory, env, encoding: 'utf8', timeout: 5000 });
    const mutations = fs.readFileSync(gitLog, 'utf8').trim().split('\n').map(JSON.parse).filter(args => ['tag', 'push'].includes(args[0]));
    if (scenario === 'passed') {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(mutations, [['tag', '-a', 'v0.2.0', '-m', 'YunusPi 0.2.0'], ['push', 'origin', 'v0.2.0']]);
    } else {
      assert.notEqual(result.status, 0); assert.deepEqual(mutations, []);
      assert.match(result.stderr, scenario === 'existing-tag' ? /already exists.*never moved/ : /desktop run failed/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

#!/usr/bin/env node
/** Tag the current commit only after the exact main commit passes both the
 * complete safety suite and the Electron desktop workflow. The release job
 * rechecks the same evidence before publication.
 * Usage: node scripts/release-tag.mjs [--timeout-minutes N]
 * Run it after pushing main; it creates the annotated tag vX.Y.Z from
 * package.json (never moving an existing one) and pushes it. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MAIN_TEST_EVENTS = ['push', 'workflow_dispatch', 'schedule'];
const mainRuns = (runs, sha) => (Array.isArray(runs) ? runs : []).filter(run => run?.head_sha === sha && run.head_branch === 'main' && MAIN_TEST_EVENTS.includes(run.event))
  .sort((a, b) => b.id - a.id);

/** Status of the newest main run. Its full safety job must also pass before tagging. */
export function safetyState(runs, sha) {
  const mine = mainRuns(runs, sha)[0];
  if (!mine) return 'missing';
  if (mine.status !== 'completed') return 'pending';
  return mine.conclusion === 'success' ? 'passed' : 'failed';
}

export function fullSafetyPassed(jobs) {
  return Array.isArray(jobs) && jobs.some(job => job.name === 'safety' && job.status === 'completed' && job.conclusion === 'success');
}

const releaseChecks = [
  { file: 'public-safety.yml', name: 'safety', job: 'safety' },
  { file: 'desktop.yml', name: 'desktop', job: 'desktop' },
];

/** Both callers use the same source, workflow and latest-attempt validation.
 * `read` returns JSON from an authenticated or rate-limit-aware API lookup. */
export async function mainReleaseEvidence(repository, sha, read) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository ?? '')
    || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('Expected a repository and exact commit SHA');
  const base = `https://api.github.com/repos/${repository}`;
  const query = new URLSearchParams({ branch: 'main', head_sha: sha, per_page: '100' });
  const checks = [];
  for (const check of releaseChecks) {
    const workflowPath = `.github/workflows/${check.file}`;
    const workflow = await read(`${base}/actions/workflows/${check.file}`);
    if (workflow?.path !== workflowPath || !Number.isSafeInteger(workflow.id) || workflow.id <= 0)
      throw Error(`Unexpected ${check.name} workflow identity`);
    const runs = await read(`${base}/actions/workflows/${workflow.id}/runs?${query}`);
    if (!Array.isArray(runs?.workflow_runs) || !Number.isSafeInteger(runs.total_count) || runs.total_count < 0
      || runs.total_count > 100 || runs.total_count !== runs.workflow_runs.length)
      throw Error(`Missing or ambiguous main ${check.name} evidence`);
    const run = runs.workflow_runs.filter(row => row?.head_sha === sha && row.head_branch === 'main' && MAIN_TEST_EVENTS.includes(row.event)
      && row.workflow_id === workflow.id && typeof row.path === 'string' && row.path.split('@')[0] === workflowPath
      && row.repository?.full_name === repository && row.head_repository?.full_name === repository
      && Number.isSafeInteger(row.id) && row.id > 0).sort((a, b) => b.id - a.id)[0];
    const state = safetyState(run ? [run] : [], sha);
    if (state === 'failed') return { state, check: check.name };
    checks.push({ ...check, run, state });
  }
  const incomplete = checks.find(check => check.state !== 'passed');
  if (incomplete) return { state: incomplete.state, check: incomplete.name };
  const evidence = { state: 'passed' };
  // Fetch job evidence once both workflows finish. Run evidence stays fresh
  // during polling without spending repeated lookups on already-green jobs.
  for (const check of checks) {
    const jobs = await read(`${base}/actions/runs/${check.run.id}/jobs?filter=latest&per_page=100`);
    if (!Array.isArray(jobs?.jobs) || !jobs.jobs.some(job => job?.name === check.job && job.status === 'completed' && job.conclusion === 'success'))
      throw Error(`The main ${check.name} run did not complete its required ${check.job} job`);
    evidence[check.name] = { id: check.run.id, url: `https://github.com/${repository}/actions/runs/${check.run.id}` };
  }
  return evidence;
}

/** Milliseconds to wait when GitHub refuses a lookup because the rate limit is used up (60 an hour without a
 * token), or undefined for any other failure. */
export function rateLimitWait(status, headers, now = Date.now()) {
  if (status !== 403 && status !== 429) return undefined;
  const retryAfter = Number(headers.get('retry-after')), reset = Number(headers.get('x-ratelimit-reset'));
  if (retryAfter > 0) return retryAfter * 1000;
  if (headers.get('x-ratelimit-remaining') === '0' && reset > 0) return Math.max(1000, reset * 1000 - now + 2000);
  return undefined;
}

export async function waitForReleaseChecks(repository, sha, {
  token, timeoutMinutes = 25, request = fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = message => console.error(message),
} = {}) {
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || timeoutMinutes > 120)
    throw Error('Expected --timeout-minutes between 1 and 120');
  const deadline = now() + timeoutMinutes * 60_000;
  const interval = token ? 20_000 : 60_000;
  const workflowIdentities = new Map();
  const read = async url => {
    if (workflowIdentities.has(url)) return workflowIdentities.get(url);
    for (;;) {
      const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } });
      if (response.status === 200) {
        const data = await response.json();
        if (releaseChecks.some(check => url.endsWith(`/actions/workflows/${check.file}`))) workflowIdentities.set(url, data);
        return data;
      }
      const wait = rateLimitWait(response.status, response.headers, now());
      if (wait === undefined || now() + wait > deadline) throw Error(`GitHub release evidence lookup failed (${response.status})`);
      log(`GitHub rate limit reached; waiting ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
    }
  };
  for (;;) {
    const evidence = await mainReleaseEvidence(repository, sha, read);
    if (evidence.state === 'passed') return evidence;
    if (evidence.state === 'failed') throw Error(`The main ${evidence.check} run failed for ${sha.slice(0, 7)}; fix it before tagging`);
    if (now() >= deadline) throw Error(`The main ${evidence.check} run is still ${evidence.state} after ${timeoutMinutes} minutes; rerun later`);
    log(`main ${evidence.check} run ${evidence.state}; waiting`);
    await sleep(interval);
  }
}

async function main() {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const timeoutIndex = process.argv.indexOf('--timeout-minutes');
  const limit = Number(timeoutIndex > 0 ? process.argv[timeoutIndex + 1] : 25);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 120) throw Error('Expected --timeout-minutes between 1 and 120');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, tag = `v${version}`;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Only stable versions are tagged');
  if (git('status', '--porcelain')) throw Error('The working tree has uncommitted changes; commit and push main first');
  git('fetch', '--quiet', 'origin', 'main');
  const sha = git('rev-parse', 'HEAD');
  if (git('rev-parse', 'origin/main') !== sha) throw Error('HEAD is not the pushed tip of origin/main; push main first');
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(git('remote', 'get-url', 'origin'));
  if (!match) throw Error('origin is not a GitHub repository');
  await waitForReleaseChecks(match[1], sha, { timeoutMinutes: limit, token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN });
  const existing = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`);
  if (existing) throw Error(`${tag} already exists on origin; release tags are never moved`);
  git('tag', '-a', tag, '-m', `YunusPi ${version}`);
  git('push', 'origin', tag);
  console.log(JSON.stringify({ tag, sha, repository: match[1] }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

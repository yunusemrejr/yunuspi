#!/usr/bin/env node
/** Tag the current commit for release only after GitHub has finished the main
 * safety run for that exact commit. The release job verifies the same run, so
 * a tag pushed while main is still running fails and has to be recreated.
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

/** Milliseconds to wait when GitHub refuses a lookup because the rate limit is used up (60 an hour without a
 * token), or undefined for any other failure. */
export function rateLimitWait(status, headers, now = Date.now()) {
  if (status !== 403 && status !== 429) return undefined;
  const retryAfter = Number(headers.get('retry-after')), reset = Number(headers.get('x-ratelimit-reset'));
  if (retryAfter > 0) return retryAfter * 1000;
  if (headers.get('x-ratelimit-remaining') === '0' && reset > 0) return Math.max(1000, reset * 1000 - now + 2000);
  return undefined;
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
  const query = new URLSearchParams({ branch: 'main', head_sha: sha, per_page: '20' });
  const url = `https://api.github.com/repos/${match[1]}/actions/workflows/public-safety.yml/runs?${query}`;
  const deadline = Date.now() + limit * 60_000, token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  // Without a token the whole machine shares 60 lookups an hour, so poll once a minute and sit out a refusal.
  const interval = token ? 20_000 : 60_000;
  for (;;) {
    const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200) {
      const wait = rateLimitWait(response.status, response.headers);
      if (wait === undefined || Date.now() + wait > deadline) throw Error(`GitHub run lookup failed (${response.status})`);
      console.error(`GitHub rate limit reached; waiting ${Math.ceil(wait / 1000)}s`);
      await new Promise(resolve => setTimeout(resolve, wait));
      continue;
    }
    const runs = (await response.json()).workflow_runs;
    const state = safetyState(runs, sha);
    if (state === 'passed') {
      const run = mainRuns(runs, sha)[0];
      const evidence = await fetch(`https://api.github.com/repos/${match[1]}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, {
        headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30_000),
      });
      if (evidence.status !== 200) throw Error(`Full safety job lookup failed (${evidence.status})`);
      if (!fullSafetyPassed((await evidence.json()).jobs)) throw Error('Quick checks alone cannot authorize a release. Run the complete workflow on main before tagging.');
      break;
    }
    if (state === 'failed') throw Error(`The main safety run failed for ${sha.slice(0, 7)}; fix it before tagging`);
    if (Date.now() > deadline) throw Error(`The main safety run is still ${state} after ${limit} minutes; rerun later`);
    console.error(`main safety run ${state}; waiting`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  const existing = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`);
  if (existing) throw Error(`${tag} already exists on origin; release tags are never moved`);
  git('tag', '-a', tag, '-m', `YunusPi ${version}`);
  git('push', 'origin', tag);
  console.log(JSON.stringify({ tag, sha, repository: match[1] }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

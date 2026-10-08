#!/usr/bin/env node
// One small catalogue for routine checks; the full suite is discovered, never curated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createDistributionTempRoot } from '../agent/scripts/publish-public.mjs';

const root = path.resolve(import.meta.dirname, '..');
export const QUICK_TESTS = [
  'command-dispatch', 'core-robustness', 'preflight-stop-cancellation', 'autonomous-triage-cancellation',
  'provider-gate', 'provider-health-admission', 'provider-health-stall',
  'double-runner', 'quality-review', 'scope-deliberation',
  'project-vector-memory', 'memory-embedding-coverage', 'jev-client',
  'stream-lifecycle', 'rpc-client-lifecycle', 'guarded-process',
  'needle-embedding-cache', 'memory-guard', 'creative-evidence', 'creative-qa',
  'ui-doctrine', 'goal-state', 'completion-gate', 'motion-routing-sdk',
  'source-integrity', 'release-tag', 'release-version', 'test-pipeline',
].map(name => `tests/${name}.test.mjs`);

// A shared build/dependency/safety change needs the complete distribution gate.
const FULL_CHANGE = /^(?:core\/|config\/|\.github\/|\.githooks\/|scripts\/|package(?:-lock)?\.json$|agent\/npm\/|agent\/extensions\/manifest\.json$|agent\/scripts\/|tests\/(?![^/]+\.test\.mjs$)|tests\/[^/]*(?:browser|render|media|video|blender|sandbox|isolation|desktop|source-syntax|install|update|public-safety)[^/]*\.test\.mjs$)/;
export function testPlan({ files, changed = [], event, knownBase = true, quick = false }) {
  const full = !quick || !knownBase || ['schedule', 'workflow_dispatch'].includes(event)
    || changed.some(file => FULL_CHANGE.test(file));
  const selected = full ? files : [...new Set([...QUICK_TESTS, ...changed.filter(file => files.includes(file))])].sort();
  for (const file of selected) if (!files.includes(file)) throw Error(`Missing registered test: ${file}`);
  if (!selected.length) throw Error('No tests selected');
  return { full, selected };
}

export function testConcurrency(value, cores = os.availableParallelism()) {
  if (value === undefined) return Math.max(1, Math.min(4, cores));
  if (!/^(?:[1-9]|1[0-6])$/.test(value)) throw Error('PI_PUBLIC_TEST_CONCURRENCY must be 1-16 (default capped at 4)');
  return Number(value);
}

function main(args) {
  let quick = false, list = false, planOnly = false, base;
  const explicit = [], native = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--quick') quick = true;
    else if (arg === '--list') list = true;
    else if (arg === '--plan') planOnly = true;
    else if (arg === '--base') base = args[++i] ?? '';
    else if (/^tests\/[^/]+\.test\.mjs$/.test(arg)) explicit.push(arg);
    else if (/^--test-(?:name-pattern|skip-pattern|reporter|reporter-destination|timeout)(?:=|$)/.test(arg)) {
      const flag = arg.split('=')[0], value = arg.includes('=') ? arg.slice(flag.length + 1) : args[++i];
      if (!value || value.startsWith('--')) throw Error(`Missing value for ${flag}`);
      native.push(`${flag}=${value}`);
    } else if (['--test-only', '--experimental-test-coverage'].includes(arg)) native.push(arg);
    else throw Error(`Unknown test argument: ${arg}`);
  }
  const files = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`).sort();
  let changed = [], knownBase = true;
  if (base !== undefined) {
    knownBase = /^[a-f0-9]{40}$/.test(base) && !/^0+$/.test(base);
    if (knownBase) {
      try { changed = execFileSync('git', ['diff', '--name-only', '-z', base, 'HEAD', '--'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean); }
      catch { knownBase = false; } // Unknown history runs everything, never an empty check.
    }
  }
  const plan = testPlan({ files, changed, event: base !== undefined || planOnly ? process.env.GITHUB_EVENT_NAME : undefined, knownBase, quick });
  if (explicit.length) {
    for (const file of explicit) if (!files.includes(file)) throw Error(`Unknown test: ${file}`);
    plan.selected = [...new Set(quick ? [...plan.selected, ...explicit] : explicit)].sort();
    if (!quick) plan.full = false;
  }
  if (planOnly) {
    console.log(JSON.stringify({ ...plan, count: plan.selected.length }));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `full=${plan.full}\n`);
    return;
  }
  if (list) { console.log(plan.selected.join('\n')); return; }
  const concurrency = testConcurrency(process.env.PI_PUBLIC_TEST_CONCURRENCY);
  const tempRoot = createDistributionTempRoot();
  try {
    console.log(`Running ${plan.selected.length} test files (${explicit.length && !quick ? 'focused' : plan.full ? 'full' : 'quick'}, concurrency ${concurrency})`);
    const run = spawnSync(process.execPath, ['--test', '--test-timeout=120000', `--test-concurrency=${concurrency}`, ...native, ...plan.selected], {
      cwd: root, stdio: 'inherit', timeout: 15 * 60_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, PI_LOCAL_LM: 'off', PI_NEEDLE_DISK_CACHE: 'off', TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot },
    });
    if (run.error) throw run.error;
    process.exitCode = run.status ?? 1;
  } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

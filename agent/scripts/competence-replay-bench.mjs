#!/usr/bin/env node
/** Replays tool-step outcomes through the real competence estimator and reports
 * what its control levels predict and change. Default: a seeded synthetic
 * workload with the structure measured on recorded sessions (route and session
 * heterogeneity, self-exciting bursts, aged history carried between sessions),
 * so the result is deterministic and CI-safe. `--sessions <dir>` replays recorded
 * session JSONL instead (private data stays local; only aggregates are printed).
 * Synthetic numbers verify the estimator's behavior on a known process; they
 * are not a claim about live task outcomes. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import {
  classifyToolOutcome, createCompetenceEstimator, createStepTracker, mergeCompetence, priorFromAggregate,
  fleetRateFromAggregate, COMPETENCE_PARAMS,
} from '../extensions/lib/model-competence.ts';
import { classifyExecution } from '../extensions/lib/adaptive-execution.ts';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sessionsDir = flag('--sessions'), since = Date.parse(flag('--since') ?? '2026-09-10'), HORIZON = 20, DAY = 86_400_000;
const isStrong = outcome => ['slip', 'stall', 'reversal'].includes(outcome.cls) && outcome.weight >= 0.5;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** Synthetic sessions: a good, a typical and a weak route; each session has its own base slip rate
 * and every strong slip excites the next steps (decaying), as measured on recorded sessions. */
function syntheticSessions() {
  const random = rng(20261004);
  const normal = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
  const routes = [['synthetic/steady', 0.015], ['synthetic/typical', 0.035], ['synthetic/erratic', 0.085]];
  const tools = ['read', 'edit', 'bash', 'grep'], failing = ['edit', 'bash', 'todo'];
  const sessions = [];
  for (let n = 0; n < 45; n++) for (const [route, mean] of routes) {
    const base = Math.min(0.3, Math.max(0.003, mean * Math.exp(0.5 * normal() - 0.125)));
    const outcomes = []; let excitement = 0;
    for (let step = 0; step < 150; step++) {
      const p = Math.min(0.6, base + excitement);
      excitement *= 0.55;
      if (random() < p) {
        const strong = random() < 0.7;
        outcomes.push(strong ? { cls: 'slip', weight: 1, family: failing[Math.floor(random() * failing.length)] } : { cls: 'check', weight: 0.35, family: 'check' });
        if (strong) excitement += 0.09;
      } else outcomes.push({ cls: 'clean', weight: 1, family: tools[Math.floor(random() * tools.length)] });
    }
    sessions.push({ route, at: Date.UTC(2026, 8, 1) + sessions.length * 0.4 * DAY, outcomes });
  }
  return sessions;
}

async function recordedSessions(root) {
  const READ_ONLY = /^\s*(?:cd [^;&|]+&&\s*)?(?:ls|cat|head|tail|grep|rg|find|wc|stat|file|pwd|which|echo|date|git (?:log|status|diff|show|branch|rev-parse|ls-files)|jq|curl)\b(?![^|]*>)/;
  const { projectCheckCommand } = await import('../extensions/lib/project-tests.ts');
  const files = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const name of fs.readdirSync(full)) if (name.endsWith('.jsonl')) { const file = path.join(full, name); if (fs.statSync(file).mtimeMs >= since) files.push(file); }
  }
  const sessions = [];
  for (const file of files) {
    const calls = new Map(), tracker = createStepTracker(), outcomes = []; let cwd = '/', at = 0, route = '';
    for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      at ||= Date.parse(row.timestamp ?? '') || 0;
      if (row.type === 'session') { cwd = row.cwd || '/'; continue; }
      const message = row.message; if (!message) continue;
      if (message.role === 'assistant') { route = `${message.provider}/${message.model}`; for (const block of message.content ?? []) if (block.type === 'toolCall') calls.set(block.id, { name: block.name, args: block.arguments ?? {}, route }); }
      else if (message.role === 'toolResult') {
        const call = calls.get(message.toolCallId); if (!call) continue;
        const text = (message.content ?? []).map(part => part.text ?? '').join(' '), command = call.args.command;
        const shell = call.name === 'bash' || call.name === 'bg_run';
        const mutated = ['edit', 'write', 'bulk_edit'].includes(call.name) && !message.isError || shell && typeof command === 'string' && !READ_ONLY.test(command);
        const flags = tracker.track({ toolName: call.name, args: call.args, text, isError: message.isError === true, mutated });
        outcomes.push({ route: call.route, outcome: classifyToolOutcome({ toolName: call.name, isError: message.isError === true, text, check: shell && typeof command === 'string' && Boolean(projectCheckCommand(command, cwd)), ...flags }) });
      }
    }
    if (outcomes.length) sessions.push({ at, outcomes: outcomes.map(row => row.outcome), routes: outcomes.map(row => row.route) });
  }
  return sessions.sort((a, b) => a.at - b.at).map(session => ({ ...session, route: session.routes?.[0] ?? 'recorded/unknown' }));
}

function replay(sessions) {
  const store = new Map(), steps = [];
  for (const session of sessions) {
    const estimators = new Map(), fleetRate = fleetRateFromAggregate(store.get('*'), session.at), rows = [];
    session.outcomes.forEach((outcome, index) => {
      const route = session.routes?.[index] ?? session.route;
      let estimator = estimators.get(route);
      if (!estimator) { estimator = createCompetenceEstimator(priorFromAggregate(store.get(route), session.at), { fleetRate }); estimators.set(route, estimator); }
      const before = estimator.snapshot();
      estimator.observe(outcome);
      if (outcome.cls !== 'neutral') rows.push({ route, level: before.level, burst: Boolean(before.burst), n: before.steps, strong: isStrong(outcome), high: before.slip.high, low: before.slip.low });
    });
    const end = session.at + 0.1 * DAY;
    for (const [route, estimator] of estimators) { const delta = estimator.takeDelta(); store.set(route, mergeCompetence(store.get(route), delta, end)); store.set('*', mergeCompetence(store.get('*'), delta, end)); }
    steps.push(rows);
  }
  return steps;
}

const sessions = sessionsDir ? await recordedSessions(sessionsDir) : syntheticSessions();
const perSession = replay(sessions), all = perSession.flat();
const rate = rows => rows.length ? rows.reduce((sum, row) => sum + row.fut, 0) / rows.length : NaN;
const prediction = [];
for (const rows of perSession) for (let i = 0; i + HORIZON < rows.length; i++) {
  if (rows[i].n < COMPETENCE_PARAMS.minStepsGuarded) continue;
  let fut = 0, next5 = 0;
  for (let j = i + 1; j <= i + HORIZON; j++) fut += rows[j].strong ? 1 : 0;
  for (let j = i + 1; j <= i + 5; j++) next5 += rows[j].strong ? 1 : 0;
  prediction.push({ level: rows[i].level, burst: rows[i].burst, fut: fut / HORIZON, any5: next5 > 0 ? 1 : 0 });
}
const byLevel = level => prediction.filter(row => row.level === level);
const mean = values => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
let transitions = 0;
for (const rows of perSession) for (let i = 1; i < rows.length; i++) if (rows[i].level !== rows[i - 1].level) transitions++;
const occupancy = Object.fromEntries(['earned', 'standard', 'guarded'].map(level => [level, Number((all.filter(row => row.level === level).length / Math.max(1, all.length)).toFixed(3))]));
const burstRows = prediction.filter(row => row.burst), quietRows = prediction.filter(row => !row.burst);
// What the control changes for work of the same difficulty: the real policy at each level.
const policy = ['direct', 'standard', 'complex'].flatMap(tier => ['earned', 'standard', 'guarded'].map(level => {
  const task = { direct: 'Fix a one-line typo', standard: 'Investigate why the parser check fails', complex: 'Redesign the settings page layout' }[tier];
  const profile = classifyExecution({ task, control: { level } });
  return { tier: profile.tier, level, observerMs: profile.cadence.observerMs, watchmakerMs: profile.cadence.watchmakerMs, reviewers: profile.review.reviewers, autoHelper: profile.features.assistance, observer: profile.features.observer, qualityReview: profile.features.qualityReview };
}));
const result = {
  kind: sessionsDir ? 'recorded sessions' : 'seeded synthetic workload (measured structure, not live outcomes)',
  sessions: sessions.length, steps: all.length, horizonSteps: HORIZON,
  occupancy, transitionsPer100Steps: Number((100 * transitions / Math.max(1, all.length)).toFixed(2)),
  futureStrongSlipRate: Object.fromEntries(['earned', 'standard', 'guarded'].map(level => [level, Number(mean(byLevel(level).map(row => row.fut)).toFixed(4))])),
  burst: { shareOfSteps: Number((all.filter(row => row.burst).length / Math.max(1, all.length)).toFixed(4)), nextFiveStepsSlip: Number(mean(burstRows.map(row => row.any5)).toFixed(3)), otherwise: Number(mean(quietRows.map(row => row.any5)).toFixed(3)) },
  policy,
};
console.log(JSON.stringify(result, null, 2));
if (!sessionsDir) {
  const f = result.futureStrongSlipRate;
  assert.ok(f.earned < f.standard && f.standard < f.guarded, 'control levels order the future slip rate');
  assert.ok(f.guarded >= 1.8 * f.earned, `guarded routes must slip clearly more than earned ones (${f.guarded} vs ${f.earned})`);
  assert.ok(result.burst.nextFiveStepsSlip >= 2 * result.burst.otherwise, 'a burst predicts further slips');
  assert.ok(occupancy.earned <= 0.45 && occupancy.guarded <= 0.2 && occupancy.earned > 0 && occupancy.guarded > 0, 'levels are rare enough to mean something and present enough to matter');
  assert.ok(result.transitionsPer100Steps <= 1.5, 'levels do not flap');
  const light = policy.find(row => row.tier === 'complex' && row.level === 'earned'), tight = policy.find(row => row.tier === 'complex' && row.level === 'guarded'), base = policy.find(row => row.tier === 'complex' && row.level === 'standard');
  assert.ok(light.observerMs > base.observerMs && base.observerMs > tight.observerMs, 'earned routes are observed less often than guarded ones');
  assert.ok(light.reviewers <= base.reviewers, 'freedom never adds reviewers');
}

#!/usr/bin/env node
/** Compare candidate GGUF models for the local language model's real jobs:
 * yes/no skill-relevance judgements (P(yes) from the first token of the
 * production few-shot prompt, scored as AUC and accuracy at the production
 * threshold) and shortlist choices (letter answer, scored as accepted and
 * correct). Each candidate is served by the installed llama.cpp runtime on a
 * scratch port with the production server flags; nothing here changes the
 * harness configuration.
 *
 * node scripts/benchmark-local-lm-candidates.mjs --live --models a.gguf,b.gguf [--threads 4] [--port 18799] [--repeat 3]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createLocalLm, yesProbability, skillRelevancePrompt, SKILL_RELEVANCE_THRESHOLD, SKILL_RELEVANCE_EXAMPLES, localLmPost, warmLocalLmPrefix } from '../agent/extensions/lib/local-lm.ts';
import { localLmDir } from '../agent/extensions/lib/local-lm-assets.mjs';

if (!process.argv.includes('--live')) throw Error('Pass --live to serve and evaluate local models.');
const arg = (name, fallback) => { const hit = process.argv.find(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; };
const models = arg('models', '').split(',').map(s => s.trim()).filter(Boolean);
if (!models.length) throw Error('Pass --models=a.gguf,b.gguf');
const threads = Number(arg('threads', 4)), port = Number(arg('port', 18799)), repeat = Number(arg('repeat', 1));
const runtimeDir = localLmDir();
// The scratch server runs without --api-key-file; the client header is required but unchecked.
const benchKey = `bench-${process.pid}`;
const server = fs.readdirSync(path.join(runtimeDir, 'runtime')).map(d => path.join(runtimeDir, 'runtime', d, 'llama-server')).find(f => fs.existsSync(f));
if (!server) throw Error('llama-server runtime not installed');
const fixtures = new URL('../tests/fixtures/micro-intel/', import.meta.url);
const relevance = JSON.parse(fs.readFileSync(new URL('skill-relevance.json', fixtures), 'utf8'));
const choices = JSON.parse(fs.readFileSync(new URL('local-choices.json', fixtures), 'utf8'));
const focus = [['correctness', 'correctness: logic, invariants and edge cases'], ['security', 'security: authorization, injection and trust boundaries'], ['performance', 'performance: latency, throughput and resource use'], ['maintainability', 'maintainability: duplication, coupling and clarity'], ['testing', 'testing: coverage and regression checks'], ['architecture', 'architecture: boundaries and system design'], ['product', 'product: requirements and user experience']].map(([id, text]) => ({ id, text }));

function auc(rows) {
  const pos = rows.filter(r => r.label), neg = rows.filter(r => !r.label);
  if (!pos.length || !neg.length) return undefined;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p.p > n.p ? 1 : p.p === n.p ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : undefined; };

async function serve(model) {
  const child = spawn(server, ['--model', model, '--host', '127.0.0.1', '--port', String(port), '--parallel', '1', '--threads', String(threads), '--threads-batch', '6', '--checkpoint-min-step', '0', '--ctx-checkpoints', '4', '--cache-ram', '256', '--ctx-size', '4096', '--n-predict', '128', '--no-webui', '--log-disable'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(`llama-server exited ${child.exitCode}: ${stderr}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return child; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 300));
  }
  child.kill('SIGKILL');
  throw Error(`llama-server did not become healthy: ${stderr}`);
}

async function evaluate(model) {
  const child = await serve(model);
  const runtime = { version: 2, enabled: true, model: path.basename(model), endpoint: `http://127.0.0.1:${port}/completion`, apiKey: benchKey, execution: 'background', timeoutMs: 20_000 };
  const rss = () => { try { return Number(fs.readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) / 1024; } catch { return undefined; } };
  try {
    const post = localLmPost(runtime, fetch, new AbortController().signal);
    await warmLocalLmPrefix(post, SKILL_RELEVANCE_EXAMPLES).catch(() => {});
    const rows = [], latencies = [];
    for (let round = 0; round < repeat; round++) for (const example of relevance) {
      const prompt = skillRelevancePrompt(example.task, { name: example.skill, description: example.description });
      const started = performance.now();
      const body = await post({ prompt, n_predict: 1, n_probs: 10, cache_prompt: true });
      latencies.push(performance.now() - started);
      const p = yesProbability(body);
      if (round === 0) rows.push({ id: example.id, label: example.helps, p: p ?? 0.5, parsed: p !== undefined });
    }
    const accuracy = rows.filter(r => (r.p >= SKILL_RELEVANCE_THRESHOLD) === r.label).length / rows.length;
    const kept = rows.filter(r => r.p >= SKILL_RELEVANCE_THRESHOLD);
    const precision = kept.length ? kept.filter(r => r.label).length / kept.length : undefined;
    const recall = rows.filter(r => r.label && r.p >= SKILL_RELEVANCE_THRESHOLD).length / rows.filter(r => r.label).length;
    const lm = createLocalLm({ runtime, fetch });
    const choiceRows = [], choiceLatencies = [];
    for (const example of choices) {
      const candidates = example.focus ? focus : example.choices.map((text, i) => ({ id: String(i), text }));
      const started = performance.now();
      const result = await lm.choose(example.task, candidates, example.focus ? 'review-focus-evaluation' : 'discovery-evaluation');
      choiceLatencies.push(performance.now() - started);
      choiceRows.push({ id: example.id, accepted: result.ok, correct: result.ok ? result.id === String(example.expected) : example.expected === null });
    }
    const accepted = choiceRows.filter(r => r.accepted);
    return {
      model: path.basename(model), bytesMb: Math.round(fs.statSync(model).size / 1e6), rssMb: Math.round(rss() ?? 0),
      relevance: { cases: rows.length, auc: Number(auc(rows)?.toFixed(3)), accuracy: Number(accuracy.toFixed(3)), precision: precision === undefined ? undefined : Number(precision.toFixed(3)), recall: Number(recall.toFixed(3)), unparsed: rows.filter(r => !r.parsed).length, p50Ms: Math.round(median(latencies)), p50WarmMs: Math.round(median(latencies.slice(relevance.length)) ?? median(latencies)), wrong: rows.filter(r => (r.p >= SKILL_RELEVANCE_THRESHOLD) !== r.label).map(r => `${r.id}:${r.p.toFixed(2)}`) },
      choices: { cases: choiceRows.length, accepted: accepted.length, correctAccepted: accepted.filter(r => r.correct).length, correctOverall: choiceRows.filter(r => r.correct).length, p50Ms: Math.round(median(choiceLatencies)) },
    };
  } finally {
    child.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 500));
  }
}

const results = [];
for (const model of models) {
  try { results.push(await evaluate(model)); console.error(JSON.stringify(results.at(-1))); }
  catch (error) { results.push({ model: path.basename(model), error: String(error.message).slice(0, 400) }); console.error(JSON.stringify(results.at(-1))); }
}
console.log(JSON.stringify({ threads, host: os.cpus()[0]?.model, results }, null, 2));

#!/usr/bin/env node
/** Live local-only advisory evaluation; never changes harness configuration. */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createLocalLm, loadLocalLmRuntime } from '../agent/extensions/lib/local-lm.ts';
if (!process.argv.includes('--live')) throw Error('Pass --live to evaluate the installed local model.');
const runtime = await loadLocalLmRuntime();
if (!runtime) throw Error('The pinned local Qwen runtime is unavailable or disabled.');
const cases = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/micro-intel/local-choices.json', import.meta.url), 'utf8'));
const focus = [
 ['correctness','correctness: logic, invariants and edge cases'], ['security','security: authorization, injection and trust boundaries'],
 ['performance','performance: latency, throughput and resource use'], ['maintainability','maintainability: duplication, coupling and clarity'],
 ['testing','testing: coverage and regression checks'], ['architecture','architecture: boundaries and system design'], ['product','product: requirements and user experience'],
].map(([id,text]) => ({id,text}));
const lm = createLocalLm({runtime}), rows = [];
for (const example of cases) {
 const candidates = example.focus ? focus : example.choices.map((text,i) => ({id:String(i),text}));
 const start = performance.now();
 const result = await lm.choose(example.task,candidates,example.focus?'review-focus-evaluation':'discovery-evaluation');
 rows.push({id:example.id,expected:example.expected,accepted:result.ok,correct:result.ok ? result.id === String(example.expected) : example.expected === null,latencyMs:performance.now()-start,result});
}
const accepted = rows.filter(row => row.accepted);
console.log(JSON.stringify({model:runtime.model,cases:rows.length,accepted:accepted.length,correctAccepted:accepted.filter(row=>row.correct).length,rows},null,2));

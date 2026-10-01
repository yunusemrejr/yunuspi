#!/usr/bin/env node
/** Compare repeated local advisory inference. No configuration is changed. */
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as candidate from '../agent/extensions/lib/local-lm.ts';

if (!process.argv.includes('--live')) throw Error('Pass --live to evaluate the installed local Qwen model.');
const baselineArg = process.argv.indexOf('--baseline');
if (baselineArg < 0 || !process.argv[baselineArg + 1]) throw Error('Pass --baseline /path/to/previous/local-lm.ts.');
const baseline = await import(pathToFileURL(resolve(process.argv[baselineArg + 1])).href);
const runtime = await candidate.loadLocalLmRuntime();
if (!runtime) throw Error('The installed local Qwen runtime is unavailable or disabled.');
const tasks = [
 ['Review a Rust CLI for memory leaks', {name:'rust-systems-engineering', description:'Rust lifetimes, safe ownership and memory correctness'}],
 ['Build a Python command line parser', {name:'python-software-engineering', description:'Python applications, typing and test design'}],
 ['Fix focus navigation in a dialog', {name:'accessible-interaction-design', description:'Keyboard navigation, focus and assistive technology'}],
];
const clients = Object.fromEntries([['baseline', baseline], ['candidate', candidate]].map(([name, module]) =>
 [name, module.createLocalLm({runtime, fetch:(...args)=>fetch(...args)})]));
const prompts = tasks.map(([task, skill]) => candidate.skillRelevancePrompt(task, skill));
const options = {prefix:candidate.SKILL_RELEVANCE_EXAMPLES};
const probabilities = {}, samples = {baseline:[], candidate:[]};
for (const name of ['baseline', 'candidate']) {
 probabilities[name] = [];
 for (const prompt of prompts) {
  const result = await clients[name].judge(prompt, 'reuse-benchmark-warmup', options);
  if (!result.ok) throw Error(`${name} warmup: ${result.reason}`);
  probabilities[name].push(result.p);
 }
}
let maxProbabilityDifference = 0;
for (let trial = 0; trial < 5; trial++) for (let index = 0; index < prompts.length; index++) {
 for (const name of trial % 2 ? ['candidate','baseline'] : ['baseline','candidate']) {
  const started = performance.now();
  const result = await clients[name].judge(prompts[index], 'reuse-benchmark', options);
  if (!result.ok) throw Error(`${name} inference: ${result.reason}`);
  samples[name].push(performance.now() - started);
  maxProbabilityDifference = Math.max(maxProbabilityDifference, Math.abs(result.p - probabilities.candidate[index]));
 }
}
const percentile = (values, quantile) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length * quantile) - 1];
console.log(JSON.stringify({model:runtime.model, workload:'three fixed advisory prompts, five repeats each, alternating order after warmup',
 maxProbabilityDifference, results:Object.fromEntries(Object.entries(samples).map(([name, values])=>
 [name,{samples:values.length,p50Ms:percentile(values,.5),p95Ms:percentile(values,.95),stats:clients[name].stats()}]))},null,2));

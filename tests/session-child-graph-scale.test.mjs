import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSessionCost, collectSessionMetrics } from '../core/coding-agent/src/core/session-accounting.js';

const usage = { input: 7, output: 3, turns: 1, cost: { total: 0.125, source: 'provider-reported' } };
const child = runId => ({ runId, exitCode: 0, model: 'fixture/model', usage });
const receipt = (runId, result) => ({ type: 'custom', customType: 'subagent-cost-v1', data: { runId, results: [result] } });

test('cost and metrics count each child once when many exact identities arrive late', () => {
  const count = 2500;
  const entries = [];
  for (let index = 0; index < count; index++) {
    entries.push(receipt('legacy-' + index, child(undefined)));
    entries.push(receipt('independent-' + index, child('native-' + index)));
  }
  for (let index = 0; index < count; index++) entries.push(receipt('legacy-' + index, child('native-' + index)));

  const cost = collectSessionCost(entries);
  const metrics = collectSessionMetrics(entries);
  assert.equal(cost.children.reported, 0.125 * count);
  assert.equal(cost.pending, 0);
  assert.equal(cost.unknown, false);
  assert.equal(metrics.agents, count);
  assert.equal(metrics.agentsCompleted, count);
  assert.equal(metrics.childTokens, 10 * count);
});

test('shallow child receipts can form a deep graph without recursive footer evaluation', () => {
  const count = 6000;
  const entries = Array.from({ length: count }, (_, index) => receipt(
    'wrapper-' + index, { ...child('native-' + index), children: [child('native-' + (index + 1))] },
  ));
  const cost = collectSessionCost(entries);
  assert.equal(cost.children.reported, 0.125 * (count + 1));
  assert.equal(cost.pending, 0);
  assert.equal(cost.unknown, false);
});

test('cyclic receipts mark the measured total as partial without charging a child twice', () => {
  const entries = [
    receipt('first', { ...child('first'), children: [child('second')] }),
    receipt('second', { ...child('second'), children: [child('first')] }),
  ];
  const cost = collectSessionCost(entries);
  assert.equal(cost.children.reported, 0.25);
  assert.equal(cost.unknown, true);
  assert.match(cost.formatted, /\+\?$/);
});

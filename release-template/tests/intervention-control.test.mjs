import test from 'node:test';
import assert from 'node:assert/strict';
import { InterventionControl } from '../core/coding-agent/src/core/intervention-control.js';
import { createInterventionSession } from '../core/coding-agent/src/core/intervention-session.js';
import { getSharedSession, noteUserInput, resetSharedControl } from '../agent/extensions/lib/intervention-shared.ts';
import { enforceAssistanceFlow } from '../agent/extensions/pi-subagents/src/runs/shared/assistance-shadow.ts';

const intent = (requestId, extra = {}) => ({
  source: 'fixture', requestId, category: 'context', priority: 50,
  reason: 'bounded fixture context', stabilityKey: 'fixture', ttlMs: 10_000,
  estimatedChars: 100, estimatedCost: 0, blocking: false, evidence: [], ...extra,
});

test('shadow evaluation accepts immutable intent without changing caller input or spending', () => {
  const control = new InterventionControl();
  const input = Object.freeze(intent(control.beginCycle()));
  assert.equal(control.evaluate(input).outcome, 'admitted');
  assert.equal(control.spentBudget().contextChars, 0);
  assert.equal(Object.hasOwn(input, 'id'), false);
  assert.equal(Object.hasOwn(input, 'createdAt'), false);
});

test('a committed admission cannot authorize work after its request ends', () => {
  const control = new InterventionControl();
  const requestId = control.beginCycle();
  const input = intent(requestId, { id: 'same' });
  assert.equal(control.commit(input).outcome, 'admitted');
  assert.equal(control.commit(input).outcome, 'admitted');
  assert.equal(control.spentBudget().contextChars, 100, 'same live intent spends once');
  control.endCycle(requestId);
  assert.equal(control.commit(input).outcome, 'suppressed-stale');
});

test('reusing an intent id in a new request spends the new request budget', () => {
  const control = new InterventionControl();
  const first = intent(control.beginCycle(), { id: 'repeat' });
  control.commit(first);
  const requestId = control.beginCycle();
  const decision = control.commit(intent(requestId, { id: 'repeat' }));
  assert.equal(decision.outcome, 'admitted');
  assert.equal(decision.requestId, requestId);
  assert.equal(control.spentBudget().contextChars, 100);
});

test('an idempotency id cannot be replayed with a different effect', () => {
  const control = new InterventionControl();
  const requestId = control.beginCycle();
  control.commit(intent(requestId, { id: 'same' }));
  const decision = control.commit(intent(requestId, { id: 'same', category: 'assistance', estimatedCost: 0.01 }));
  assert.equal(decision.outcome, 'rejected-invalid');
  assert.equal(control.spentBudget().helperChildren, 0);
});

test('an expired committed intent keeps its original age when replayed', () => {
  let now = 100;
  const control = new InterventionControl({ clock: () => now });
  const input = intent(control.beginCycle(), { id: 'aging', ttlMs: 50 });
  assert.equal(control.commit(input).outcome, 'admitted');
  now = 151;
  assert.equal(control.commit(input).outcome, 'suppressed-expired');
  assert.equal(control.spentBudget().contextChars, 100);
});

test('distinct fast user requests get separate cycles; delayed hooks join the exact request', () => {
  resetSharedControl();
  try {
    const first = noteUserInput(100, { sessionId: 'one', requestId: 'request-a' });
    assert.equal(noteUserInput(5_000, { sessionId: 'one', requestId: 'request-a' }), first);
    assert.notEqual(noteUserInput(101, { sessionId: 'one', requestId: 'request-b' }), first);
  } finally { resetSharedControl(); }
});

test('launch observations and later automatic flows do not reopen the request budget', () => {
  resetSharedControl();
  const saved = Date.now;
  let now = saved();
  Date.now = () => now;
  try {
    const cycle = noteUserInput(now, { sessionId: 'one', requestId: 'request-a' });
    assert.equal(enforceAssistanceFlow('first', { agent: 'reviewer', task: 'review one' }), 'admitted');
    now += 5_000;
    assert.equal(enforceAssistanceFlow('second', { agent: 'reviewer', task: 'review two' }), 'refused');
    assert.equal(getSharedSession().control().currentCycle(), cycle);
  } finally { Date.now = saved; resetSharedControl(); }
});

test('all members of the first implicit flow share one admission', () => {
  resetSharedControl();
  try {
    assert.equal(enforceAssistanceFlow('first', { agent: 'reviewer-a', task: 'review' }), 'admitted');
    assert.equal(enforceAssistanceFlow('first', { agent: 'reviewer-b', task: 'review' }), 'admitted');
    assert.equal(enforceAssistanceFlow('second', { agent: 'other', task: 'other work' }), 'refused');
    assert.equal(getSharedSession().control().spentBudget().helperChildren, 1);
  } finally { resetSharedControl(); }
});

test('invalid journal capacities cannot spin eviction or retain unbounded history', () => {
  for (const journalLimit of [-1, Number.NaN, Infinity, 0]) {
    const session = createInterventionSession({ journalLimit });
    for (let i = 0; i < 205; i++) session.shadow(intent(session.control().currentCycle() ?? session.beginRequest()));
    assert.equal(session.journal().length, 200);
  }
});

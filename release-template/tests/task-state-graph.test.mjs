import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const lib = path.join(import.meta.dirname, '..', 'agent', 'extensions', 'lib', 'task-state');
const { emptyGraph, applyEvent, reduce, requirementState, isStatusTransitionAllowed } = await import(path.join(lib, 'reducer.ts'));
const ingest = await import(path.join(lib, 'ingest.ts'));
const projections = await import(path.join(lib, 'projections.ts'));
const store = await import(path.join(lib, 'store.ts'));
const { TaskStateService, clearTaskStateServices } = await import(path.join(lib, 'service.ts'));

const ctx = (taskId = 'task-x') => ({ sessionId: 'sid-test', taskId, ts: 1000 });
const opened = (taskId = 'task-x', ts = 1000) => ({
  eventId: `open-${taskId}`, ts, sessionId: 'sid-test', taskId,
  kind: 'task-opened', label: 'Build widget', objective: 'Build the widget', provenance: 'literal-user',
});

test('initial task creation records objective and task entity', () => {
  const graph = reduce([opened()]);
  assert.equal(graph.label, 'Build widget');
  assert.equal(graph.objective, 'Build the widget');
  assert.equal(graph.entities['task-x']?.kind, 'task');
  assert.equal(graph.entities['task-x']?.status, 'active');
  assert.equal(graph.health.eventCount, 1);
});

test('literal requirements are independently trackable through implementation and verification', () => {
  const events = [
    opened(),
    ...ingest.requirementEvents(ctx(), [{ id: 'R1', text: 'Keep existing text unchanged' }], 'followup'),
    ingest.upsertEvent(ctx(), { id: 'chg-1', kind: 'tool-exec', status: 'implemented', title: 'edit file', provenance: 'tool-output' }, 'c1'),
    ingest.linkEvent(ctx(), 'chg-1', 'req-task-x-R1', 'implemented-by'),
    ingest.upsertEvent(ctx(), { id: 'ev-1', kind: 'evidence', status: 'active', title: 'source diff passed', provenance: 'test-result' }, 'e1'),
    ingest.linkEvent(ctx(), 'ev-1', 'req-task-x-R1', 'verified-by'),
    ingest.statusEvent(ctx(), 'req-task-x-R1', 'implemented'),
    ingest.statusEvent(ctx(), 'req-task-x-R1', 'verified'),
  ];
  const graph = reduce(events);
  const state = projections.projectCompletion(graph);
  assert.equal(state.total, 1);
  assert.equal(state.implemented, 1);
  assert.equal(state.verified, 1);
  assert.deepEqual(state.blockers, []);
  assert.equal(state.complete, true);
  const detail = requirementState(graph, 'req-task-x-R1');
  assert.equal(detail.implemented, true);
  assert.equal(detail.verified, true);
});

test('completion is blocked by missing verification: R1/R3 verified, R2 not', () => {
  const events = [
    opened(),
    ...ingest.requirementEvents(ctx(), [
      { id: 'R1', text: 'First part' },
      { id: 'R2', text: 'Second part' },
      { id: 'R3', text: 'Third part' },
    ], 'followup'),
  ];
  for (const id of ['R1', 'R2', 'R3']) {
    events.push(
      ingest.upsertEvent(ctx(), { id: `chg-${id}`, kind: 'tool-exec', status: 'implemented', title: `change ${id}`, provenance: 'tool-output' }, `c${id}`),
      ingest.linkEvent(ctx(), `chg-${id}`, `req-task-x-${id}`, 'implemented-by'),
      ingest.statusEvent(ctx(), `req-task-x-${id}`, 'implemented'),
    );
  }
  for (const id of ['R1', 'R3']) {
    events.push(
      ingest.upsertEvent(ctx(), { id: `ev-${id}`, kind: 'evidence', status: 'active', title: `evidence ${id}`, provenance: 'test-result' }, `e${id}`),
      ingest.linkEvent(ctx(), `ev-${id}`, `req-task-x-${id}`, 'verified-by'),
      ingest.statusEvent(ctx(), `req-task-x-${id}`, 'verified'),
    );
  }
  const graph = reduce(events);
  const view = projections.projectCompletion(graph);
  assert.equal(view.complete, false);
  assert.equal(view.blockers.length, 1);
  assert.match(view.blockers[0], /R2.*unverified/);
  const main = projections.projectMain(graph);
  assert.match(main, /R2/);
});

test('inferred requirements stay distinguished from literal user requirements', () => {
  const events = [
    opened(),
    ...ingest.requirementEvents(ctx(), [{ id: 'R1', text: 'Use plain HTML' }], 'followup'),
    ...ingest.inferredConstraintEvents(ctx(), [{ text: 'Probably wants responsive layout', confidence: 0.62 }]),
  ];
  const graph = reduce(events);
  const req = graph.entities['req-task-x-R1'];
  assert.equal(req.provenance, 'literal-user');
  assert.equal(req.kind, 'requirement');
  const inferred = Object.values(graph.entities).filter((e) => e.kind === 'inferred-constraint');
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].provenance, 'prompt-analysis');
  assert.equal(inferred[0].status, 'proposed');
  assert.match(inferred[0].detail ?? '', /not a literal user constraint/);
});

test('user correction supersedes conflicting prior state and preserves history', () => {
  const prior = new Map([['req-task-x-R1', 'R1 Use React for the UI']]);
  const events = [
    opened(),
    ...ingest.requirementEvents(ctx(), [{ id: 'R1', text: 'Use React for the UI' }], 'followup'),
    ...ingest.requirementEvents(ctx(), [{ id: 'R2', text: 'Actually, no React. Plain HTML/CSS/JS only for the UI.' }], 'correction', prior),
  ];
  const graph = reduce(events);
  const old = graph.entities['req-task-x-R1'];
  assert.equal(old.status, 'superseded');
  assert.ok(old.title.includes('React'), 'history preserved, not deleted');
  const link = graph.links.find((l) => l.kind === 'supersedes');
  assert.ok(link, 'supersede link recorded');
  assert.equal(link.from, 'req-task-x-R2');
  assert.equal(link.to, 'req-task-x-R1');
});

test('terminal entities are history: upserts cannot rewrite superseded state', () => {
  const prior = new Map([['req-task-x-R1', 'R1 Use React for the UI']]);
  const graph = reduce([
    opened(),
    ...ingest.requirementEvents(ctx(), [{ id: 'R1', text: 'Use React for the UI' }], 'followup'),
    ...ingest.requirementEvents(ctx(), [{ id: 'R2', text: 'Actually, no React. Plain HTML/CSS/JS only for the UI.' }], 'correction', prior),
  ]);
  const before = graph.entities['req-task-x-R1'].title;
  applyEvent(graph, ingest.upsertEvent(ctx(), {
    id: 'req-task-x-R1', kind: 'requirement', status: 'active', title: 'rewritten', provenance: 'main-agent',
  }, 'rewrite'));
  assert.equal(graph.entities['req-task-x-R1'].status, 'superseded');
  assert.equal(graph.entities['req-task-x-R1'].title, before);
});

test('follow-up vs genuinely new task classification reuses prompt-analysis relations', () => {
  assert.equal(ingest.classifyUserInput('continue with the same work', 'continue').mode, 'followup');
  assert.equal(ingest.classifyUserInput('actually use plain HTML', 'correct').mode, 'correction');
  assert.equal(ingest.classifyUserInput('something else entirely', 'unrelated').mode, 'new-task');
  assert.equal(ingest.classifyUserInput('do this instead now', 'replace').mode, 'new-task');
  assert.equal(ingest.classifyUserInput('keep going', undefined).mode, 'followup');
  assert.equal(ingest.classifyUserInput('Actually, no React — plain HTML only.').mode, 'correction');
  assert.equal(ingest.classifyUserInput('New task: build a dashboard').mode, 'new-task');
});

test('todo linkage: todo results become linked work entities', () => {
  const graph = reduce([
    opened(),
    ...ingest.todoEvents(ctx(), [
      { id: 1, title: 'Write code', status: 'completed' },
      { id: 2, title: 'Add tests', status: 'in_progress' },
    ]),
  ]);
  assert.equal(graph.entities['todo-task-x-1']?.status, 'implemented');
  assert.equal(graph.entities['todo-task-x-2']?.status, 'active');
  assert.equal(graph.entities['todo-task-x-1']?.refs?.todoId, 1);
  assert.ok(graph.links.some((l) => l.from === 'todo-task-x-1' && l.to === 'task-x'));
});

test('file mutation linkage: writes bump versions and link change to artifact', () => {
  const graph = reduce([
    opened(),
    ...ingest.fileWriteEvents({ ...ctx(), ts: 1001 }, { path: 'src/a.ts', toolCallId: 'call-1' }, 1),
    ...ingest.fileWriteEvents({ ...ctx(), ts: 1002 }, { path: 'src/a.ts', toolCallId: 'call-2' }, 2),
  ]);
  assert.equal(graph.files['src/a.ts']?.version, 2);
  assert.ok(Object.values(graph.entities).some((e) => e.kind === 'artifact' && e.refs?.file === 'src/a.ts'));
  assert.ok(graph.links.some((l) => l.kind === 'affects'));
});

test('test evidence binds to tool calls; failures get stable families', () => {
  const graph = reduce([
    opened(),
    ...ingest.bashResultEvents(ctx(), { command: 'npm test', toolCallId: 't1', failed: false, excerpt: '12 passed' }),
    ...ingest.bashResultEvents({ ...ctx(), ts: 1001 }, { command: 'npm test', toolCallId: 't2', failed: true, excerpt: 'TypeError: bad widget id 42' }),
    ...ingest.bashResultEvents({ ...ctx(), ts: 1002 }, { command: 'npm test', toolCallId: 't3', failed: true, excerpt: 'TypeError: bad widget id 97' }),
  ]);
  const evidence = Object.values(graph.entities).filter((e) => e.kind === 'evidence');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].provenance, 'test-result');
  const families = projections.failureFamilies(graph);
  assert.equal(families.length, 1, 'normalized failures share one family');
  assert.equal(families[0].count, 2);
});

test('stale evidence after a later edit cascades requirement verification back', () => {
  const file = 'src/a.ts';
  const graph = reduce([
    opened(),
    ...ingest.fileWriteEvents({ ...ctx(), ts: 1001 }, { path: file, toolCallId: 'c1' }, 1),
    ...ingest.requirementEvents({ ...ctx(), ts: 1002 }, [{ id: 'R1', text: 'Widget works' }], 'followup'),
    ingest.upsertEvent({ ...ctx(), ts: 1003 }, {
      id: 'ev-1', kind: 'evidence', status: 'active', title: 'tests pass',
      provenance: 'test-result', refs: { file, fileVersion: 1 },
    }, 'e1'),
    ingest.linkEvent({ ...ctx(), ts: 1004 }, 'ev-1', 'req-task-x-R1', 'verified-by'),
    ingest.statusEvent({ ...ctx(), ts: 1005 }, 'req-task-x-R1', 'implemented'),
    ingest.statusEvent({ ...ctx(), ts: 1006 }, 'req-task-x-R1', 'verified'),
  ]);
  assert.equal(requirementState(graph, 'req-task-x-R1').verified, true);
  applyEvent(graph, {
    eventId: 'fv-2', ts: 2000, sessionId: 'sid-test', taskId: 'task-x',
    kind: 'file-version', file, version: 2, toolCallId: 'c2',
  });
  assert.equal(graph.entities['ev-1'].stale, true);
  assert.equal(graph.entities['ev-1'].status, 'invalidated');
  assert.equal(graph.entities['req-task-x-R1'].status, 'partially-verified');
  assert.equal(requirementState(graph, 'req-task-x-R1').verified, false);
  const view = projections.projectCompletion(graph);
  assert.match(view.blockers[0], /stale/);
});

test('subagent results keep subagent provenance and are never auto-verified', () => {
  const graph = reduce([
    opened(),
    ...ingest.subagentResultEvents(ctx(), { runId: 'run-1', agent: 'explore', ok: true, summary: 'Found the bug in parser.ts' }),
    ...ingest.subagentResultEvents({ ...ctx(), ts: 1001 }, { runId: 'run-2', agent: 'explore', ok: false, summary: 'Crashed: out of tokens' }),
  ]);
  const children = Object.values(graph.entities).filter((e) => e.kind === 'child');
  assert.equal(children.length, 2);
  assert.ok(children.every((c) => c.provenance === 'subagent'));
  assert.ok(children.every((c) => c.status !== 'verified'), 'child claims are not verification');
  assert.equal(children.find((c) => c.refs?.childRunId === 'run-2')?.status, 'failed');
  const slice = projections.projectSubagentSlice(graph, { focus: ['parser.ts'] });
  assert.ok(slice.length <= 1500);
});

test('observer and review findings attach to entities; disagreement stays representable', () => {
  const graph = reduce([
    opened(),
    ...ingest.requirementEvents(ctx(), [{ id: 'R1', text: 'Fast page' }], 'followup'),
    ingest.upsertEvent(ctx(), { id: 'dec-1', kind: 'decision', status: 'active', title: 'Use heavy animation lib', provenance: 'main-agent' }, 'd1'),
    ...ingest.findingEvents(ctx(), { reviewId: 'obs-1', kind: 'observer', blocker: false, note: 'Animation lib may hurt load time', targets: ['dec-1'] }),
    ...ingest.findingEvents({ ...ctx(), ts: 1001 }, { reviewId: 'qr-1', kind: 'review-council', blocker: true, note: 'No render evidence for R1', targets: ['req-task-x-R1'] }),
  ]);
  const findings = Object.values(graph.entities).filter((e) => e.kind === 'finding');
  assert.equal(findings.length, 2);
  assert.equal(findings.find((f) => f.refs?.reviewId === 'obs-1')?.provenance, 'observer');
  assert.equal(findings.find((f) => f.refs?.reviewId === 'qr-1')?.status, 'blocked');
  assert.equal(graph.links.filter((l) => l.kind === 'challenges').length, 2);
  const contradictions = projections.findContradictions(graph);
  assert.ok(contradictions.some((c) => c.includes('R1')), 'blocker challenge surfaces as contradiction');
});

test('impossible status transitions are recorded, never applied', () => {
  const graph = reduce([
    opened(),
    ...ingest.requirementEvents(ctx(), [{ id: 'R1', text: 'Something' }], 'followup'),
    ingest.statusEvent(ctx(), 'req-task-x-R1', 'verified'),
  ]);
  // active -> verified directly is allowed? check contract: active→verified is NOT in ALLOWED.
  assert.equal(isStatusTransitionAllowed('active', 'verified'), false);
  assert.equal(graph.entities['req-task-x-R1'].status, 'active');
  assert.equal(graph.health.impossibleTransitions.length, 1);
  // Legal path works (distinct reasons keep idempotent event ids apart).
  applyEvent(graph, ingest.statusEvent({ ...ctx(), ts: 2000 }, 'req-task-x-R1', 'implemented', 'change landed'));
  applyEvent(graph, ingest.statusEvent({ ...ctx(), ts: 2001 }, 'req-task-x-R1', 'verified', 'evidence checked'));
  assert.equal(graph.entities['req-task-x-R1'].status, 'verified');
});

test('generated transition sequences never produce false verified state (behavioral contract)', () => {
  // Independent invariant check over many orderings: verified requires both
  // status verified AND current (non-stale) evidence.
  const statuses = ['proposed', 'active', 'implemented', 'partially-verified', 'verified', 'failed', 'blocked'];
  let seed = 1234567;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 60; trial++) {
    const taskId = `task-fuzz-${trial}`;
    const c = { sessionId: 'sid-fuzz', taskId, ts: 1000 };
    const events = [{ eventId: `open-${taskId}`, ts: 999, sessionId: 'sid-fuzz', taskId, kind: 'task-opened', label: 't', objective: 'o', provenance: 'literal-user' },
      ...ingest.requirementEvents(c, [{ id: 'R1', text: 'Fuzz requirement' }], 'followup')];
    const reqId = `req-${taskId}-R1`;
    for (let i = 0; i < 8; i++) {
      const status = statuses[Math.floor(rand() * statuses.length)];
      events.push(ingest.statusEvent({ ...c, ts: 1000 + i }, reqId, status, `fuzz-${trial}-${i}`));
    }
    const graph = reduce(events);
    const state = requirementState(graph, reqId);
    if (state.verified) {
      assert.ok(state.evidence.some((e) => e.status !== 'invalidated' && !e.stale),
        `trial ${trial}: verified without current evidence`);
    }
  }
});

test('replay and double delivery are idempotent (no duplicate logical facts)', () => {
  const events = [
    opened(),
    ...ingest.requirementEvents(ctx(), [{ id: 'R1', text: 'Same thing' }], 'followup'),
  ];
  const once = reduce(events);
  const twice = reduce([...events, ...events, ...events]);
  assert.equal(Object.keys(twice.entities).length, Object.keys(once.entities).length);
  assert.equal(twice.links.length, once.links.length);
  assert.ok(twice.health.duplicateEvents > 0);
  // Determinism: the same log sequence always folds to the same graph.
  const again = reduce(events);
  assert.deepEqual(Object.keys(again.entities).sort(), Object.keys(once.entities).sort());
  assert.equal(again.links.length, once.links.length);
  assert.equal(again.entities['req-task-x-R1']?.status, 'active');
});

test('equal-timestamp batches keep log order (upsert before link)', () => {
  const c = { sessionId: 'sid-test', taskId: 'task-x', ts: 5000 };
  const graph = reduce([
    opened(),
    ingest.upsertEvent(c, { id: 'a-1', kind: 'decision', status: 'active', title: 'D', provenance: 'main-agent' }, 'x'),
    ingest.linkEvent(c, 'a-1', 'task-x', 'child-of'),
  ]);
  assert.ok(graph.links.some((l) => l.from === 'a-1' && l.to === 'task-x'), 'causal link applied');
});

test('context projection bounds hold under a large graph', () => {
  const events = [opened()];
  for (let i = 0; i < 120; i++) {
    events.push(...ingest.requirementEvents({ ...ctx(), ts: 1000 + i }, [{ id: `R${i}`, text: `Requirement number ${i} with a reasonably long description text` }], 'followup'));
    events.push(...ingest.bashResultEvents({ ...ctx(), ts: 2000 + i }, { command: 'npm test', toolCallId: `t${i}`, failed: i % 3 === 0, excerpt: `output ${i} `.repeat(20) }));
  }
  const graph = reduce(events);
  assert.ok(Object.keys(graph.entities).length > 100);
  for (const text of [
    projections.projectMain(graph),
    projections.projectObserver(graph),
    projections.projectWatchmaker(graph),
    projections.projectSubagentSlice(graph),
  ]) {
    assert.ok(text.length <= 2000, `projection exceeded budget: ${text.length}`);
  }
  const tight = projections.projectMain(graph, { maxChars: 500, maxItems: 4 });
  assert.ok(tight.length <= 600, `tight budget exceeded: ${tight.length}`);
});

test('diagnostics surface dangling, stale, orphaned, unlinked, and uncovered state', () => {
  const graph = reduce([
    opened(),
    ...ingest.requirementEvents(ctx(), [{ id: 'R1', text: 'Thing' }], 'followup'),
    ingest.upsertEvent(ctx(), { id: 'ev-lonely', kind: 'evidence', status: 'active', title: 'unlinked evidence', provenance: 'test-result' }, 'u1'),
    ...ingest.subagentResultEvents(ctx(), { runId: 'orphan', agent: 'x', ok: true, summary: 'done' }),
    ...ingest.completionClaimEvents(ctx(), { claimId: 'c1', blocked: false, reason: 'we are done' }),
  ]);
  // Orphan the child and strip the claim's coverage (simulates partial writes).
  graph.links = graph.links.filter((l) => !((l.from.startsWith('child-') || l.from.startsWith('claim-')) && l.to === 'task-x'));
  const diag = projections.collectDiagnostics(graph);
  assert.ok(diag.unlinkedVerification.includes('ev-lonely'));
  assert.equal(diag.orphanedChildren.length, 1);
  assert.equal(diag.claimsWithoutCoverage.length, 1);
});

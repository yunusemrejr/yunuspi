import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyGraph, applyEvent, requirementState, TASK_GRAPH_MAX_EVENT_IDS } from '../agent/extensions/lib/task-state/reducer.ts';
import { appendTaskEvents, writeTaskSnapshot, loadTaskState, taskStatePaths } from '../agent/extensions/lib/task-state/store.ts';
import { getTaskStateService, currentTaskStateService, clearTaskStateServices } from '../agent/extensions/lib/task-state/service.ts';
import { withSessionObservability } from '../core/coding-agent/src/core/session-observability.js';
import * as ingest from '../agent/extensions/lib/task-state/ingest.ts';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, paths: taskStatePaths(dir, 'sid', 'task'), ctx: { sessionId: 'sid', taskId: 'task', ts: 1000 } };
}

test('a snapshot beyond the event-id bound resumes without replaying settled events', t => {
  const { paths, ctx } = fixture(t);
  const graph = emptyGraph(ctx.taskId, ctx.sessionId);
  const events = Array.from({ length: TASK_GRAPH_MAX_EVENT_IDS + 2 }, (_, i) => ({
    ...ctx, eventId: `followup-${i}`, kind: 'task-followup', mode: 'followup', summary: '', promptHash: String(i),
  }));
  events.push(ingest.upsertEvent(ctx, { id: 'decision', kind: 'decision', title: 'Retain the contract', provenance: 'main-agent' }));
  events.forEach(event => applyEvent(graph, event));
  appendTaskEvents(paths, events);
  writeTaskSnapshot(paths, graph);
  const loaded = loadTaskState(paths, ctx.sessionId, ctx.taskId).graph;
  assert.equal(loaded.seq, graph.seq);
  assert.equal(loaded.entities.decision.version, graph.entities.decision.version);
  const tail = ingest.upsertEvent(ctx, { id: 'tail', kind: 'decision', title: 'New evidence', provenance: 'main-agent' });
  appendTaskEvents(paths, [tail]);
  assert.equal(loadTaskState(paths, ctx.sessionId, ctx.taskId).graph.seq, graph.seq + 1);
});

test('recent double delivery stays idempotent after the event-id bound', t => {
  const { ctx } = fixture(t);
  const graph = emptyGraph(ctx.taskId, ctx.sessionId);
  for (let i = 0; i <= TASK_GRAPH_MAX_EVENT_IDS; i++) applyEvent(graph, { ...ctx, eventId: `event-${i}`, kind: 'task-followup' });
  const event = ingest.upsertEvent(ctx, { id: 'decision', kind: 'decision', title: 'Stable finding', provenance: 'main-agent' });
  applyEvent(graph, event);
  const seq = graph.seq;
  assert.equal(applyEvent(graph, event), false);
  assert.equal(graph.seq, seq);
});

test('an interrupted final log write cannot swallow the next event', t => {
  const { paths, ctx } = fixture(t);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.events, '{"eventId":"partial');
  appendTaskEvents(paths, [ingest.upsertEvent(ctx, { id: 'recovered', kind: 'decision', title: 'Recovered', provenance: 'main-agent' })]);
  const loaded = loadTaskState(paths, ctx.sessionId, ctx.taskId);
  assert.ok(loaded.graph.entities.recovered);
  assert.equal(loaded.skippedLines, 1);
});

test('a snapshot must belong to its session and have a complete graph shape', t => {
  const { paths, ctx } = fixture(t);
  const event = ingest.upsertEvent(ctx, { id: 'correct', kind: 'decision', title: 'Correct session', provenance: 'main-agent' });
  appendTaskEvents(paths, [event]);
  for (const invalid of [emptyGraph(ctx.taskId, 'other-session'), { taskId: ctx.taskId, sessionId: ctx.sessionId, entities: {}, eventIds: [] }]) {
    fs.writeFileSync(paths.snapshot, JSON.stringify(invalid));
    const loaded = loadTaskState(paths, ctx.sessionId, ctx.taskId);
    assert.ok(loaded.quarantinedSnapshot);
    assert.equal(loaded.graph.sessionId, ctx.sessionId);
    assert.ok(loaded.graph.entities.correct);
  }
});

test('replacing or truncating the log invalidates its snapshot replay cursor', t => {
  const { paths, ctx } = fixture(t);
  const event = ingest.upsertEvent(ctx, { id: 'old', kind: 'decision', title: 'Old', provenance: 'main-agent' });
  const graph = emptyGraph(ctx.taskId, ctx.sessionId);
  applyEvent(graph, event); appendTaskEvents(paths, [event]); writeTaskSnapshot(paths, graph);
  const next = ingest.upsertEvent(ctx, { id: 'new', kind: 'decision', title: 'New', provenance: 'main-agent' });
  fs.writeFileSync(paths.events, JSON.stringify(next) + '\n');
  const loaded = loadTaskState(paths, ctx.sessionId, ctx.taskId);
  assert.equal(loaded.graph.entities.old, undefined);
  assert.ok(loaded.graph.entities.new);
});

test('switching back to a cached service republishes it in the current native scope', t => {
  const { dir } = fixture(t);
  clearTaskStateServices(); t.after(clearTaskStateServices);
  let sid = 'a';
  const ctx = { sessionManager: { getSessionId: () => sid } };
  const a = withSessionObservability(ctx, () => getTaskStateService(sid, dir));
  sid = 'b'; withSessionObservability(ctx, () => getTaskStateService(sid, dir));
  sid = 'a';
  withSessionObservability(ctx, () => {
    assert.equal(getTaskStateService(sid, dir), a);
    assert.equal(currentTaskStateService(), a);
  });
});

test('failed, superseded and non-evidence records cannot verify a requirement', t => {
  const { ctx } = fixture(t);
  for (const [kind, status] of [['evidence', 'failed'], ['evidence', 'superseded'], ['evidence', 'blocked'], ['child', 'implemented']]) {
    const graph = emptyGraph(ctx.taskId, ctx.sessionId);
    const req = `req-${ctx.taskId}-R1`;
    [
      ...ingest.requirementEvents(ctx, [{ id: 'R1', text: 'Verify the actual output' }], 'followup'),
      ingest.upsertEvent(ctx, { id: 'e', kind, status, title: 'Record', provenance: 'subagent' }),
      ingest.linkEvent(ctx, 'e', req, 'verified-by'),
      ingest.statusEvent(ctx, req, 'implemented'), ingest.statusEvent(ctx, req, 'verified'),
    ].forEach(event => applyEvent(graph, event));
    assert.equal(requirementState(graph, req).verified, false, `${kind}/${status}`);
  }
});

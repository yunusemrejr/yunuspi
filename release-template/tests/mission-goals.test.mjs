import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMission, readMission, updateMission } from '../agent/extensions/pi-subagents/src/missions/store.ts';
import { attachMissionToLaunchResult } from '../agent/extensions/pi-subagents/src/missions/lifecycle.ts';
import { collectGoalContinuationNotices } from '../agent/extensions/pi-subagents/src/missions/goal-driver.ts';
import { handleMissionAction } from '../agent/extensions/pi-subagents/src/missions/actions.ts';

const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-goals-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const location = { projectRoot: root, missionDir: path.join(root, 'missions'), globalIndexDir: path.join(root, 'index'), writeGlobalIndex: false };
  const goal = (title = 'Goal') => createMission(location, { title, objective: 'Complete work', status: 'active', ownerSessionId: 'owner', goal: true, budget: { tokens: 100 } });
  return { root, location, goal };
};

test('a goal budget cannot forget recorded consumption on an unrelated update', t => {
  const { location, goal } = fixture(t);
  const mission = goal();
  updateMission(location, mission.id, { usage: { tokens: 100 } });
  const updated = updateMission(location, mission.id, { summary: 'Keep this exhausted goal stopped' });
  assert.equal(updated.usage.tokens, 100);
  assert.equal(updated.goal.status, 'budget-exhausted');
});

test('a paused goal stays paused across exhaustion and a budget increase', t => {
  const { location, goal } = fixture(t);
  const mission = goal();
  updateMission(location, mission.id, { goal: { status: 'paused' }, usage: { tokens: 100 } });
  const updated = updateMission(location, mission.id, { budget: { tokens: 200 } });
  assert.equal(updated.goal.status, 'paused');
});

test('a paused child cannot hide a sibling that is still active', t => {
  const { location } = fixture(t);
  const mission = createMission(location, { title: 'Parallel', objective: 'Collect both children', status: 'active' });
  updateMission(location, mission.id, { addRuns: [{ runId: 'running', mode: 'single', status: 'running' }] });
  const result = attachMissionToLaunchResult({ binding: { location, missionId: mission.id, autoCreated: false }, result: {
    content: [], details: { mode: 'single', runId: 'paused', results: [{ agent: 'worker', exitCode: 0, interrupted: true, usage: { input: 1, output: 1 } }] },
  } });
  assert.equal(result.details.mission.status, 'active');
});

test('one corrupt linked run does not suppress notices for other goal missions', t => {
  const { root, location, goal } = fixture(t);
  const bad = goal('Bad status'), healthy = goal('Healthy goal');
  const asyncDir = path.join(root, 'bad-run'); fs.mkdirSync(asyncDir);
  fs.writeFileSync(path.join(asyncDir, 'status.json'), '{');
  updateMission(location, bad.id, { addRuns: [{ runId: 'bad', mode: 'single', status: 'running', asyncDir }] });
  const notices = collectGoalContinuationNotices({ location, ownerSessionId: 'owner', retainedChildren: [], turnId: 1 });
  assert.deepEqual(notices.map(notice => notice.missionId), [healthy.id]);
});

test('an unchanged run status still refreshes token usage before continuing a goal', t => {
  const { root, location, goal } = fixture(t);
  const mission = goal();
  const asyncDir = path.join(root, 'run'); fs.mkdirSync(asyncDir);
  fs.writeFileSync(path.join(asyncDir, 'status.json'), JSON.stringify({ state: 'completed', totalTokens: { total: 100 } }));
  updateMission(location, mission.id, { addRuns: [{ runId: 'run', mode: 'single', status: 'completed', asyncDir, usage: { tokens: 1 } }] });
  // The management refresh and the continuation driver must use the same accounting.
  handleMissionAction('mission.show', { missionId: mission.id }, { cwd: root, config: { directory: location.missionDir, globalIndex: false } });
  assert.equal(readMission(location, mission.id).usage.tokens, 100);
  assert.equal(collectGoalContinuationNotices({ location, ownerSessionId: 'owner', retainedChildren: [], turnId: 1 }).length, 0);
});

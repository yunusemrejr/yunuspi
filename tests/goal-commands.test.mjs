import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';

const jiti=createJiti(import.meta.dirname);
const gs=await jiti.import('../agent/extensions/lib/goal-state.ts');
const {parseGoalArgs,GOAL_USAGE,goalSummary,goalStatusText,goalRestoreNotice,createGoal,createPresetGoal}=gs;

const goalWith=(status,settle=0)=>{
 const goal=createGoal('Fix the login redirect and add a test');
 const criteria=goal.criteria.map((criterion,index)=>index<settle&&criterion.id!=='V'?{...criterion,status:'met',evidence:'npm test: 12 passed, exit 0'}:criterion);
 return {...goal,status,criteria};
};

test('goal aliases map onto the subcommands', () => {
  assert.deepEqual(parseGoalArgs(''), {kind:'status'});
  assert.deepEqual(parseGoalArgs('show'), {kind:'status'});
  assert.deepEqual(parseGoalArgs('progress'), {kind:'status'});
  assert.deepEqual(parseGoalArgs('continue'), {kind:'resume'});
  assert.deepEqual(parseGoalArgs('stop'), {kind:'clear'});
  assert.deepEqual(parseGoalArgs('help'), {kind:'help'});
  assert.deepEqual(parseGoalArgs('pause'), {kind:'pause'});
  assert.deepEqual(parseGoalArgs('done'), {kind:'done'});
  assert.deepEqual(parseGoalArgs('retry'), {kind:'retry'});
});

test('resume, continue and retry take a note only when a goal exists', () => {
  assert.deepEqual(parseGoalArgs('resume fix the logo', true), {kind:'resume', note:'fix the logo'});
  assert.deepEqual(parseGoalArgs('continue fix the logo', true), {kind:'resume', note:'fix the logo'});
  assert.deepEqual(parseGoalArgs('retry try the staging host', true), {kind:'retry', note:'try the staging host'});
  assert.deepEqual(parseGoalArgs('resume fix the logo', false), {kind:'set', text:'resume fix the logo'}, 'without a goal the words start one');
  assert.deepEqual(parseGoalArgs('continue fix the logo'), {kind:'set', text:'continue fix the logo'});
  assert.deepEqual(parseGoalArgs('retry'), {kind:'retry'});
});

test('the usage text lists every form and the summary carries it', () => {
  assert.equal(typeof GOAL_USAGE, 'string');
  assert.match(GOAL_USAGE, /\/goal resume/);
  assert.match(GOAL_USAGE, /\/goal clear/);
  const none = goalSummary(undefined);
  assert.ok(none.startsWith('No goal set in this session.'), none);
  assert.ok(none.includes(GOAL_USAGE));
  assert.ok(goalSummary({...goalWith('active'), status:'cleared'}).startsWith('No goal set in this session.'));
});

test('the summary ends with the next-step hint for each live or finished status', () => {
  const hints = {
    active: '/goal pause stops it · /goal clear drops it',
    paused: '/goal resume continues it',
    blocked: '/goal retry continues it · /goal clear drops it',
    achieved: '/goal <text> starts the next one',
  };
  for (const [status, hint] of Object.entries(hints)) {
    const lines = goalSummary(goalWith(status)).split('\n');
    assert.equal(lines[0].startsWith(`Goal `), true, status);
    assert.match(lines[0], new RegExp(`\\[${status}\\]`));
    assert.equal(lines.at(-1), hint, status);
  }
});

test('the footer status shows the mark and the settled count per status', () => {
  // A preset goal has three given criteria plus the verification criterion: four in all.
  const base = createPresetGoal('Ship the trailer', ['Render the film', 'Check the audio', 'Export the MP4']);
  const total = base.criteria.length;
  assert.equal(total, 4);
  const settled = (status, count) => ({...base, status, criteria: base.criteria.map((criterion, index) => index < count ? {...criterion, status: 'met', evidence: 'npm test: 12 passed, exit 0'} : criterion)});
  assert.equal(goalStatusText(settled('active', 0)), `goal ◎ 0/${total}`);
  assert.equal(goalStatusText(settled('active', 2)), `goal ◎ 2/${total}`);
  assert.equal(goalStatusText(settled('paused', 1)), `goal ⏸ 1/${total}`);
  assert.equal(goalStatusText(settled('blocked', 3)), `goal ⚠ 3/${total}`);
  assert.equal(goalStatusText(settled('achieved', 4)), undefined);
  assert.equal(goalStatusText(settled('cleared', 0)), undefined);
  assert.equal(goalStatusText(undefined), undefined);
});

test('the restore notice names the command that continues each unfinished goal', () => {
  assert.match(goalRestoreNotice(goalWith('active')), /\/goal resume/);
  assert.match(goalRestoreNotice(goalWith('paused')), /\/goal resume/);
  assert.match(goalRestoreNotice(goalWith('blocked')), /\/goal retry/);
  assert.equal(goalRestoreNotice(goalWith('achieved')), undefined);
  assert.equal(goalRestoreNotice(goalWith('cleared')), undefined);
  assert.equal(goalRestoreNotice(undefined), undefined);
});

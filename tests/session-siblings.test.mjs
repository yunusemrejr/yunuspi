// What a child knows about the others at work in its session: the refusal of
// an identical launch while its twin runs, and the "Also at work" block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.dirname);
const { launchChildren, rememberLaunch, refuseTwinLaunch, withSiblingBlocks, ownBrief } =
  await jiti.import('../agent/extensions/pi-subagents/src/runs/shared/session-siblings.ts');

const newState = () => ({ asyncJobs: new Map() });
const alive = (state, id, status = 'running') => state.asyncJobs.set(id, { asyncId: id, status });
const BLOCK = 'Also at work in this session:';

test('children are read from a single call, a tasks batch and a chain with its parallel members', () => {
  assert.deepEqual(launchChildren({ agent: 'scout', task: 'Find   the\nloader' }), [{ agent: 'scout', label: 'Find the loader', key: 'scout\nFind the loader' }]);
  assert.deepEqual(launchChildren({ tasks: [{ agent: 'scout', task: 'a' }, { agent: 'worker', task: 'b' }] }).map((child) => child.agent), ['scout', 'worker']);
  const chain = launchChildren({ chain: [{ agent: 'scout', task: 'one' }, { parallel: [{ agent: 'worker', task: 'two' }, { agent: 'reviewer', task: 'three' }] }, { agent: 'worker' }] });
  assert.deepEqual(chain.map((child) => child.agent), ['scout', 'worker', 'reviewer', 'worker']);
  assert.equal(chain[3].key, undefined, 'a step that takes the previous output has no task of its own to match');
  assert.deepEqual(launchChildren({ action: 'list' }), []);
});

test('a shared brief does not hide what makes each child different', () => {
  const [child] = launchChildren({ tasks: [{ agent: 'scout', task: 'Shared brief:\nread the repo rules\n\nChild task:\nlist the exports of the loader' }] });
  assert.equal(child.label, 'list the exports of the loader');
  assert.match(child.key, /read the repo rules/, 'the match still covers the whole brief');
});

test('an identical launch is refused once while its twin runs, and runs when sent again', () => {
  const state = newState();
  const call = { agent: 'scout', task: 'find where   the loader reads\nits settings' };
  const children = launchChildren(call);
  assert.equal(refuseTwinLaunch(state, children), undefined, 'nothing is running yet');
  rememberLaunch(state, 'run-1', children);
  alive(state, 'run-1');
  const refusal = refuseTwinLaunch(state, launchChildren({ agent: 'scout', task: 'find where the loader reads its settings' }));
  assert.match(refusal, /^already running as run-1 since 1 min; its report will arrive; send the call again to run a second one$/);
  assert.equal(refuseTwinLaunch(state, children), undefined, 'the same call sent again runs');
  assert.match(refuseTwinLaunch(state, children), /already running as run-1/, 'refused once more for the next repeat');
});

test('a different agent, a different task or a finished twin is not a duplicate', () => {
  const state = newState();
  rememberLaunch(state, 'run-1', launchChildren({ agent: 'scout', task: 'list the exports' }));
  alive(state, 'run-1');
  assert.equal(refuseTwinLaunch(state, launchChildren({ agent: 'researcher', task: 'list the exports' })), undefined);
  assert.equal(refuseTwinLaunch(state, launchChildren({ agent: 'scout', task: 'list the exports and imports' })), undefined);
  state.asyncJobs.get('run-1').status = 'complete';
  assert.equal(refuseTwinLaunch(state, launchChildren({ agent: 'scout', task: 'list the exports' })), undefined, 'a finished run no longer counts');
  assert.equal(refuseTwinLaunch(state, launchChildren({ agent: 'scout', task: 'list the exports' })), undefined);
});

test('another session never sees these children', () => {
  const first = newState();
  const second = newState();
  rememberLaunch(first, 'run-1', launchChildren({ agent: 'scout', task: 'list the exports' }));
  alive(first, 'run-1');
  assert.equal(refuseTwinLaunch(second, launchChildren({ agent: 'scout', task: 'list the exports' })), undefined);
});

test('children of one tasks batch see each other and the children still running from earlier calls', () => {
  const state = newState();
  rememberLaunch(state, 'run-1', launchChildren({ agent: 'researcher', task: 'compare the two settings loaders' }));
  alive(state, 'run-1');
  const call = { tasks: [{ agent: 'scout', task: 'list the exports' }, { agent: 'worker', task: 'rename foo to bar' }] };
  const out = withSiblingBlocks(state, call, launchChildren(call));
  assert.equal(out.tasks[0].task, `list the exports\n\n${BLOCK}\n- worker: rename foo to bar\n- researcher: compare the two settings loaders`);
  assert.equal(out.tasks[1].task, `rename foo to bar\n\n${BLOCK}\n- scout: list the exports\n- researcher: compare the two settings loaders`);
  assert.equal(call.tasks[0].task, 'list the exports', 'the caller\'s call is not changed');
});

test('a block holds at most four lines of at most 100 characters of each task', () => {
  const state = newState();
  const long = 'x'.repeat(250);
  const call = { tasks: Array.from({ length: 7 }, (_, index) => ({ agent: 'scout', task: `${index} ${long}` })) };
  const out = withSiblingBlocks(state, call, launchChildren(call));
  const lines = out.tasks[0].task.split(`${BLOCK}\n`)[1].split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], `- scout: 1 ${'x'.repeat(98)}`);
});

test('a lone child, a chain step and a child with no task of its own get nothing they should not', () => {
  const state = newState();
  const single = { agent: 'scout', task: 'list the exports' };
  assert.deepEqual(withSiblingBlocks(state, single, launchChildren(single)), single, 'nothing else is running');
  rememberLaunch(state, 'run-1', launchChildren({ agent: 'researcher', task: 'compare the loaders' }));
  alive(state, 'run-1');
  assert.equal(withSiblingBlocks(state, single, launchChildren(single)).task, `list the exports\n\n${BLOCK}\n- researcher: compare the loaders`);
  const chain = { chain: [{ agent: 'scout', task: 'one' }, { agent: 'worker' }] };
  const out = withSiblingBlocks(state, chain, launchChildren(chain));
  assert.match(out.chain[0].task, new RegExp(BLOCK));
  assert.equal(out.chain[1].task, undefined, 'a step that takes the previous output keeps taking it');
  const batch = { tasks: [{ agent: 'scout', task: 'one' }, { agent: 'worker', task: 'two' }] };
  assert.doesNotMatch(withSiblingBlocks(state, batch, launchChildren(batch)).tasks[1].task, /worker: two/, 'a child is not listed beside itself');
});

test('a paused or stopped run is finished: its child is not refused and not listed', () => {
  for (const status of ['paused', 'stopped']) {
    const state = newState();
    rememberLaunch(state, 'run-1', launchChildren({ agent: 'scout', task: 'list the exports' }));
    alive(state, 'run-1', status);
    assert.equal(refuseTwinLaunch(state, launchChildren({ agent: 'scout', task: 'list the exports' })), undefined, status);
    const other = { agent: 'worker', task: 'rename foo to bar' };
    assert.deepEqual(withSiblingBlocks(state, other, launchChildren(other)), other, status);
  }
});

test('a child that has finished while its batch still runs is neither refused nor listed', () => {
  const state = newState();
  const batch = { tasks: [{ agent: 'scout', task: 'list the exports' }, { agent: 'worker', task: 'rename foo to bar' }] };
  rememberLaunch(state, 'run-1', launchChildren(batch));
  state.asyncJobs.set('run-1', { asyncId: 'run-1', status: 'running', steps: [{ agent: 'scout', status: 'complete' }, { agent: 'worker', status: 'running' }] });
  assert.equal(refuseTwinLaunch(state, launchChildren({ agent: 'scout', task: 'list the exports' })), undefined, 'the finished child has no twin');
  assert.match(refuseTwinLaunch(state, launchChildren({ agent: 'worker', task: 'rename foo to bar' })), /already running as run-1/, 'the one at work does');
  const next = { agent: 'reviewer', task: 'check the rename' };
  assert.equal(withSiblingBlocks(state, next, launchChildren(next)).task, `check the rename\n\n${BLOCK}\n- worker: rename foo to bar`);
});

test('a mark belongs to the run it was set for: it is dropped when that run ends', () => {
  const state = newState();
  const children = launchChildren({ agent: 'scout', task: 'list the exports' });
  rememberLaunch(state, 'run-1', children);
  alive(state, 'run-1');
  assert.match(refuseTwinLaunch(state, children), /already running as run-1/);
  state.asyncJobs.get('run-1').status = 'complete';
  assert.equal(refuseTwinLaunch(state, children), undefined, 'no twin runs any more');
  rememberLaunch(state, 'run-2', children);
  alive(state, 'run-2');
  assert.match(refuseTwinLaunch(state, children), /already running as run-2/, 'the old mark does not excuse a duplicate of a newer run');
  assert.equal(refuseTwinLaunch(state, children), undefined, 'and that one is refused once, as well');
});

test('copies of one task are one sibling line, and the harness blocks are not part of the brief', () => {
  const params = { tasks: [{ agent: 'scout', task: 'list the exports' }, { agent: 'scout', task: 'list the exports' }, { agent: 'scout', task: 'list the exports' }] };
  const out = withSiblingBlocks(newState(), params, launchChildren(params));
  assert.equal(out.tasks[0].task, `list the exports\n\n${BLOCK}\n- scout: list the exports (2 copies)`);
  const withSlice = `read the loader\n\nTask context (shared Task State Graph, advisory — verify before relying):\naudit security\n\n${BLOCK}\n- scout: x`;
  assert.equal(ownBrief(withSlice), 'read the loader');
  assert.equal(ownBrief('read the loader'), 'read the loader');
});

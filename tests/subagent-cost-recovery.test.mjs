import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { collectSessionCost, recoverRetainedChildCosts } from '../core/coding-agent/src/core/session-accounting.js';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const usage = (total) => ({input:10, output:2, cost:{total, source:'provider-reported'}});
const assistant = (id, parentId, total) => ({type:'message', id, parentId, timestamp,
  message:{role:'assistant', provider:'openrouter', model:'fixture', content:[], usage:usage(total)}});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-child-cost-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const sessionFile = path.join(root, 'parent.jsonl');
  const statusRoot = path.join(root, 'async-subagent-runs');
  const nativeId = randomUUID();
  const runId = 'auto-assist-fixture';
  const childFile = path.join(root, 'parent', nativeId, 'run-0', 'session.jsonl');
  const statusFile = path.join(statusRoot, runId, 'status.json');
  const header = (id) => ({type:'session', id, version:3, timestamp, cwd:root});
  const hostedReceipt = (value) => {
    const {status, requestId, cost} = typeof value === 'string'
      ? {status:value, requestId:value, cost:value === 'completed' ? .125 : undefined} : value;
    return {type:'custom', customType:'auxiliary-model-usage-v1', id:`${requestId}-${status}`, parentId:'answer', timestamp,
      data:{owner:'web-access', id:requestId, provider:'openrouter', model:'fixture-hosted', status,
        ...(cost !== undefined ? {usage:usage(cost)} : {})}};
  };
  const row = {index:0, agent:'automatic-free-assistant', status:'completed', sessionFile:childFile, usage:{...usage(.5), turns:1}};
  const entries = [header('parent'), assistant('lead', null, .25),
    {type:'custom', customType:'subagent-cost-v1', id:'wrapper', parentId:'lead', timestamp, data:{runId, mode:'single', state:'complete', results:[row]}}];
  fs.mkdirSync(path.dirname(childFile), {recursive:true});
  fs.mkdirSync(path.dirname(statusFile), {recursive:true});
  const write = (file, rows) => fs.writeFileSync(file, rows.map(value => JSON.stringify(value)).join('\n') + '\n');
  const writeParent = () => write(sessionFile, entries);
  writeParent();
  const writeChild = (receipts, main = assistant('answer', null, .5)) => write(childFile,
    [header('child'), ...(main ? [main] : []), ...receipts.map(value => value?.type === 'custom' ? value : hostedReceipt(value))]);
  writeChild(['completed']);
  const writeStatus = (overrides = {}) => fs.writeFileSync(statusFile, JSON.stringify({runId, mode:'single', state:'complete', sessionId:sessionFile,
    steps:[{status:'complete', sessionFile:childFile}], ...overrides}));
  writeStatus();
  return {entries, options:{sessionFile, statusRoot}, writeParent, writeStatus, writeChild, childFile, statusFile, nativeId, row};
}

function retainForegroundResult(f) {
  fs.unlinkSync(f.statusFile);
  delete f.entries[2].data.mode;
  delete f.entries[2].data.state;
  delete f.row.status;
  f.row.runId = f.nativeId;
  f.row.exitCode = 0;
  f.row.evidence = {version:1, usage:{input:10, output:2, cacheRead:0, cacheWrite:0, turns:1}};
  Object.assign(f.row.usage, {cacheRead:0, cacheWrite:0,
    costByModel:[{route:'openrouter/fixture', evidence:{reported:.5, estimated:0, unknown:false, subscription:false, seen:true}}]});
  f.writeParent();
}

test('owner-attested local recovery retains hosted spend exactly once across reopen and native replay', t => {
  const f = fixture(t);
  const parentBefore = fs.readFileSync(f.options.sessionFile);
  const childBefore = fs.readFileSync(f.childFile);
  const baseline = collectSessionCost(f.entries);
  assert.equal(baseline.total, .75);
  const recovered = recoverRetainedChildCosts(f.entries, f.options);
  assert.equal(recovered.entries.length, 1);
  assert.equal(collectSessionCost([...f.entries, ...recovered.entries]).total, .875);
  assert.deepEqual(fs.readFileSync(f.options.sessionFile), parentBefore);
  assert.deepEqual(fs.readFileSync(f.childFile), childBefore);

  const manager = SessionManager.open(f.options.sessionFile);
  const previousLeaf = manager.getLeafId();
  for (const receipt of recovered.entries) manager.appendCustomEntry(receipt.customType, receipt.data);
  assert.equal(manager.getLeafId(), previousLeaf);
  assert.equal(manager.getTree().length, 1);
  const reopened = SessionManager.open(f.options.sessionFile);
  assert.equal(reopened.getLeafId(), previousLeaf);
  assert.equal(collectSessionCost(reopened.getEntries()).children.reported, .625);
  assert.deepEqual(recoverRetainedChildCosts([reopened.getHeader(), ...reopened.getEntries()], f.options).entries, []);

  const native = {type:'custom', customType:'subagent-cost-v1', data:{runId:f.nativeId,
    results:[{...f.row, runId:f.nativeId, usage:usage(.625)}]}};
  assert.equal(collectSessionCost([...reopened.getEntries(), native]).total, .875);
  assert.deepEqual(recoverRetainedChildCosts([...f.entries, native], f.options).entries, []);

  const fork = reopened.createBranchedSession(previousLeaf);
  const forked = SessionManager.open(fork);
  assert.equal(collectSessionCost(forked.getEntries()).total, .75);
  const forkEntries = [forked.getHeader(), ...forked.getEntries()];
  assert.deepEqual(recoverRetainedChildCosts(forkEntries, {...f.options, sessionFile:fork}).entries, []);
  assert.equal(collectSessionCost([...forkEntries, ...recovered.entries]).total, .75);
  assert.throws(() => forked.appendCustomEntry(recovered.entries[0].customType, recovered.entries[0].data), /different session/);
});

test('recovery requires a terminal run, exact originating session and exact owned child file', t => {
  const f = fixture(t);
  const deny = () => assert.deepEqual(recoverRetainedChildCosts(f.entries, f.options).entries, []);
  f.writeStatus({state:'running'});
  deny();
  f.writeStatus({sessionId:f.options.sessionFile + '.copy'});
  deny();
  f.writeStatus({steps:[{status:'running', sessionFile:f.childFile}]});
  deny();
  f.writeStatus({steps:[{status:'complete', sessionFile:f.childFile + '.copy'}]});
  deny();
  f.writeStatus();
  const target = f.childFile + '.copy';
  fs.renameSync(f.childFile, target);
  fs.symlinkSync(target, f.childFile);
  deny();
  fs.unlinkSync(f.childFile);
  fs.linkSync(target, f.childFile);
  deny();
});

test('recovery retains known charges and explicitly marks unfinished or damaged child evidence', t => {
  const f = fixture(t);
  f.writeStatus({state:'stopped', steps:[{status:'stopped', sessionFile:f.childFile}]});
  f.writeChild(['completed', 'pending']);
  const pending = recoverRetainedChildCosts(f.entries, f.options);
  const cost = collectSessionCost([...f.entries, ...pending.entries]);
  assert.equal(cost.total, .875);
  assert.equal(cost.unknown, true);
  f.writeChild(['completed']);
  fs.appendFileSync(f.childFile, '{"type":"message"');
  const damaged = recoverRetainedChildCosts(f.entries, f.options);
  const retained = collectSessionCost([...f.entries, ...damaged.entries]);
  assert.equal(retained.total, .875);
  assert.equal(retained.unknown, true);
});

test('equal-dollar child coverage retains unpriced routes and settles the same request at reported zero', t => {
  const f = fixture(t);
  const pending = {status:'pending', requestId:'hosted'};
  f.writeChild([pending]);
  const first = recoverRetainedChildCosts(f.entries, f.options).entries;
  assert.equal(first.length, 1);
  const withPending = [...f.entries, ...first];
  const status = collectSessionCost(withPending);
  assert.equal(status.total, .75);
  assert.equal(status.unknown, true);
  assert.equal(status.pending, 1);
  assert.equal(status.rows.find(row => row.route === 'openrouter/fixture-hosted').unknown, true);
  assert.deepEqual(recoverRetainedChildCosts(withPending, f.options).entries, []);

  f.writeChild([]);
  assert.deepEqual(recoverRetainedChildCosts(withPending, f.options).entries, []);
  f.writeChild([pending, {status:'completed', requestId:'hosted'}]);
  const unpriced = recoverRetainedChildCosts(withPending, f.options).entries;
  const withUnpriced = [...withPending, ...unpriced];
  assert.equal(collectSessionCost(withUnpriced).pending, 0);
  assert.equal(collectSessionCost(withUnpriced).unknown, true);
  f.writeChild([pending, {status:'completed', requestId:'hosted', cost:0}]);
  const settled = recoverRetainedChildCosts(withUnpriced, f.options).entries;
  const entries = [...withUnpriced, ...settled];
  const native = {type:'custom', customType:'subagent-cost-v1', data:{runId:f.nativeId,
    results:[{...f.row, runId:f.nativeId}]}};
  const cost = collectSessionCost([...entries, native]);
  assert.equal(cost.total, .75);
  assert.equal(cost.unknown, false);
  assert.equal(cost.pending, 0);
  const route = cost.rows.find(row => row.route === 'openrouter/fixture-hosted');
  assert.ok(route?.seen);
  assert.equal(route.reported, 0);
  assert.deepEqual(recoverRetainedChildCosts([...entries, native], f.options).entries, []);
});

test('a zero-only retained child can establish a known zero', t => {
  const f = fixture(t);
  f.row.usage = {cost:0};
  const entries = [f.entries[0], f.entries[2]];
  assert.equal(collectSessionCost(entries).formatted, '$?');
  f.writeChild([{status:'completed', requestId:'zero', cost:0}], null);
  const receipts = recoverRetainedChildCosts(entries, f.options).entries;
  assert.equal(collectSessionCost([...entries, ...receipts]).formatted, '$0.000');
});

test('only exact fully priced direct usage can lower a legacy estimate', t => {
  const f = fixture(t);
  f.row.model = 'openrouter/fixture';
  f.row.usage = {...f.row.usage, cost:.5};
  const direct = assistant('answer', null, .375);
  f.writeChild([], {...direct, message:{...direct.message, usage:{...direct.message.usage, output:3}}});
  const unmatched = recoverRetainedChildCosts(f.entries, f.options).entries;
  assert.equal(collectSessionCost([...f.entries, ...unmatched]).total, .75);
  f.writeChild([], direct);
  const receipts = recoverRetainedChildCosts(f.entries, f.options).entries;
  const entries = [...f.entries, ...receipts];
  assert.equal(collectSessionCost(entries).total, .625);
  assert.equal(collectSessionCost(entries).children.reported, .375);
  assert.deepEqual(recoverRetainedChildCosts(entries, f.options).entries, []);

  f.writeChild([{status:'pending', requestId:'missing'}], null);
  const more = recoverRetainedChildCosts(entries, f.options).entries;
  const incomplete = collectSessionCost([...entries, ...more]);
  assert.equal(incomplete.total, .625);
  assert.equal(incomplete.children.reported, .375);
  assert.equal(incomplete.unknown, true);

  f.row.usage = {...f.row.usage, ...usage(.5)};
  f.writeChild([], direct);
  assert.deepEqual(recoverRetainedChildCosts(f.entries, f.options).entries, []);
});

test('a newer native estimate cannot erase recovered provider-reported spend', t => {
  const f = fixture(t);
  const recovered = recoverRetainedChildCosts(f.entries, f.options).entries;
  const estimate = {type:'custom', customType:'subagent-cost-v1', data:{runId:f.nativeId,
    results:[{...f.row, runId:f.nativeId, usage:{...f.row.usage, turns:2, cost:.875}}]}};
  const entries = [...f.entries, ...recovered, estimate];
  const result = collectSessionCost(entries);
  assert.equal(result.children.reported, .625);
  assert.equal(result.children.estimated, .25);
  assert.equal(result.total, 1.125);
  assert.equal(result.rows.find(row => row.route === 'openrouter/fixture-hosted').reported, .125);
  assert.deepEqual(recoverRetainedChildCosts(entries, f.options).entries, []);
});

test('terminal ownership permits recovering a saved placeholder that had no usage snapshot', t => {
  const f = fixture(t);
  delete f.row.usage;
  f.row.status = 'running';
  assert.equal(collectSessionCost(f.entries).pending, 1);
  const recovered = recoverRetainedChildCosts(f.entries, f.options).entries;
  const cost = collectSessionCost([...f.entries, ...recovered]);
  assert.equal(cost.total, .875);
  assert.equal(cost.pending, 0);
  assert.equal(cost.unknown, false);
});

test('exact direct spend stays reported when the child adds metered and estimated auxiliary requests', t => {
  const f = fixture(t);
  f.row.usage.costByModel = [{route:'openrouter/fixture', evidence:{reported:.5, estimated:0, seen:true, unknown:false, subscription:false}}];
  f.writeChild(['completed', {type:'custom', customType:'jev-usage-v1', id:'legacy', parentId:'answer', timestamp,
    data:{model:'fixture-judge', costUsd:.03125}}]);
  const receipts = recoverRetainedChildCosts(f.entries, f.options).entries;
  const entries = [...f.entries, ...receipts];
  const result = collectSessionCost(entries);
  assert.equal(result.children.reported, .625);
  assert.equal(result.children.estimated, .03125);
  assert.equal(result.total, .90625);
  assert.match(result.formatted, /~0\.906250/);
  assert.deepEqual(recoverRetainedChildCosts(entries, f.options).entries, []);
});

test('a saved native foreground terminal result attests its retained auxiliary charge without async status', t => {
  const f = fixture(t);
  retainForegroundResult(f);
  const prior = collectSessionCost(f.entries);
  assert.equal(prior.total, .75);

  const receipts = recoverRetainedChildCosts(f.entries, f.options).entries;
  const next = [...f.entries, ...receipts];
  assert.equal(receipts.length, 1);
  assert.equal(collectSessionCost(next).total, .875);
  assert.equal(collectSessionCost([...next, ...receipts]).total, .875);
  assert.deepEqual(recoverRetainedChildCosts(next, f.options).entries, []);

  const manager = SessionManager.open(f.options.sessionFile);
  for (const receipt of receipts) manager.appendCustomEntry(receipt.customType, receipt.data);
  const fork = manager.createBranchedSession(manager.getLeafId());
  const forked = SessionManager.open(fork);
  const forkEntries = [forked.getHeader(), ...forked.getEntries()];
  assert.equal(collectSessionCost(forkEntries).total, .75);
  assert.deepEqual(recoverRetainedChildCosts(forkEntries, {...f.options, sessionFile:fork}).entries, []);
});

test('foreground backfill rejects unproven native identities, usage, and terminal state', t => {
  const f = fixture(t);
  retainForegroundResult(f);
  const deny = () => assert.deepEqual(recoverRetainedChildCosts(f.entries, f.options).entries, []);
  f.row.runId = randomUUID();
  deny();
  f.row.runId = f.nativeId;
  const evidence = f.row.evidence;
  delete f.row.evidence;
  deny();
  f.row.evidence = evidence;
  f.row.status = 'running';
  deny();
  delete f.row.status;
  f.row.usage.input += 1;
  deny();
  f.row.usage.input -= 1;
  f.row.usage.costByModel[0].route = 'openrouter/different-model';
  deny();
  f.row.usage.costByModel[0].route = 'openrouter/fixture';
  f.writeStatus({state:'running'});
  deny();
});

test('foreground recovery leaves inclusive child graphs to the existing native accounting', t => {
  const f = fixture(t);
  retainForegroundResult(f);
  f.writeChild(['completed', {type:'custom', customType:'subagent-cost-v1', id:'descendant', parentId:'answer', timestamp,
    data:{runId:randomUUID(), results:[{usage:usage(.125)}]}}]);
  assert.deepEqual(recoverRetainedChildCosts(f.entries, f.options).entries, []);
});

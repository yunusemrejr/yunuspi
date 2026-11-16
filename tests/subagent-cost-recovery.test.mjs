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
  const hostedReceipt = (status) => ({type:'custom', customType:'auxiliary-model-usage-v1', id:status, parentId:'answer', timestamp,
    data:{owner:'web-access', id:status, provider:'openrouter', model:'fixture-hosted', status, ...(status === 'completed' ? {usage:usage(.125)} : {})}});
  const row = {index:0, agent:'automatic-free-assistant', status:'completed', sessionFile:childFile, usage:{...usage(.5), turns:1}};
  const entries = [header('parent'), assistant('lead', null, .25),
    {type:'custom', customType:'subagent-cost-v1', id:'wrapper', parentId:'lead', timestamp, data:{runId, mode:'single', state:'complete', results:[row]}}];
  fs.mkdirSync(path.dirname(childFile), {recursive:true});
  fs.mkdirSync(path.dirname(statusFile), {recursive:true});
  const write = (file, rows) => fs.writeFileSync(file, rows.map(value => JSON.stringify(value)).join('\n') + '\n');
  write(sessionFile, entries);
  const writeChild = (receipts) => write(childFile, [header('child'), assistant('answer', null, .5), ...receipts.map(hostedReceipt)]);
  writeChild(['completed']);
  const writeStatus = (overrides = {}) => fs.writeFileSync(statusFile, JSON.stringify({runId, mode:'single', state:'complete', sessionId:sessionFile,
    steps:[{status:'complete', sessionFile:childFile}], ...overrides}));
  writeStatus();
  return {entries, options:{sessionFile, statusRoot}, writeStatus, writeChild, childFile, statusFile, nativeId, row};
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

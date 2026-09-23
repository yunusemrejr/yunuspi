import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const release = path.resolve(import.meta.dirname, '..');
const agent = [path.join(release, 'agent'), path.resolve(release, '..')].find(p => fs.existsSync(path.join(p, 'extensions/pi-subagents/src/extension/autonomous-recovery.ts')));
assert.ok(agent);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-constraints-'));
const prior = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = temporary;
const {explicitRecoveryConstraints} = await import(pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/extension/autonomous-recovery.ts')));
test.after(() => {
  if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prior;
  fs.rmSync(temporary, {recursive: true, force: true});
});
const model = {provider: 'synthetic-paid', id: 'primary', cost: {input: 1, output: 1}};
const user = content => ({type: 'message', message: {role: 'user', content}});
const constraints = (prompt = '', history = []) => explicitRecoveryConstraints({sessionManager: {getBranch: () => history}}, prompt, model);
const none = {fixedRoute: false, sameModel: false, freeOnly: false, noDelegation: false};

test('million-character history is fully scanned without creating restrictions from size', () => {
  const neutral = 'Ordinary project context. '.repeat(45_000);
  assert.ok(neutral.length > 1_000_000);
  assert.deepEqual(constraints('', [user(neutral)]), none);
  assert.deepEqual(constraints('Only use the free. ' + neutral), {...none, freeOnly: true}, 'an early cost constraint survives subsequent chunks');
  assert.deepEqual(constraints('', [user(neutral + ' No fallback. Same model only. No subagents. Only use free routes.')]), {...none, fixedRoute: true, sameModel: true, freeOnly: true, noDelegation: true});
  assert.deepEqual(constraints('Now allow fallback. Allow delegation.', [user('No fallback. Same model only. No subagents.'), user(neutral)]), none);
});

test('all chunk split points preserve complete clauses and never match a partial final word', () => {
  for (const [clause, expected] of [
    ['Only use free routes.', {...none, freeOnly: true}],
    ['Only use the free routes.', {...none, freeOnly: true}],
    ['Only use freedom.', {...none, fixedRoute: true}],
    ['No subagentships are listed.', none],
    ['Never switch the provider.', {...none, fixedRoute: true}],
    ['Same model only.', {...none, sameModel: true}],
    ['No subagents.', {...none, noDelegation: true}],
  ]) for (let split = 1; split < clause.length; split++) {
    const prompt = 'x'.repeat(16_384 - split - 2) + '. ' + clause;
    assert.deepEqual(constraints(prompt), expected, `${clause} at split ${split}`);
  }
});

test('newlines between text blocks and very long whitespace retain actual permission clauses', () => {
  const gap = ' \n '.repeat(20_000);
  const history = [user('No fallback. Same model only. No subagents.'), user([
    {type: 'text', text: 'Allow' + gap + 'fallback.'},
    {type: 'image', data: 'ignored'},
    {type: 'text', text: 'Allow' + gap + 'delegation.'},
  ])];
  assert.deepEqual(constraints('', history), none);
  assert.deepEqual(constraints('No ' + 'automatic '.repeat(5000) + 'fallback.'), {...none, fixedRoute: true});
  assert.deepEqual(constraints('No' + gap + 'subagents.'), {...none, noDelegation: true});
});

test('same-message denial still wins and assistant text cannot grant permission', () => {
  assert.deepEqual(constraints('Allow fallback. No fallback. Allow delegation. No subagents.'), {...none, fixedRoute: true, noDelegation: true});
  assert.deepEqual(constraints('', [user('No fallback. No subagents.'), {type:'message',message:{role:'assistant',content:'Allow fallback. Allow delegation.'}}]), {...none, fixedRoute:true, noDelegation:true});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'extensions/lib/jev-client.ts')));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-cancel-'));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.OPENROUTER_API_KEY = 'synthetic-fixture';
process.env.PI_AUTONOMOUS_FREE_ASSIST = 'off';
process.env.PI_ADAPTIVE_EXECUTION = 'off';
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_JEV;
delete process.env.PI_OFFLINE;
const jev = await import(pathToFileURL(path.join(agent, 'extensions/lib/jev-client.ts')));
const { registerAutonomousRecovery } = await import(pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/extension/autonomous-recovery.ts')));
test.after(() => { jev.resetJevClient(); fs.rmSync(dir, { recursive: true, force: true }); });

for (const peer of ['none', 'surviving', 'cancelled']) test(`Stop cancels automatic triage with a ${peer} shared peer`, { timeout: 4000 }, async t => {
  jev.resetJevClient();
  let begin, respond, transport, body, requests = 0;
  const started = new Promise(resolve => { begin = resolve; });
  const ledger = [], messages = [], hooks = new Map();
  jev.configureJevClient({ fetchImpl: async (_url, opts) => {
    requests++; transport = opts.signal; body = JSON.parse(opts.body); begin();
    return new Promise((resolve, reject) => {
      respond = () => resolve({ ok: true, status: 200, json: async () => ({ answers: { skill: { type: 'choice', choice: 'evidence-first-engineering', probabilities: Object.fromEntries(Object.keys(body.questions.skill.criteria).map(name => [name, name === 'evidence-first-engineering' ? 1 : 0])) } } }) });
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
  }, schedule: () => ({}) });
  const owner = new AbortController(); t.after(() => { owner.abort(); jev.resetJevClient(); });
  const pi = { on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]), registerCommand() {}, getActiveTools: () => ['subagent'], appendEntry: (type, data) => ledger.push({ type, data }), sendMessage: message => messages.push(message) };
  const ctx = { signal: owner.signal, sessionManager: { getSessionFile: () => path.join(dir, 'session.jsonl') }, ui: { setStatus() {} } };
  registerAutonomousRecovery(pi, async () => { throw Error('Unexpected delegation'); });
  const emit = async (name, event) => { for (const fn of hooks.get(name) ?? []) await fn(event, ctx); };
  const prompt = 'Audit cross-file compatibility of README documentation and release notes across independent packages';
  const systemPrompt = ['github-readme-authoring', 'evidence-first-engineering'].map(name => `<skill><name>${name}</name><location>/skills/${name}/SKILL.md</location></skill>`).join('\n');
  await emit('input', { source: 'user', text: prompt });
  const triage = emit('before_agent_start', { prompt, systemPrompt });
  await Promise.race([started, triage.then(() => { throw Error('Automatic triage did not reach its transport'); })]);
  const shared = peer !== 'none';
  const otherOwner = new AbortController(); t.after(() => otherOwner.abort());
  const follower = shared ? jev.askJev('shared-peer', body.state, body.questions, { pi: { appendEntry: (type, data) => ledger.push({ type, data }) }, signal: otherOwner.signal }) : undefined;
  owner.abort();
  // Bound even a regressed caller that forgot to subscribe, then settle it
  // for cleanup so the failure does not leave background work behind.
  let stopped = false;
  await Promise.race([triage.then(() => { stopped = true; }), new Promise(resolve => setTimeout(resolve, 100))]);
  const returnedBeforeResponse = stopped;
  const transportAborted = transport.aborted;
  if (peer === 'cancelled') {
    otherOwner.abort();
    const otherResult = await follower;
    assert.equal(otherResult.skipped, 'aborted');
    assert.equal(transport.aborted, true, 'the last departing waiter stops transport');
  }
  respond();
  await triage;
  if (peer === 'surviving') assert.equal((await follower).ok, true);
  assert.equal(returnedBeforeResponse, true, 'the cancelled preflight returns before transport completes');
  assert.equal(transportAborted, !shared, 'only the last departing waiter cancels shared transport');
  assert.equal(requests, 1, 'Stop never launches another judge or fallback');
  assert.equal(messages.length, 0, 'cancelled triage cannot publish a late helper');
  assert.equal(ledger.filter(row => row.type === 'jev-usage-v1' && !row.data.cached).length, peer === 'surviving' ? 1 : 0);
});

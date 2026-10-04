import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import observerExtension from '../agent/extensions/session-observer.ts';
import watchmakerExtension from '../agent/extensions/session-watchmaker.ts';
import { publishReviewerNote, registerPlannerStatus, reviewerSessionKey } from '../agent/extensions/lib/reviewer-board.ts';

const GUARDIAN_META = Symbol.for('yunuspi.guardian.request-meta.v1');
const model = { provider: 'deepseek', id: 'deepseek-flash', name: 'Synthetic reviewer route', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', maxTokens: 8192, contextWindow: 65536, reasoning: true, input: ['text'], cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0 } };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function clock() {
  let now = 0; let id = 0; const jobs = new Map();
  return { now: () => now,
    setTimeout(fn, ms) { jobs.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; jobs.delete(next[0]); next[1].fn(); await tick();
      }
      now = end; await tick();
    } };
}

/** Runs one real reviewer extension to its first review and returns the packet it sent. */
async function firstPacket(t, extension, beforeReview) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-coordination-'));
  const keys = ['PI_CODING_AGENT_DIR', 'PI_LLM_PREFERENCES_FILE', 'PI_SUBAGENTS_ECONOMY_CONFIG', 'PI_PROVIDER_STATE_FILE', 'PI_MODEL_EXCLUSIONS_PATH', 'PI_OFFLINE', 'PI_SESSION_OBSERVER', 'PI_SUBAGENT_CHILD', 'PI_OBSERVER_TOOLS', 'PI_WATCHMAKER'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: cwd, PI_LLM_PREFERENCES_FILE: path.join(cwd, 'prefs.json'), PI_SUBAGENTS_ECONOMY_CONFIG: path.join(cwd, 'economy.json'), PI_PROVIDER_STATE_FILE: path.join(cwd, 'health.json'), PI_MODEL_EXCLUSIONS_PATH: path.join(cwd, 'exclusions.json'), PI_OBSERVER_BOOK_DIR: 'off' });
  for (const key of ['PI_OFFLINE', 'PI_SESSION_OBSERVER', 'PI_SUBAGENT_CHILD', 'PI_OBSERVER_TOOLS', 'PI_WATCHMAKER']) delete process.env[key];
  fs.writeFileSync(path.join(cwd, 'economy.json'), '{}');
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; fs.rmSync(cwd, { recursive: true, force: true }); });
  const time = clock();
  const handlers = new Map();
  const packets = [];
  const pi = {
    on: (event, fn) => { handlers.set(event, fn); },
    events: { on: () => () => {} },
    registerMessageRenderer: () => {}, registerCommand: () => {},
    getActiveTools: () => [], getAllTools: () => [],
    sendMessage: () => {}, appendEntry: () => {},
  };
  const sessionManager = { getSessionId: () => 'coordination-fixture', getSessionFile: () => path.join(cwd, 'session.jsonl'), getBranch: () => [] };
  const ctx = { cwd, sessionManager, modelRegistry: { getAvailable: () => [model] }, model, isIdle: () => false, ui: { setStatus() {} } };
  extension(pi, { ...time, judge: async () => ({ ok: false, skipped: 'fixture' }), loadBook: () => undefined,
    dispatch: async (_route, packet) => {
      packets.push(packet.text);
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ note: '', evidence: [], tools: [], skills: [] }) }] };
    } });
  const fire = (event, payload) => handlers.get(event)?.(payload, ctx);
  fire('session_start', {});
  fire('input', { source: 'interactive', requestId: 'req-1', originalText: 'Fix the login redirect in the fixture project.' });
  fire('before_agent_start', { systemPromptOptions: {} });
  fire('message_start', { message: { role: 'user', [GUARDIAN_META]: { requestId: 'req-1' } } });
  fire('message_start', { message: { role: 'assistant', content: [] } });
  for (let i = 0; i < 6; i++) {
    fire('tool_execution_start', { toolCallId: `read-${i}`, toolName: 'read', args: { path: `src/login-${i}.ts` } });
    await time.advance(1000);
    fire('tool_result', { toolCallId: `read-${i}`, toolName: 'read', input: { path: `src/login-${i}.ts` }, isError: false, content: [{ type: 'text', text: 'export const login = 1;' }], details: {} });
  }
  beforeReview(ctx);
  await time.advance(130_000);
  for (let i = 0; i < 100 && !packets.length; i++) await tick();
  assert.ok(packets.length, 'the reviewer ran a review');
  return packets[0];
}

for (const [name, extension, planners] of [
  ['observer', observerExtension, /planner-state|Double mode: ON/],
  ['watchmaker', watchmakerExtension, /time-planners|Double mode: ON/],
]) {
  test(`the ${name} sees Double's mode and what its directive told the agent`, async (t) => {
    const dispose = registerPlannerStatus('double', () => 'ON (custom pair A deepseek/deepseek-flash ∥ B zai/glm-5.3-flash): every user prompt is analyzed by two independent streams and reconciled into one planning directive before the agent starts. Do not advise repeating that deliberation.');
    t.after(dispose);
    const packet = await firstPacket(t, extension, (ctx) => {
      publishReviewerNote(reviewerSessionKey(ctx), 'double', 'Double mode directive: read src/login.ts first, then fix the redirect and run the tests.', [], 0);
      publishReviewerNote(reviewerSessionKey(ctx), 'council', 'Scope council (complete, advisory): keep the existing login copy; change only the redirect target.', [], 0);
    });
    assert.match(packet, planners);
    assert.match(packet, /Double mode: ON \(custom pair A deepseek\/deepseek-flash ∥ B zai\/glm-5\.3-flash\)/);
    assert.match(packet, /Do not advise repeating that deliberation/);
    assert.match(packet, /Double mode already told the agent \d+s ago: Double mode directive: read src\/login\.ts first/);
    assert.match(packet, /Scope council already told the agent \d+s ago: Scope council \(complete, advisory\): keep the existing login copy/);
  });

  test(`the ${name} adds nothing about planners that are not running`, async (t) => {
    const packet = await firstPacket(t, extension, () => {});
    assert.doesNotMatch(packet, /Double mode/);
    assert.doesNotMatch(packet, /already told the agent \d+s ago/);
  });
}

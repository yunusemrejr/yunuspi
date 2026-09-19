import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const template = path.resolve(import.meta.dirname, '..');
const agent = [path.join(template, 'agent'), path.resolve(template, '..')]
  .find((p) => fs.existsSync(path.join(p, 'extensions/session-signals.ts')));
assert.ok(agent, 'agent tree with session-signals.ts is present');
register('data:text/javascript,' + encodeURIComponent(`export function resolve(name,ctx,next){
 const sources={
 '@yunuspi/coding-agent':'export function getAgentDir(){return ${JSON.stringify(path.join(template, 'agentFixture'))}};export class SettingsManager{static create(){return {getCompactionSettings(){return{};}};}}',
 '@yunuspi/ai':'export function StringEnum(v){return v}'};
 return name in sources?{url:'data:text/javascript,'+encodeURIComponent(sources[name]),shortCircuit:true}:next(name,ctx);
}`), import.meta.url);

const signals = await import(pathToFileURL(path.join(agent, 'extensions/session-signals.ts')));
const { stopAllSessionRuns } = await import(
  pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/foreground/async-stop-action.ts'))
);

test('popup html escapes untrusted branch content', () => {
  assert.equal(signals.escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  const html = signals.usedSummaryHtml({
    tools: [{ name: '<img src=x>', count: 5 }],
    skillsRead: [], skillsPartial: [], skillsSuggested: [],
    routes: [], runs: [], swarms: 0, fusions: 0, recoveries: 0, councils: [], reviews: null, inspected: 1,
  });
  assert.ok(html.includes('&lt;img src=x&gt;'));
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(html.includes('x5'));
});

test('sys snapshot reads system fields and system-role messages, never user content', () => {
  assert.equal(signals.extractSysSnapshot(undefined), undefined);
  assert.equal(signals.extractSysSnapshot({ messages: [{ role: 'user', content: 'secret' }] }), undefined);
  assert.equal(signals.extractSysSnapshot({ messages: [{ role: 'assistant', content: 'draft' }] }), undefined);
  assert.equal(signals.extractSysSnapshot({ input: [{ role: 'user', content: 'secret' }] }), undefined);
  const snapshot = signals.extractSysSnapshot({
    system: 'Be helpful.',
    model: 'fixture/model',
    tools: [{ name: 'read' }, { function: { name: 'bash' } }],
  });
  assert.equal(snapshot.system, 'Be helpful.');
  assert.equal(snapshot.model, 'fixture/model');
  assert.deepEqual(snapshot.tools, ['read', 'bash']);
  assert.equal(snapshot.toolCount, 2);
  const legacy = signals.extractSysSnapshot({ systemPrompt: 'Legacy shape.' });
  assert.equal(legacy.system, 'Legacy shape.');
  const big = signals.extractSysSnapshot({ system: 'x'.repeat(300000) });
  assert.equal(big.truncated, true);
  assert.ok(big.system.includes('characters total'));
});

test('sys snapshot understands OpenAI, Responses, Anthropic and Google envelopes', () => {
  // OpenAI-compatible chat payloads (OpenAI, DeepSeek, OpenRouter, ...): the
  // system prompt travels as a system/developer message.
  const openai = signals.extractSysSnapshot({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'You are helpful. OPENAI_MARKER' },
      { role: 'user', content: 'user secret must stay out' },
    ],
    tools: [{ type: 'function', function: { name: 'read' } }],
  });
  assert.ok(openai);
  assert.equal(openai.system, 'You are helpful. OPENAI_MARKER');
  assert.ok(!openai.system.includes('user secret'));
  assert.deepEqual(openai.tools, ['read']);
  const developer = signals.extractSysSnapshot({
    messages: [{ role: 'developer', content: 'Reasoning instruction.' }],
  });
  assert.equal(developer.system, 'Reasoning instruction.');
  // Responses APIs carry the same list as `input`.
  const responses = signals.extractSysSnapshot({
    model: 'gpt-x',
    input: [
      { role: 'system', content: 'You are helpful. RESPONSES_MARKER' },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ],
  });
  assert.equal(responses.system, 'You are helpful. RESPONSES_MARKER');
  // Anthropic: system is an array of text blocks — captured as readable text.
  const anthropic = signals.extractSysSnapshot({
    model: 'claude-x',
    system: [{ type: 'text', text: 'You are Claude. ANTHROPIC_MARKER' }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(anthropic.system, 'You are Claude. ANTHROPIC_MARKER');
  // Google nests the instruction and the tool declarations inside config.
  const google = signals.extractSysSnapshot({
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    config: {
      systemInstruction: 'You are helpful. GOOGLE_MARKER',
      tools: [{ functionDeclarations: [{ name: 'read' }, { name: 'bash' }] }],
    },
  });
  assert.equal(google.system, 'You are helpful. GOOGLE_MARKER');
  assert.deepEqual(google.tools, ['read', 'bash']);
  assert.equal(google.toolCount, 2);
});

test('harness tool-first line is a fixed system-prompt string', () => {
  assert.equal(typeof signals.HARNESS_TOOL_FIRST, 'string');
  assert.ok(signals.HARNESS_TOOL_FIRST.includes('tool_search'));
  assert.ok(signals.HARNESS_TOOL_FIRST.includes('skill_review'));
  assert.ok(signals.HARNESS_TOOL_FIRST.length > 40);
});

const toolCall = (id, name, args) => ({
  type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] },
});
const toolResult = (toolCallId, toolName, details = {}, isError = false) => ({
  type: 'message', message: { role: 'toolResult', toolCallId, toolName, details, content: [{ type: 'text', text: 'ok' }], ...(isError ? { isError: true } : {}) },
});

test('used summary counts tools and skill reads from call pairing', () => {
  const branch = [
    toolCall('c1', 'read', { path: '/skills/debugging/SKILL.md' }),
    toolResult('c1', 'read'),
    toolCall('c2', 'read', { path: '/skills/debugging/SKILL.md', limit: 10 }),
    toolResult('c2', 'read'),
    toolCall('c3', 'bash', { command: 'ls' }),
    toolResult('c3', 'bash'),
    toolCall('c4', 'bash', { command: 'pwd' }),
    toolResult('c4', 'bash'),
  ];
  const summary = signals.buildUsedSummary(branch);
  assert.deepEqual(summary.tools, [{ name: 'read', count: 2 }, { name: 'bash', count: 2 }]);
  assert.deepEqual(summary.skillsRead, [{ name: 'debugging', count: 1 }]);
  assert.deepEqual(summary.skillsPartial, [{ name: 'debugging', count: 1 }]);
  assert.equal(summary.inspected, 8);
});

test('used summary joins child runs with launch-level model and thinking', () => {
  const branch = [
    toolCall('s1', 'subagent', { agent: 'worker', model: 'openrouter/big-model', thinking: 'high' }),
    toolResult('s1', 'subagent', { asyncId: 'run-async-1' }),
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'run-async-1', mode: 'single', state: 'completed', results: [{ index: 0, status: 'completed', model: 'openrouter/big-model' }] } },
    { type: 'custom', customType: 'model-config-v1', data: { route: 'openrouter/main-model', thinking: 'medium', openRouterRouting: { provider: 'DeepInfra' }, source: 'session_start' } },
    { type: 'custom', customType: 'scope-deliberation-v1', data: { requestHash: 'abc', status: 'complete', evidenceCount: 3, incomplete: false } },
    { type: 'custom', customType: 'quality-review-v1', data: { rounds: 1, disposition: 'accepted', reports: [{ aspect: 'correctness', outcome: 'pass' }] } },
  ];
  const summary = signals.buildUsedSummary(branch);
  assert.equal(summary.runs.length, 1);
  assert.deepEqual(summary.runs[0], { runId: 'run-async-1', mode: 'single', status: 'completed', provider: 'openrouter', model: 'big-model', thinking: 'high' });
  assert.equal(summary.routes.length, 1);
  assert.equal(summary.routes[0].thinking, 'medium');
  assert.ok(summary.routes[0].nested.includes('DeepInfra'));
  assert.equal(summary.councils.length, 1);
  assert.equal(summary.councils[0].status, 'complete');
  assert.equal(summary.reviews.disposition, 'accepted');
  assert.deepEqual(summary.reviews.aspects, [{ aspect: 'correctness', outcome: 'pass' }]);
  const html = signals.usedSummaryHtml(summary);
  for (const needle of ['openrouter', 'big-model', 'thinking high', 'DeepInfra', 'deliberation 1', 'correctness:pass']) {
    assert.ok(html.includes(needle), `popup shows ${needle}`);
  }
});

test('unknown run provenance stays absent, never guessed', () => {
  const branch = [
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'run-orphan', results: [{ index: 0, status: 'completed' }] } },
  ];
  const summary = signals.buildUsedSummary(branch);
  assert.equal(summary.runs.length, 1);
  assert.equal(summary.runs[0].provider, undefined);
  assert.equal(summary.runs[0].thinking, undefined);
  assert.ok(signals.usedSummaryHtml(summary).includes('thinking –'));
});

test('commands popup sorts and escapes the live registry', () => {
  const html = signals.commandsHtml([
    { name: 'used', description: 'Usage <popup>', source: 'session-signals' },
    { name: 'graph', description: 'Graph window', source: 'project-intelligence' },
  ]);
  assert.ok(html.indexOf('/graph') < html.indexOf('/used'));
  assert.ok(html.includes('Usage &lt;popup&gt;'));
  assert.ok(!html.includes('<popup>'));
});

test('popup files are written privately and pruned without touching the current one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-popup-test-'));
  try {
    const file = signals.writePopupFile(dir, 'used-test.html', '<html></html>');
    assert.equal(fs.readFileSync(file, 'utf8'), '<html></html>');
    assert.equal(fs.statSync(file).mode & 0o777 & 0o077, 0);
    const stale = path.join(dir, 'stale.html');
    fs.writeFileSync(stale, 'old');
    const past = Date.now() - 8 * 24 * 3600_000;
    fs.utimesSync(stale, new Date(past), new Date(past));
    const removed = signals.pruneStaleFiles(dir, 7 * 24 * 3600_000, 'used-test.html');
    assert.equal(removed, 1);
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(stale));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const job = (asyncId, sessionId, status = 'running') => ({
  asyncId, asyncDir: `/tmp/async-${asyncId}`, sessionId, status,
});

test('stop-all proves session ownership and dedupes shared jobs', () => {
  const aborted = [];
  const delivered = [];
  const state = {
    asyncJobs: new Map([
      ['a1', job('a1', 'session-1')],
      ['a2', job('a2', 'session-2')],
      ['a3', job('a3', 'session-1', 'complete')],
    ]),
    fleetJobs: new Map([['a1', job('a1', 'session-1')]]),
    workflowControllers: new Map([['a1', { abort: () => aborted.push('a1') }]]),
  };
  const io = {
    reconcile: (asyncDir) => ({
      status: {
        runId: asyncDir === '/tmp/async-a1' ? 'a1' : asyncDir === '/tmp/async-a2' ? 'a2' : 'a3',
        sessionId: asyncDir === '/tmp/async-a2' ? 'session-2' : 'session-1',
        state: asyncDir === '/tmp/async-a3' ? 'complete' : 'running',
      },
    }),
    deliver: (request) => delivered.push(request.asyncDir),
  };
  const result = stopAllSessionRuns(state, 'session-1', undefined, io);
  assert.deepEqual(result.stopped, ['a1']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(delivered, ['/tmp/async-a1']);
  assert.deepEqual(aborted, ['a1']);
});

test('stop-all fails closed and captures delivery errors', () => {
  assert.deepEqual(stopAllSessionRuns(undefined, 'session-1').stopped, []);
  assert.deepEqual(stopAllSessionRuns({ asyncJobs: new Map() }, '').stopped, []);
  const state = {
    asyncJobs: new Map([['b1', job('b1', undefined)], ['b2', job('b2', 'session-1')]]),
  };
  const io = {
    reconcile: (asyncDir) => {
      if (asyncDir.endsWith('b1')) throw new Error('unreadable status');
      return { status: { runId: 'b2', sessionId: 'session-1', state: 'queued' } };
    },
    deliver: () => { throw new Error('control channel down'); },
  };
  const result = stopAllSessionRuns(state, 'session-1', undefined, io);
  assert.deepEqual(result.stopped, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'b2');
});

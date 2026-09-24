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
  assert.ok(html.includes('5 results'));
  assert.ok(html.includes('<details class="group"'));
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
  assert.deepEqual(summary.tools, [{ name: 'read', count: 2, errors: 0 }, { name: 'bash', count: 2, errors: 0 }]);
  assert.equal(summary.toolDistinctTotal, 2);
  assert.deepEqual(summary.skillsRead, [{ name: 'debugging', count: 1 }]);
  assert.deepEqual(summary.skillsPartial, [], 'a fully opened skill is not also labeled partial-only');
  assert.equal(summary.inspected, 8);
  assert.ok(signals.usedSummaryHtml(summary).includes('1 fully opened · 0 partial only'));
});

test('used summary includes ledger-backed skill reads and separates suggestions', () => {
  const branch = [{
    type: 'custom', customType: 'relevant-guidance', data: {
      read: ['/skills/coding-practices/SKILL.md'],
      shown: ['skill:/skills/coding-practices/SKILL.md', 'skill:/skills/debugging/SKILL.md'],
    },
  }];
  const summary = signals.buildUsedSummary(branch);
  assert.deepEqual(summary.skillsRead, [{ name: 'coding-practices', count: 0 }]);
  assert.deepEqual(summary.skillsSuggested, ['coding-practices', 'debugging']);
  assert.deepEqual(summary.skillTotals, { read: 1, partial: 0, suggested: 2, suggestedOnly: 1, omitted: 0 });
  const html = signals.usedSummaryHtml(summary);
  assert.ok(html.includes('1 fully opened · 0 partial only · 1 suggested only'));
  assert.ok(html.includes('also suggested'));
  assert.ok(html.includes('no read recorded'));
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
  const summary = signals.buildUsedSummary(branch, { provider: 'openrouter', id: 'main-model', thinking: 'medium' });
  assert.equal(summary.runs.length, 1);
  assert.deepEqual(summary.runs[0], { runId: 'run-async-1', attempt: 1, index: 0, mode: 'single', agent: 'worker', status: 'completed', provider: 'openrouter', model: 'big-model', thinking: 'high', tokens: 0, usageRecorded: false });
  assert.equal(summary.routes.length, 1);
  assert.equal(summary.routes[0].thinking, 'medium');
  assert.ok(summary.routes[0].nested.includes('DeepInfra'));
  assert.equal(summary.models.length, 1);
  assert.equal(summary.models[0].current, true);
  assert.equal(summary.models[0].selections, 1);
  assert.equal(summary.councils.length, 1);
  assert.equal(summary.councils[0].status, 'complete');
  assert.equal(summary.reviews.disposition, 'accepted');
  assert.deepEqual(summary.reviews.aspects, [{ aspect: 'correctness', outcome: 'pass' }]);
  const html = signals.usedSummaryHtml(summary);
  for (const needle of ['openrouter', 'big-model', 'Thinking', 'high', 'DeepInfra', 'Decision 1', 'correctness: pass', '● current']) {
    assert.ok(html.includes(needle), `popup shows ${needle}`);
  }
});

test('used summary shows actual main-model usage and token detail', () => {
  const branch = [
    { type: 'message', message: { role: 'assistant', provider: 'deepseek', model: 'reasoner', content: [{ type: 'text', text: 'ok' }], usage: { input: 100, cacheRead: 20, cacheWrite: 0, output: 5, reasoning: 3 } } },
    { type: 'custom', customType: 'model-config-v1', data: { route: 'deepseek/reasoner', thinking: 'high', source: 'session_start' } },
  ];
  const summary = signals.buildUsedSummary(branch, { provider: 'deepseek', id: 'reasoner', thinking: 'high' });
  assert.equal(summary.models.length, 1);
  assert.deepEqual({ route: summary.models[0].route, current: summary.models[0].current, turns: summary.models[0].turns, input: summary.models[0].input, output: summary.models[0].output }, { route: 'deepseek/reasoner', current: true, turns: 1, input: 100, output: 5 });
  assert.deepEqual(summary.models[0].thinking, ['high']);
  const html = signals.usedSummaryHtml(summary);
  assert.ok(html.includes('125 total'));
  assert.ok(html.includes('100 input'));
  assert.ok(html.includes('3 tokens (included in output)'));
});

test('used summary deduplicates child snapshots and keeps final model usage', () => {
  const branch = [
    toolCall('s1', 'subagent', { agent: 'worker', model: 'openrouter/child-model', thinking: 'high' }),
    toolResult('s1', 'subagent', { asyncId: 'child-parent', state: 'running' }),
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'child-parent', mode: 'single', state: 'running', results: [{ index: 0, status: 'running' }] } },
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'child-parent', mode: 'single', state: 'completed', results: [{ index: 0, status: 'completed', model: 'openrouter/child-model', usage: { input: 20, cacheRead: 10, cacheWrite: 0, output: 5, turns: 2, cost: {total:0,source:'provider-reported',complete:true} } }] } },
  ];
  const summary = signals.buildUsedSummary(branch);
  assert.equal(summary.runs.length, 1);
  assert.equal(summary.runs[0].status, 'completed');
  assert.equal(summary.runs[0].tokens, 35);
  assert.equal(summary.runs[0].turns, 2);
  assert.equal(summary.runs[0].costUsd, 0);
  assert.equal(summary.agents.total, 1);
  const html = signals.usedSummaryHtml(summary);
  assert.ok(html.includes('35'));
  assert.ok(html.includes('$0.000000'));
  // A numeric zero without pricing provenance is a legacy placeholder, not
  // evidence that these nonzero token counts were free.
  const legacy=structuredClone(branch);
  legacy.at(-1).data.results[0].usage.cost=0;
  const unknown=signals.buildUsedSummary(legacy);
  assert.equal(unknown.runs[0].tokens,35);
  assert.equal(unknown.runs[0].costUsd,undefined);
  assert.ok(!signals.usedSummaryHtml(unknown).includes('$0.000000'));
});

test('unknown run provenance stays absent, never guessed', () => {
  const branch = [
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'run-orphan', results: [{ index: 0, status: 'completed' }] } },
  ];
  const summary = signals.buildUsedSummary(branch);
  assert.equal(summary.runs.length, 1);
  assert.equal(summary.runs[0].provider, undefined);
  assert.equal(summary.runs[0].thinking, undefined);
  const html = signals.usedSummaryHtml(summary);
  assert.ok(html.includes('<dt>Thinking</dt><dd>not recorded</dd>'));
  assert.ok(html.includes('model not recorded'));
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

const errorsLib = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-errors.ts')));
const diagnosticsLib = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-diagnostics.ts')));

const errorResult = (toolCallId, toolName, text, details = {}) => ({
  type: 'message', message: { role: 'toolResult', toolCallId, toolName, details, content: [{ type: 'text', text }], isError: true },
});

test('errors collector captures deep tool failure with payload, module and stable incident', () => {
  const branch = [
    toolCall('e1', 'http_request', { url: 'https://example.com/api', apiKey: 'TEST_SYNTHETIC_API_KEY_VALUE' }),
    errorResult('e1', 'http_request', 'transport failure: fetch failed 503 for Bearer TEST_SYNTHETIC_BEARER_TOKEN (socket hang up)', { status: 503 }),
  ];
  const report = errorsLib.collectSessionErrors(branch);
  assert.equal(report.total, 1);
  assert.equal(report.inspected, 2);
  const item = report.errors[0];
  assert.equal(item.seq, 1);
  assert.equal(item.kind, 'tool');
  assert.equal(item.tool, 'http_request');
  assert.equal(item.module, 'agent/extensions/http-tools.ts');
  assert.equal(item.category, 'transport');
  assert.equal(item.callId, 'e1');
  assert.equal(item.statusCode, '503');
  assert.ok(item.error.includes('socket hang up'));
  assert.ok(!item.error.includes('TEST_SYNTHETIC_BEARER_TOKEN'), 'bearer token is redacted from error text');
  assert.equal(item.payload.url, 'https://example.com/api');
  assert.equal(item.payload['apiKey'], '[redacted]');
  assert.ok(item.why.includes('http_request'));
  // Same stable incident id the /metrics diagnostics show for this cause.
  const diag = diagnosticsLib.collectSessionDiagnostics(branch);
  assert.equal(diag.failures.length, 1);
  assert.equal(item.incident, diag.failures[0].incident);
});

test('errors collector captures model failure with route, usage and status code', () => {
  const branch = [
    { type: 'message', message: { role: 'assistant', provider: 'friendli', model: 'mixtral-x', stopReason: 'error', errorMessage: 'request failed with status 429: quota exceeded for quota group', content: [], usage: { input: 100, output: 5 } } },
  ];
  const report = errorsLib.collectSessionErrors(branch);
  assert.equal(report.total, 1);
  const item = report.errors[0];
  assert.equal(item.kind, 'model');
  assert.equal(item.provider, 'friendli');
  assert.equal(item.model, 'mixtral-x');
  assert.equal(item.category, 'capacity');
  assert.equal(item.statusCode, '429');
  assert.deepEqual(item.usage, { input: 100, output: 5 });
  assert.ok(item.module.includes('provider-gate'));
  assert.ok(item.why.includes('friendli/mixtral-x'));
});

test('errors collector captures child failure with launch payload and ledger cause', () => {
  const branch = [
    toolCall('s1', 'subagent', { agent: 'worker', model: 'friendli/child-model', task: 'do the thing' }),
    toolResult('s1', 'subagent', { asyncId: 'run-9' }),
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'run-9', mode: 'single', state: 'failed', results: [{ index: 0, runId: 'run-9', status: 'failed', model: 'friendli/child-model', backend: 'native', exitCode: 1, error: 'Child timed out after 20000ms', usage: { input: 50, output: 10 }, evidence: { version: 1, outcomeReason: 'timeout', attemptCount: 2, output: 'absent' } }] } },
  ];
  const ledgerTasks = [{
    taskId: 't1', label: 'thing', state: 'failed',
    execution: { status: 'failed' }, acceptance: { status: 'none' },
    attempts: [{
      attempt: 1, runId: 'run-9', route: 'friendli/child-model', backend: 'native', state: 'failed',
      execution: { status: 'failed', cause: { stage: 'execute', category: 'timeout', retryable: true, deterministicShape: false, outputPresent: false, truncation: 'none', acceptance: 'none' } },
      acceptance: { status: 'none' },
    }],
  }];
  const report = errorsLib.collectSessionErrors(branch, { ledgerTasks });
  assert.equal(report.total, 1);
  const item = report.errors[0];
  assert.equal(item.kind, 'child');
  assert.equal(item.runId, 'run-9');
  assert.equal(item.category, 'timeout');
  assert.equal(item.exitCode, 1);
  assert.equal(item.attempts, 2);
  assert.equal(item.outputPresence, 'absent');
  assert.equal(item.execution, 'failed (execute/timeout)');
  assert.equal(item.module, 'agent/extensions/pi-subagents (native · friendli/child-model)');
  assert.equal(item.payload.agent, 'worker');
  assert.equal(item.payload.model, 'friendli/child-model');
  assert.deepEqual(item.usage, { input: 50, output: 10 });
});

test('errors collector does not mistake bare counts for status codes', () => {
  const report = errorsLib.collectSessionErrors([
    toolCall('c1', 'bash', { command: 'ls' }),
    errorResult('c1', 'bash', 'processed 500 items then broke: boom'),
  ]);
  assert.equal(report.total, 1);
  assert.equal(report.errors[0].statusCode, undefined);
});

test('errors popup escapes content and carries JSON plus copy button', () => {
  const report = errorsLib.collectSessionErrors([
    toolCall('x1', 'bash', { command: 'false' }),
    errorResult('x1', 'bash', '<script>alert("x")</script> boom'),
  ]);
  const html = signals.errorsHtml(report);
  assert.ok(!html.includes('<script>alert("x")</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('id="copy-errors"'));
  assert.ok(html.includes('id="errors-json"'));
  assert.ok(html.includes('navigator.clipboard'));
  assert.ok(html.includes('core (native)'));
  assert.ok(html.includes('Failed payload (redacted)'));
  const empty = signals.errorsHtml(errorsLib.collectSessionErrors([]));
  assert.ok(empty.includes('id="copy-errors"'));
  assert.ok(empty.includes('No tool, model, child or workflow failures'));
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

test('used popup merges a legacy automatic wrapper and names the recorded timeout at collapsed rows', () => {
  const native='11111111-1111-4111-8111-111111111111';
  const branch=[
    {type:'custom',customType:'subagent-lifecycle-v1',data:{runId:native,mode:'single',results:[{index:0,status:'failed'}]}},
    {type:'custom',customType:'subagent-cost-v1',data:{runId:'auto-assist-wrapper',mode:'single',results:[{index:0,agent:'automatic-free-assistant',model:'fixture/reviewer',sessionFile:`/fixture/${native}/run-0/session.jsonl`,timedOut:true,error:'child-error',usage:{input:300,output:100,turns:3}}]}},
  ];
  branch.push({type:'custom',customType:'subagent-cost-v1',data:{runId:'auto-assist-wrapper',mode:'single',results:[{index:0,status:'failed',error:'child-error'}]}});
  const summary=signals.buildUsedSummary(branch),html=signals.usedSummaryHtml(summary);
  assert.equal(summary.agents.total,1);
  assert.equal(summary.agents.failed,1);
  assert.equal(summary.logicalTasks.length,1);
  assert.equal(summary.runs.length,1);
  assert.match(html,/<summary><span class="item-name">Automatic assistant<\/span><span class="badge failed">Timed out<\/span>/);
  assert.match(html,/Attempt 1 · fixture\/reviewer<\/span><span class="badge failed">Timed out/);
  assert.match(html,/automatic-free-assistant/,'raw agent identity remains inspectable');
  assert.doesNotMatch(html,/failed \(unknown\)/);
  assert.match(html,/1 child · 0 main-session · 0 recoveries/);
});

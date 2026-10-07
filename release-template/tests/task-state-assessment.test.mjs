import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'task-assessment-'));
process.env.PI_CODING_AGENT_DIR = directory;
process.env.PI_TASK_STATE_DIR = path.join(directory, 'state');
delete process.env.PI_CHECKPOINTS;
process.env.PI_LOCAL_LM = 'off';
process.env.PI_OFFLINE = '1';
process.env.PI_LLM_PREFERENCES_FILE = path.join(directory, 'preferences.json');
process.env.PI_PROVIDER_STATE_FILE = path.join(directory, 'providers.json');

const { default: taskState } = await import('../agent/extensions/task-state.ts');
const { default: checkpoints } = await import('../agent/extensions/checkpoints.ts');
const { getTaskStateService, clearTaskStateServices } = await import('../agent/extensions/lib/task-state/service.ts');
const { taskFileObservation } = await import('../agent/extensions/lib/task-state/file-evidence.ts');
const { taskStatePaths } = await import('../agent/extensions/lib/task-state/store.ts');
const { requirementState, applyEvent } = await import('../agent/extensions/lib/task-state/reducer.ts');
const { readSessionLedger } = await import('../agent/extensions/lib/requirement-ledger.ts');
const { createExtensionRuntime, loadExtensionFromFactory } = await import('../core/coding-agent/src/core/extensions/loader.js');
const { ExtensionRunner } = await import('../core/coding-agent/src/core/extensions/runner.js');
const { createEventBus } = await import('../core/coding-agent/src/core/event-bus.js');
const { SessionManager } = await import('../core/coding-agent/src/core/session-manager.js');
const { withSessionObservability } = await import('../core/coding-agent/src/core/session-observability.js');
const { createWriteTool } = await import('../core/coding-agent/src/core/tools/write.js');
const { createBashTool } = await import('../core/coding-agent/src/core/tools/bash.js');
test.after(() => { clearTaskStateServices(); fs.rmSync(directory, { recursive: true, force: true }); });

async function harness(t, ledger = false) {
  clearTaskStateServices();
  const cwd = fs.mkdtempSync(path.join(directory, 'workspace-'));
  const manager = SessionManager.inMemory(cwd);
  const runtime = createExtensionRuntime();
  runtime.appendEntry = (type, data) => manager.appendCustomEntry(type, data);
  runtime.getActiveTools = () => ['task_state', 'write', 'bash'];
  runtime.getAllTools = () => [];
  runtime.sendMessage = message => manager.appendCustomMessageEntry(message.customType, message.content, !!message.display, message.details);
  const bus = createEventBus();
  // Reverse the usual ordering: task state runs before the ledger owner.
  const extensions = [await loadExtensionFromFactory(taskState, cwd, bus, runtime)];
  if (ledger) extensions.push(await loadExtensionFromFactory(checkpoints, cwd, bus, runtime));
  const runner = new ExtensionRunner(extensions, runtime, cwd, manager, { getAvailable: () => [] });
  const errors = [];
  runner.onError(error => errors.push(error));
  const scope = fn => withSessionObservability(runner.createContext(), fn);
  const emit = (type, data = {}) => scope(() => runner.emit({ type, ...data }));
  await emit('session_start');
  const service = scope(() => getTaskStateService(manager.getSessionId()));
  const tool = runner.getToolDefinition('task_state');
  const query = params => scope(() => tool.execute('query', params, undefined, undefined, runner.createContext()));
  const result = event => scope(() => runner.emitToolResult({ type: 'tool_result', content: [], isError: false, ...event }));
  const call = (toolName, toolCallId, input) => scope(() => runner.emitToolCall({ type: 'tool_call', toolName, toolCallId, input }));
  const input = (text, requestId) => scope(() => runner.emitInput(text, undefined, 'interactive', undefined, { requestId }));
  const before = text => scope(() => runner.emitBeforeAgentStart(text, undefined, '', { cwd }));
  const message = message => scope(() => runner.emitMessageEnd({ type: 'message_end', message }));
  t.after(async () => { await emit('session_shutdown'); assert.deepEqual(errors, [], 'native hooks must not fail silently'); bus.clear(); });
  return { cwd, manager, service, input, emit, before, query, result, call, message };
}

async function seed(h) {
  await h.input('Implement the answer and check its behavior.', 'seed');
  h.service.syncRequirements([{ id: 'R1', text: 'Export the answer as 42' }]);
  fs.mkdirSync(path.join(h.cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(h.cwd, 'src/answer.mjs'), 'export const answer = 42;\n');
  await h.result({ toolName: 'write', toolCallId: 'write-answer', input: { path: 'src/answer.mjs' } });
}

async function checked(h, id = 'check') {
  const input = { command: 'node --test verify.test.mjs' };
  await h.call('bash', id, input);
  await h.result({ toolName: 'bash', toolCallId: id, input, content: [{ type: 'text', text: 'Observed answer 42.' }] });
  return h.service.query(entity => entity.kind === 'evidence' && entity.refs?.toolCallId === id)[0];
}

const assessment = (h, evidence) => ({ action: 'assess', requirementId: 'R1',
  implementationIds: [h.service.query(entity => entity.kind === 'tool-exec')[0].id], evidenceIds: [evidence.id],
  reason: 'The retained test imports the written module and asserts that its exported answer equals 42.' });

test('native ledger owner and runtime preserve requirements regardless of input-hook order', async t => {
  const h = await harness(t, true);
  const prompt = 'Add a search box. Keep existing text unchanged.';
  await h.input(prompt, 'literal');
  const ledger = readSessionLedger(h.manager.getBranch());
  assert.equal(ledger.items.length, 2, 'actual checkpoint owner persisted its receipt');
  assert.equal(h.service.stats().requirements, 0, 'task input ran before the ledger');
  await h.before(prompt);
  assert.deepEqual(h.service.query(entity => entity.kind === 'requirement').map(entity => entity.refs.requirementId), ledger.items.map(item => item.id));
  const seq = h.service.graph().seq;
  const paths = taskStatePaths(process.env.PI_TASK_STATE_DIR, h.manager.getSessionId(), h.service.taskId);
  const size = fs.statSync(paths.events).size;
  await h.before(prompt);
  assert.equal(h.service.graph().seq, seq);
  assert.equal(fs.statSync(paths.events).size, size, 'unchanged requirements do not append duplicate log records');
});

test('unmapped creative requirements stay advisory at the actual last-todo gate', async t => {
  const h = await harness(t, true);
  const prompt = '- Render the diagram as SVG\n- Preserve its typography';
  await h.input(prompt, 'creative'); await h.before(prompt);
  await h.result({ toolName: 'svg_render', toolCallId: 'render', input: { action: 'render' }, details: { status: 'rendered' } });
  const todo = { id: 1, status: 'in_progress', subject: 'Deliver the diagram' };
  h.manager.appendMessage({ role: 'toolResult', toolName: 'todo', toolCallId: 'todo-list', content: [], details: { tasks: [todo] }, isError: false, timestamp: Date.now() });
  await h.result({ toolName: 'todo', toolCallId: 'todo-list', details: { tasks: [todo] } });
  assert.equal(h.service.stats().requirements, 2);
  assert.equal(h.service.stats().verified, 0);
  assert.deepEqual(h.service.completionBlockers(), []);
  const completion = await h.call('todo', 'finish', { action: 'update', id: 1, status: 'completed' });
  assert.notEqual(completion?.block, true, 'unmapped creative requirements cannot demand irrelevant tests');
  assert.ok(h.service.query(entity => entity.kind === 'completion-claim' && /completion plan-complete.*allowed/.test(entity.detail ?? '')).length, 'the real gate ran, not a shadow/disabled bypass');
});

test('owned write and bash tools supply an accountable assessment that survives recovery', async t => {
  const h = await harness(t);
  await h.input('Implement the answer and check its behavior.', 'native');
  h.service.syncRequirements([{ id: 'R1', text: 'Export the answer as 42' }]);
  const write = { path: 'src/answer.mjs', content: 'export const answer = 42;\n' };
  await h.call('write', 'native-write', write);
  const written = await createWriteTool(h.cwd).execute('native-write', write);
  await h.result({ toolName: 'write', toolCallId: 'native-write', input: write, ...written });
  fs.writeFileSync(path.join(h.cwd, 'verify.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { answer } from './src/answer.mjs'; test('observes answer', () => assert.equal(answer, 42));\n");
  const command = { command: 'node --test verify.test.mjs', timeout: 15 };
  await h.call('bash', 'native-test', command);
  const checked = await createBashTool(h.cwd).execute('native-test', command);
  await h.result({ toolName: 'bash', toolCallId: 'native-test', input: command, ...checked });
  const evidence = h.service.query(entity => entity.kind === 'evidence')[0];
  assert.deepEqual(h.service.stats().verified, 0, 'exit zero alone never verifies a requirement');
  const params = assessment(h, evidence);
  const result = await h.query(params);
  assert.equal(result.details.ok, true, result.details.reason);
  assert.deepEqual(h.service.completionBlockers(), []);
  const paths = taskStatePaths(process.env.PI_TASK_STATE_DIR, h.manager.getSessionId(), h.service.taskId);
  const batches = fs.readFileSync(paths.events, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.kind === 'assessment');
  assert.equal(batches.length, 1, 'links, main judgment and transitions share one log record');
  await h.query(params);
  assert.equal(fs.readFileSync(paths.events, 'utf8').trim().split('\n').filter(line => JSON.parse(line).kind === 'assessment').length, 1, 'identical assessments are idempotent');
  h.service.checkpoint();
  clearTaskStateServices();
  const restored = getTaskStateService(h.manager.getSessionId());
  assert.equal(restored.stats().verified, 1);
  assert.deepEqual(restored.completionBlockers(), []);
  fs.writeFileSync(path.join(h.cwd, 'src/answer.mjs'), 'export const answer = 43;\n');
  await h.result({ toolName: 'edit', toolCallId: 'after-resume', input: { path: 'src/answer.mjs' } });
  assert.match(restored.completionBlockers().join('\n'), /R1.*stale/, 'mapped verification remains a hard receipt when later edits invalidate it');
});

test('assessment rejects unknown, advisory, stale and cross-task evidence without mutation', async t => {
  const h = await harness(t); await seed(h);
  const evidence = await checked(h);
  const params = assessment(h, evidence);
  h.service.record({ id: 'advice', kind: 'evidence', status: 'active', title: 'Child says it passed', provenance: 'subagent', refs: { toolCallId: 'child-call' } });
  for (const evidenceIds of [['missing'], ['advice'], [`evi-from-another-task`]]) {
    const before = h.service.graph().seq;
    const result = await h.query({ ...params, evidenceIds });
    assert.equal(result.isError, true);
    assert.equal(h.service.graph().seq, before);
  }
  fs.writeFileSync(path.join(h.cwd, 'src/answer.mjs'), 'export const answer = 43;\n');
  assert.equal((await h.query(params)).isError, true, 'external edits are detected without a harness write event');
  await h.result({ toolName: 'edit', toolCallId: 'edit-answer', input: { path: './src/answer.mjs' } });
  assert.equal(h.service.entity(evidence.id).stale, true);
  assert.equal((await h.query(params)).isError, true);
});

test('checks cannot bind newer source that appeared while they ran; duplicate writes are harmless', async t => {
  const h = await harness(t); await seed(h);
  const input = { command: 'node --test verify.test.mjs' };
  await h.call('bash', 'racing-test', input);
  fs.writeFileSync(path.join(h.cwd, 'src/answer.mjs'), 'export const answer = 43;\n');
  await h.result({ toolName: 'edit', toolCallId: 'racing-write', input: { path: 'src/answer.mjs' } });
  await h.result({ toolName: 'bash', toolCallId: 'racing-test', input });
  const evidence = h.service.query(entity => entity.kind === 'evidence')[0];
  assert.deepEqual(evidence.refs.fileHashes, {}, 'result boundary cannot certify source absent at launch');
  const version = h.service.graph().files['src/answer.mjs'].version;
  await h.result({ toolName: 'edit', toolCallId: 'racing-write', input: { path: path.join(h.cwd, 'src/answer.mjs') } });
  assert.equal(h.service.graph().files['src/answer.mjs'].version, version);
  const params = { ...assessment(h, evidence), implementationIds: [h.service.query(entity => entity.kind === 'tool-exec').at(-1).id] };
  assert.equal((await h.query(params)).isError, true);
});

test('interrupted assessment append and malformed batches cannot partially verify a requirement', async t => {
  const h = await harness(t); await seed(h);
  const evidence = await checked(h), params = assessment(h, evidence);
  const paths = taskStatePaths(process.env.PI_TASK_STATE_DIR, h.manager.getSessionId(), h.service.taskId);
  fs.renameSync(paths.events, `${paths.events}.retained`);
  fs.mkdirSync(paths.events);
  const seq = h.service.graph().seq;
  const result = await h.query(params);
  assert.equal(result.isError, true);
  assert.equal(h.service.graph().seq, seq);
  assert.equal(h.service.graph().links.some(link => link.kind === 'verified-by'), false);
  assert.equal(requirementState(h.service.graph(), `req-${h.service.taskId}-R1`).verified, false);
  fs.rmdirSync(paths.events); fs.renameSync(`${paths.events}.retained`, paths.events);
  assert.equal((await h.query(params)).details.ok, true, 'a retry can record the complete batch');
  const before = h.service.graph().seq;
  const graph = h.service.graph();
  assert.equal(applyEvent(graph, { sessionId: graph.sessionId, taskId: graph.taskId, ts: Date.now(), kind: 'assessment', eventId: 'bad-batch', events: [null] }), false);
  assert.equal(graph.seq, before);
});

test('only matching current prompt analysis can rotate a task; old ledger IDs stay archived after reload', async t => {
  const h = await harness(t); await seed(h);
  const original = h.service.taskId;
  h.manager.appendCustomMessageEntry('prompt-analysis', '', false, { requestId: 'old', relation: 'unrelated' });
  await h.input('Also add documentation.', 'new');
  assert.equal(h.service.taskId, original, 'historical unrelated analysis does not classify the new prompt');
  await h.input('Investigate something different.', 'latest');
  await h.message({ role: 'custom', customType: 'prompt-analysis', details: { requestId: 'new', relation: 'unrelated' } });
  assert.equal(h.service.taskId, original, 'superseded request analysis is ignored');
  h.manager.appendCustomEntry('requirement-ledger-v1', { items: [{ id: 'R1', text: 'Export the answer as 42' }, { id: 'R2', text: 'Investigate the new issue' }], next: 2 });
  await h.message({ role: 'custom', customType: 'prompt-analysis', details: { requestId: 'latest', relation: 'unrelated' } });
  assert.notEqual(h.service.taskId, original);
  assert.deepEqual(h.service.query(entity => entity.kind === 'requirement').map(entity => entity.refs.requirementId), ['R2']);
  h.service.checkpoint(); clearTaskStateServices();
  const restored = getTaskStateService(h.manager.getSessionId());
  restored.syncRequirements(readSessionLedger(h.manager.getBranch()).items);
  assert.deepEqual(restored.query(entity => entity.kind === 'requirement').map(entity => entity.refs.requirementId), ['R2']);
});

test('async child launches remain active and retained partial failures survive native waits', async t => {
  const h = await harness(t); await h.input('Delegate the investigation.', 'dispatch');
  await h.call('subagent', 'launch', { agent: 'reviewer', task: 'Inspect it', async: true });
  await h.result({ toolName: 'subagent', toolCallId: 'launch', input: { agent: 'reviewer' }, details: { mode: 'single', results: [], asyncId: 'run-native' } });
  let children = h.service.query(entity => entity.kind === 'child');
  assert.equal(children.length, 1, 'the launch updates its dispatch, not a duplicate child');
  assert.equal(children[0].status, 'active');
  await h.call('subagent', 'inspect', { action: 'status', id: 'run-native' });
  await h.result({ toolName: 'subagent', toolCallId: 'inspect', input: { action: 'status' }, details: { mode: 'management', results: [] } });
  assert.equal(h.service.query(entity => entity.kind === 'child').length, 1);
  await h.result({ toolName: 'bg_wait', toolCallId: 'wait', details: { completions: [{ runId: 'run-native', state: 'complete', results: [{ agent: 'a', terminalState: 'succeeded', success: true }, { agent: 'b', terminalState: 'timed_out', success: false }] }] } });
  children = h.service.query(entity => entity.kind === 'child');
  assert.equal(children[0].status, 'failed');
  assert.match(children[0].detail, /timed_out/);
  assert.equal(children[0].provenance, 'subagent');
  assert.equal(h.service.stats().verified, 0);
});

test('native background launches retain source bindings across recovery and require a terminal exit', async t => {
  const h = await harness(t); await seed(h);
  const input = { command: 'node --test verify.test.mjs' };
  await h.call('bg_run', 'bg-call', input);
  await h.result({ toolName: 'bg_run', toolCallId: 'bg-call', input, details: { task: { id: 'bg-native', status: 'running' } } });
  assert.equal(h.service.query(entity => entity.kind === 'evidence').length, 0);
  h.service.checkpoint(); clearTaskStateServices();
  const message = details => h.message({ role: 'custom', customType: 'background-task-notification', details: { id: 'bg-native', command: input.command, ...details } });
  await message({ status: 'completed' });
  await message({ status: 'running', exitCode: 0 });
  const restored = getTaskStateService(h.manager.getSessionId());
  assert.equal(restored.query(entity => entity.kind === 'evidence').length, 0, 'neither missing exit nor nonterminal state is a pass');
  await message({ status: 'completed', exitCode: 0 });
  const evidence = restored.query(entity => entity.kind === 'evidence')[0];
  assert.equal(evidence.refs.fileHashes['src/answer.mjs'], restored.graph().files['src/answer.mjs'].hash);
});

test('source hashing handles aliases and Unicode but rejects escapes, huge files and mid-read replacement', t => {
  const cwd = fs.mkdtempSync(path.join(directory, 'hash-'));
  const file = '@kanıt ü.mjs', bytes = 'export const value = 42;\n';
  fs.writeFileSync(path.join(cwd, file), bytes);
  fs.symlinkSync(file, path.join(cwd, 'alias'));
  assert.deepEqual(taskFileObservation(cwd, 'alias'), { file, hash: createHash('sha256').update(bytes).digest('hex') });
  assert.ok(taskFileObservation(cwd, file).hash);
  fs.symlinkSync(path.join(directory, 'outside'), path.join(cwd, 'escape'));
  fs.writeFileSync(path.join(directory, 'outside'), bytes);
  assert.equal(taskFileObservation(cwd, 'escape').hash, undefined);
  const huge = fs.openSync(path.join(cwd, 'huge'), 'w'); fs.ftruncateSync(huge, 2 ** 31); fs.closeSync(huge);
  assert.equal(taskFileObservation(cwd, 'huge').hash, undefined);
  assert.equal(taskFileObservation(cwd, '.').hash, undefined);
  const read = fs.readSync;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = read(...args);
    fs.renameSync(path.join(cwd, file), path.join(cwd, 'retired'));
    fs.writeFileSync(path.join(cwd, file), bytes);
    return count;
  });
  assert.equal(taskFileObservation(cwd, file).hash, undefined, 'inode replacement while reading cannot earn a hash');
});

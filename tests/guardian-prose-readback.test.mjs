import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GuardianSupervisor, tagGuardianRequestMessage } from '../core/coding-agent/dist/core/guardian/guardian-supervisor.js';
import { createReadToolDefinition } from '../core/coding-agent/dist/core/tools/read.js';
import { createEditToolDefinition } from '../core/coding-agent/dist/core/tools/edit.js';
import { createWriteToolDefinition } from '../core/coding-agent/dist/core/tools/write.js';
import { createAgentSession } from '../core/coding-agent/dist/core/sdk.js';
import { DefaultResourceLoader } from '../core/coding-agent/dist/core/resource-loader.js';
import { SessionManager } from '../core/coding-agent/dist/core/session-manager.js';
import { SettingsManager } from '../core/coding-agent/dist/core/settings-manager.js';
import { readOnlyDiscoveryShell } from '../core/coding-agent/dist/core/guardian/guardian-prose.js';

const prompt = 'Correct teh to the in README.md. This is a one-line typo; finish directly after checking the file.';
const finished = { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done. Corrected the typo and read back the file.' }] } };

async function fixture(t, request = prompt) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-prose-'));
  const emitted = [], supervisor = new GuardianSupervisor({ sessionId: path.basename(cwd), cwd, emit: event => emitted.push(event), clock: () => 0 });
  t.after(() => { supervisor.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); });
  supervisor.noteInput({ requestId: 'request', source: 'rpc', originalText: request }); supervisor.acceptRequest('request');
  await supervisor.observeAgentEvent({ type: 'message_start', message: tagGuardianRequestMessage({ role: 'user', content: [{ type: 'text', text: request }] }, { requestId: 'request', turnId: 'request', sessionId: supervisor.sessionId, processId: String(process.pid), guardianOwnerId: supervisor.ownerId }) });
  const tools = { read: createReadToolDefinition(cwd), edit: createEditToolDefinition(cwd), write: createWriteToolDefinition(cwd) };
  let id = 0;
  const file = (name, content = 'Use teh documented command.\n') => { const target = path.join(cwd, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  const start = async (name, args) => { const toolCallId = `tool-${++id}`; await supervisor.observeAgentEvent({ type: 'tool_execution_start', toolName: name, toolCallId, args }); return toolCallId; };
  const end = async (toolCallId, name, result, isError = false) => supervisor.observeAgentEvent({ type: 'tool_execution_end', toolName: name, toolCallId, result, isError });
  const run = async (name, args) => {
    const toolCallId = await start(name, args);
    let result, isError = false;
    try { result = await tools[name].execute(toolCallId, args); } catch (error) { isError = true; result = { content: [{ type: 'text', text: error.message }] }; }
    await end(toolCallId, name, result, isError); return result;
  };
  const edit = (name = 'README.md', oldText = 'teh', newText = 'the') => run('edit', { path: name, edits: [{ oldText, newText }] });
  const read = (name = 'README.md', options = {}) => run('read', { path: name, ...options });
  const finish = async () => { await supervisor.observeAgentEvent(finished); return emitted.filter(event => event.detail.kind === 'unverified-completion').length; };
  return { cwd, supervisor, file, start, end, run, edit, read, finish };
}

test('bounded native prose edits and rewrites accept current complete readback without manufacturing a test pass', async t => {
  for (const [name, content, rewrite] of [['README.md', 'Use teh documented command.\n', false], ['docs/intro.rst', 'Use teh example.\n', false], ['note.txt', 'Use teh example.\n', false], ['README.md', 'Use teh example.\n\n```sh\nnpm test\n```\n', false], ['README.md', 'Use teh example.\n', true]]) {
    const f = await fixture(t); f.file(name, content);
    await f.read(name);
    if (rewrite) await f.run('write', { path: name, content: 'Use the example.\n' }); else await f.edit(name);
    await f.read(name);
    assert.equal(await f.finish(), 0, name);
    const task = f.supervisor._tasks.get('request');
    assert.notEqual(task.verifiedVersion, task.mutationVersion);
    assert.equal(f.supervisor.handleCommand('/guardian stats').stats.verifications, 0);
  }
});

for (const [name, args, safe] of [['grep', { pattern: 'teh', path: 'README.md' }, true], ['find', { pattern: '*.md' }, true], ['ls', { path: '.' }, true], ['bash', { command: 'pwd' }, true], ['bash', { command: 'ls -la ./docs' }, true], ['bash', { command: 'ls; pwd' }, true], ['bash', { command: 'ls -la; grep -rn "teh" README.md 2>/dev/null' }, true], ['bash', { command: 'pwd && ls -a && grep --line-number --fixed-strings \'teh\' README.md 2> /dev/null' }, true], ['bash', { command: 'ls > index.js' }, false], ['bash', { command: 'ls $(touch index.js)' }, false], ['bash', { command: 'ls `touch index.js`' }, false], ['bash', { command: 'sh check.sh' }, false], ['bash', { command: 'ls; node --eval "1"' }, false], ['bash', { command: 'ls; echo text > index.js' }, false], ['bash', { command: 'ls; write index.js' }, false], ['bash', { command: 'grep "teh; rm file" README.md' }, false], ['bash', { command: 'grep "teh && rm file" README.md' }, false]]) {
  test(`native read-only discovery preserves direct scope only when proven: ${name} ${JSON.stringify(args)}`, async t => {
    const f = await fixture(t); f.file('README.md');
    const id = await f.start(name, args); await f.end(id, name, { content: [{ type: 'text', text: 'Synthetic metadata listing' }] });
    await f.edit(); await f.read(); assert.equal(await f.finish(), safe ? 0 : 1);
  });
}

test('read-only Bash discovery grammar rejects adversarial and opaque shell forms', () => {
  for (const command of ['ls | grep x', 'ls & pwd', 'ls || pwd', 'ls &&', '; ls', 'ls;;pwd', 'ls; pwd; ls; pwd; ls', 'ls 2>/tmp/out', 'ls 1>/dev/null', 'ls >/dev/null', 'ls 2>&1', 'ls 2>/dev/null >README.md', 'ls 2>/dev/null; touch x', 'grep -rn "teh" README.md 2>/dev/null extra', 'grep -e "teh" README.md', 'grep --exec sh README.md', 'grep "teh"', 'grep "$HOME" README.md', 'grep \'$(touch x)\' README.md', 'grep "teh|rm" README.md', 'grep "teh>file" README.md', 'grep "teh\\\"; touch x" README.md', 'grep "teh" <(node x)', 'grep "teh" README.md\npwd', 'find . -delete', 'sed -i s/a/b/ README.md', 'eval ls', 'env ls', 'command ls', 'bash -c ls', '/bin/ls', '"ls"', 'ls -la; sh check.sh']) assert.equal(readOnlyDiscoveryShell(command), false, command);
  for (const command of ['pwd', 'pwd -P', 'ls -la', 'ls "docs folder"', 'grep -rn "teh" README.md 2>/dev/null', 'ls -la; grep -rn "teh" README.md 2>/dev/null', 'pwd && ls -a', 'grep --fixed-strings -- "teh" README.md', "grep 'teh' docs/README.md note.txt", 'pwd; ls -la; grep -n teh README.md']) assert.equal(readOnlyDiscoveryShell(command), true, command);
});

for (const scenario of ['no-readback', 'read-before-write', 'wrong-file', 'partial-read', 'stale-hash', 'changed-readback', 'read-overlaps-write', 'write-overlaps-read', 'failed-read', 'summary-only', 'late-write', 'mixed-files', 'mixed-code', 'shell-write', 'unclassified-shell-write', 'large-change', 'large-document', 'code-fence', 'inline-code', 'rst-literal', 'rewrite-code', 'plain-code', 'operational-prose']) {
  test(`prose readback cannot waive unsupported evidence: ${scenario}`, async t => {
    const f = await fixture(t);
    f.file('README.md', scenario === 'partial-read' ? 'Use teh example.\nAnother line.\n' : scenario === 'code-fence' || scenario === 'rewrite-code' ? '```text\nteh\n```\n' : scenario === 'inline-code' ? 'Use `teh` here.\n' : scenario === 'rst-literal' ? 'Example::\n\n    teh\n' : scenario === 'plain-code' ? 'echo teh\n' : scenario === 'operational-prose' ? 'Keep teh port open.\n' : scenario === 'large-document' ? `Use teh example.\n${'More prose.\n'.repeat(201)}` : 'Use teh documented command.\n');
    const original = await f.read();
    if (scenario === 'read-overlaps-write') {
      const id = await f.start('read', { path: 'README.md' }); const result = await createReadToolDefinition(f.cwd).execute(id, { path: 'README.md' });
      await f.edit(); await f.end(id, 'read', result);
    } else if (scenario === 'write-overlaps-read') {
      const id = await f.start('edit', { path: 'README.md', edits: [{ oldText: 'teh', newText: 'the' }] });
      await f.read(); const result = await createEditToolDefinition(f.cwd).execute(id, { path: 'README.md', edits: [{ oldText: 'teh', newText: 'the' }] }); await f.end(id, 'edit', result);
    } else {
      if (scenario === 'rewrite-code') await f.run('write', { path: 'README.md', content: 'Use the example.\n' });
      else await f.edit('README.md', 'teh', scenario === 'large-change' ? 'word '.repeat(300) : 'the');
      if (scenario === 'mixed-files' || scenario === 'mixed-code') { const name = scenario === 'mixed-code' ? 'index.js' : 'note.txt'; f.file(name); await f.edit(name); await f.read(name); }
      if (scenario === 'shell-write') { const id = await f.start('bash', { command: 'sed -i s/the/The/ README.md' }); await f.end(id, 'bash', { content: [{ type: 'text', text: '' }] }); }
      if (scenario === 'unclassified-shell-write') { const id = await f.start('bash', { command: 'python -c "open(\'index.js\',\'w\').write(\'code\')"' }); await f.end(id, 'bash', { content: [{ type: 'text', text: '' }] }); }
      if (scenario === 'wrong-file') { f.file('note.txt'); await f.read('note.txt'); }
      else if (scenario === 'stale-hash') { const id = await f.start('read', { path: 'README.md' }); await f.end(id, 'read', original); }
      else if (scenario === 'failed-read') { const id = await f.start('read', { path: 'README.md' }); await f.end(id, 'read', { content: [{ type: 'text', text: 'Read aborted' }] }, true); }
      else if (scenario === 'summary-only') { const id = await f.start('read', { path: 'README.md' }); await f.end(id, 'read', { content: [{ type: 'text', text: 'Looks good' }] }); }
      else if (scenario === 'partial-read') await f.read('README.md', { limit: 1 });
      else if (!['no-readback', 'read-before-write'].includes(scenario)) await f.read();
      if (scenario === 'changed-readback') { f.file('README.md', 'A concurrent writer replaced it.\n'); await f.read(); }
      if (scenario === 'late-write') await f.edit('README.md', 'the', 'this');
    }
    assert.equal(await f.finish(), 1, scenario);
  });
}

for (const [name, request] of [['AGENTS.md', 'Correct a typo in AGENTS.md.'], ['SKILL.md', 'Correct a typo in SKILL.md.'], ['SECURITY.md', 'Correct a typo in SECURITY.md.'], ['config/readme.md', prompt], ['core/readme.md', prompt], ['docs/policy.md', prompt], ['docs/authentication.md', prompt], ['docs/operations.md', prompt], ['README.md', `${prompt} Run the requested tests.`], ['README.md', `${prompt} Execute all checks.`], ['README.md', `${prompt} Change authentication behavior.`], ['README.md', 'Implement the new documentation requirements and fix a typo.']]) {
  test(`prose proof preserves requested checks and risk scope: ${name} ${request}`, async t => {
    const f = await fixture(t, request); f.file(name); await f.read(name); await f.edit(name); await f.read(name); assert.equal(await f.finish(), 1);
  });
}

test('a failed check cannot be displaced by later prose readback', async t => {
  const f = await fixture(t); f.file('README.md'); await f.edit();
  const id = await f.start('bash', { command: 'npm test' }); await f.end(id, 'bash', { content: [{ type: 'text', text: 'failed' }], details: { execution: { exitCode: 1 } } }, true);
  await f.read(); assert.equal(await f.finish(), 1);
});

for (const discovery of [false, true]) test(`real SDK completes a README typo with${discovery ? ' sampled Bash discovery and' : ''} read/edit/read and no Guardian continuation or invented check`, { timeout: 30000 }, async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-prose-sdk-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true })); fs.writeFileSync(path.join(cwd, 'README.md'), 'Use teh documented command.\n');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true }); await resourceLoader.reload();
  const model = { id: 'prose-readback', name: 'Prose transport fixture', api: 'openai-completions', provider: 'audit', baseUrl: 'https://invalid.example', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 };
  let calls = 0;
  const modelRuntime = { getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false, getAuth: async () => ({ auth: { apiKey: ['synthetic', 'fixture'].join('-') } }),
    streamSimple() {
      calls++;
      const step = calls - Number(discovery);
      const content = step === 0 ? [{ type: 'toolCall', id: 'discovery', name: 'bash', arguments: { command: 'ls -la; grep -rn "teh" README.md 2>/dev/null' } }] : step === 1 || step === 3 ? [{ type: 'toolCall', id: `read-${calls}`, name: 'read', arguments: { path: 'README.md' } }] : step === 2 ? [{ type: 'toolCall', id: 'edit', name: 'edit', arguments: { path: 'README.md', edits: [{ oldText: 'teh', newText: 'the' }] } }] : finished.message.content;
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason: step <= 3 ? 'toolUse' : 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
    } };
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), tools: ['read', 'edit', 'write', 'bash'], thinkingLevel: 'off' }); t.after(() => session.dispose());
  await session.prompt(prompt, { source: 'rpc' });
  assert.equal(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8'), 'Use the documented command.\n');
  assert.equal(calls, 4 + Number(discovery), 'only requested discovery, three necessary tool turns and final completion');
  assert.equal(session.messages.filter(message => message.customType === 'guardian_intervention').length, 0);
  assert.equal(session.messages.filter(message => message.role === 'toolResult').length, 3 + Number(discovery));
  assert.equal(session._guardian.handleCommand('/guardian stats').stats.verifications, 0);
});

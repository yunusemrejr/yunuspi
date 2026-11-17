import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager} from '../core/coding-agent/dist/index.js';

const run = promisify(execFile);
const command = '/skill:fixture scoped argument';
const heading = '---\nname: fixture\ndescription: Skill invocation test.\n---\n';

async function makeSession(cwd, body = 'Synthetic inspection instructions.\n') {
  const skillDir = path.join(cwd, 'fixture');
  const file = path.join(skillDir, 'SKILL.md');
  await fs.mkdir(skillDir);
  await fs.writeFile(file, heading + body);
  const settingsManager = SettingsManager.inMemory({compaction: {enabled: false}, retry: {enabled: false}});
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true,
    noPromptTemplates: true, noThemes: true, additionalSkillPaths: [file],
  });
  await loader.reload();
  assert.deepEqual(loader.getSkills().skills.map(skill => skill.name), ['fixture']);
  const model = {id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions',
    baseUrl: 'https://fixture.invalid', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 4096,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
  const requests = [], errors = [];
  const modelRuntime = {
    getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false,
    getAuth: async () => ({auth: {apiKey: 'synthetic'}}),
    streamSimple(_model, context) {
      requests.push(context.messages.findLast(message => message.role === 'user')?.content?.[0]?.text);
      const message = {role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: [{type: 'text', text: 'Mock reply.'}], stopReason: 'stop',
        usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {total: 0}}};
      return {async *[Symbol.asyncIterator]() { yield {type: 'done', reason: 'stop', message}; }, result: async () => message};
    },
  };
  const sessionManager = SessionManager.inMemory(cwd);
  const {session} = await createAgentSession({
    cwd, agentDir: cwd, model, modelRuntime, resourceLoader: loader, settingsManager, sessionManager, noTools: 'all', thinkingLevel: 'off',
  });
  await session.bindExtensions({mode: 'rpc', onError: error => errors.push(error)});
  return {session, sessionManager, file, requests, errors};
}

async function tempDir(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'yunuspi-skill-invocation-'));
  t.after(() => fs.rm(cwd, {recursive: true, force: true}));
  return cwd;
}

if (process.argv[2] === '--fifo-fixture') {
  const {session, file, requests, errors} = await makeSession(process.argv[3]);
  try {
    await fs.unlink(file);
    await run('mkfifo', [file]);
    console.log('Catalogued guide replaced with a FIFO before submitting the command');
    await session.prompt(command, {source: 'rpc'});
    assert.deepEqual(requests, [command]);
    assert.deepEqual(errors.map(error => error.event), ['skill_expansion']);
  } finally {
    session.dispose();
  }
} else {
  test('a catalogued skill replaced by a FIFO reports its read error and RPC input still settles', {skip: process.platform === 'win32'}, async t => {
    const cwd = await tempDir(t);
    await run(process.execPath, [import.meta.filename, '--fifo-fixture', cwd],
      {timeout: 20_000, killSignal: 'SIGKILL'});
  });

  test('explicit skills retain the full guide and arguments, and missing files retain the original fallback', async t => {
    const body = 'Synthetic guide line.\n'.repeat(3000) + 'Final guide sentence.';
    const {session, file, requests, errors} = await makeSession(await tempDir(t), body);
    t.after(() => session.dispose());
    await session.prompt(command, {source: 'rpc'});
    assert.ok(requests[0].endsWith(`${body}\n</skill>\n\nscoped argument`));
    assert.ok(!requests[0].includes(heading));
    assert.deepEqual(errors, []);
    const referent = path.join(path.dirname(file), 'linked.md');
    await fs.rename(file, referent);
    await fs.symlink(referent, file);
    await session.steer(command);
    assert.deepEqual(session.clearQueue().steering, [requests[0]]);
    await fs.unlink(file);
    await session.prompt(command, {source: 'rpc'});
    assert.equal(requests[1], command);
    assert.deepEqual(errors.map(error => error.event), ['skill_expansion']);
  });

  for (const method of ['prompt', 'steer', 'followUp']) {
    test(`Stop during explicit skill ${method} expansion prevents late input mutation`, {timeout: 10_000}, async t => {
      const {session, sessionManager, file, requests, errors} = await makeSession(await tempDir(t));
      t.after(() => session.dispose());
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const closed = Promise.withResolvers();
      const originalOpen = fs.open;
      fs.open = async (name, ...args) => {
        const handle = await originalOpen(name, ...args);
        if (name !== file) return handle;
        const readFile = handle.readFile.bind(handle);
        const close = handle.close.bind(handle);
        handle.readFile = async options => {
          entered.resolve(options.signal);
          await release.promise;
          return readFile(options);
        };
        handle.close = async () => {
          await close();
          closed.resolve();
        };
        return handle;
      };
      syncBuiltinESMExports();
      try {
        const result = method === 'prompt' ? session.prompt(command, {source: 'rpc'}) : session[method](command);
        const rejected = assert.rejects(result, {name: 'AbortError'});
        const signal = await entered.promise;
        await session.abort();
        await rejected;
        assert.equal(signal.aborted, true);
        assert.deepEqual(requests, []);
        assert.deepEqual(session.getSteeringMessages(), []);
        assert.deepEqual(session.getFollowUpMessages(), []);
        assert.equal(sessionManager.getEntries().some(entry => entry.type === 'message' && entry.message.role === 'user'), false);

        await session.prompt('Fresh input after Stop.', {source: 'rpc'});
        assert.deepEqual(requests, ['Fresh input after Stop.']);
        release.resolve();
        await closed.promise;
        assert.deepEqual(errors, []);
      } finally {
        release.resolve();
        fs.open = originalOpen;
        syncBuiltinESMExports();
      }
    });
  }
}

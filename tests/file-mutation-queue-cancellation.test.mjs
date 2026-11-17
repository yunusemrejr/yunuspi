import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { NodeExecutionEnv } from '../core/agent/src/harness/env/nodejs.js';
import { createWriteTool as createSandboxWrite } from '../core/agent/src/harness/tools/write.js';
import { createWriteToolDefinition } from '../core/coding-agent/src/core/tools/write.js';

async function workspace(t) {
  const cwd = await fsp.mkdtemp(path.join(tmpdir(), 'yunuspi-write-queue-cancel-'));
  t.after(() => fsp.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function within(operation, milliseconds = 1400) {
  const deadline = new AbortController();
  const timeout = delay(milliseconds, undefined, { signal: deadline.signal })
    .then(() => { throw new Error('Operation remained blocked'); });
  return Promise.race([operation, timeout]).finally(() => deadline.abort());
}

for (const layer of ['native', 'sandbox']) {
  test(`${layer} write cancellation removes only the queued alias write`, async t => {
    const cwd = await workspace(t);
    const target = path.join(cwd, 'target'), alias = path.join(cwd, 'alias');
    await fsp.writeFile(target, 'original');
    await fsp.symlink('target', alias);
    const firstEntered = Promise.withResolvers(), firstRelease = Promise.withResolvers(), aliasResolved = Promise.withResolvers();
    const acts = [];
    function noteWrite(content) {
      acts.push(content);
      if (content === 'first') {
        firstEntered.resolve();
        return firstRelease.promise;
      }
    }
    let write;
    if (layer === 'native') {
      const realpath = fsp.realpath;
      t.mock.method(fsp, 'realpath', async (file, ...options) => {
        const resolved = await realpath(file, ...options);
        if (file === alias) aliasResolved.resolve();
        return resolved;
      });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      const tool = createWriteToolDefinition(cwd, { operations: {
        mkdir: async () => {},
        writeFile: async (file, content) => {
          await noteWrite(content);
          await fsp.writeFile(file, content);
        },
      } });
      write = (file, content, signal) => tool.execute(content, { path: file, content }, signal);
    } else {
      const env = new NodeExecutionEnv({ cwd });
      const writeFile = env.writeFile.bind(env);
      const canonicalPath = env.canonicalPath.bind(env);
      env.writeFile = async (file, content, context) => {
        await noteWrite(content);
        return writeFile(file, content, context);
      };
      env.canonicalPath = async (file, context) => {
        const resolved = await canonicalPath(file, context);
        if (file === alias) aliasResolved.resolve();
        return resolved;
      };
      const tool = createSandboxWrite();
      write = (file, content, signal) => tool.execute(content, { path: file, content }, undefined, { env }, undefined, { abortSignal: signal });
    }

    const running = new AbortController(), queued = new AbortController();
    const first = write('target', 'first', running.signal);
    let middle, last;
    try {
      await within(firstEntered.promise);
      middle = assert.rejects(write('alias', 'cancelled', queued.signal), /Operation aborted/);
      await within(aliasResolved.promise);
      await new Promise(resolve => setImmediate(resolve));
      queued.abort();
      await within(middle);
      last = write('target', 'last', running.signal);
      assert.equal(await Promise.race([last.then(() => 'overtook'), delay(50, 'blocked')]), 'blocked');
      firstRelease.resolve();
      await Promise.all([first, last]);
      assert.deepEqual(acts, ['first', 'last']);
      assert.equal(await fsp.readFile(target, 'utf8'), 'last');
    } finally {
      firstRelease.resolve();
      await Promise.allSettled([first, middle, last].filter(Boolean));
    }
  });
}

test('canceling canonical path lookup releases registration for another real write', async t => {
  const cwd = await workspace(t);
  const delayed = path.join(cwd, 'delayed');
  const started = Promise.withResolvers(), late = Promise.withResolvers();
  const realpath = fsp.realpath;
  t.mock.method(fsp, 'realpath', (file, ...options) => {
    if (file !== delayed) return realpath(file, ...options);
    started.resolve();
    return late.promise;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const controller = new AbortController(), tool = createWriteToolDefinition(cwd);
  const stopped = assert.rejects(tool.execute('delayed', { path:'delayed', content:'should never write' }, controller.signal), /Operation aborted/);
  let other;
  try {
    await within(started.promise);
    controller.abort();
    await within(stopped);
    other = tool.execute('ordinary', { path:'ordinary', content:'completed' });
    await within(other);
    assert.equal(await fsp.readFile(path.join(cwd, 'ordinary'), 'utf8'), 'completed');
    await assert.rejects(fsp.access(delayed), { code: 'ENOENT' });
  } finally {
    late.reject(new Error('Synthetic underlying canonical path failure arrived after Stop'));
    await Promise.allSettled([stopped, other].filter(Boolean));
  }
});

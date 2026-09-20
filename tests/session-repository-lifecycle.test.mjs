import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NodeExecutionEnv } from '@yunuspi/agent-core/node';
import { BACKGROUND_CONTEXT } from '@yunuspi/agent-core/harness/context';
import { JsonlSessionRepo, MemorySessionRepo } from '@yunuspi/agent-core/harness/session';

const context = BACKGROUND_CONTEXT;

test('JSONL repositories share one canonical-path open lease', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-jsonl-lease-'));
  const sessionsRoot = path.join(root, 'sessions');
  const cwd = path.join(root, 'workspace');
  const repoA = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot });
  const repoB = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot });
  try {
    const first = await repoA.create({ cwd, id: 'shared-session' }, context);
    await first.setName('first writer', context);

    await assert.rejects(repoB.open(first.metadata, context), /already open/i);

    await first.close(context);
    const second = await repoB.open(first.metadata, context);
    assert.equal(await second.getName(context), 'first writer');
    await second.setName('second writer', context);
    await second.close(context);

    const verified = await repoA.open(first.metadata, context);
    assert.equal(await verified.getName(context), 'second writer');
    await verified.close(context);
  } finally {
    await Promise.allSettled([repoA.close(context), repoB.close(context)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('JSONL repositories serialize creation of one logical session id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-jsonl-create-'));
  const sessionsRoot = path.join(root, 'sessions');
  const cwd = path.join(root, 'workspace');
  const repoA = new JsonlSessionRepo({
    fileSystem: new NodeExecutionEnv({ cwd: root }),
    sessionsRoot,
    now: () => 1_000,
  });
  const repoB = new JsonlSessionRepo({
    fileSystem: new NodeExecutionEnv({ cwd: root }),
    sessionsRoot,
    now: () => 2_000,
  });
  try {
    const results = await Promise.allSettled([
      repoA.create({ cwd, id: 'duplicate-id' }, context),
      repoB.create({ cwd, id: 'duplicate-id' }, context),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
    assert.match(String(results.find(({ status }) => status === 'rejected').reason), /already exists/i);
  } finally {
    await Promise.allSettled([repoA.close(context), repoB.close(context)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('memory repository close drains an admitted fork and closes its result', async () => {
  const repo = new MemorySessionRepo();
  const source = await repo.create({ id: 'source' }, context);

  const forkPromise = repo.fork(source.metadata, { scope: 'tree', id: 'fork' }, context);
  const closePromise = repo.close(context);
  const fork = await forkPromise;
  await closePromise;

  await assert.rejects(source.getStats(context), /closed/i);
  await assert.rejects(fork.getStats(context), /closed/i);
  await assert.rejects(repo.list(undefined, context), /closed/i);
});

test('JSONL repository close drains an admitted create and closes its result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-jsonl-close-'));
  const env = new NodeExecutionEnv({ cwd: root });
  let releaseGate;
  let markReached;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const reached = new Promise((resolve) => { markReached = resolve; });
  let gateNextAbsolutePath = true;
  const gatedFileSystem = new Proxy(env, {
    get(target, property) {
      if (property === 'absolutePath') {
        return async (...args) => {
          if (gateNextAbsolutePath) {
            gateNextAbsolutePath = false;
            markReached();
            await gate;
          }
          return target.absolutePath(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const repo = new JsonlSessionRepo({
    fileSystem: gatedFileSystem,
    sessionsRoot: path.join(root, 'sessions'),
  });
  try {
    const createPromise = repo.create({ cwd: path.join(root, 'workspace'), id: 'closing-create' }, context);
    await reached;
    const closePromise = repo.close(context);
    releaseGate();

    const session = await createPromise;
    await closePromise;

    await assert.rejects(session.getStats(context), /closed/i);
    await assert.rejects(repo.create({ cwd: root, id: 'too-late' }, context), /closed/i);
  } finally {
    releaseGate?.();
    await repo.close(context);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

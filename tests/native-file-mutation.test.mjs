import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEditToolDefinition } from '../core/coding-agent/src/core/tools/edit.js';
import { createWriteToolDefinition } from '../core/coding-agent/src/core/tools/write.js';

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'yunuspi-native-mutation-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function replaceOldText(edit, target, signal) {
  return edit.execute('fixture-edit', { path: target, edits: [{ oldText: 'original', newText: 'replacement' }] }, signal);
}

function afterNativeRead(t, target, modify) {
  const { open, readFile } = fsp;
  const run = async bytes => { modify(); return bytes; };
  fsp.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === target) {
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...parameters) => run(await read(...parameters));
    }
    return handle;
  };
  fsp.readFile = async (file, ...args) => {
    const bytes = await readFile(file, ...args);
    return file === target ? run(bytes) : bytes;
  };
  syncBuiltinESMExports();
  t.after(() => { fsp.open = open; fsp.readFile = readFile; syncBuiltinESMExports(); });
}

test('native edit and write reject unwritten FIFOs without pinning the filesystem pool', { skip: process.platform !== 'linux' }, t => {
  const cwd = workspace(t);
  execFileSync('mkfifo', [path.join(cwd, 'read-pipe'), path.join(cwd, 'write-pipe')]);
  fs.writeFileSync(path.join(cwd, 'ordinary'), 'ready');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import path from 'node:path';
    import { createEditToolDefinition } from './core/coding-agent/src/core/tools/edit.js';
    import { createWriteToolDefinition } from './core/coding-agent/src/core/tools/write.js';
    const cwd = process.argv[1];
    await Promise.all([
      assert.rejects(createEditToolDefinition(cwd).execute('edit', { path: 'read-pipe', edits: [{ oldText: 'a', newText: 'b' }] }), { code: 'EINVAL' }),
      assert.rejects(createWriteToolDefinition(cwd).execute('write', { path: 'write-pipe', content: 'x' }), error => ['ENXIO', 'EINVAL'].includes(error.code)),
    ]);
    assert.equal(await readFile(path.join(cwd, 'ordinary'), 'utf8'), 'ready');
  `, cwd], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, UV_THREADPOOL_SIZE: '2' },
    encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('edits reject intervening same-inode writes and path replacement before committing', async t => {
  for (const replace of [false, true]) {
    await t.test(replace ? 'atomic replacement' : 'same-size write', async subtest => {
      const cwd = workspace(subtest);
      const target = path.join(cwd, 'file');
      fs.writeFileSync(target, 'original\n');
      afterNativeRead(subtest, target, () => {
        if (replace) {
          const next = path.join(cwd, 'next');
          fs.writeFileSync(next, 'external\n');
          fs.renameSync(next, target);
        } else {
          fs.writeFileSync(target, 'external\n');
        }
      });
      await assert.rejects(replaceOldText(createEditToolDefinition(cwd), target), { code: 'ESTALE' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'external\n');
    });
  }
});

test('retargeting after the commit check preserves the replacement and rejects the stale receipt', async t => {
  const cwd = workspace(t);
  const target = path.join(cwd, 'file');
  const previous = path.join(cwd, 'previous');
  fs.writeFileSync(target, 'original\n');
  fs.linkSync(target, previous);
  const { stat } = fsp;
  let changed = false;
  fsp.stat = async (file, ...args) => {
    const snapshot = await stat(file, ...args);
    if (file === target && !changed) {
      changed = true;
      const next = path.join(cwd, 'next');
      fs.writeFileSync(next, 'external\n');
      fs.renameSync(next, target);
    }
    return snapshot;
  };
  syncBuiltinESMExports();
  t.after(() => { fsp.stat = stat; syncBuiltinESMExports(); });
  await assert.rejects(replaceOldText(createEditToolDefinition(cwd), target), /Path changed during writing/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'external\n');
  assert.equal(fs.readFileSync(previous, 'utf8'), 'replacement\n');
});

test('a late external append prevents a success receipt for unexpected final bytes', async t => {
  const cwd = workspace(t);
  const target = path.join(cwd, 'file');
  fs.writeFileSync(target, 'old');
  const { stat } = fsp;
  let appended = false;
  fsp.stat = async (file, ...args) => {
    const snapshot = await stat(file, ...args);
    if (file === target && !appended) {
      appended = true;
      fs.appendFileSync(target, '-external');
    }
    return snapshot;
  };
  syncBuiltinESMExports();
  t.after(() => { fsp.stat = stat; syncBuiltinESMExports(); });
  await assert.rejects(createWriteToolDefinition(cwd).execute('write', { path: target, content: 'new' }), { code: 'ESTALE' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'new-external');
});

test('write truncation and edit preserve normal symlink and hardlink semantics', async t => {
  const cwd = workspace(t);
  const target = path.join(cwd, 'file');
  const link = path.join(cwd, 'link');
  const twin = path.join(cwd, 'twin');
  fs.writeFileSync(target, '\ufefforiginal\r\n', { mode: 0o640 });
  fs.symlinkSync('file', link);
  fs.linkSync(target, twin);
  const { mode, ino } = fs.statSync(target);
  await replaceOldText(createEditToolDefinition(cwd), 'link');
  assert.equal(fs.readFileSync(twin, 'utf8'), '\ufeffreplacement\r\n');
  await createWriteToolDefinition(cwd).execute('write', { path: 'link', content: 'α\n' });
  assert.equal(fs.readFileSync(twin, 'utf8'), 'α\n');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.statSync(target).mode, mode);
  assert.equal(fs.statSync(target).ino, ino);
});

test('Stop during native mutation validation leaves existing bytes untouched', async t => {
  for (const tool of ['edit', 'write']) {
    await t.test(tool, async subtest => {
      const cwd = workspace(subtest);
      const target = path.join(cwd, 'file');
      fs.writeFileSync(target, 'original\n');
      const controller = new AbortController();
      const { stat } = fsp;
      fsp.stat = async (file, ...args) => {
        const snapshot = await stat(file, ...args);
        if (file === target) controller.abort();
        return snapshot;
      };
      syncBuiltinESMExports();
      subtest.after(() => { fsp.stat = stat; syncBuiltinESMExports(); });
      const mutation = tool === 'edit'
        ? replaceOldText(createEditToolDefinition(cwd), target, controller.signal)
        : createWriteToolDefinition(cwd).execute('write', { path: target, content: 'different' }, controller.signal);
      await assert.rejects(mutation, /Operation aborted/);
      assert.equal(fs.readFileSync(target, 'utf8'), 'original\n');
    });
  }
});

test('Stop before new file creation leaves no empty file and Stop after creation can finish', async t => {
  for (const stopBeforeCreate of [true, false]) {
    await t.test(stopBeforeCreate ? 'before' : 'after', async subtest => {
      const cwd = workspace(subtest);
      const target = path.join(cwd, 'new');
      const destination = path.join(cwd, 'missing-target');
      fs.symlinkSync(destination, target);
      const controller = new AbortController();
      const { open } = fsp;
      fsp.open = async (file, ...args) => {
        try {
          const handle = await open(file, ...args);
          if (file === target && !stopBeforeCreate) controller.abort();
          return handle;
        } catch (error) {
          if (file === target && stopBeforeCreate && error.code === 'ENOENT') controller.abort();
          throw error;
        }
      };
      syncBuiltinESMExports();
      subtest.after(() => { fsp.open = open; syncBuiltinESMExports(); });
      const mutation = createWriteToolDefinition(cwd).execute('write', { path: target, content: 'new content' }, controller.signal);
      if (stopBeforeCreate) {
        await assert.rejects(mutation, /Operation aborted/);
        assert.equal(fs.existsSync(destination), false);
      } else {
        await mutation;
        assert.equal(fs.readFileSync(destination, 'utf8'), 'new content');
      }
      assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
    });
  }
});

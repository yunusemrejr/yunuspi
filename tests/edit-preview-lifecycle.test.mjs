import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs, { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEditToolDefinition } from '../core/coding-agent/src/core/tools/edit.js';
import { editRenderers } from '../core/coding-agent/src/core/tools/renderers/edit.js';
import { initTheme, theme } from '../core/coding-agent/src/modes/interactive/theme/theme.js';

const repo = path.resolve(import.meta.dirname, '..');

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'yunuspi-edit-preview-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test('terminal edit previews reject unwritten pipes without blocking unrelated file reads', { skip: process.platform !== 'linux' }, t => {
  const cwd = workspace(t);
  execFileSync('mkfifo', [path.join(cwd, 'pipe'), path.join(cwd, 'second')]);
  fs.symlinkSync('second', path.join(cwd, 'link'));
  fs.writeFileSync(path.join(cwd, 'ordinary'), 'original\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import path from 'node:path';
    import { editRenderers } from './core/coding-agent/src/core/tools/renderers/edit.js';
    import { initTheme, theme } from './core/coding-agent/src/modes/interactive/theme/theme.js';
    const cwd = process.argv[1];
    initTheme('dark');
    const previews = ['pipe', 'link'].map(file => new Promise(resolve => {
      const state = {};
      editRenderers.renderCall({ path: file, edits: [{ oldText: 'original', newText: 'changed' }] }, theme, {
        cwd, state, argsComplete: true, isPartial: true,
        invalidate() { resolve(state.callComponent.preview); },
      });
    }));
    const results = await Promise.all(previews);
    for (const result of results) assert.match(result.error, /regular file/);
    assert.equal(await readFile(path.join(cwd, 'ordinary'), 'utf8'), 'original\\n');
  `, cwd], { cwd: repo, env: { ...process.env, UV_THREADPOOL_SIZE: '2' },
    encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('a delayed terminal edit preview cannot replace the applied edit receipt', async t => {
  const cwd = workspace(t);
  const file = path.join(cwd, 'sample');
  const original = Buffer.from('original\n');
  fs.writeFileSync(file, original);
  initTheme('dark');

  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const readAfterCommit = async () => {
    started.resolve();
    await release.promise;
    return Buffer.from('changed\n');
  };
  const { open, readFile } = fsp;
  const readFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
  t.mock.method(fsp, 'open', (filename, flags, ...rest) =>
    filename === file && flags === readFlags
      ? Promise.resolve({
          stat: () => Promise.resolve({ isFile: () => true }),
          readFile: readAfterCommit,
          close: () => Promise.resolve(),
        })
      : open(filename, flags, ...rest));
  t.mock.method(fsp, 'readFile', (filename, ...rest) =>
    filename === file ? readAfterCommit() : readFile(filename, ...rest));
  syncBuiltinESMExports();
  t.after(() => {
    release.resolve();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const args = { path: 'sample', edits: [{ oldText: 'original', newText: 'changed' }] };
  const state = {};
  let invalidations = 0;
  const context = { cwd, state, args, argsComplete: true, isPartial: true, invalidate() { invalidations++; } };
  editRenderers.renderCall(args, theme, context);
  await started.promise;

  const receipt = await createEditToolDefinition(cwd).execute('sample', args);
  editRenderers.renderResult(receipt, { isPartial: false }, theme, { ...context, isPartial: false, isError: false });
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fs.readFileSync(file, 'utf8'), 'changed\n');
  assert.equal(state.callComponent.preview.diff, receipt.details.diff);
  assert.equal(invalidations, 0);
});

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NodeExecutionEnv } from '../core/agent/src/harness/env/nodejs.js';
import { withRegularReadFile } from '../core/agent/src/harness/env/regular-read-file.js';
import { processFileArguments } from '../core/coding-agent/src/cli/file-processor.js';
import { createReadToolDefinition } from '../core/coding-agent/src/core/tools/read.js';

const repo = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'yunuspi-regular-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('native and sandbox read reject two unwritten FIFOs while the file worker pool stays responsive', { skip: process.platform !== 'linux' }, t => {
  const dir = fixture(t);
  execFileSync('mkfifo', [path.join(dir, 'alpha'), path.join(dir, 'beta')]);
  fs.symlinkSync('beta', path.join(dir, 'link'));
  fs.writeFileSync(path.join(dir, 'ordinary.txt'), 'ordinary\n');
  const worker = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import path from 'node:path';
    import { NodeExecutionEnv } from './core/agent/src/harness/env/nodejs.js';
    import { createReadTool as createSandboxRead } from './core/agent/src/harness/tools/read.js';
    import { createReadToolDefinition } from './core/coding-agent/src/core/tools/read.js';
    const cwd = process.argv[1];
    const nativeRead = createReadToolDefinition(cwd);
    const sandbox = createSandboxRead();
    const env = new NodeExecutionEnv({ cwd });
    const context = { abortSignal: new AbortController().signal };
    await Promise.all([
      assert.rejects(nativeRead.execute('alpha', { path: 'alpha' }), { code: 'EINVAL' }),
      assert.rejects(nativeRead.execute('link', { path: 'link' }), { code: 'EINVAL' }),
    ]);
    await Promise.all([
      assert.rejects(sandbox.execute('alpha', { path: 'alpha' }, undefined, { env }, undefined, context), { code: 'invalid' }),
      assert.rejects(sandbox.execute('link', { path: 'link' }, undefined, { env }, undefined, context), { code: 'invalid' }),
    ]);
    for (const result of await Promise.all([
      env.readTextFile('alpha', context), env.readTextLines('link', {}, context), env.readBinaryFile('alpha', context),
    ])) {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'invalid');
      assert.match(result.error.message, /regular file/);
    }
    assert.equal(await readFile(path.join(cwd, 'ordinary.txt'), 'utf8'), 'ordinary\\n');
  `, dir], {
    cwd: repo, env: { ...process.env, UV_THREADPOOL_SIZE: '2' }, encoding: 'utf8', timeout: 12_000, killSignal: 'SIGKILL',
  });
  assert.ifError(worker.error);
  assert.equal(worker.status, 0, worker.stderr);
});

test('CLI attachment uses the opened file when its symlink changes into a named pipe', { skip: process.platform !== 'linux' }, t => {
  const dir = fixture(t);
  const attachment = path.join(dir, 'attachment');
  fs.writeFileSync(path.join(dir, 'plain.txt'), 'fixture attachment');
  execFileSync('mkfifo', [path.join(dir, 'pipe')]);
  fs.symlinkSync('plain.txt', attachment);
  const worker = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const attachment = process.argv[1];
    let replaced = false;
    const replaceAfterStat = stats => {
      if (!replaced) {
        replaced = true;
        fs.unlinkSync(attachment);
        fs.symlinkSync('pipe', attachment);
      }
      return stats;
    };
    const stat = fsp.stat;
    const open = fsp.open;
    fsp.stat = async (file, ...args) => {
      const stats = await stat(file, ...args);
      return file === attachment ? replaceAfterStat(stats) : stats;
    };
    fsp.open = async (file, ...args) => {
      const handle = await open(file, ...args);
      if (file === attachment && !replaced) {
        const originalStat = handle.stat.bind(handle);
        handle.stat = async (...args) => replaceAfterStat(await originalStat(...args));
      }
      return handle;
    };
    syncBuiltinESMExports();
    const { processFileArguments } = await import('./core/coding-agent/src/cli/file-processor.js');
    const { detectSupportedImageMimeTypeFromFile } = await import('./core/coding-agent/src/utils/mime.js');
    const result = await processFileArguments([attachment]);
    assert.equal(replaced, true);
    assert.match(result.text, /fixture attachment/);
    await assert.rejects(detectSupportedImageMimeTypeFromFile(attachment), { code: 'EINVAL' });
    console.log('read-original-descriptor');
    await processFileArguments([attachment]);
  `, attachment], { cwd: repo, encoding: 'utf8', timeout: 12_000, killSignal: 'SIGKILL' });
  assert.ifError(worker.error);
  assert.match(worker.stdout, /^read-original-descriptor\s*$/);
  assert.equal(worker.status, 1, worker.stderr);
  assert.match(worker.stderr, /Read requires a regular file/);
});

test('CLI attachment keeps BOM-free text, bounded MIME detection and ordinary empty-file behavior', async t => {
  const dir = fixture(t);
  const text = path.join(dir, 'text.txt');
  const empty = path.join(dir, 'empty.txt');
  const image = path.join(dir, 'image-without-suffix');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9L8AAAAASUVORK5CYII=';
  fs.writeFileSync(text, '\ufefffixture');
  fs.writeFileSync(empty, '');
  fs.writeFileSync(image, Buffer.from(png, 'base64'));
  const result = await processFileArguments([empty, text, image], { autoResizeImages: false });
  assert.equal(result.text, `<file name="${text}">\nfixture\n</file>\n<file name="${image}"></file>\n`);
  assert.deepEqual(result.images, [{ type: 'image', mimeType: 'image/png', data: png }]);
});

test('ordinary symlinks, text ranges and sandbox lines use the verified file and close it', async t => {
  const dir = fixture(t);
  const link = path.join(dir, 'link.txt');
  fs.writeFileSync(path.join(dir, 'original.txt'), 'α\r\nβ\r\nγ');
  fs.writeFileSync(path.join(dir, 'replacement.txt'), 'new bytes');
  fs.symlinkSync('original.txt', link);
  const nativeRead = createReadToolDefinition(dir);
  const page = await nativeRead.execute('page', { path: 'link.txt', offset: 2, limit: 1 });
  assert.match(page.content[0].text, /^β\r\n\n\[1 more lines in file\. Use offset=3 to continue\.\]$/);
  const env = new NodeExecutionEnv({ cwd: dir });
  const context = { abortSignal: new AbortController().signal };
  assert.deepEqual(await env.readTextLines('link.txt', { maxLines: 2 }, context), { ok: true, value: ['α', 'β'] });
  await assert.rejects(nativeRead.execute('directory', { path: '.' }), { code: 'EISDIR' });
  const directory = await env.readTextFile('.', context);
  assert.equal(directory.error.code, 'is_directory');

  let verified;
  const exact = await withRegularReadFile(link, undefined, async file => {
    verified = file;
    fs.unlinkSync(link);
    fs.symlinkSync('replacement.txt', link);
    return file.readFile('utf8');
  });
  assert.equal(exact, 'α\r\nβ\r\nγ');
  assert.equal(verified.fd, -1);
  assert.deepEqual(await env.readTextFile('link.txt', context), { ok: true, value: 'new bytes' });
});

test('aborted reads settle and a later read of the same path succeeds', async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'fixture');
  const nativeRead = createReadToolDefinition(dir);
  const env = new NodeExecutionEnv({ cwd: dir });
  const controller = new AbortController();
  const nativeResult = nativeRead.execute('cancelled', { path: 'file.txt' }, controller.signal);
  const sandboxResult = env.readBinaryFile('file.txt', { abortSignal: controller.signal });
  controller.abort(new Error('fixture cancellation'));
  await assert.rejects(nativeResult, /Operation aborted/);
  assert.equal((await sandboxResult).error.code, 'aborted');
  const repeated = await nativeRead.execute('repeat', { path: 'file.txt' });
  assert.equal(repeated.content[0].text, 'fixture');
});

test('custom read operations retain access, image detection and read ordering', async t => {
  const dir = fixture(t);
  const calls = [];
  const nativeRead = createReadToolDefinition(dir, { operations: {
    async access(file) { calls.push(['access', file]); },
    async detectImageMimeType(file) { calls.push(['mime', file]); return null; },
    async readFile(file) { calls.push(['read', file]); return Buffer.from('custom text'); },
  } });
  const result = await nativeRead.execute('remote', { path: 'absent-remote.txt' });
  assert.equal(result.content[0].text, 'custom text');
  assert.deepEqual(calls, ['access', 'mime', 'read'].map(operation => [operation, path.join(dir, 'absent-remote.txt')]));
});

test('a read with an unavailable spill location still returns a bounded continuation', async t => {
  const dir = fixture(t);
  const file = 'large.txt';
  const content = `${'long line '.repeat(8)}\n`.repeat(1000);
  fs.writeFileSync(path.join(dir, file), content);
  const previousTmp = process.env.TMPDIR;
  try {
    const read = createReadToolDefinition(dir);
    process.env.TMPDIR = path.join(dir, 'missing');
    const result = await read.execute('spill-failure', { path: file });
    assert.equal(result.details.truncation.truncated, true);
    assert.equal(result.details.fullOutputPath, undefined);
    assert.match(result.details.captureError, /ENOENT/);
    const offset = Number(/Use offset=(\d+)/.exec(result.content[0].text)?.[1]);
    assert.ok(offset > 1);
    assert.ok(result.content[0].text.startsWith('long line '));
    const page = await read.execute('continuation', { path: file, offset, limit: 1 });
    assert.match(page.content[0].text, /^long line /);

    process.env.TMPDIR = dir;
    const saved = await read.execute('spill-success', { path: file, offset: 2 });
    assert.equal(saved.details.captureError, undefined);
    assert.equal(fs.readFileSync(saved.details.fullOutputPath, 'utf8'), content.slice(content.indexOf('\n') + 1));
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  }
});

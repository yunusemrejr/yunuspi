import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..'), path.resolve(root, '../..')]
  .find(dir => fs.existsSync(path.join(dir, 'extensions/pi-subagents/src/agents/agent-memory.ts')));
const moduleUrl = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/agents/agent-memory.ts')).href;
const {readMemoryFile} = await import(moduleUrl);

test('role memory keeps bounded regular reads and refuses symlink aliases', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  assert.equal(readMemoryFile(dir), null);
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'remember this');
  assert.deepEqual(readMemoryFile(dir), {contents: 'remember this', byteCapped: false});
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'x'.repeat(20_000));
  const capped = readMemoryFile(dir);
  assert.equal(capped.contents.length, 16 * 1024);
  assert.equal(capped.byteCapped, true);
  fs.renameSync(path.join(dir, 'MEMORY.md'), path.join(dir, 'target'));
  fs.symlinkSync('target', path.join(dir, 'MEMORY.md'));
  assert.equal(readMemoryFile(dir), 'unsafe');
});

test('a FIFO memory file cannot block child-agent startup', {skip: process.platform === 'win32'}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-fifo-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const fifo = spawnSync('mkfifo', [path.join(dir, 'MEMORY.md')]);
  assert.ifError(fifo.error);
  assert.equal(fifo.status, 0);
  const code = `import assert from 'node:assert/strict'; import {readMemoryFile} from ${JSON.stringify(moduleUrl)}; assert.equal(readMemoryFile(process.argv[1]), null);`;
  const child = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code, dir], {encoding: 'utf8', timeout: 3000});
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

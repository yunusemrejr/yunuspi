import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(template, 'agent'), path.resolve(template, '..')].find(p => fs.existsSync(path.join(p, 'extensions/utility-tools.ts')));
const load = name => import(pathToFileURL(path.join(agent, 'extensions', name)));
const { UtilityClient } = await load('lib/utility-client.ts');
const { default: register } = await load('utility-tools.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-operations-'));
const client = new UtilityClient(root);
const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
async function call(name, args, isError = false) {
  const response = await client.call(name, args);
  assert.equal(response.isError, isError, JSON.stringify(response));
  assert.ok(Buffer.byteLength(response.content[0].text) <= 24576);
  return JSON.parse(response.content[0].text);
}
before(async () => {
  write('project/source/a.txt', 'one\nneedle in exact line\nthree\n');
  write('project/source/b.txt', 'needle again\n');
  write('project/.hidden.txt', 'needle hidden');
  write('project/node_modules/pkg/a.txt', 'needle dependency');
  write('project/binary.bin', Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  write('project/large.txt', 'x'.repeat(1024 * 1024 + 1));
  fs.symlinkSync('/etc', path.join(root, 'project/outside'));
  fs.symlinkSync(path.join(root, 'project/source'), path.join(root, 'project/inside-link'));
  await client.start();
});
after(() => { client.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('workspace content search is confined, bounded and source grounded with stable paging', async () => {
  const first = await call('workspace_search', { root: 'project', mode: 'content', query: 'needle', limit: 1 });
  assert.equal(first.items[0].path, 'project/source/a.txt');
  assert.equal(first.items[0].line, 2); assert.match(first.items[0].source_hash, /^[a-f0-9]{64}$/);
  assert.equal(first.scope.excluded.symlink, 2); assert.equal(first.scope.excluded.binary, 1); assert.equal(first.scope.excluded.oversized, 1);
  assert.equal(first.scan_complete, false); assert.equal(first.total, 2);
  const second = await call('workspace_search', { root: 'project', mode: 'content', query: 'needle', limit: 1, offset: first.next_offset, snapshot: first.snapshot });
  assert.equal(second.items[0].path, 'project/source/b.txt');
  await call('workspace_search', { root: 'project', mode: 'content', query: 'needle', offset: 1 }, true);
  write('project/source/b.txt', 'needle changed');
  assert.match((await call('workspace_search', { root: 'project', mode: 'content', query: 'needle', offset: 1, snapshot: first.snapshot }, true)).error, /Stale snapshot/);
  for (const root of ['../', '/etc', 'project/outside']) await call('workspace_search', { root, query: 'passwd' }, true);
});

test('folder, hidden opt-in, no-match and depth searches expose their actual scope', async () => {
  const folder = await call('workspace_search', { root: 'project', query: 'source', kind: 'directory' });
  assert.deepEqual(folder.items.map(x => x.path), ['project/source']);
  assert.equal((await call('workspace_search', { root: 'project', query: 'hidden', include_hidden: true })).total, 1);
  const none = await call('workspace_search', { root: 'project/source', query: 'missing', mode: 'content' });
  assert.equal(none.total, 0); assert.equal(none.scan_complete, true);
  const shallow = await call('workspace_search', { root: 'project', query: 'a.txt', max_depth: 0 });
  assert.equal(shallow.scan_complete, false); assert.equal(shallow.scope.excluded.depth, 1);
});



test('native utility tool adapter executes new tools through its real MCP process', async () => {
  const tools = new Map(), handlers = new Map();
  register({ registerTool: spec => tools.set(spec.name, spec), on: (name, callback) => handlers.set(name, callback) });
  try {
    const result = await tools.get('workspace_search').execute('native-fixture', { root: 'project/source', query: 'txt' }, undefined, undefined, { cwd: root });
    assert.equal(result.isError, false); assert.equal(JSON.parse(result.content[0].text).total, 2);
    for (const name of ['workspace_search', 'sqlite_probe']) assert.ok(tools.has(name));
  } finally { handlers.get('session_shutdown')(); }
});



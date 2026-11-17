import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const fixture = `
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const [project, home, mode] = process.argv.slice(1);
os.homedir = () => home;
const exec = childProcess.execFileSync;
let gitCalls = 0;
childProcess.execFileSync = (command, ...args) => {
  if (command === 'git') gitCalls++;
  return exec(command, ...args);
};
syncBuiltinESMExports();

const { default: registerReminders } = await import('./agent/extensions/reminders.ts');
const { readWorkspaceGitState } = await import('./agent/extensions/lib/workspace-write-lease.ts');
const { createReadToolDefinition } = await import('./core/coding-agent/src/core/tools/read.js');
const handlers = new Map();
registerReminders({
  on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  registerTool() {}, registerCommand() {},
});
const ctx = {cwd: project, sessionManager: {getSessionId: () => 'workspace-fixture', getBranch: () => []}};
const emit = async (name, event) => {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
};
const read = createReadToolDefinition(project);
const input = {path: 'sample.txt'};
const turn = async i => {
  const toolCallId = 'fixture-' + i;
  const result = await read.execute(toolCallId, input);
  assert.equal(result.content[0].text, 'synthetic');
  await emit('tool_result', {toolName: 'read', toolCallId, input, isError: false, ...result});
};
await emit('session_start', {reason: 'startup'});
assert.equal(gitCalls, 1);

if (mode === 'unborn') {
  for (let i = 0; i < 20; i++) await turn(i);
  assert.equal(gitCalls, 1, 'only the initial checkout identity query may spawn Git');
  exec('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-q', '--allow-empty', '-m', 'first commit']);
  await turn(21);
  assert.equal(readWorkspaceGitState(project)?.head, exec('git', ['-C', project, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim());
  assert.equal(gitCalls, 1, 'a new loose ref should be observed without rediscovering the checkout');
} else {
  const head = path.join(project, '.git', 'HEAD');
  const saved = fs.readFileSync(head);
  fs.unlinkSync(head);
  exec('mkfifo', [head]);
  const controller = new AbortController();
  ctx.signal = controller.signal;
  const stopped = new Promise(resolve => controller.signal.addEventListener('abort', resolve, {once: true}));
  const stop = setTimeout(() => controller.abort(), 100);
  try {
    await turn(0);
    await stopped;
    assert.equal(gitCalls, 1, 'the confirmed FIFO must not be passed to Git');
  } finally {
    clearTimeout(stop);
    fs.unlinkSync(head);
    fs.writeFileSync(head, saved);
  }
}
await emit('session_shutdown', {});
`;

for (const mode of ['unborn', 'fifo']) {
  test(mode === 'unborn' ? 'reminders reuse an unborn workspace identity across native reads' :
    'an unwritten Git FIFO cannot freeze a native read reminder hook or Stop', {
    skip: mode === 'fifo' && process.platform !== 'linux', timeout: 15000,
  }, t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-reminder-git-'));
    t.after(() => fs.rmSync(base, {recursive: true, force: true}));
    const project = path.join(base, 'project');
    const home = path.join(base, 'fixture-home');
    fs.mkdirSync(project);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(project, 'sample.txt'), 'synthetic');
    const env = {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
    delete env.PI_SUBAGENT_CHILD;
    execFileSync('git', ['-C', project, 'init', '-q', '--template='], {env});
    if (mode === 'fifo') {
      execFileSync('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-q', '--allow-empty', '-m', 'fixture'], {env});
    }
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', fixture, project, home, mode], {
      cwd: root, env, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL',
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
  });
}

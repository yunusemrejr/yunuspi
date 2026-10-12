import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { activePiProcesses } from '../agent/scripts/lib/active-core-processes.mjs';

test('updates detect idle desktop entrypoints without confusing other installations or version probes', { skip: process.platform !== 'linux' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-desktop-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime'), core = path.join(runtime, 'core/coding-agent');
  const desktop = path.join(runtime, 'desktop'), other = path.join(root, 'other/runtime/desktop');
  fs.mkdirSync(path.join(core, 'dist'), { recursive: true });
  fs.mkdirSync(desktop); fs.mkdirSync(other, { recursive: true });
  const ready = "console.log('ready');setInterval(() => {}, 10000);";
  for (const file of ['main.mjs', 'launch.mjs', 'unrelated.mjs']) fs.writeFileSync(path.join(desktop, file), ready);
  fs.writeFileSync(path.join(other, 'main.mjs'), ready);
  const cli = path.join(core, 'dist/cli.js'); fs.writeFileSync(cli, ready);
  const cases = [
    { args: [path.join(desktop, 'main.mjs')], active: true },
    { args: ['desktop/main.mjs'], active: true },
    { args: [path.join(desktop, 'launch.mjs')], active: true },
    { args: ['--no-warnings', path.join(desktop, 'main.mjs')], active: true },
    { args: [path.join(desktop, 'main.mjs'), '--version'], active: true },
    { args: [path.join(desktop, 'launch.mjs'), '--help'], active: true },
    { args: [path.join(desktop, 'unrelated.mjs')], active: false },
    { args: [path.join(desktop, 'unrelated.mjs'), path.join(desktop, 'main.mjs')], active: false },
    { args: ['--eval', ready, path.join(desktop, 'main.mjs')], active: false },
    { args: [path.join(other, 'main.mjs')], active: false },
    { args: [cli, '--version'], active: false },
    { args: [cli, '--help'], active: false },
    { args: [cli], active: true },
  ];
  for (const { args, active } of cases) await t.test(args.join(' '), async () => {
    const child = spawn(process.execPath, args, { cwd: runtime, stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(Error(`Fixture exited ${code}`))); });
      assert.equal(activePiProcesses(core).includes(child.pid), active);
    } finally { child.kill(); await exited; }
  });
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const wrapper = path.resolve(import.meta.dirname, '../agent/scripts/harness-readonly-exec.py');
const probe = spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true'], { timeout: 3_000 });

test('guarded background commands spend execution time only after namespace setup', {
  skip: probe.status !== 0 && 'requires working Linux bubblewrap', timeout: 60_000,
}, t => {
  const temporary = [`/run/user/${process.getuid()}`, '/var/tmp', os.tmpdir()].find(dir => {
    try { fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK); return true; }
    catch { return false; }
  });
  const base = fs.mkdtempSync(path.join(temporary, 'yunuspi-bg-guard-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const harness = path.join(base, 'harness');
  const cwd = path.join(base, 'workspace');
  fs.mkdirSync(harness);
  fs.mkdirSync(cwd);
  const fixtureWrapper = path.join(harness, 'wrapper.py');
  fs.writeFileSync(fixtureWrapper, `import os, runpy, sys, time
real_exec = os.execv
module = runpy.run_path(${JSON.stringify(wrapper)})
def delayed_exec(command, arguments):
    if command == '/usr/bin/bwrap':
        prefix = os.environ['YUNUSPI_BG_GUARD_ATTEMPT']
        with open(prefix + '.prepared', 'w') as receipt: receipt.write('mounting')
        while not os.path.exists(prefix + '.release'): time.sleep(0.01)
        if os.environ.get('YUNUSPI_BG_GUARD_MODE') == 'missing': sys.exit(0)
    real_exec(command, arguments)
os.execv = delayed_exec
module['main']()
`);
  const token = 'f0000000000000000000000000000001';
  const substituteGuard = `export function guardedCommand(command, args, options) {
    const armed = options?.mountedReady;
    return {command: '/usr/bin/python3', args: ['-I', ${JSON.stringify(fixtureWrapper)}, ${JSON.stringify(harness)},
      ...(armed ? ['--mounted-ready', process.env.YUNUSPI_BG_GUARD_MODE === 'bad' ? '0'.repeat(32) : ${JSON.stringify(token)}] : []), '--', command, ...args],
      ...(armed ? {readyStdoutPrefix: Buffer.from('\\x1e' + ${JSON.stringify(token)} + '\\n')} : {})};
  }`;
  const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const [cwd, substituteGuard] = process.argv.slice(1);
const loader = 'data:text/javascript,' + encodeURIComponent(substituteGuard);
registerHooks({resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/pi-background-tasks/src/core/registry.ts') && specifier.endsWith('/self-mutation-guard.ts')) return next(loader, context);
  try { return next(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || !specifier.endsWith('.js')) throw error;
    return next(specifier.slice(0, -3) + '.ts', context);
  }
}});
const { BackgroundTaskRegistry } = await import('./agent/extensions/pi-background-tasks/src/core/registry.ts');
const registry = new BackgroundTaskRegistry({sendCompletionNotification() {}});
const ctx = {cwd, sessionId:'fixture-owner', modelRegistry:{getAll:()=>[]}};
const choose = (name, mode='normal') => {
  const prefix=path.join(cwd,name);
  process.env.YUNUSPI_BG_GUARD_ATTEMPT=prefix;
  process.env.YUNUSPI_BG_GUARD_MODE=mode;
  return prefix;
};
const waitFor = async (check, message) => {
  for(const deadline=Date.now()+12000; !check()&&Date.now()<deadline;) await delay(10);
  assert.ok(check(),message);
};
const release = prefix => fs.writeFileSync(prefix+'.release','go');
const commandMs = 4137;
const original = globalThis.setTimeout;
let admissionTimer, executionTimer;
let admissions=0, executions=0;
globalThis.setTimeout = (callback, ms, ...args) => {
  if(Math.round(ms)===commandMs || ms===120000) {
    const timer=original(()=>{},15000);
    const fire=()=>{clearTimeout(timer);callback(...args);};
    if(ms===120000) { admissions++; admissionTimer=fire; }
    else { executions++; executionTimer=fire; }
    return timer;
  }
  return original(callback, ms, ...args);
};
const launch = command => registry.startTask(ctx,command,{timeoutSeconds:commandMs/1000,notifyOnCompletion:false});
try {
  const quick=choose('quick');
  const payload=Buffer.from(${JSON.stringify(`\x1e${token}\nπ\u0000`)});
  const task=await launch("printf '\\\\036${token}\\\\nπ\\\\000'");
  await waitFor(()=>fs.existsSync(quick+'.prepared'),'the real guard did not reach its delayed mount exec');
  assert.equal(executions,0,'execution timeout started while mount setup was still blocked');
  assert.equal(admissions,1);
  release(quick);
  await waitFor(()=>task.status!=='running','the quick command did not settle');
  assert.equal(task.status,'completed');
  assert.equal(task.exitCode,0);
  assert.equal(executions,1);
  assert.deepEqual(fs.readFileSync(task.outputAbsPath),payload,'only the trusted first frame is removed');

  const stop=choose('stop');
  const stopped=await launch('touch '+stop+'.payload');
  await waitFor(()=>fs.existsSync(stop+'.prepared'),'stop launch did not reach the guard');
  await registry.stopTask(stopped,'user');
  release(stop);
  assert.equal(stopped.status,'killed');
  assert.equal(executions,1);
  assert.equal(fs.existsSync(stop+'.payload'),false);

  const expire=choose('expire');
  const expired=await launch('touch '+expire+'.payload');
  await waitFor(()=>fs.existsSync(expire+'.prepared'),'expiry launch did not reach the guard');
  admissionTimer();
  await waitFor(()=>expired.status!=='running','admission timer did not stop the guard');
  assert.match(expired.error,/isolation admission timed out/);
  assert.equal(executions,1);
  assert.equal(fs.existsSync(expire+'.payload'),false);

  const after=choose('after');
  release(after);
  const running=await launch('touch '+after+'.payload; exec /bin/sleep 20');
  await waitFor(()=>fs.existsSync(after+'.payload'),'actual execution did not begin');
  await waitFor(()=>executions===2,'execution timer did not arm after readiness');
  executionTimer();
  await waitFor(()=>running.status!=='running','execution deadline did not stop the command');
  assert.match(running.error,/Timed out after 4.137s/);

  for(const mode of ['missing','bad']) {
    const prefix=choose(mode,mode);
    release(prefix);
    const invalid=await launch('/bin/true');
    await waitFor(()=>invalid.status!=='running','invalid guard did not settle');
    assert.equal(invalid.status,'failed');
    assert.match(invalid.error,/isolation readiness/);
    assert.equal(executions,2);
  }
} finally {
  globalThis.setTimeout=original;
  await Promise.allSettled(registry.allTasks().filter(t=>t.status==='running').map(t=>registry.stopTask(t,'user')));
}
`;
  const result = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script, cwd, substituteGuard], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 56_000,
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

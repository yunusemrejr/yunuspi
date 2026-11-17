import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const source = path.resolve(import.meta.dirname, '../agent/scripts/harness-readonly-exec.py');
const probe = spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true'], {timeout: 3000});

test('managed Bash separates cold guard admission from execution and preserves fail-closed Stop', {
  skip: probe.status !== 0 && 'requires working Linux bubblewrap',
  timeout: 30000,
}, t => {
  // The real wrapper binds writable siblings. Prefer the low-entry user
  // runtime directory rather than turning this lifecycle test into a mount benchmark.
  const temporary = [`/run/user/${process.getuid()}`, '/var/tmp', os.tmpdir()].find(dir => {
    try { fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK); return true; }
    catch { return false; }
  });
  const base = fs.mkdtempSync(path.join(temporary, 'yunuspi-bash-guard-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'protected');
  const fixtureWrapper = path.join(root, 'agent/scripts/harness-readonly-exec.py');
  fs.mkdirSync(path.dirname(fixtureWrapper), {recursive: true});
  fs.mkdirSync(path.join(base, 'workspace'));
  fs.writeFileSync(fixtureWrapper, `import os, runpy, sys, time
module = runpy.run_path(${JSON.stringify(source)})
guard = module['main'].__globals__
real = guard['check_protected_hardlinks']
def inventory(roots):
    attempt = os.environ['YUNUSPI_TEST_GUARD_ATTEMPT']
    with open(attempt + '.scan', 'w') as receipt: receipt.write('scan started')
    while not os.path.exists(attempt + '.release'): time.sleep(0.01)
    real(roots)
def refuse_exec(*args):
    raise OSError('fixture exec failure')
if os.environ['YUNUSPI_TEST_GUARD_MODE'] == 'missing': sys.exit(0)
if os.environ['YUNUSPI_TEST_GUARD_MODE'] == 'exec-failure': os.execv = refuse_exec
guard['check_protected_hardlinks'] = inventory
try: guard['main']()
except Exception as error:
    print('Harness write isolation refused command: ' + str(error), file=sys.stderr)
    sys.exit(126)
`);

  // Only the harness-root discovery input is replaced. Managed Bash, its
  // child process, the Python inventory and bubblewrap are all real.
  const guardModule = `export function guardedCommand(command, args, options) {
    return {command:'/usr/bin/python3',args:['-I',${JSON.stringify(fixtureWrapper)},${JSON.stringify(root)},
      ...(options?.readyPipe ? ['--ready-pipe'] : []),'--',command,...args],...(options?.readyPipe ? {readyFd:3} : {})};
  }`;
  const loader = `data:text/javascript,${encodeURIComponent(guardModule)}`;
  const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const [base, loader] = process.argv.slice(1);
const cwd = path.join(base, 'workspace');
registerHooks({resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/agent/extensions/managed-bash.ts') && specifier === './lib/self-mutation-guard.ts') return next(loader, context);
  return next(specifier, context);
}});
const { runManagedCommand } = await import('./agent/extensions/managed-bash.ts');
const quote = value => "'" + value.replaceAll("'", "'\\\\''") + "'";
const set = (name, mode='normal') => {
  const prefix = path.join(cwd, name);
  process.env.YUNUSPI_TEST_GUARD_ATTEMPT = prefix;
  process.env.YUNUSPI_TEST_GUARD_MODE = mode;
  return prefix;
};
const waitFor = async file => {
  for (let n=0; n<500 && !fs.existsSync(file); n++) await delay(10);
  assert.ok(fs.existsSync(file),'expected stage did not begin: ' + path.basename(file));
};
const release = prefix => fs.writeFileSync(prefix+'.release','go');
const userTimeoutMs = 4173;
const originalTimer = globalThis.setTimeout;
let commandTimers = 0;
let admissionTimers = 0;
let shortenAdmission = false;
let holdCommandTimer = false;
let commandDeadline;
globalThis.setTimeout = (callback, ms, ...args) => {
  if (ms === userTimeoutMs) {
    commandTimers++;
    if (holdCommandTimer) {
      commandDeadline = callback;
      return originalTimer(() => {}, 12000);
    }
  }
  if (ms === 120_000) { admissionTimers++; if (shortenAdmission) ms = 750; }
  return originalTimer(callback, ms, ...args);
};
const quick = set('quick');
const quickStop = new AbortController();
const checkFd = "import os; assert not os.path.exists('/proc/self/fd/3'); print('ok', end='')";
holdCommandTimer = true;
const before = runManagedCommand('/usr/bin/python3 -I -c '+quote(checkFd), cwd, userTimeoutMs/1000, quickStop.signal, Infinity);
try {
  await waitFor(quick+'.scan');
  assert.equal(commandTimers,0,'the command deadline began during a blocked inventory');
  assert.equal(admissionTimers,1);
  release(quick);
  assert.deepEqual(await before, {exitCode:0,output:'ok'});
} finally {
  quickStop.abort();
  await before.catch(() => {});
  holdCommandTimer = false;
}
assert.equal(commandTimers,1);

const pre = set('stop-before');
const beforeStop = new AbortController();
const during = runManagedCommand('touch '+quote(pre+'.payload'),cwd,5,beforeStop.signal,Infinity);
const stopped = assert.rejects(during,/aborted/);
await waitFor(pre+'.scan');
beforeStop.abort();
await stopped;
release(pre);
assert.equal(fs.existsSync(pre+'.payload'),false);

const post = set('stop-after');
const afterStop = new AbortController();
release(post);
const executing = runManagedCommand('touch '+quote(post+'.payload')+'; sleep 300',cwd,20,afterStop.signal,Infinity);
const killed = assert.rejects(executing,/aborted/);
await waitFor(post+'.payload');
afterStop.abort();
await killed;

const expired = set('admission-timeout');
shortenAdmission = true;
await assert.rejects(runManagedCommand('touch '+quote(expired+'.payload'),cwd,20,undefined,Infinity),/isolation admission timed out/);
shortenAdmission = false;
assert.equal(fs.existsSync(expired+'.payload'),false);

const command = set('command-timeout');
release(command);
holdCommandTimer = true;
const timed = runManagedCommand('touch '+quote(command+'.payload')+'; sleep 300',cwd,userTimeoutMs/1000,undefined,Infinity);
const timedOut = assert.rejects(timed,/timeout:4.173/);
await waitFor(command+'.payload');
assert.equal(typeof commandDeadline,'function');
commandDeadline();
await timedOut;
holdCommandTimer = false;

const rejected = set('exec-failure','exec-failure');
release(rejected);
const failed = await runManagedCommand('touch '+quote(rejected+'.payload'),cwd,10,undefined,Infinity);
assert.equal(failed.exitCode,126);
assert.match(failed.output,/fixture exec failure/);
assert.equal(fs.existsSync(rejected+'.payload'),false);

set('missing','missing');
await assert.rejects(runManagedCommand('printf wrong',cwd,10,undefined,Infinity),/before reporting shell admission/);
`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, base, loader], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {...process.env, PI_HARDLINK_SCAN_TTL_S: '0', PI_OWNER_DIR: path.join(base, 'owners')},
    encoding: 'utf8', timeout: 24000, killSignal: 'SIGKILL',
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMountedReadyParser } from '../agent/extensions/lib/guard-readiness.ts';

const source = path.resolve(import.meta.dirname, '../agent/scripts/harness-readonly-exec.py');
const probe = spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true'], {timeout: 3000});

test('both guarded launchers strip the first readiness frame across stdout chunks', () => {
  const prefix = Buffer.from('\x1ef000\n');
  const payload = Buffer.concat([prefix, Buffer.from('π\x00')]);
  for (let split = 0; split < prefix.length; split++) {
    const consume = createMountedReadyParser(prefix);
    assert.equal(consume(prefix.subarray(0, split)), 'pending');
    assert.deepEqual(consume(Buffer.concat([prefix.subarray(split), payload])), payload);
    const invalid = createMountedReadyParser(prefix);
    assert.equal(invalid(prefix.subarray(0, split)), 'pending');
    assert.equal(invalid(Buffer.from([0])), 'invalid');
  }
});

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
real_exec = os.execv
def hold_mount(executable, argv):
    attempt = os.environ['YUNUSPI_TEST_GUARD_ATTEMPT']
    with open(attempt + '.pre-mount', 'w') as receipt: receipt.write('exec pending')
    while not os.path.exists(attempt + '.mount-release'): time.sleep(0.01)
    real_exec(executable, argv)
if os.environ['YUNUSPI_TEST_GUARD_MODE'] == 'missing': sys.exit(0)
if os.environ['YUNUSPI_TEST_GUARD_MODE'] == 'exec-failure': os.execv = refuse_exec
if os.environ['YUNUSPI_TEST_GUARD_MODE'] == 'held-mount': os.execv = hold_mount
guard['check_protected_hardlinks'] = inventory
try: guard['main']()
except Exception as error:
    print('Harness write isolation refused command: ' + str(error), file=sys.stderr)
    sys.exit(126)
`);

  // Only the harness-root discovery input is replaced. Managed Bash, its
  // child process, the Python inventory and bubblewrap are all real.
  const token = 'f0000000000000000000000000000001';
  const guardModule = `export function guardedCommand(command, args, options) {
    return {command:'/usr/bin/python3',args:['-I',${JSON.stringify(fixtureWrapper)},${JSON.stringify(root)},
      ...(options?.readyPipe ? ['--ready-pipe'] : []), ...(options?.mountedReady ? ['--mounted-ready', '${token}'] : []),'--',command,...args],
      ...(options?.readyPipe ? {readyFd:3} : {}),...(options?.mountedReady ? {readyStdoutPrefix:Buffer.from('\\x1e${token}\\n')} : {})};
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
const codingEntry = JSON.stringify(import.meta.resolve('@yunuspi/coding-agent'));
const codingLoader = 'data:text/javascript,' + encodeURIComponent('export * from ' + codingEntry +
  ';import { getShellConfig as normal } from ' + codingEntry +
  ';export function getShellConfig(...args) { return process.env.YUNUSPI_TEST_STDIN === "1" '+
  '? { shell:"/bin/bash",args:["-s"], commandTransport:"stdin" } : normal(...args); }');
registerHooks({resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/agent/extensions/managed-bash.ts')) {
    if (specifier === './lib/self-mutation-guard.ts') return next(loader, context);
    if (specifier === '@yunuspi/coding-agent') return next(codingLoader, context);
  }
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
const userGraceMs = 4139;
const originalTimer = globalThis.setTimeout;
let commandTimers = 0;
let admissionTimers = 0;
let graceTimers = 0;
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
  if (ms === userGraceMs) graceTimers++;
  return originalTimer(callback, ms, ...args);
};
const quick = set('quick','held-mount');
const quickStop = new AbortController();
const checkFd = "import os; assert not os.path.exists('/proc/self/fd/3'); print(chr(30)+'${token}'); print('ok', end='')";
holdCommandTimer = true;
const before = runManagedCommand('/usr/bin/python3 -I -c '+quote(checkFd), cwd, userTimeoutMs/1000, quickStop.signal, userGraceMs);
try {
  await waitFor(quick+'.scan');
  assert.equal(commandTimers,0,'the command deadline began during a blocked inventory');
  assert.equal(admissionTimers,1);
  release(quick);
  await waitFor(quick+'.pre-mount');
  await delay(25);
  assert.equal(commandTimers,0,'the command deadline began before bubblewrap exec');
  assert.equal(graceTimers,0,'the detach grace began before bubblewrap exec');
  fs.writeFileSync(quick+'.mount-release','go');
  assert.deepEqual(await before, {exitCode:0,output:String.fromCharCode(30)+'${token}'+String.fromCharCode(10)+'ok'});
} finally {
  quickStop.abort();
  await before.catch(() => {});
  holdCommandTimer = false;
}
assert.equal(commandTimers,1);
assert.equal(graceTimers,1);

const stdin = set('stdin');
release(stdin);
process.env.YUNUSPI_TEST_STDIN = '1';
assert.deepEqual(await runManagedCommand('printf %s '+quote('stdin literal ; $() π'),cwd,5,undefined,Infinity),
  {exitCode:0,output:'stdin literal ; $() π'});
delete process.env.YUNUSPI_TEST_STDIN;

const pre = set('stop-before','held-mount');
const beforeStop = new AbortController();
const during = runManagedCommand('touch '+quote(pre+'.payload'),cwd,5,beforeStop.signal,Infinity);
const stopped = assert.rejects(during,/aborted/);
release(pre);
await waitFor(pre+'.pre-mount');
beforeStop.abort();
await stopped;
fs.writeFileSync(pre+'.mount-release','go');
assert.equal(fs.existsSync(pre+'.payload'),false);

const post = set('stop-after');
const afterStop = new AbortController();
release(post);
const executing = runManagedCommand('touch '+quote(post+'.payload')+'; sleep 300',cwd,20,afterStop.signal,Infinity);
const killed = assert.rejects(executing,/aborted/);
await waitFor(post+'.payload');
afterStop.abort();
await killed;

const expired = set('admission-timeout','held-mount');
release(expired);
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

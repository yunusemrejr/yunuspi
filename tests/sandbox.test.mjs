import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { spawn, execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")]
  .find(dir => fs.existsSync(path.join(dir, "scripts/sandbox-runner.py")));
const helper = path.join(agent, "scripts/sandbox-runner.py");
const { createRelevantGuidance } = await import(pathToFileURL(path.join(agent, "extensions/lib/relevant-guidance.ts")));
const python = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

function run(params, { abortAfter, cwd = work } = {}) {
  const child = spawn(python, ["-I", helper, cwd, process.execPath], { env: { ...process.env, PI_SANDBOX_TEST_SECRET: "must-not-inherit" } });
  const pending = new Promise((resolve, reject) => {
    let out = "", err = "";
    child.stdout.on("data", chunk => out += chunk);
    child.stderr.on("data", chunk => err += chunk);
    child.stdin.on("error", () => {});
    child.on("error", reject);
    const kill = setTimeout(() => child.kill("SIGKILL"), 15000);
    const abort = abortAfter ? setTimeout(() => child.kill("SIGTERM"), abortAfter) : undefined;
    child.on("close", () => {
      clearTimeout(kill); clearTimeout(abort);
      try { resolve(JSON.parse(out)); } catch { reject(Error(`Invalid launcher result: ${out} ${err}`)); }
    });
    child.stdin.end(JSON.stringify(params));
  });
  return pending;
}

let probe;
async function available(t) {
  probe ??= await run({ command: "true" });
  if (!probe.started) {
    assert.equal(probe.exitCode === 0, false);
    assert.match(probe.error, /requires|sandbox/i);
    if (process.env.PI_SANDBOX_REQUIRE === "1") assert.fail(JSON.stringify(probe));
    t.skip("OS sandbox unavailable; fail-closed result verified. Set PI_SANDBOX_REQUIRE=1 on a capable Linux host.");
    return false;
  }
  assert.equal(probe.exitCode, 0, JSON.stringify(probe));
  return true;
}

test("requests reject unsafe paths, special files, aliases and oversized inputs before execution", async () => {
  fs.writeFileSync(path.join(work, "source.txt"), "original");
  fs.mkdirSync(path.join(work, "dir"));
  fs.symlinkSync("source.txt", path.join(work, "symlink"));
  fs.symlinkSync(work, path.join(work, "ancestor"));
  fs.writeFileSync(path.join(work, "linked"), "alias");
  fs.linkSync(path.join(work, "linked"), path.join(work, "hardlink"));
  fs.writeFileSync(path.join(work, "large"), Buffer.alloc(262145));
  if (process.platform === "linux") await execFileAsync("mkfifo", [path.join(work, "fifo")]);
  const invalid = [null, {}, { command: "" }, { command: "x\0y" },
    { command: "true", network: true }, { command: "true", nodeBinary: "/etc/passwd" }, { command: "true", timeoutMs: 0 },
    { command: "true", timeoutMs: true }, { command: "true", maxOutputBytes: 999999 },
    ...["../escape", "/absolute", "a/../../escape", "a//b", "a/./b", "a\\b", "a\0b"].map(p => ({ command: "true", files: [{ path: p, content: "x" }] })),
    ...["symlink", "ancestor/source.txt", "hardlink", "dir", "large", "../outside", ...(process.platform === "linux" ? ["fifo"] : [])]
      .map(source => ({ command: "true", files: [{ path: "copy", source }] })),
    { command: "true", files: [{ path: "a" }] },
    { command: "true", files: [{ path: "a", content: "x", source: "source.txt" }] },
    { command: "true", files: [{ path: "a", content: "x" }, { path: "a/b", content: "y" }] },
    { command: "true", files: Array.from({ length: 9 }, (_, i) => ({ path: `${i}`, content: "x".repeat(262144) })) },
  ];
  for (const request of invalid) {
    const result = await run(request);
    assert.equal(result.started, false, JSON.stringify(request).slice(0, 100));
    assert.ok(result.error);
  }
  const direct = spawn(python, ["-I", helper, "--worker"]);
  const result = new Promise(resolve => { let stderr = ""; direct.stderr.on("data", c => stderr += c); direct.on("close", code => resolve({ code, stderr })); });
  direct.stdin.end('{}');
  const refused = await result;
  assert.equal(refused.code, 126);
  assert.match(refused.stderr, /cgroup|syscall filtering/);
});

test("manifest, all builtin child allowlists and active-tool guidance expose the capability", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(agent, "extensions/manifest.json")));
  assert.ok(manifest.extensions.includes("sandbox.ts"));
  assert.ok(manifest.supportFiles.includes("scripts/sandbox-runner.py"));
  for (const name of fs.readdirSync(path.join(agent, "extensions/pi-subagents/agents")).filter(n => n.endsWith('.md'))) {
    const body = fs.readFileSync(path.join(agent, "extensions/pi-subagents/agents", name), "utf8");
    assert.match(body, /^tools:.*\bsandbox_run\b/m, name);
    assert.match(body, /^subagentOnlyExtensions:.*\.\.\/\.\.\/sandbox\.ts/m, name);
  }
  const hints = (prompt, active) => {
    const g = createRelevantGuidance({ getActiveTools: () => active, appendEntry() {} });
    const ctx = { cwd: work, sessionManager: { getBranch: () => [] } };
    g.restore(ctx); g.start({ prompt, systemPrompt: "" }, ctx); return g;
  };
  for (const prompt of ["Run this in a disposable sandbox", "Test this in an isolated experiment", "Run a reproduction without touching the project"]) {
    const g = hints(prompt, ["sandbox_run"]);
    assert.ok(g.candidates().some(h => h.tool === "sandbox_run"), prompt);
    g.record({ toolName: "sandbox_run", input: {}, isError: false });
    assert.ok(!g.candidates().some(h => h.tool === "sandbox_run"));
    assert.equal(hints(prompt, []).candidates().length, 0);
  }
  for (const prompt of ["Explain disposable sandboxes", "Do not run sandbox experiments", "Run unit tests", "> Run this in a sandbox"]) {
    assert.ok(!hints(prompt, ["sandbox_run"]).candidates().some(h => h.tool === "sandbox_run"), prompt);
  }
});

test("real sandbox runs editable snapshots without host files, credentials, host PIDs or network", async t => {
  if (!await available(t)) return;
  const sentinel = path.join(work, "host-only");
  fs.writeFileSync(sentinel, "unchanged");
  const server = net.createServer(socket => socket.end("host"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const script = `import os, pathlib, socket\nassert pathlib.Path('nested/input').read_text() == 'Türkçe 🙂'\nassert pathlib.Path('source').read_bytes() == b'original'\npathlib.Path('source').write_text('changed')\nassert not pathlib.Path(${JSON.stringify(sentinel)}).exists()\nassert not pathlib.Path('/proc/${process.pid}/root').exists()\nassert not pathlib.Path('/run/user').exists()\nassert 'PI_SANDBOX_TEST_SECRET' not in os.environ\nassert 'DBUS_SESSION_BUS_ADDRESS' not in os.environ\nassert os.environ['HOME'] == '/home/sandbox'\ns = socket.socket(); s.settimeout(0.5)\nassert s.connect_ex(('127.0.0.1', ${server.address().port})) != 0\nassert os.listdir('/home') == ['sandbox']\ntry:\n socket.socket(getattr(socket, 'AF_VSOCK', 40), socket.SOCK_STREAM)\nexcept OSError: pass\nelse: raise AssertionError('host-facing socket family permitted')\nprint('isolated')\n`;
    const result = await run({ command: "set -eu\npython3 check.py\nnode -e 'if(2+2!==4) process.exit(1)'\nprintf persisted > /tmp/value\ntest \"$(cat /tmp/value)\" = persisted\n! touch /usr/pi-sandbox-test-write\n! unshare -Ur true",
      files: [{ path: "nested/input", content: "Türkçe 🙂" }, { path: "source", source: "source.txt" }, { path: "check.py", content: script }] });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.started, true);
    assert.match(result.stdout, /isolated/);
    assert.equal(fs.readFileSync(path.join(work, "source.txt"), "utf8"), "original");
    assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged");
    const fresh = await run({ command: "test ! -e /tmp/value && test ! -e /workspace/source" });
    assert.equal(fresh.exitCode, 0, JSON.stringify(fresh));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("nonzero exits, both output streams and output floods remain truthful and bounded", async t => {
  if (!await available(t)) return;
  const failure = await run({ command: "printf out; printf err >&2; exit 7" });
  assert.equal(failure.exitCode, 7); assert.equal(failure.started, true);
  assert.equal(failure.stdout, "out"); assert.equal(failure.stderr, "err");
  const flood = await run({ command: "python3 -c 'print(\"x\" * 200000)'", maxOutputBytes: 1024 });
  assert.equal(flood.exitCode, 0); assert.equal(flood.truncated, true);
  assert.ok(Buffer.byteLength(flood.stdout + flood.stderr) <= 1024);
});

test("timeouts and cancellation stop detached descendants and release slots", async t => {
  if (!await available(t)) return;
  const command = `setsid /bin/bash -c 'sleep 30' ${path.basename(work)} & wait`;
  const timed = await run({ command, timeoutMs: 1000 });
  assert.equal(timed.started, true); assert.equal(timed.timedOut, true);
  assert.ok(timed.durationMs < 5000, JSON.stringify(timed));
  const cancelled = await run({ command }, { abortAfter: 700 });
  assert.equal(cancelled.started, true); assert.equal(cancelled.cancelled, true);
  assert.ok(cancelled.durationMs < 5000, JSON.stringify(cancelled));
  const successful = await run({ command: `setsid /bin/bash -c 'sleep 30' ${path.basename(work)} & exit 0`, timeoutMs: 2000 });
  assert.equal(successful.exitCode, 0, JSON.stringify(successful));
  assert.equal(successful.timedOut, false, JSON.stringify(successful));
});

test("scratch and memory exhaustion are confined to the experiment", async t => {
  if (!await available(t)) return;
  const disk = await run({ command: "dd if=/dev/zero of=/workspace/full bs=1M count=80 status=none", timeoutMs: 5000 });
  assert.equal(disk.started, true); assert.notEqual(disk.exitCode, 0);
  assert.match(disk.stderr, /No space left/);
  const memory = await run({ command: "python3 -c 'a=bytearray(512*1024*1024)'", timeoutMs: 5000 });
  assert.equal(memory.started, true); assert.notEqual(memory.exitCode, 0);
  assert.equal((await run({ command: "true" })).exitCode, 0, "host can start another sandbox after OOM");
});

test("service deadline disposes experiments even after the launcher is killed", async t => {
  if (!await available(t)) return;
  const child = spawn(python, ["-I", helper, work]);
  const closed = new Promise(resolve => child.on('close', resolve));
  child.stdout.resume(); child.stderr.resume(); child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ command: `setsid /bin/bash -c 'sleep 30' ${path.basename(work)} & wait`, timeoutMs: 1500 }));
  await new Promise(resolve => setTimeout(resolve, 700));
  const descendants = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(/\s+/);
  const unit = descendants.map(pid => {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').find(arg => arg.startsWith('--unit=pi-sandbox-'))?.slice(7); }
    catch { return undefined; }
  }).find(Boolean);
  assert.ok(unit, 'test locates only its own service via the launcher child');
  child.kill('SIGKILL');
  await closed;
  // The independent service deadline may outlive the client/pipes. Observe
  // that specific unit's removal before asserting that its slot is released.
  const deadline = Date.now() + 5000;
  let units;
  do {
    ({ stdout: units } = await execFileAsync('/usr/bin/systemctl', ['--user', 'list-units', unit, '--all', '--no-legend', '--plain']));
    if (!units.trim()) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(units.trim(), '', 'service deadline reaps a crashed client');
  const { stdout } = await execFileAsync('ps', ['-eo', 'args']);
  assert.ok(!stdout.split('\n').some(line => line.includes(path.basename(work)) && line.includes('/bin/bash -c')));
  assert.equal((await run({ command: 'true' })).exitCode, 0);
});

test("process cap rejects excess children without exhausting host process capacity", async t => {
  if (!await available(t)) return;
  const code = "import subprocess\nkids=[]\ntry:\n for _ in range(40): kids.append(subprocess.Popen(['sleep','3']))\n raise AssertionError('process cap absent')\nexcept BlockingIOError: print('tasks bounded')\nfinally:\n for child in kids: child.kill()\n for child in kids: child.wait()\n";
  const result = await run({ command: "python3 tasks.py", files: [{ path: "tasks.py", content: code }], timeoutMs: 5000 });
  assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.match(result.stdout, /tasks bounded/);
});

test("concurrent callers have separate workspaces and a shared four-slot ceiling", async t => {
  if (!await available(t)) return;
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => run({
    command: `printf ${i} > same-name; sleep 1.5; test "$(cat same-name)" = ${i}; cat same-name`, timeoutMs: 5000,
  })));
  assert.equal(results.filter(r => r.started && r.exitCode === 0).length, 4, JSON.stringify(results));
  const refused = results.filter(r => !r.started);
  assert.equal(refused.length, 1); assert.match(refused[0].stderr, /slots are busy/);
  assert.equal((await run({ command: "true" })).exitCode, 0, "slots are released");
  // No services from this test remain after calls settle. Do not touch other
  // callers' units: the test only inspects the test-owned process markers.
  const { stdout: processes } = await execFileAsync("ps", ["-eo", "args"], { encoding: "utf8" });
  assert.ok(!processes.split('\n').some(line => line.includes(path.basename(work)) && line.includes("/bin/bash -c")), "detached test descendants cleaned up");
});

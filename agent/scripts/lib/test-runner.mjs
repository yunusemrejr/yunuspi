import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// The curated catalogue owns which scripts are safe offline. Parallelism is
// explicit because some historical suites share installed-runtime fixtures.
export function parseSelection(args, tests) {
  const requested = []; let jobs = 1, report, list = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--list") { list = true; continue; }
    const value = args[++i];
    if (key === "--test" && tests.includes(value)) requested.push(value);
    else if (key === "--match" && value && !value.startsWith("--")) {
      // Search only the curated offline catalogue. Literal text cannot pull
      // historical paid benchmarks into a run or expand an accidental glob.
      const matches = tests.filter(test => test.includes(value));
      if (!matches.length) throw new Error(`No registered offline suites match ${JSON.stringify(value)}. Use --list to inspect available suites.`);
      requested.push(...matches);
    }
    else if (key === "--jobs" && /^[1-4]$/.test(value ?? "")) jobs = Number(value);
    else if (key === "--report" && value && !value.startsWith("--")) report = path.resolve(value);
    else throw new Error(`Invalid test selection: ${value ?? key}. Use --test <registered relative path>, --match <literal path text>, --list, --jobs <1-4>, or --report <file>.`);
  }
  return { selected: [...new Set(requested.length ? requested : tests)], jobs, report, list };
}

export function runSuite(test, file, { signal, env = process.env, cwd, timeoutMs = 120000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid suite deadline');
  const started = performance.now();
  return new Promise((resolve) => {
    let stdout = "", stderr = "", bytes = 0, error, hardKill;
    const child = spawn("timeout", ["--kill-after=5s", `${timeoutMs / 1000}s`, process.execPath,
      "--no-warnings", "--experimental-strip-types", file], {
      env: { ...env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_MEMORY_EXIT_SUMMARY: "0", PI_MEMORY_QMD_UPDATE: "off" },
      stdio: ["ignore", "pipe", "pipe"], detached: true, cwd,
    });
    const stop = () => {
      if (!child.pid) return;
      const kill = (name) => { try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch {} } };
      kill("SIGTERM"); hardKill ??= setTimeout(() => kill("SIGKILL"), 5000);
      hardKill.unref();
    };
    // GNU timeout stops watching when the direct child exits. Descendants
    // can still hold inherited stdout/stderr open, preventing close forever.
    const deadline = setTimeout(() => { error ??= 'test exceeded suite deadline'; stop(); }, timeoutMs + 25);
    const abort = () => { error ??= "test run interrupted"; stop(); };
    const collect = (stream) => (data) => {
      const chunk = data.toString(); bytes += Buffer.byteLength(chunk);
      // Retain an actionable tail while bounding both output memory and work.
      if (stream === "stdout") stdout = (stdout + chunk).slice(-6000);
      else stderr = (stderr + chunk).slice(-6000);
      if (bytes > 2 * 1024 * 1024 && !error) { error = "test output exceeded 2 MiB"; stop(); }
    };
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
    child.on("error", (e) => { error = e.message; });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("close", (status, childSignal) => {
      clearTimeout(deadline); clearTimeout(hardKill); signal?.removeEventListener("abort", abort);
      const ok = status === 0 && !error;
      resolve({ test, ok, status, signal: childSignal, ms: Math.round(performance.now() - started),
        error: error ?? null, failure: ok ? null : `${error ? error + "\n" : ""}${stdout}${stderr}`.slice(-6000) });
    });
  });
}

export async function runPool(selected, jobs, run, signal) {
  const results = new Array(selected.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, selected.length) }, async () => {
    while (next < selected.length && !signal?.aborted) {
      const index = next++; results[index] = await run(selected[index]);
    }
  }));
  return results.filter(Boolean);
}

export function writeReport(file, report) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
}

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const lib = path.join(import.meta.dirname, "..", "agent/extensions/lib");
const guard = await import(pathToFileURL(path.join(lib, "memory-guard.ts")).href);
const studio = await import(pathToFileURL(path.join(lib, "video-studio.ts")).href);

test("large process trees count each descendant exactly once and exclude unrelated processes", () => {
  const readdir = fs.readdirSync, read = fs.readFileSync;
  const count = 7000;
  fs.readdirSync = () => Array.from({ length: count + 1 }, (_, i) => String(i + 1000));
  fs.readFileSync = file => {
    const pid = Number(String(file).split('/')[2]);
    const fields = Array(22).fill('0');
    fields[0] = 'S';
    fields[1] = String(pid === 1000 || pid === 1000 + count ? 1 : pid - 1);
    fields[21] = '256';
    return `${pid} (synthetic worker) ${fields.join(' ')}`;
  };
  syncBuiltinESMExports();
  try {
    const usage = guard.treeUsage(1000);
    assert.equal(usage.pids.length, count);
    assert.equal(new Set(usage.pids).size, count);
    assert.equal(usage.mb, count);
    assert.equal(usage.pids.at(-1), 1000 + count - 1);
  } finally { fs.readdirSync = readdir; fs.readFileSync = read; syncBuiltinESMExports(); }
});

test("overlapping memory checks share a sample and explicit ownership checks read fresh", t => {
  const processes = new Map([
    [2001, { parent: 1, identity: '101', mb: 64 }],
    [2002, { parent: 2001, identity: '102', mb: 16 }],
    [3001, { parent: 1, identity: '201', mb: 96 }],
  ]);
  const { readdirSync, readFileSync } = fs;
  let scans = 0, memoryReads = 0, now = performance.now() + 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setInterval'] });
  fs.readdirSync = (file, ...args) => {
    if (file !== '/proc') return readdirSync(file, ...args);
    scans++;
    return [...processes.keys()].map(String);
  };
  fs.readFileSync = (file, ...args) => {
    if (file === '/proc/meminfo') { memoryReads++; return 'MemAvailable: 4000000 kB\n'; }
    const match = /^\/proc\/(\d+)\/stat$/.exec(file);
    if (!match) return readFileSync(file, ...args);
    const { parent, identity, mb } = processes.get(Number(match[1]));
    const fields = Array(22).fill('0');
    fields[0] = 'S';
    fields[1] = String(parent);
    fields[19] = identity;
    fields[21] = String(mb * 256);
    return `${match[1]} (synthetic job) ${fields.join(' ')}`;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.readdirSync = readdirSync; fs.readFileSync = readFileSync; syncBuiltinESMExports(); });

  const warnings = [];
  const stopFirst = guard.watchMemory(2001, 75, (text, pids) => warnings.push({ text, pids }), { intervalMs: 100 });
  const stopSecond = guard.watchMemory(3001, 92, (text, pids) => warnings.push({ text, pids }), { intervalMs: 100 });
  t.after(() => { stopFirst(); stopSecond(); });
  t.mock.timers.tick(100);
  assert.equal(scans, 1);
  assert.equal(memoryReads, 1);
  assert.deepEqual(warnings.map(item => item.pids), [[2001, 2002], [3001]]);
  assert.match(warnings[0].text, /using 80 MB/);
  assert.match(warnings[1].text, /using 96 MB/);

  processes.set(2001, { parent: 1, identity: '999', mb: 1024 });
  t.mock.timers.tick(100);
  assert.equal(scans, 1, 'the shared sample still falls inside its age limit');
  assert.deepEqual(warnings.slice(2).map(item => item.pids), [[3001]], 'a reused root cannot trigger a cached warning');
  assert.equal(guard.treeUsage(2001, true).identities[2001], '999');
  assert.equal(scans, 2, 'an explicit identity scan cannot read a cached PID');
  now += 100;
  t.mock.timers.tick(100);
  assert.equal(scans, 3);
  assert.equal(memoryReads, 2);
  assert.deepEqual(warnings.slice(3).map(item => item.pids), [[3001]], 'the watchdog does not report a reused root PID');

  stopFirst();
  stopSecond();
  t.mock.timers.tick(100);
  assert.equal(scans, 3);
});

test("tree usage counts a process and its children", async () => {
  const child = spawn("sh", ["-c", "node -e 'const b = Buffer.alloc(120 * 1024 * 1024, 1); setTimeout(() => {}, 4000)' & wait"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 1200));
    const usage = guard.treeUsage(child.pid);
    assert.ok(usage.pids.length >= 2, `shell and node are both counted: ${usage.pids}`);
    assert.ok(usage.mb >= 100, `the child's buffer is counted, saw ${usage.mb} MB`);
  } finally { child.kill("SIGKILL"); }
});

test("a job over its budget is stopped with an actionable reason", async () => {
  const child = spawn("node", ["-e", "const b = Buffer.alloc(300 * 1024 * 1024, 1); setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  const message = await new Promise((resolve) => {
    const stop = guard.watchMemory(child.pid, 150, (text, pids) => { stop(); for (const pid of pids) process.kill(pid, "SIGKILL"); resolve(text); }, { intervalMs: 100 });
    setTimeout(() => { stop(); resolve("never stopped"); }, 15000).unref();
  });
  assert.match(message, /memory budget of 150 MB exceeded \(using \d+ MB\)/);
  await new Promise((r) => child.on("exit", r));
});

test("the budget follows free memory unless overridden", () => {
  assert.ok(guard.memoryBudgetMb() >= 1536 && guard.memoryBudgetMb() <= 12 * 1024);
  process.env.YUNUSPI_VIDEO_MEMORY_MB = "3000";
  try { assert.equal(guard.memoryBudgetMb(), 3000); } finally { delete process.env.YUNUSPI_VIDEO_MEMORY_MB; }
});

test("render workers shrink with resolution and memory instead of exhausting RAM", () => {
  delete process.env.YUNUSPI_VIDEO_CONCURRENCY;
  assert.equal(studio.renderConcurrency(1920, 1080, 1, 1600), 1, "a tight budget still renders, one worker at a time");
  assert.ok(studio.renderConcurrency(3840, 2160, 1, 3300) < studio.renderConcurrency(1920, 1080, 1, 3300), "4K runs fewer workers than 1080p when memory is the limit");
  assert.ok(studio.renderConcurrency(3840, 2160, 0.5, 3300) >= studio.renderConcurrency(3840, 2160, 1, 3300), "a lower scale never lowers parallelism");
  process.env.YUNUSPI_VIDEO_CONCURRENCY = "3";
  try { assert.equal(studio.renderConcurrency(3840, 2160, 1, 1600), 3); } finally { delete process.env.YUNUSPI_VIDEO_CONCURRENCY; }
});

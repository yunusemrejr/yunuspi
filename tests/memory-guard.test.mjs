import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = path.join(import.meta.dirname, "..", "agent/extensions/lib");
const guard = await import(pathToFileURL(path.join(lib, "memory-guard.ts")).href);
const studio = await import(pathToFileURL(path.join(lib, "video-studio.ts")).href);

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

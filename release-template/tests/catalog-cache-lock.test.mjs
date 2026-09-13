// Real OS-process lock coverage.  The fixture never loads a provider or reads
// the live catalog; it only exercises the lock's marker and reclamation
// protocol against independent Node processes.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-cache-lock-"));
const template = path.resolve(import.meta.dirname, "..");
const agent = [path.join(template, "agent"), path.resolve(template, "..")].find(p => fs.existsSync(path.join(p, "extensions/lib/catalog-cache-lock.ts")));
const helper = pathToFileURL(path.join(agent, "extensions/lib/catalog-cache-lock.ts")).href;
const workerPath = path.join(root, "worker.mjs");
fs.writeFileSync(workerPath, `
import { acquireCatalogCacheLock } from ${JSON.stringify(helper)};
import { setTimeout as delay } from "node:timers/promises";
const [cacheFile, mode, holdText] = process.argv.slice(2);
const send = (message) => new Promise((resolve) => {
  if (!process.send) return resolve();
  process.send(message, () => resolve());
});
async function main() {
  if (mode === "abort") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(holdText));
    timer.unref();
    try {
      const release = await acquireCatalogCacheLock(cacheFile, controller.signal);
      await send({ phase: "acquired", pid: process.pid });
      release();
      await send({ phase: "released", pid: process.pid });
    } catch (error) {
      await send({ phase: "failed", name: error?.name, message: String(error?.message ?? error) });
    }
  } else {
    const release = await acquireCatalogCacheLock(cacheFile);
    await send({ phase: "acquired", pid: process.pid });
    await delay(Number(holdText));
    release();
    await send({ phase: "released", pid: process.pid });
  }
}
main().catch(async (error) => {
  await send({ phase: "crashed", name: error?.name, message: String(error?.message ?? error) });
  process.exitCode = 1;
}).finally(() => {
  if (process.connected) process.disconnect();
});
`);

const children = new Set();
function launch(cacheFile, mode, holdMs) {
  const child = fork(workerPath, [cacheFile, mode, String(holdMs)], {
    execArgv: ["--experimental-strip-types", "--no-warnings"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const events = [];
  const waiters = new Set();
  child.on("message", (message) => {
    events.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return {
    child,
    events,
    wait(predicate, timeoutMs = 7000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`worker timed out: ${JSON.stringify({ cacheFile, mode, events })}`));
          }, timeoutMs),
        };
        waiter.timer.unref();
        waiters.add(waiter);
      });
    },
  };
}

async function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}
const phase = (name) => (event) => event?.phase === name;

try {
  const cache = path.join(root, "catalog.json");
  const lock = `${cache}.lock`;

  // A live legacy numeric owner is never stolen, and cancellation leaves the
  // owner's directory untouched.
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner"), String(process.pid), { mode: 0o600 });
  const liveLegacy = launch(cache, "abort", 120);
  const liveFailure = await liveLegacy.wait(phase("failed"));
  assert.match(`${liveFailure.name} ${liveFailure.message}`, /abort|cancel/i);
  assert.equal(fs.existsSync(lock), true);
  fs.rmSync(lock, { recursive: true, force: true });

  // An owner killed after publishing its marker leaves the lock behind.  Its
  // replacement must be recovered without an age-based guess.
  const holder = launch(cache, "acquire", 10000);
  await holder.wait(phase("acquired"));
  assert.equal(fs.existsSync(lock), true);
  holder.child.kill("SIGKILL");
  await waitExit(holder.child);
  assert.equal(fs.existsSync(lock), true, "a killed owner leaves a recoverable marker");

  // Two independent reclaimers race for the same dead marker.  Exactly one
  // may enter first; the other must wait for the new owner and then enter.
  const first = launch(cache, "acquire", 300);
  const second = launch(cache, "acquire", 300);
  const winner = await Promise.race([
    first.wait(phase("acquired")).then((event) => ({ worker: first, event })),
    second.wait(phase("acquired")).then((event) => ({ worker: second, event })),
  ]);
  await delay(100);
  assert.equal(
    [first, second].filter((worker) => worker.events.some(phase("acquired"))).length,
    1,
    "the losing reclaimer must not rename a newly acquired lock",
  );
  const other = winner.worker === first ? second : first;
  await Promise.all([winner.worker.wait(phase("released")), other.wait(phase("acquired"))]);
  await other.wait(phase("released"));
  assert.equal(fs.existsSync(lock), false, "all reclaimed lock owners release cleanly");

  // Legacy dead-PID markers remain recoverable, while an ownerless directory
  // fails closed rather than being deleted by age.
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner"), "2147483647", { mode: 0o600 });
  const deadLegacy = launch(cache, "acquire", 0);
  await deadLegacy.wait(phase("released"));
  assert.equal(fs.existsSync(lock), false);

  fs.mkdirSync(lock, { mode: 0o700 });
  const ownerless = launch(cache, "abort", 120);
  const ownerlessFailure = await ownerless.wait(phase("failed"));
  assert.match(`${ownerlessFailure.name} ${ownerlessFailure.message}`, /abort|cancel/i);
  assert.equal(fs.existsSync(lock), true, "ownerless locks require explicit recovery");
  fs.rmSync(lock, { recursive: true, force: true });

  console.log("PASS catalog cache lock: legacy owners, live-owner abort, killed-owner recovery, atomic two-reclaimer handoff and cleanup");
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.allSettled([...children].map((child) => waitExit(child)));
  fs.rmSync(root, { recursive: true, force: true });
}

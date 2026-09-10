#!/usr/bin/env node
// Conservative local housekeeping. Default is REPORT ONLY. No transcript,
// credential, memory, worktree, task-output or arbitrary backup deletion.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const DAY = 86400_000;
const SID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const stateName = new RegExp(`^state-(${SID})\\.json$`, "i");
const shadowName = new RegExp(`^shadow-(${SID})\\.jsonl$`, "i");
const temporaryName = new RegExp(`^state-(${SID})\\.json(?:\\.(\\d+))?\\.tmp$`, "i");
const repairName = new RegExp(`_(${SID})\\.jsonl\\.bak-thinkrepair$`, "i");
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
};
async function regular(file) {
  try {
    const stat = await fsp.lstat(file);
    // Reject symlink ancestors as well as the final component.
    if (!stat.isFile() || await fsp.realpath(file) !== path.resolve(file)) return;
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}
async function children(dir) {
  try {
    if ((await fsp.lstat(dir)).isSymbolicLink() || await fsp.realpath(dir) !== path.resolve(dir)) return [];
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function smallJson(file, stat) {
  if (!stat || stat.size > 65536) return;
  try {
    const fd = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(65537);
      const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 65536) return;
      return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } finally { await fd.close(); }
  } catch (error) {
    if (error instanceof SyntaxError || error.code === "ENOENT" || error.code === "ELOOP") return;
    throw error;
  }
}
async function activeSessions(root) {
  const ids = new Set([process.env.PI_SESSION_ID].filter(Boolean));
  const dir = path.join(root, "sibling-bridge/active");
  for (const entry of await children(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    const record = await smallJson(file, await regular(file));
    // Unknown heartbeat contents cannot justify deleting anybody's state.
    if (!record || typeof record.sid !== "string" || !Number.isSafeInteger(record.pid))
      throw new Error(`Unverifiable active-session record: ${entry.name}; cleanup skipped`);
    if (alive(record.pid)) ids.add(record.sid);
  }
  return ids;
}
const unchanged = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs);
async function digest(file, compressed = false) {
  const hash = createHash("sha256");
  const input = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
  const sink = async (source) => { for await (const chunk of source) hash.update(chunk); };
  await pipeline(...(compressed ? [input, createGunzip(), sink] : [input, sink]));
  return hash.digest("hex");
}
async function archiveRepair(root, candidate) {
  const relative = path.relative(path.join(root, "agent/sessions"), candidate.file);
  const archiveRoot = path.join(root, "agent/backups/session-repair");
  const target = path.join(archiveRoot, relative + ".gz");
  const parent = path.dirname(target);
  // Never follow an existing archive-directory symlink while creating children.
  let cursor = root;
  for (const segment of path.relative(root, parent).split(path.sep)) {
    cursor = path.join(cursor, segment);
    try { await fsp.mkdir(cursor, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!(await fsp.lstat(cursor)).isDirectory() || await fsp.realpath(cursor) !== cursor)
      throw new Error("Unsafe archive directory");
  }
  try { await fsp.lstat(target); return 0; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const tmp = `${target}.${process.pid}.tmp`;
  let created = false;
  try {
    const output = await fsp.open(tmp, "wx", 0o600);
    created = true;
    try {
      await pipeline(fs.createReadStream(candidate.file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW }), createGzip(), output.createWriteStream());
    } finally { await output.close(); }
    const durable = await fsp.open(tmp, "r");
    try { await durable.sync(); } finally { await durable.close(); }
    if (await digest(candidate.file) !== await digest(tmp, true)) throw new Error("Archive verification failed");
    if (!unchanged(candidate.stat, await regular(candidate.file))) throw new Error("Repair backup changed during compression; original preserved");
    await fsp.link(tmp, target); // Atomic, collision-safe publication.
    const archivedSize = (await fsp.stat(target)).size;
    const dir = await fsp.open(parent, "r");
    try { await dir.sync(); } finally { await dir.close(); }
    if (!unchanged(candidate.stat, await regular(candidate.file))) throw new Error("Repair backup changed before removal; original preserved");
    await fsp.unlink(candidate.file);
    return candidate.stat.size - archivedSize;
  } finally { if (created) await fsp.unlink(tmp).catch(() => {}); }
}

export async function cleanupHarness({ home = os.homedir(), apply = false, now = Date.now() } = {}) {
  const root = path.resolve(home, ".pi");
  if (await fsp.realpath(root) !== root) throw new Error("Harness root must not be a symlink");
  const active = await activeSessions(root);
  const candidates = [];
  const summary = { apply, protectedSessions: active.size, planned: {}, completed: {}, reclaimedBytes: 0, errors: [], sample: [] };
  const add = (kind, file, stat, sid) => {
    if (active.has(sid)) return;
    candidates.push({ kind, file, stat, sid });
    const item = summary.planned[kind] ??= { files: 0, bytes: 0 };
    item.files++; item.bytes += stat.size;
    if (summary.sample.length < 15) summary.sample.push({ kind, path: path.relative(root, file) });
  };
  for (const category of ["reminders", "checkpoints"]) {
    const dir = path.join(root, category);
    for (const entry of await children(dir)) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name), stat = await regular(file);
      if (!stat) continue;
      const temporary = entry.name.match(temporaryName);
      if (temporary && now - stat.mtimeMs > DAY && !alive(Number(temporary[2]))) {
        add("abandoned-temp", file, stat, temporary[1]); continue;
      }
      if (now - stat.mtimeMs <= 7 * DAY) continue;
      const shadow = entry.name.match(shadowName);
      if (category === "checkpoints" && shadow) { add("expired-debug", file, stat, shadow[1]); continue; }
      const match = entry.name.match(stateName);
      if (!match) continue;
      const data = await smallJson(file, stat);
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      if (category === "reminders") {
        // No empty/default record needs to survive for a whole month. Preserve
        // registered reminders, including legacy custom queues and malformed state.
        const queues = [data.manual, data.custom].filter((value) => value !== undefined);
        if (!queues.length || queues.some((queue) => !Array.isArray(queue) || queue.length)) continue;
        if (!Number.isFinite(data.startedAt)) continue;
      } else if (data.sid !== match[1] || data.editsSinceCommand !== 0 ||
            (data.pendingReadbackPaths !== undefined && (!Array.isArray(data.pendingReadbackPaths) || data.pendingReadbackPaths.length))) continue;
      add(`idle-${category}`, file, stat, match[1]);
    }
  }
  // Old one-off thinking repair snapshots are not live transcripts. Compress
  // losslessly into the existing backup tree, outside transcript retention.
  const walk = async (dir, depth = 0) => {
    if (depth > 8) return;
    for (const entry of await children(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file, depth + 1); continue; }
      const match = entry.name.match(repairName);
      if (!entry.isFile() || !match) continue;
      const stat = await regular(file);
      if (stat && stat.size <= 256 * 1024 * 1024 && now - stat.mtimeMs > 7 * DAY)
        add("repair-backup", file, stat, match[1]);
    }
  };
  await walk(path.join(root, "agent/sessions"));
  if (!apply) return summary;
  for (const candidate of candidates) {
    try {
      if ((await activeSessions(root)).has(candidate.sid) || !unchanged(candidate.stat, await regular(candidate.file))) continue;
      const saved = candidate.kind === "repair-backup" ? await archiveRepair(root, candidate) : (await fsp.unlink(candidate.file), candidate.stat.size);
      if (candidate.kind === "repair-backup" && saved === 0) continue;
      summary.completed[candidate.kind] = (summary.completed[candidate.kind] ?? 0) + 1;
      summary.reclaimedBytes += saved;
    } catch (error) {
      if (error.code !== "ENOENT") summary.errors.push(`${path.relative(root, candidate.file)}: ${error.message}`);
    }
  }
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--apply", "--dry-run"].includes(arg)) || (args.includes("--apply") && args.includes("--dry-run"))) {
    console.error("Usage: cleanup-harness.mjs [--dry-run | --apply] (default: dry-run)");
    process.exitCode = 2;
  } else {
    try {
      const result = await cleanupHarness({ apply: args.includes("--apply") });
      console.log(JSON.stringify(result, null, 2));
      if (result.errors.length) process.exitCode = 1;
    } catch (error) { console.error(`Cleanup skipped: ${error.message}`); process.exitCode = 1; }
  }
}

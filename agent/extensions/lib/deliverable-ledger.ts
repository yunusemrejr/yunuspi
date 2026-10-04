/** Which files did this session produce, and has anyone opened them?
 *
 * The ledger is the pure state behind the deliverables extension: a produced file is
 * "unverified" until a check recorded the same bytes (mtime and size). Detection stays
 * deliberately narrow so a follow-up is rare and warranted: only final-product types
 * (documents, PDFs, video, audio), only files this call could have written, and only
 * when the model named the file or it sits where outputs conventionally go. A project's
 * own test fixtures, build output trees and dependency folders never count. */
import fs from "node:fs";
import path from "node:path";
import { DELIVERABLE_AUTO_EXTENSIONS } from "./deliverable-inspect.ts";

export type Observed = { path: string; mtimeMs: number; size: number; via: string };
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "__pycache__", ".venv", "venv", ".cache", "target", ".next", ".idea", ".vscode"]);
/** A path segment that marks a file as test data, scratch output or an intermediate, never as the thing asked for. */
const NOT_A_DELIVERABLE_SEGMENT = new Set(["tests", "test", "__tests__", "spec", "fixtures", "fixture", "snapshots", "__snapshots__", "tmp", "temp", "cache", "frames", "segments", "chunks", "intermediate", "scratch", "node_modules", ".git"]);
/** Top-level folders where scripts conventionally leave finished outputs. */
const OUTPUT_FOLDERS = new Set(["out", "output", "outputs", "dist", "build", "export", "exports", "report", "reports", "deliverables", "deliverable", "results", "renders", "render", "release", "releases", "documents", "docs"]);

export const isDeliverableName = (file: string): boolean => DELIVERABLE_AUTO_EXTENSIONS.test(file);

export function createDeliverableLedger() {
  const produced = new Map<string, Observed>(), checked = new Map<string, { mtimeMs: number; size: number; status: string }>();
  const statOf = (file: string) => { try { const stat = fs.statSync(file); return stat.isFile() ? stat : undefined; } catch { return undefined; } };
  return {
    /** Record a produced file at its current bytes. True when this is new or changed since the last observation. */
    noteProduced(file: string, via: string): boolean {
      const resolved = path.resolve(file), stat = statOf(resolved);
      if (!stat) return false;
      const before = produced.get(resolved);
      if (before && before.mtimeMs === stat.mtimeMs && before.size === stat.size) return false;
      produced.set(resolved, { path: resolved, mtimeMs: stat.mtimeMs, size: stat.size, via });
      if (produced.size > 64) produced.delete(produced.keys().next().value!);
      return true;
    },
    /** Record that a check looked at the file as it is now. */
    noteChecked(file: string, status: string): void {
      const resolved = path.resolve(file), stat = statOf(resolved);
      if (stat) { checked.set(resolved, { mtimeMs: stat.mtimeMs, size: stat.size, status }); if (checked.size > 128) checked.delete(checked.keys().next().value!); }
    },
    /** Produced files that still exist and whose current bytes no check has seen, newest first. */
    pending(): Observed[] {
      const open: Observed[] = [];
      for (const [file, seen] of produced) {
        const stat = statOf(file);
        if (!stat) { produced.delete(file); continue; }
        const done = checked.get(file);
        if (done && done.mtimeMs === stat.mtimeMs && done.size === stat.size) continue;
        open.push({ ...seen, mtimeMs: stat.mtimeMs, size: stat.size });
      }
      return open.sort((a, b) => b.mtimeMs - a.mtimeMs);
    },
    reset() { produced.clear(); checked.clear(); },
    snapshot: () => ({ produced: produced.size, checked: checked.size }),
  };
}
export type DeliverableLedger = ReturnType<typeof createDeliverableLedger>;

/** Commands that cannot create a deliverable need no scan. */
const READ_ONLY = /^\s*(?:cd [^;&|]+&&\s*)?(?:ls|cat|head|tail|grep|rg|find|wc|stat|file|pwd|which|echo|date|diff|tree|du|df|ps|git (?:log|status|diff|show|branch|rev-parse|ls-files|blame)|jq|curl -s|pdfinfo|pdftotext|ffprobe)\b(?![^|]*>)/;
export const commandMayProduceFiles = (command: unknown): boolean => typeof command === "string" && command.trim() !== "" && !READ_ONLY.test(command);

/** Deliverable-type files under `cwd` written at or after `since`, found with a fixed budget of entries and time. */
export function scanRecentDeliverables(cwd: string, since: number, options: { maxEntries?: number; maxMs?: number } = {}): string[] {
  const found: string[] = [], queue: Array<[string, number]> = [[cwd, 0]], started = Date.now();
  const maxEntries = options.maxEntries ?? 2500, maxMs = options.maxMs ?? 80;
  let examined = 0;
  while (queue.length && examined < maxEntries && Date.now() - started < maxMs) {
    const [dir, depth] = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++examined > maxEntries) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < 3 && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) queue.push([full, depth + 1]); continue; }
      if (!entry.isFile() || !isDeliverableName(entry.name)) continue;
      try { if (fs.statSync(full).mtimeMs >= since) found.push(full); } catch { /* vanished */ }
    }
  }
  return found;
}

/** Whether a scanned file plausibly is what the command produced: named in the command or its output, or placed
 * directly in the working directory or a conventional output folder, and not under test/scratch/intermediate folders. */
export function plausibleDeliverable(file: string, cwd: string, commandAndOutput: string): boolean {
  const relative = path.relative(cwd, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep), name = segments[segments.length - 1];
  if (segments.slice(0, -1).some(segment => NOT_A_DELIVERABLE_SEGMENT.has(segment.toLowerCase()))) return false;
  if (/^(?:~\$|\.~lock|\.)/.test(name) || /\.(?:tmp|part|crdownload)$/i.test(name)) return false;
  if (commandAndOutput.includes(name) || commandAndOutput.includes(relative)) return true;
  return segments.length === 1 || (segments.length === 2 && OUTPUT_FOLDERS.has(segments[0].toLowerCase()));
}

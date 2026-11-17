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
import { tokenizeSimple } from "./bash-routing.ts";
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
    /** Has this session produced the file (at any bytes)? */
    isProduced: (file: string): boolean => produced.has(path.resolve(file)),
    producedPaths: (): string[] => [...produced.keys()],
    /** How the session produced the file ("write", "bash", "office_doc", "convert"), when it did. */
    originOf: (file: string): string | undefined => produced.get(path.resolve(file))?.via,
    reset() { produced.clear(); checked.clear(); },
    snapshot: () => ({ produced: produced.size, checked: checked.size }),
  };
}
export type DeliverableLedger = ReturnType<typeof createDeliverableLedger>;

const READ_ONLY_COMMANDS = new Set(["cd", "ls", "cat", "head", "tail", "grep", "wc", "stat", "file", "pwd", "which", "echo", "date", "diff", "du", "df", "ps", "jq", "pdfinfo"]);
const READ_ONLY_GIT = new Set(["log", "status", "diff", "show", "rev-parse", "ls-files", "blame"]);

function isReadOnlyCommand(command: string): boolean {
  if (!command.trim()) return true;
  const words = tokenizeSimple(command);
  if (!words) return false;
  const [name, ...args] = words;
  switch (name) {
    case "find": return args.every(arg => !/^-(?:exec(?:dir)?|ok(?:dir)?|delete|fprint0?|fprintf|fls)$/.test(arg));
    case "curl": return args.length === 2 && /^-sS?L?$/.test(args[0]) && /^https?:\/\//.test(args[1]);
    case "pdftotext": return args.length >= 2 && args.at(-1) === "-";
    case "ffprobe": return !args.some(arg => /^-o(?:=|$)/.test(arg));
    case "rg": return !args.some(arg => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg));
    case "tree": return !args.some(arg => /^-[a-z]*o/i.test(arg));
    case "git": {
      const [subcommand, ...flags] = args;
      if (subcommand === "branch") return flags.every(flag => /^(?:-a|-r|-v|-vv|--list|--show-current)$/.test(flag));
      return READ_ONLY_GIT.has(subcommand) && !flags.some(flag => /^--(?:out(?:put)?(?:=|$)|ext-diff$)/.test(flag));
    }
    default: return READ_ONLY_COMMANDS.has(name);
  }
}

/** Skip the scan only when each literal segment of a command is read-only. */
export function commandMayProduceFiles(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  let quote = "", start = 0;
  for (let at = 0; at < command.length; at++) {
    const char = command[at];
    if (char === "\\" && quote !== "'") {
      const next = command[++at];
      if (next === undefined || next === "\n" || next === "\r") return true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else if (quote === '"' && (char === "$" || char === "`")) return true;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    // Redirections, expansions, comments and groups can hide further effects.
    if ("<>$()`#{}".includes(char)) return true;
    if (";|&\n\r".includes(char)) {
      const next = command[at + 1];
      if (char === "&" && next !== "&") return true;
      if (!isReadOnlyCommand(command.slice(start, at))) return true;
      if (char === "&" || char === "|" && (next === "|" || next === "&")) at++;
      start = at + 1;
    }
  }
  return Boolean(quote) || !isReadOnlyCommand(command.slice(start));
}

/** Deliverable-type files under `cwd` written at or after `since`, found with a fixed budget of entries and time. */
export function scanRecentDeliverables(cwd: string, since: number, options: { maxEntries?: number; maxMs?: number } = {}): string[] {
  const found: string[] = [], queue: Array<[string, number]> = [[cwd, 0]];
  const maxEntries = Math.floor(options.maxEntries ?? 2500);
  const deadline = performance.now() + (options.maxMs ?? 80);
  let examined = 0;
  // Read a bounded batch of dirents instead of materializing every name in a
  // directory. Keep breadth-first traversal so nearby output is checked first.
  for (let next = 0; next < queue.length && examined < maxEntries && performance.now() < deadline; next++) {
    const [dir, depth] = queue[next];
    let handle: fs.Dir;
    try { handle = fs.opendirSync(dir, { bufferSize: Math.min(32, maxEntries - examined) }); }
    catch { continue; }
    try {
      while (examined < maxEntries && performance.now() < deadline) {
        const entry = handle.readSync();
        if (!entry) break;
        examined++;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 3 && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) queue.push([full, depth + 1]);
          continue;
        }
        if (!entry.isFile() || !isDeliverableName(entry.name)) continue;
        try { if (fs.statSync(full).mtimeMs >= since) found.push(full); } catch { /* vanished */ }
      }
    } catch { /* unreadable directory */ }
    finally {
      try { handle.closeSync(); } catch { /* best-effort discovery */ }
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

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveWithinRoot } from "../path-safety.ts";

const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_EVIDENCE_FILES = 32;

/** Bound source observations to a stable regular file in the current checkout.
 * No source text is retained. Missing, changing or oversized files stay unknown. */
export function taskFileObservation(cwd: string, input: string): { file: string; hash?: string } {
  const resolved = path.resolve(cwd, input);
  const relative = path.relative(cwd, resolved);
  let file = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? resolved : relative;
  let fd: number | undefined;
  try {
    const root = fs.realpathSync(cwd);
    const target = resolveWithinRoot(root, resolved, "evidence source");
    file = path.relative(root, target);
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_FILE_BYTES) return { file };
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!read) break;
      length += read;
    }
    const after = fs.fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || fs.realpathSync(target) !== target) return { file };
    const current = fs.statSync(target);
    if (current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size
      || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) return { file };
    return { file, hash: createHash("sha256").update(buffer.subarray(0, length)).digest("hex") };
  } catch {
    return { file };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function taskFileHashes(cwd: string, files: readonly string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of [...new Set(files)].slice(0, MAX_EVIDENCE_FILES)) {
    const observation = taskFileObservation(cwd, file);
    if (observation.hash) hashes[file] = observation.hash;
  }
  return hashes;
}

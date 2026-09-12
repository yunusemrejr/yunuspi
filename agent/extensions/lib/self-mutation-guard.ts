/** Launch-scoped harness maintenance authority. Never derive authority from tool cwd. */
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export function canonicalMutationPath(
  input: string,
  cwd = process.cwd(),
  followLeaf = true,
): string {
  // Resolve components before '..': path.resolve would erase a symlink/..
  // pair before the filesystem can interpret it. Follow dangling links too.
  const absolute = path.isAbsolute(input) ? input : cwd + path.sep + input;
  let current = path.parse(absolute).root,
    links = 0;
  const pending = absolute.slice(current.length).split(path.sep);
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") {
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = candidate;
      continue;
    }
    if (stat.isSymbolicLink()) {
      if (!followLeaf && pending.length === 0) {
        current = candidate;
        continue;
      }
      if (++links > 40) throw new Error("Too many symbolic links");
      const link = fs.readlinkSync(candidate);
      if (path.isAbsolute(link)) current = path.parse(link).root;
      pending.unshift(
        ...link
          .slice(path.isAbsolute(link) ? current.length : 0)
          .split(path.sep),
      );
    } else {
      if (pending.some(Boolean) && !stat.isDirectory())
        throw new Error("Non-directory path ancestor");
      current = candidate;
    }
  }
  return current;
}
export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
export const HARNESS_ROOT = canonicalMutationPath(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
);
const INITIAL_CWD = canonicalMutationPath(process.cwd());
export const SELF_MUTATION_ALLOWED =
  process.env.PI_HARNESS_MUTATION_DENIED !== "1" &&
  !process.env.PI_SUBAGENT_CHILD &&
  containsPath(HARNESS_ROOT, INITIAL_CWD);
// Children inherit denial even if they change cwd or import another copy of this module.
if (!SELF_MUTATION_ALLOWED) process.env.PI_HARNESS_MUTATION_DENIED = "1";
const maintenanceSkill = path.join(
  HARNESS_ROOT,
  "agent/skills/harness-self-maintenance/SKILL.md",
);
export const SELF_MUTATION_GUIDANCE = `Harness maintenance: inspect ${fs.existsSync(maintenanceSkill) ? JSON.stringify(maintenanceSkill) : "the harness-self-maintenance skill"} and current maintenance map before changes. Preserve credentials and runtime state; make focused reversible edits, run relevant checks, and export only reviewed non-sensitive files. Child agents have no independent maintenance authority.`;
export function selfMutationDenial(
  target: string,
  cwd: string,
  followLeaf = true,
): string | undefined {
  if (SELF_MUTATION_ALLOWED) return;
  try {
    const resolved = canonicalMutationPath(
      target.replace(/^@/, "").replace(/^~(?=\/|$)/, homedir()),
      cwd,
      followLeaf,
    );
    if (
      containsPath(HARNESS_ROOT, resolved) ||
      containsPath(resolved, HARNESS_ROOT)
    )
      return "Blocked: this session was launched outside the harness maintenance directory. Harness writes require a new human-started session inside the harness root; launching from home or a parent directory, changing cwd, or using a subagent does not grant authority.";
    const stat =
      followLeaf && fs.existsSync(resolved) ? fs.statSync(resolved) : undefined;
    if (stat?.isFile() && stat.nlink > 1 && hasHarnessInode(stat))
      return "Blocked: this file is a hard-link alias of a protected harness file. Use an independent project copy.";
  } catch {
    return "Blocked: unable to safely resolve mutation target.";
  }
}
function hasHarnessInode(target: fs.Stats): boolean {
  const dirs = [HARNESS_ROOT];
  while (dirs.length) {
    const dir = dirs.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(file);
      else if (entry.isFile()) {
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (stat.dev === target.dev && stat.ino === target.ino) return true;
      }
    }
  }
  return false;
}
/** Every untrusted executable must use this wrapper, not merely commands mentioning .pi. */
export function guardedCommand(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (SELF_MUTATION_ALLOWED) return { command, args: [...args] };
  if (process.platform !== "linux")
    throw new Error(
      "Harness write isolation requires Linux bubblewrap. Use the documented WSL2/Linux VM runtime. No unisolated command was started.",
    );
  return {
    command: "/usr/bin/python3",
    args: [
      "-I",
      path.join(HARNESS_ROOT, "agent/scripts/harness-readonly-exec.py"),
      HARNESS_ROOT,
      "--",
      command,
      ...args,
    ],
  };
}

import { guardedCommand } from "../../../../lib/self-mutation-guard.ts";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

/** Repository selection belongs to cwd, never an inherited session's Git env. */
export function managedGitEnv(indexFile?: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
  };
}
// Native bookkeeping must not execute repository hooks or fsmonitor programs.
// File conversion filters still follow project semantics during patch capture.
export const MANAGED_GIT_ARGS = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "color.ui=false",
];
export function runManagedGit(cwd: string, args: string[], indexFile?: string) {
  const commandArgs = [
    ...MANAGED_GIT_ARGS,
    "-C",
    cwd,
    ...(["diff", "show"].includes(args[0])
      ? [args[0], "--no-ext-diff", "--no-textconv", ...args.slice(1)]
      : args),
  ];
  // Git clean/smudge filters are executable project code. Keep conversion
  // semantics, but inherit the same harness write boundary as shell tools.
  const command = ["add", "worktree", "checkout", "read-tree"].includes(args[0])
    ? guardedCommand("git", commandArgs)
    : { command: "git", args: commandArgs };
  const result = spawnSync(command.command, command.args, {
    env: managedGitEnv(indexFile),
    encoding: "utf-8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || "",
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
  };
}
export interface ManagedRepositoryIdentity {
  workTree: string;
  gitDir: string;
  commonDir: string;
  branch: string | null;
}
export function managedRepositoryIdentity(
  cwd: string,
): ManagedRepositoryIdentity {
  const get = (args: string[]) => {
    const result = runManagedGit(cwd, args);
    if (result.status !== 0)
      throw new Error("Unable to establish managed Git repository identity");
    return result.stdout.trim();
  };
  if (get(["rev-parse", "--is-inside-work-tree"]) !== "true")
    throw new Error("Git working tree required");
  const canonical = (s: string) => realpathSync(path.resolve(cwd, s));
  const branch = runManagedGit(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
  return {
    workTree: canonical(get(["rev-parse", "--show-toplevel"])),
    gitDir: canonical(get(["rev-parse", "--absolute-git-dir"])),
    commonDir: canonical(get(["rev-parse", "--git-common-dir"])),
    branch: branch.status === 0 ? branch.stdout.trim() : null,
  };
}

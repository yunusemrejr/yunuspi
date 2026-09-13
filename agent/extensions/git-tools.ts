/**
 * git_info — read-only Git inspection with bounded, structured output.
 *
 * Replaces the highest-volume read-only bash git calls (status/diff/log/show/
 * branch) with one tool that cannot page, cannot prompt and cannot mutate.
 * Mutating git commands (commit, push, checkout, rebase, …) are deliberately
 * NOT implemented here and remain with bash and the git-github skill.
 *
 * Safety: subcommands are built from a fixed allowlist with execFile (no
 * shell), paths/revisions are validated, and output is capped.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { managedGitEnv, MANAGED_GIT_ARGS, managedRepositoryIdentity } from "./pi-subagents/src/runs/shared/git-command.ts";

const execFileP = promisify(execFile);
const MAX_OUTPUT = 32768;
const MAX_FILES = 100;

export type GitInfoParams = {
  action: string;
  path?: string;
  revision?: string;
  count?: number;
  staged?: boolean;
  patch?: boolean;
};

function validatePath(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value || value.length > 512)
    throw new Error("path must be a non-empty string up to 512 characters");
  if (value.startsWith("-") || /[\0\n\r]/.test(value))
    throw new Error(
      "path must not start with '-' or contain control characters",
    );
  return value;
}

function validateRevision(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,119}$/.test(value)
  )
    throw new Error("revision is not a valid git revision");
  return value;
}

export function boundText(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

function formatStatus(stdout: string): string {
  const lines = stdout.split("\n").filter(Boolean);
  const head = lines.find((line) => line.startsWith("## "));
  let branch = "(unknown)";
  let tracking = "";
  if (head) {
    const match = /^## (.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head);
    if (match) {
      branch = match[1];
      const upstream = match[2];
      const state = match[3];
      tracking = [upstream, state].filter(Boolean).join(" ");
    }
  }
  const changes = lines.filter((line) => !line.startsWith("## "));
  const shown = changes.slice(0, MAX_FILES);
  const body = changes.length
    ? [
        `changed: ${changes.length} file(s)`,
        ...shown,
        changes.length > shown.length
          ? `…[+${changes.length - shown.length} more]`
          : "",
      ]
    : ["working tree clean"];
  return [`branch: ${branch}${tracking ? ` (${tracking})` : ""}`, ...body]
    .filter(Boolean)
    .join("\n");
}

/** Run one read-only git action. Errors are short and path-safe. */
export async function runGitInfo(
  params: GitInfoParams,
  cwd: string,
): Promise<string> {
  const action = params.action;
  const filePath = validatePath(params.path);
  const revision = validateRevision(params.revision);
  const count = Math.min(Math.max(Math.floor(Number(params.count)) || 10, 1), 50);
  const base = [...MANAGED_GIT_ARGS, "--literal-pathspecs", "-c", "log.showSignature=false"];
  let args: string[];

  switch (action) {
    case "scope": {
      const identity = managedRepositoryIdentity(cwd);
      return JSON.stringify({ ...identity, scope: "project", managedBranch: identity.branch?.startsWith("refs/heads/pi-parallel-") ?? false,
        note: "Session history branches and checkpoints are not Git refs or file rollback. Managed worktrees share project objects/refs/config but own their worktree and index. Fusion output is a proposal until an explicit project integration. Harness releases use the sanitized public export; GitHub state requires a fresh remote query." }, null, 2);
    }
    case "status":
      args = [
        "status",
        "--porcelain=v1",
        "--branch",
        "--untracked-files=normal",
      ];
      if (filePath) args.push("--", filePath);
      break;
    case "diff": {
      const patch = params.patch !== false;
      args = [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--stat",
        ...(patch ? ["--patch", "--unified=2"] : []),
        ...(params.staged ? ["--cached"] : []),
      ];
      if (revision) args.push(revision);
      if (filePath) args.push("--", filePath);
      break;
    }
    case "log":
      args = [
        "log",
        "--no-color",
        "--oneline",
        "--no-decorate",
        "-n",
        String(count),
      ];
      if (filePath) args.push("--", filePath);
      break;
    case "show": {
      const patch = params.patch !== false;
      args = [
        "show",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--stat",
        "--oneline",
        ...(patch ? ["--patch", "--unified=2"] : []),
        "--end-of-options",
        revision || "HEAD",
        "--",
        ...(filePath ? [filePath] : []),
      ];
      break;
    }
    case "branch":
      args = ["branch", "--no-color", "--list", "-v"];
      break;
    default:
      throw new Error(
        `Unsupported git action: ${String(action)} (read-only: status, diff, log, show, branch, scope)`,
      );
  }

  let stdout: string;
  try {
    const result = await execFileP("git", [...base, ...args], {
      cwd,
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
      env: managedGitEnv(),
    });
    stdout = String(result.stdout ?? "");
  } catch (error: any) {
    if (error?.killed || error?.signal)
      throw new Error("git timed out after 10s");
    const stderr = String(error?.stderr ?? "").trim();
    if (/not a git repository/i.test(stderr))
      throw new Error("Not inside a Git repository");
    throw new Error(stderr ? stderr.slice(0, 300) : "git command failed");
  }

  if (action === "status") return boundText(formatStatus(stdout));
  return boundText(stdout.trim() || "(no output)");
}

export default function gitTools(pi: any) {
  pi.registerTool({
    name: "git_info",
    label: "Git Info",
    description:
      "Read-only Git inspection with bounded output: status, diff, log, show, branch or scope. scope identifies the project Git/worktree/index ownership and distinguishes session history, fusion and harness publishing. Use this INSTEAD of bash `git status`, `git diff`, `git log`, `git show` or `git branch`. Mutating git commands (commit, push, checkout, rebase) remain in bash. Output is capped at 32 KB; diff/show include a patch unless patch is false.",
    promptSnippet:
      "Inspect git status/diff/log/show/branch with bounded output",
    promptGuidelines: [
      "Use git_info instead of running `git status`, `git diff`, `git log`, `git show` or `git branch` through bash.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("scope"),
        Type.Literal("status"),
        Type.Literal("diff"),
        Type.Literal("log"),
        Type.Literal("show"),
        Type.Literal("branch"),
      ]),
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      revision: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      staged: Type.Optional(Type.Boolean()),
      patch: Type.Optional(Type.Boolean()),
    }),
    async execute(
      _id: any,
      params: GitInfoParams,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ) {
      const cwd =
        typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
      const text = await runGitInfo(params, cwd);
      return {
        content: [{ type: "text", text }],
        details: { action: params.action, cwd },
      };
    },
  });
}

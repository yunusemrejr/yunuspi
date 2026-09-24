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
  range?: string;
};

// ─── review: pre-commit evidence for the working tree or a revision range ───

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["API secret key", /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{24,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["credential assignment", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];
const LOCKS: Array<[RegExp, RegExp, string]> = [
  [/(?:^|\/)package\.json$/, /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/, "package.json dependencies"],
  [/(?:^|\/)(?:pyproject\.toml|requirements[\w.-]*\.txt|Pipfile)$/, /(?:^|\/)(?:poetry\.lock|uv\.lock|Pipfile\.lock|pdm\.lock|requirements[\w.-]*\.lock)$/, "Python dependencies"],
  [/(?:^|\/)Cargo\.toml$/, /(?:^|\/)Cargo\.lock$/, "Cargo dependencies"],
  [/(?:^|\/)go\.mod$/, /(?:^|\/)go\.sum$/, "Go modules"],
  [/(?:^|\/)Gemfile$/, /(?:^|\/)Gemfile\.lock$/, "Ruby gems"],
  [/(?:^|\/)composer\.json$/, /(?:^|\/)composer\.lock$/, "Composer dependencies"],
];
const kindOf = (file: string) =>
  /(?:^|\/)(?:tests?|__tests__|spec|e2e)\/|[._-](?:test|spec)\.[a-z]+$|_test\.(?:go|py)$|(?:^|\/)test_[^/]+\.py$/i.test(file) ? "test"
  : /\.(?:md|mdx|rst|txt|adoc)$|(?:^|\/)docs?\//i.test(file) ? "docs"
  : /(?:^|\/)\.github\/workflows\/|(?:^|\/)\.gitlab-ci\.yml$|(?:^|\/)(?:Jenkinsfile|\.circleci\/)/i.test(file) ? "ci"
  : LOCKS.some(([, lock]) => lock.test(file)) ? "lockfile"
  : /(?:^|\/)(?:dist|build|out|vendor|node_modules)\/|\.min\.[a-z]+$|\.generated\./i.test(file) ? "generated"
  : /\.(?:json|ya?ml|toml|ini|cfg|conf|env|properties)$|(?:^|\/)(?:Dockerfile|Makefile|\.[\w.-]+rc)$/i.test(file) ? "config"
  : "source";

async function git(args: string[], cwd: string, allowCodes: number[] = [0]): Promise<string> {
  try {
    const result = await execFileP("git", [...MANAGED_GIT_ARGS, "--literal-pathspecs", ...args], { cwd, timeout: 15000, maxBuffer: 16 * 1024 * 1024, env: managedGitEnv() });
    return String(result.stdout ?? "");
  } catch (error: any) {
    if (typeof error?.code === "number" && allowCodes.includes(error.code)) return String(error.stdout ?? "");
    if (error?.killed || error?.signal) throw new Error("git timed out after 15s");
    const stderr = String(error?.stderr ?? "").trim();
    if (/not a git repository/i.test(stderr)) throw new Error("Not inside a Git repository");
    throw new Error(stderr ? stderr.slice(0, 300) : "git command failed");
  }
}

/** Pre-commit review evidence: what changed, by kind, with risk flags from
 * the added lines and a draft conventional-commit header. Read-only. */
export async function reviewChanges(params: GitInfoParams, cwd: string): Promise<any> {
  const revision = validateRevision(params.revision), filePath = validatePath(params.path);
  const target = params.staged ? ["--cached"] : revision ? [revision] : ["HEAD"];
  const scope = filePath ? ["--", filePath] : [];
  const numstat = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--numstat", "-M", ...target, ...scope], cwd);
  const untracked = params.staged || revision ? [] : (await git(["ls-files", "--others", "--exclude-standard", ...scope], cwd)).split("\n").filter(Boolean);
  const files = numstat.split("\n").filter(Boolean).map(line => {
    const [added, deleted, ...rest] = line.split("\t");
    const file = rest.join("\t").replace(/^.*=> /, "").replace(/[{}]/g, "");
    return { file, added: added === "-" ? 0 : Number(added), deleted: deleted === "-" ? 0 : Number(deleted), binary: added === "-" };
  });
  for (const file of untracked) files.push({ file, added: 0, deleted: 0, binary: false, untracked: true } as any);
  const patch = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=0", ...target, ...scope], cwd);
  const risks: string[] = [], added = new Map<string, string[]>();
  let current = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) { current = line.slice(4).replace(/^b\//, ""); continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) { const list = added.get(current) ?? []; if (list.length < 5000) list.push(line.slice(1)); added.set(current, list); }
  }
  // Untracked text files are new code too: scan their first lines.
  for (const file of untracked.slice(0, 200)) {
    try {
      const { readFile, stat } = await import("node:fs/promises");
      const full = (await import("node:path")).join(cwd, file);
      if ((await stat(full)).size > 512 * 1024) { risks.push(`${file}: new file over 512 KB`); continue; }
      const text = await readFile(full, "utf8");
      if (!text.includes("\0")) {
        const lines = text.split("\n");
        added.set(file, lines.slice(0, 5000));
        const entry = files.find(f => f.file === file);
        if (entry) entry.added = lines.length - (text.endsWith("\n") ? 1 : 0);
      }
    } catch { /* unreadable files are reported by name only */ }
  }
  let todos = 0;
  for (const [file, lines] of added) {
    const kind = kindOf(file), code = kind === "source" || kind === "test";
    lines.forEach(text => {
      for (const [label, pattern] of SECRET_PATTERNS) if (pattern.test(text) && risks.length < 40) risks.push(`${file}: possible ${label} in an added line`);
      if (/\b(?:TODO|FIXME|XXX|HACK)\b/.test(text)) todos++;
      if (/^(?:<<<<<<<|=======|>>>>>>>)(?: |$)/.test(text)) risks.push(`${file}: merge conflict marker`);
      if (code && kind === "test" && /\b(?:it|describe|test|context)\.only\s*\(|\bfdescribe\s*\(|\bfit\s*\(/.test(text)) risks.push(`${file}: focused test (.only) would skip the rest of the suite`);
      if (code && kind !== "test" && /\bconsole\.(?:log|debug)\s*\(|^\s*debugger\s*;?\s*$|\bbreakpoint\(\)|\bpdb\.set_trace\(\)|\bdbg!\(/.test(text) && risks.length < 40) risks.push(`${file}: debug statement added`);
    });
  }
  for (const { file } of files) {
    if (/(?:^|\/)\.env(?:\.[\w-]+)?$/.test(file) && !/\.(?:example|sample|template)$/.test(file)) risks.push(`${file}: environment file in the change`);
    if (kindOf(file) === "generated") risks.push(`${file}: generated or vendored path changed; regenerate from source instead of editing`);
  }
  for (const entry of files) if (entry.binary) risks.push(`${entry.file}: binary change`);
  for (const [manifest, lock, label] of LOCKS) {
    const changedManifest = files.filter(f => manifest.test(f.file));
    for (const m of changedManifest) {
      const depLines = (added.get(m.file) ?? []).filter(text => /["']?[@\w./-]+["']?\s*[:=]\s*["']?[\^~<>=]*\d/.test(text));
      if (depLines.length && !files.some(f => lock.test(f.file))) risks.push(`${m.file}: ${label} changed without a lockfile update`);
    }
  }
  const whitespace = (await git(["diff", "--no-color", "--check", ...target, ...scope], cwd, [0, 2])).split("\n").filter(line => /^\S.*:\d+:/.test(line)).slice(0, 10);
  const byKind: Record<string, number> = {};
  for (const f of files) byKind[kindOf(f.file)] = (byKind[kindOf(f.file)] ?? 0) + 1;
  if ((byKind.source ?? 0) > 0 && !byKind.test) risks.push("source changed without test changes (fine for refactors; otherwise add or update tests)");
  const kinds = Object.keys(byKind);
  const type = kinds.every(k => k === "docs") ? "docs" : kinds.every(k => k === "test") ? "test" : kinds.every(k => k === "ci") ? "ci"
    : kinds.every(k => k === "lockfile" || k === "config") ? "build" : files.some((f: any) => f.untracked) || files.some(f => f.deleted === 0 && f.added > 20) ? "feat" : "fix or refactor";
  const dirs = new Map<string, number>();
  for (const f of files) { const parts = f.file.split("/"); const dir = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0] : ""; if (dir) dirs.set(dir, (dirs.get(dir) ?? 0) + f.added + f.deleted + 1); }
  const top = [...dirs].sort((a, b) => b[1] - a[1])[0]?.[0]?.split("/").pop();
  return {
    target: params.staged ? "staged" : revision ?? "working tree vs HEAD",
    files: files.length, untracked: untracked.length, added: files.reduce((n, f) => n + f.added, 0), deleted: files.reduce((n, f) => n + f.deleted, 0), byKind,
    largest: [...files].sort((a, b) => b.added + b.deleted - a.added - a.deleted).slice(0, 8).map(f => `${f.file} +${f.added} -${f.deleted}${(f as any).untracked ? " (new)" : ""}`),
    risks: [...new Set(risks)].slice(0, 30), whitespace, todosAdded: todos,
    commit: { draft: `${type.split(" ")[0]}${top ? `(${top})` : ""}: <what changed and why, imperative>`, candidates: type, note: "Draft only: write the subject from the actual intent; split unrelated changes into separate commits." },
    note: "Evidence from the diff, not a verdict. Secret patterns can be false positives; a clean review does not prove the change is correct or complete.",
  };
}

/** Line history for a range: which commits last touched which lines. */
export async function blameRange(params: GitInfoParams, cwd: string): Promise<any> {
  const filePath = validatePath(params.path);
  if (!filePath) throw new Error("blame needs path");
  const range = typeof params.range === "string" ? params.range : "";
  if (!/^\d{1,7},(?:\+)?\d{1,7}$/.test(range)) throw new Error('range must look like "40,80" or "40,+20"');
  const revision = validateRevision(params.revision);
  const out = await git(["blame", "--porcelain", "-L", range, ...(revision ? [revision] : []), "--", filePath], cwd);
  const commits = new Map<string, { author: string; date: string; summary: string; lines: number[] }>();
  let current: string | undefined;
  for (const line of out.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (header) { current = header[1]; const row = commits.get(current) ?? { author: "", date: "", summary: "", lines: [] }; row.lines.push(Number(header[2])); commits.set(current, row); continue; }
    if (!current) continue;
    const row = commits.get(current)!;
    if (line.startsWith("author ")) row.author = line.slice(7, 80);
    else if (line.startsWith("author-time ")) row.date = new Date(Number(line.slice(12)) * 1000).toISOString().slice(0, 10);
    else if (line.startsWith("summary ")) row.summary = line.slice(8, 160);
  }
  const spans = (lines: number[]) => { const sorted = [...lines].sort((a, b) => a - b), out: string[] = []; let start = sorted[0], prev = sorted[0]; for (const n of sorted.slice(1)) { if (n === prev + 1) { prev = n; continue; } out.push(start === prev ? `${start}` : `${start}-${prev}`); start = prev = n; } if (start !== undefined) out.push(start === prev ? `${start}` : `${start}-${prev}`); return out.join(","); };
  return { path: filePath, range, commits: [...commits].slice(0, 30).map(([sha, row]) => ({ commit: sha.slice(0, 12), date: row.date, author: row.author, summary: row.summary, lines: spans(row.lines) })) };
}

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
    case "review":
      return boundText(JSON.stringify(await reviewChanges(params, cwd), null, 1));
    case "blame":
      return boundText(JSON.stringify(await blameRange(params, cwd), null, 1));
    default:
      throw new Error(
        `Unsupported git action: ${String(action)} (read-only: status, diff, log, show, branch, scope, review, blame)`,
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
      "Read-only Git inspection with bounded output: status, diff, log, show, branch, scope, review or blame. review is pre-commit evidence for the working tree (or staged, or a revision): changes by kind, largest files, risk flags from added lines (possible secrets, conflict markers, focused tests, debug statements, .env and generated files, manifests changed without lockfiles, binaries, source without tests), whitespace errors and a draft conventional-commit header. blame summarizes which commits last touched a line range (range \"40,80\"). scope identifies the project Git/worktree/index ownership. Use this INSTEAD of bash `git status`, `git diff`, `git log`, `git show`, `git branch` or `git blame`. Mutating git commands (commit, push, checkout, rebase) remain in bash. Output is capped at 32 KB; diff/show include a patch unless patch is false.",
    promptSnippet:
      "Inspect git status/diff/log/show/branch with bounded output",
    promptGuidelines: [
      "Use git_info instead of running `git status`, `git diff`, `git log`, `git show` or `git branch` through bash.",
      "Before committing, run git_info review and resolve its risk flags (secrets, conflict markers, focused tests, debug statements, lockfile drift).",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("scope"),
        Type.Literal("status"),
        Type.Literal("diff"),
        Type.Literal("log"),
        Type.Literal("show"),
        Type.Literal("branch"),
        Type.Literal("review"),
        Type.Literal("blame"),
      ]),
      range: Type.Optional(Type.String({ maxLength: 32, description: 'blame line range, e.g. "40,80" or "40,+20"' })),
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

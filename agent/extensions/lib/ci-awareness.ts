/** Project CI awareness for session priming. Reads CI configuration and Git
 * metadata from files (no subprocess) and, for GitHub remotes, asks the public
 * Actions API once for the current commit's runs. Every failure degrades to an
 * explicit "not checked" statement; nothing here gates or blocks work. */
import fs from "node:fs/promises";
import path from "node:path";

const CI_FILES = [".gitlab-ci.yml", ".circleci/config.yml", "Jenkinsfile", "azure-pipelines.yml", "bitbucket-pipelines.yml"];
const read = (file: string, limit = 65536) => fs.readFile(file, "utf8").then(text => text.slice(0, limit), () => undefined);

async function gitDirs(cwd: string) {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 12; depth++) {
    const dotGit = path.join(dir, ".git");
    const stat = await fs.lstat(dotGit).catch(() => undefined);
    if (stat?.isDirectory()) return { root: dir, gitDir: dotGit, commonDir: dotGit };
    if (stat?.isFile()) {
      // Worktrees point at their own gitdir, which names the shared common dir.
      const gitDir = path.resolve(dir, (await read(dotGit, 4096))?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() ?? "");
      const common = (await read(path.join(gitDir, "commondir"), 4096))?.trim();
      return { root: dir, gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function headCommit(gitDir: string, commonDir: string) {
  const head = (await read(path.join(gitDir, "HEAD"), 4096))?.trim() ?? "";
  const ref = head.match(/^ref:\s*(refs\/heads\/(.+))$/);
  if (!ref) return { branch: undefined, sha: /^[0-9a-f]{40}$/.test(head) ? head : undefined };
  const loose = (await read(path.join(commonDir, ref[1]), 4096))?.trim();
  const packed = loose ? undefined : (await read(path.join(commonDir, "packed-refs"), 1 << 20))?.split("\n").find(line => line.endsWith(` ${ref[1]}`))?.split(" ")[0];
  const sha = loose ?? packed;
  return { branch: ref[2], sha: sha && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined };
}

export interface CiFactsOptions { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; timeoutMs?: number; now?: () => number }

/** Bounded CI facts (`text` for the model, `status` for the TUI), or
 * undefined when the project has no CI configuration. */
export async function ciFacts(cwd: string, options: CiFactsOptions = {}): Promise<{ text: string; status: string } | undefined> {
  const env = options.env ?? process.env;
  const git = await gitDirs(cwd).catch(() => undefined);
  const root = git?.root ?? path.resolve(cwd);
  const workflowDir = path.join(root, ".github", "workflows");
  const workflowFiles = (await fs.readdir(workflowDir).catch(() => [] as string[])).filter(name => /\.ya?ml$/i.test(name)).sort().slice(0, 12);
  const workflows: string[] = [];
  for (const file of workflowFiles) {
    const name = (await read(path.join(workflowDir, file), 8192))?.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1];
    workflows.push(name ? `"${name.slice(0, 60)}"` : file);
  }
  const others = [];
  for (const file of CI_FILES) if (await fs.lstat(path.join(root, file)).then(s => s.isFile(), () => false)) others.push(file);
  if (!workflows.length && !others.length) return undefined;
  const config = [workflows.length ? `GitHub Actions workflows ${workflows.join(", ")}` : "", others.length ? `CI config ${others.join(", ")}` : ""].filter(Boolean).join("; ");
  const advice = "After pushing, confirm the run for the pushed commit succeeded before reporting completion; a failing or missing run is unfinished work.";
  const status = await githubStatus(git, workflows.length > 0, env, options).catch(() => "remote CI status not checked");
  return { text: `Project CI: ${config}. ${status}. ${advice}`, status };
}

async function githubStatus(git: Awaited<ReturnType<typeof gitDirs>>, hasWorkflows: boolean, env: Record<string, string | undefined>, options: CiFactsOptions) {
  if (!git || !hasWorkflows) return "remote CI status not checked";
  if (["1", "true"].includes(env.PI_OFFLINE ?? "")) return "remote CI status not checked (offline)";
  const config = await read(path.join(git.commonDir, "config"), 65536) ?? "";
  const origin = config.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1] ?? "";
  const repo = origin.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!repo) return "remote CI status not checked (no GitHub origin)";
  const { branch, sha } = await headCommit(git.gitDir, git.commonDir);
  if (!sha) return "remote CI status not checked (HEAD unresolved)";
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2500);
  try {
    const response = await (options.fetchImpl ?? fetch)(`https://api.github.com/repos/${repo[1]}/${repo[2]}/actions/runs?head_sha=${sha}&per_page=10`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "yunuspi", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: controller.signal });
    if (!response.ok) return `remote CI status not checked (GitHub API ${response.status}${response.status === 404 && !token ? "; private repositories need GITHUB_TOKEN" : ""})`;
    const runs = ((await response.json()) as any)?.workflow_runs;
    if (!Array.isArray(runs)) return "remote CI status not checked (unexpected API response)";
    const short = sha.slice(0, 7), on = branch ? ` on ${branch}` : "";
    if (!runs.length) return `no GitHub Actions run recorded for HEAD ${short}${on} (unpushed, or CI did not trigger)`;
    const latest = new Map<string, any>();
    for (const run of runs) if (!latest.has(run.name)) latest.set(run.name, run);
    const rows = [...latest.values()].slice(0, 4).map(run => `"${String(run.name).slice(0, 60)}" ${run.status === "completed" ? run.conclusion ?? "completed" : run.status}`);
    return `GitHub Actions for HEAD ${short}${on}: ${rows.join(", ")}`;
  } finally {
    clearTimeout(timer);
  }
}

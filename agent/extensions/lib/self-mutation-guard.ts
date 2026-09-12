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

/** Global skill sources are captured from trusted harness configuration, never
 * from the tool cwd or project settings. Preserve both symlink entries and
 * referents, including absent destinations where an installer could add skills.
 */
export function discoverMutationRoots(harness: string, home: string): string[] {
  const agent = path.join(harness, "agent"),
    roots = new Set<string>();
  const skillTrees: string[] = [];
  const addPath = (input: string, base = agent): string => {
    const raw = input.replace(/^~(?=\/|$)/, home);
    const physical = canonicalMutationPath(raw, base);
    if (
      ["/", "/tmp", "/var/tmp", home].some((root) => physical === root) ||
      containsPath(physical, home)
    )
      throw new Error(
        "Global skill scope is too broad; configure explicit skill directories in a maintenance session",
      );
    roots.add(physical);
    // A parent symlink can redirect an entire skill tree. Its directory entry
    // must be protected as well as the files currently reached through it.
    for (
      let at = path.resolve(base, raw);
      at !== path.dirname(at);
      at = path.dirname(at)
    ) {
      try {
        if (fs.lstatSync(at).isSymbolicLink())
          roots.add(canonicalMutationPath(at, base, false));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return physical;
  };
  addPath(harness);
  for (const candidate of [
    path.join(agent, "skills"),
    path.join(home, ".agents/skills"),
    path.join(home, ".codex/skills"),
  ])
    skillTrees.push(addPath(candidate));
  const settings = path.join(agent, "settings.json");
  try {
    const stat = fs.statSync(settings);
    if (!stat.isFile() || stat.size > 1_048_576)
      throw new Error("Global skill settings cannot be safely read");
    addPath(settings);
    const config = JSON.parse(fs.readFileSync(settings, "utf8"));
    if (config.skills !== undefined && !Array.isArray(config.skills))
      throw new Error("Global skills must be an array of paths");
    if ((config.skills?.length ?? 0) > 256)
      throw new Error("Too many global skill paths; narrow the configuration");
    for (const entry of config.skills ?? []) {
      if (typeof entry !== "string" || !entry.trim() || /^[!-]/.test(entry))
        continue;
      const source = entry.replace(/^\+/, "");
      if (/[*?\[\]{}]/.test(source))
        throw new Error(
          "Use explicit global skill directories instead of glob patterns for write isolation",
        );
      skillTrees.push(addPath(source));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const visited = new Set<string>();
  let scanned = 0;
  while (skillTrees.length) {
    const current = skillTrees.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      // Match the loader's hidden-directory and dependency exclusions.
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (++scanned > 100_000 || roots.size > 512)
        throw new Error(
          "Global skill discovery exceeded its bound; narrow the configured roots",
        );
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) skillTrees.push(addPath(candidate));
      else if (entry.isDirectory()) skillTrees.push(candidate);
    }
  }
  const all = [...roots];
  return all
    .filter(
      (root) =>
        !all.some((parent) => parent !== root && containsPath(parent, root)),
    )
    .sort();
}

let rootDiscoveryFailed = false;
export const PROTECTED_MUTATION_ROOTS: readonly string[] = Object.freeze(
  (() => {
    try {
      return discoverMutationRoots(HARNESS_ROOT, homedir());
    } catch {
      rootDiscoveryFailed = true;
      return [HARNESS_ROOT];
    }
  })(),
);
const discoveryFailure =
  "Unable to determine protected global skill paths. Use a harness maintenance session to check settings.json and skill-directory permissions; no unguarded mutation was allowed.";
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
  if (rootDiscoveryFailed) return "Blocked: " + discoveryFailure;
  try {
    const resolved = canonicalMutationPath(
      target.replace(/^@/, "").replace(/^~(?=\/|$)/, homedir()),
      cwd,
      followLeaf,
    );
    if (
      PROTECTED_MUTATION_ROOTS.some(
        (root) => containsPath(root, resolved) || containsPath(resolved, root),
      )
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
  const dirs = [...PROTECTED_MUTATION_ROOTS];
  while (dirs.length) {
    const dir = dirs.pop()!;
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isFile() && stat.dev === target.dev && stat.ino === target.ino)
        return true;
      if (!stat.isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
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
  if (rootDiscoveryFailed) throw new Error(discoveryFailure);
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
      ...PROTECTED_MUTATION_ROOTS.filter(
        (root) => root !== HARNESS_ROOT,
      ).flatMap((root) => ["--protect", root]),
      "--",
      command,
      ...args,
    ],
  };
}

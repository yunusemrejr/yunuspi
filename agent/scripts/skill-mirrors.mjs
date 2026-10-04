#!/usr/bin/env node
/** Skills under your own skill paths win over the shipped copies, silently and by design. A copy made
 * earlier therefore keeps shadowing every later improvement to the shipped skill: tool names that changed,
 * new guidance, fixed examples. This lists the skills whose copy under a path from settings.json `skills`
 * differs from the shipped one, and with --apply brings them in step: the original directories are copied
 * to <agent>/backups/skill-mirrors-<time>/ first, shipped files overwrite files of the same name, and
 * anything only you have (extra files, skills the harness does not ship) is left alone.
 *
 *   node scripts/skill-mirrors.mjs            report
 *   node scripts/skill-mirrors.mjs --apply    refresh the differing copies (backup first)
 *   node scripts/skill-mirrors.mjs --json     machine-readable report
 *   node scripts/skill-mirrors.mjs --agent-dir DIR   inspect another agent directory */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKIP = new Set(["node_modules", ".git"]);
const expand = (value, home) => value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
const isDirectory = (target) => { try { return fs.statSync(target).isDirectory(); } catch { return false; } };
const real = (target) => { try { return fs.realpathSync(target); } catch { return path.resolve(target); } };
const inside = (target, root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Directories listed in settings.json `skills` that exist as plain folders (patterns and exclusions are not skill roots). */
export function skillRoots(agentDir, home = os.homedir()) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")); } catch { return []; }
  const shipped = real(path.join(agentDir, "skills")), roots = [];
  for (const entry of Array.isArray(settings?.skills) ? settings.skills : []) {
    if (typeof entry !== "string" || /^[!+-]|[*?[\]{}]/.test(entry.trim())) continue;
    const dir = path.resolve(agentDir, expand(entry.trim(), home));
    if (isDirectory(dir) && !inside(real(dir), shipped) && !roots.includes(dir)) roots.push(dir);
  }
  return roots;
}

/** Skill directories (the ones holding a SKILL.md) below a root, as {name, dir}. The name is the frontmatter name, else the folder name. */
export function skillDirs(root, depth = 4) {
  const found = [];
  const visit = (dir, level) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (names.some((entry) => entry.name === "SKILL.md" && entry.isFile())) {
      let text = "";
      try { text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").slice(0, 4000); } catch { /* unreadable: use the folder name */ }
      const declared = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1].match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1];
      found.push({ name: declared ?? path.basename(dir), dir });
      return;
    }
    if (level >= depth) return;
    for (const entry of names) if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name)) visit(path.join(dir, entry.name), level + 1);
  };
  visit(root, 0);
  return found;
}

/** relative path -> bytes for every regular file below a skill directory. */
function filesOf(dir) {
  const out = new Map();
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.set(path.relative(dir, full), fs.readFileSync(full));
    }
  };
  visit(dir);
  return out;
}

/** How a copy differs from the shipped skill: files whose bytes differ or that the shipped skill has and the copy lacks, and files only the copy has. */
export function compareSkill(copyDir, shippedDir) {
  const copy = filesOf(copyDir), shipped = filesOf(shippedDir), changed = [], externalOnly = [];
  for (const [file, bytes] of shipped) if (!copy.has(file) || !copy.get(file).equals(bytes)) changed.push(file);
  for (const file of copy.keys()) if (!shipped.has(file)) externalOnly.push(file);
  return { changed: changed.sort(), externalOnly: externalOnly.sort() };
}

/** Skills under your own paths that win over a different shipped copy. */
export function findShadowed({ agentDir, home = os.homedir() }) {
  const shippedRoot = path.join(agentDir, "skills"), shipped = new Map();
  for (const skill of skillDirs(shippedRoot)) if (!shipped.has(skill.name)) shipped.set(skill.name, skill.dir);
  const seen = new Set(), found = [];
  for (const root of skillRoots(agentDir, home)) for (const skill of skillDirs(root)) {
    const shippedDir = shipped.get(skill.name);
    if (!shippedDir || seen.has(skill.name) || real(skill.dir) === real(shippedDir)) continue;
    seen.add(skill.name);
    const { changed, externalOnly } = compareSkill(skill.dir, shippedDir);
    if (changed.length) found.push({ name: skill.name, root, dir: skill.dir, shippedDir, changed, externalOnly });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Copy the originals aside, then lay the shipped files over the copies. Returns the backup folder and the names refreshed. */
export function refreshShadowed(entries, { agentDir, now = new Date() }) {
  if (!entries.length) return { backup: undefined, refreshed: [] };
  const backup = path.join(agentDir, "backups", `skill-mirrors-${now.toISOString().replace(/[:.]/g, "-")}`);
  const refreshed = [];
  for (const entry of entries) {
    const target = path.join(backup, path.basename(entry.root), path.relative(entry.root, entry.dir));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(entry.dir, target, { recursive: true, errorOnExist: true, force: false });
    const shipped = filesOf(entry.shippedDir);
    for (const [file, bytes] of shipped) {
      const out = path.join(entry.dir, file);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, bytes);
    }
    refreshed.push(entry.name);
  }
  return { backup, refreshed };
}

const describe = (entry) => `${entry.name}: ${entry.changed.length} file${entry.changed.length === 1 ? "" : "s"} differ (${entry.changed.slice(0, 3).join(", ")}${entry.changed.length > 3 ? ", …" : ""})${entry.externalOnly.length ? `; ${entry.externalOnly.length} extra file(s) only in your copy stay` : ""}`;

function main(argv) {
  const flag = (name) => argv.includes(name);
  const at = argv.indexOf("--agent-dir");
  const agentDir = path.resolve(at >= 0 && argv[at + 1] ? argv[at + 1] : process.env.PI_CODING_AGENT_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const entries = findShadowed({ agentDir });
  if (flag("--apply")) {
    const result = refreshShadowed(entries, { agentDir });
    if (flag("--json")) console.log(JSON.stringify(result, null, 2));
    else console.log(result.refreshed.length ? `Refreshed ${result.refreshed.length} skill(s) from the shipped copies; originals are in ${result.backup}\n${result.refreshed.join(", ")}` : "Nothing to refresh: no skill under your own paths differs from its shipped copy.");
    return;
  }
  if (flag("--json")) { console.log(JSON.stringify(entries.map(({ name, dir, shippedDir, changed, externalOnly }) => ({ name, dir, shippedDir, changed, externalOnly })), null, 2)); return; }
  if (!entries.length) { console.log("No skill under your own paths differs from its shipped copy."); return; }
  console.log(`${entries.length} skill(s) under your own skill paths win over a different shipped copy:\n${entries.map((entry) => `  ${describe(entry)}`).join("\n")}\nRun with --apply to refresh them (originals are backed up first).`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));

/** File organization engine: inventory a folder, plan moves or renames, apply them without
 * ever overwriting or deleting, verify that nothing was lost, and undo.
 *
 * The usual failure of an "organize my files" run is a shell loop: `mv *.jpg Images/` replaces
 * a same-named file silently, `rm` of a "duplicate" removes the only copy, a half-finished loop
 * leaves no record of what moved, and the answer is "done" without a count. This engine plans
 * first (a reviewable list), moves with a no-clobber link-then-unlink step, keeps a journal of
 * every move so `undo` can reverse it, and checks that the file count under the folder is
 * unchanged. Only regular files move. Directories are created, never moved or removed;
 * symlinks, hidden files, project folders and unfinished downloads are left alone. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export type Style = "keep" | "kebab" | "snake";
export type Rule = { ext?: string[]; glob?: string; nameContains?: string; regex?: string; olderThanDays?: number; largerThanMB?: number; to: string };
export type PlanOptions = {
  by: "type" | "extension" | "date" | "rules" | "tidy-names" | "moves"; rules?: Rule[]; moves?: Array<{ from: string; to: string }>; date?: "year" | "month"; style?: Style;
  recursive?: boolean; into?: string; duplicates?: "report" | "separate"; includeHidden?: boolean; allowProject?: boolean; maxFiles?: number;
};
export type Entry = { rel: string; name: string; ext: string; size: number; mtimeMs: number };
export type Move = { from: string; to: string; size: number; mtimeMs: number; why: string };
export type Done = { from: string; to: string; size: number; undone?: boolean };
export type Plan = {
  id: string; root: string; mode: PlanOptions["by"]; createdAt: number; options: PlanOptions; moves: Move[];
  fileCount: number; fileCountExact: boolean; status: "planned" | "applied" | "partial" | "undone" | "partly-undone";
  done: Done[]; skipped: Array<{ from: string; reason: string }>; createdDirs: string[]; appliedAt?: number; undoneAt?: number;
};

const GROUPS: Record<string, string> = {
  Documents: "pdf doc docx odt rtf txt md markdown tex pages epub mobi azw3 djvu wpd",
  Spreadsheets: "xls xlsx xlsm ods csv tsv numbers",
  Presentations: "ppt pptx pps ppsx odp key",
  Images: "jpg jpeg png gif webp svg heic heif bmp tif tiff ico raw cr2 nef arw dng psd ai xcf avif",
  Videos: "mp4 mov mkv avi webm m4v wmv flv mpg mpeg 3gp",
  Audio: "mp3 wav flac aac m4a ogg opus wma aiff mid midi",
  Archives: "zip tar gz tgz bz2 xz zst 7z rar iso dmg cab",
  Code: "js mjs cjs ts tsx jsx py rb go rs java kt c h cc cpp hpp cs php swift sh bash zsh ps1 lua pl r html htm css scss vue svelte",
  Data: "json jsonl ndjson xml yaml yml toml ini log sql db sqlite sqlite3 parquet feather ipynb",
  Installers: "exe msi deb rpm appimage apk pkg snap flatpak",
  Fonts: "ttf otf woff woff2 eot",
};
const CATEGORY = new Map<string, string>();
for (const [group, list] of Object.entries(GROUPS)) for (const ext of list.split(" ")) CATEGORY.set(ext, group);
export const categoryOf = (ext: string): string => CATEGORY.get(ext) ?? "Other";

const UNFINISHED = new Set(["crdownload", "part", "partial", "download", "tmp", "temp", "opdownload", "aria2"]);
const JUNK = /^(?:thumbs\.db|desktop\.ini|ehthumbs\.db)$/i;
const BUNDLE = /\.(?:app|photoslibrary|lrlibrary|xcodeproj|bundle|framework)$/i;
const MARKERS = new Set([".git", "package.json", "pyproject.toml", "setup.py", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "Makefile", "CMakeLists.txt", "composer.json", "Gemfile", "mix.exs", "deno.json", "tsconfig.json", "pubspec.yaml"]);
const SYSTEM_ROOTS = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/dev", "/proc", "/sys", "/run", "/snap", "/root", "/System", "/Library", "/Applications", "/private/etc"];
const MAX_WALK_ENTRIES = 100_000;

const within = (parent: string, child: string) => { const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel)); };
const posix = (value: string) => value.split(path.sep).join("/");
const extOf = (name: string) => path.extname(name).slice(1).toLowerCase();

export function projectMarker(dir: string): string | undefined {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return undefined; }
  return names.find(name => MARKERS.has(name)) ?? names.find(name => /\.(?:sln|csproj|xcodeproj)$/i.test(name));
}

/** Why this folder must not be reorganized, or undefined when it may be. */
export function unsafeRoot(root: string, home: string = os.homedir(), allowProject = false): string | undefined {
  const parts = root.split(path.sep).filter(Boolean);
  if (parts.length < 2) return "that is a top-level or system folder; choose a specific folder such as ~/Downloads";
  if (root === home) return "that is the home folder itself; choose a folder inside it (for example Downloads or Documents/Scans)";
  if (within(root, home)) return "that folder contains the home folder; choose a specific folder inside it";
  if (SYSTEM_ROOTS.some(system => within(system, root))) return "that is a system folder";
  if (within(home, root) && path.relative(home, root).split(path.sep)[0].startsWith(".")) return "that is a hidden configuration folder; it holds settings and credentials, not files to sort";
  if (parts.includes("node_modules")) return "that is inside node_modules";
  if (!allowProject) { const marker = projectMarker(root); if (marker) return `it looks like a project (${marker} found); moving files would break it. Pass allowProject:true only if you really mean to reorganize it`; }
  return undefined;
}

/** A relative folder below the root: no escapes, no empty or dotted segments, bounded. */
export function safeFolder(value: string, what = "folder"): string {
  const text = String(value ?? "").replace(/\\/g, "/").trim();
  if (!text) return "";
  if (text.startsWith("/") || /^[a-z]:/i.test(text)) throw new Error(`${what} must be relative to the folder being organized, not an absolute path`);
  const segments = text.split("/").filter(Boolean);
  if (segments.length > 6) throw new Error(`${what} is nested too deeply (6 levels at most)`);
  for (const segment of segments) {
    if (segment === "." || segment === ".." || /[\x00-\x1f<>:"|?*]/.test(segment) || segment.length > 120) throw new Error(`${what} has an invalid part: ${JSON.stringify(segment.slice(0, 40))}`);
  }
  return segments.map(segment => segment.replace(/[. ]+$/, "")).filter(Boolean).join("/");
}

export function tidyName(name: string, style: Style = "keep"): string {
  const ext = path.extname(name);
  let stem = name.slice(0, name.length - ext.length).normalize("NFC").replace(/[\x00-\x1f<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  if (style !== "keep") stem = stem.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, style === "kebab" ? "-" : "_").replace(/^[-_]+|[-_]+$/g, "");
  return `${(stem || "file").slice(0, 120)}${ext.toLowerCase()}`;
}

export type Walk = { files: Entry[]; folders: number; skipped: Record<string, number>; examples: Record<string, string[]>; truncated: boolean };
export async function walk(root: string, options: { recursive: boolean; includeHidden: boolean; maxFiles: number; maxDepth?: number; signal?: AbortSignal }): Promise<Walk> {
  const out: Walk = { files: [], folders: 0, skipped: {}, examples: {}, truncated: false };
  const skip = (reason: string, rel: string) => { out.skipped[reason] = (out.skipped[reason] ?? 0) + 1; const list = (out.examples[reason] ??= []); if (list.length < 3) list.push(rel); };
  const queue: Array<[string, string, number]> = [[root, "", 0]];
  let seen = 0;
  while (queue.length) {
    options.signal?.throwIfAborted();
    const [dir, relDir, depth] = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { skip("unreadable folder", relDir || "."); continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) { out.truncated = true; return out; }
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (!options.includeHidden && entry.name.startsWith(".")) { skip("hidden", rel); continue; }
      if (JUNK.test(entry.name)) { skip("system junk", rel); continue; }
      if (entry.isSymbolicLink()) { skip("symlink", rel); continue; }
      if (entry.isDirectory()) {
        out.folders++;
        if (!options.recursive || depth >= (options.maxDepth ?? 4)) continue;
        if (entry.name === "node_modules" || BUNDLE.test(entry.name)) { skip("application or dependency folder", rel); continue; }
        if (projectMarker(path.join(dir, entry.name))) { skip("project folder", rel); continue; }
        queue.push([path.join(dir, entry.name), rel, depth + 1]);
        continue;
      }
      if (!entry.isFile()) { skip("special file", rel); continue; }
      const ext = extOf(entry.name);
      if (UNFINISHED.has(ext) || entry.name.endsWith("~") || entry.name.startsWith("~$")) { skip("unfinished download or lock file", rel); continue; }
      let stat: fs.Stats;
      try { stat = await fsp.lstat(path.join(dir, entry.name)); } catch { skip("vanished", rel); continue; }
      if (out.files.length >= options.maxFiles) { out.truncated = true; return out; }
      out.files.push({ rel, name: entry.name, ext, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

/** Regular files anywhere below root, hidden included, bounded; the "nothing was lost" yardstick. */
export function countFiles(root: string): { count: number; exact: boolean } {
  let count = 0, seen = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) return { count, exact: false };
      if (entry.isFile()) count++; else if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
  return { count, exact: true };
}

/* ───────────── planning ───────────── */

const PLACEHOLDERS = ["year", "month", "day", "ext", "type"];
const pad = (n: number) => String(n).padStart(2, "0");
function expand(template: string, entry: Entry): string {
  const when = new Date(entry.mtimeMs);
  const values: Record<string, string> = { year: String(when.getFullYear()), month: pad(when.getMonth() + 1), day: pad(when.getDate()), ext: entry.ext || "no-extension", type: categoryOf(entry.ext) };
  return template.replace(/\{([a-z]+)\}/g, (whole, key: string) => { if (!(key in values)) throw new Error(`Unknown placeholder ${whole}; use ${PLACEHOLDERS.map(name => `{${name}}`).join(", ")}`); return values[key]; });
}
function globPattern(glob: string): RegExp {
  if (glob.length > 200) throw new Error("glob is too long");
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}
export function compileRules(rules: Rule[]): Array<(entry: Entry, now: number) => string | undefined> {
  if (!Array.isArray(rules) || !rules.length) throw new Error('by:"rules" needs a rules array: [{ext:["pdf"], to:"Documents/PDF"}, …]');
  if (rules.length > 60) throw new Error("At most 60 rules");
  return rules.map((rule, index) => {
    if (!rule || typeof rule.to !== "string") throw new Error(`rules[${index}] needs a "to" folder`);
    const probe = { rel: "x", name: "x", ext: "x", size: 0, mtimeMs: Date.now() };
    safeFolder(expand(rule.to, probe), `rules[${index}].to`);
    const exts = (Array.isArray(rule.ext) ? rule.ext : rule.ext ? [rule.ext] : []).map(ext => String(ext).replace(/^\./, "").toLowerCase());
    const glob = rule.glob ? globPattern(rule.glob) : undefined;
    let regex: RegExp | undefined;
    if (rule.regex) { if (rule.regex.length > 200) throw new Error(`rules[${index}].regex is too long`); try { regex = new RegExp(rule.regex, "i"); } catch { throw new Error(`rules[${index}].regex is not a valid regular expression`); } }
    const contains = rule.nameContains?.toLowerCase();
    if (!exts.length && !glob && !regex && !contains && rule.olderThanDays === undefined && rule.largerThanMB === undefined) throw new Error(`rules[${index}] has no condition (ext, glob, nameContains, regex, olderThanDays or largerThanMB); it would match every file`);
    return (entry: Entry, now: number) => {
      if (exts.length && !exts.includes(entry.ext)) return undefined;
      if (glob && !glob.test(entry.name)) return undefined;
      if (regex && !regex.test(entry.name)) return undefined;
      if (contains && !entry.name.toLowerCase().includes(contains)) return undefined;
      if (rule.olderThanDays !== undefined && now - entry.mtimeMs < rule.olderThanDays * 86_400_000) return undefined;
      if (rule.largerThanMB !== undefined && entry.size < rule.largerThanMB * 1_048_576) return undefined;
      return safeFolder(expand(rule.to, entry), `rules[${index}].to`);
    };
  });
}

async function sha256(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 22, signal })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
export type DuplicateGroups = { groups: Array<{ keep: string; copies: string[]; bytes: number }>; wastedBytes: number; incomplete: boolean };
/** Identical content (same size, same SHA-256). The oldest file of a group is the keeper. */
export async function findDuplicates(root: string, files: Entry[], signal?: AbortSignal): Promise<DuplicateGroups> {
  const bySize = new Map<number, Entry[]>();
  for (const file of files) if (file.size > 0) { const list = bySize.get(file.size) ?? []; list.push(file); bySize.set(file.size, list); }
  const result: DuplicateGroups = { groups: [], wastedBytes: 0, incomplete: false };
  let budget = 2 * 1024 ** 3; const deadline = Date.now() + 40_000;
  for (const [size, list] of [...bySize].filter(([, entries]) => entries.length > 1).sort((a, b) => a[0] - b[0])) {
    if (budget < size * list.length || Date.now() > deadline) { result.incomplete = true; continue; }
    budget -= size * list.length;
    const byHash = new Map<string, Entry[]>();
    for (const entry of list) { signal?.throwIfAborted(); try { const key = await sha256(path.join(root, entry.rel), signal); byHash.set(key, [...(byHash.get(key) ?? []), entry]); } catch { /* unreadable: not a duplicate candidate */ } }
    for (const same of byHash.values()) {
      if (same.length < 2) continue;
      same.sort((a, b) => a.mtimeMs - b.mtimeMs || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
      result.groups.push({ keep: same[0].rel, copies: same.slice(1).map(entry => entry.rel), bytes: size });
      result.wastedBytes += size * (same.length - 1);
    }
  }
  return result;
}

type Candidate = { entry: Entry; folder: string; name: string; why: string };
/** A caller-chosen list of moves (for example classified by reading the files). Each entry is validated against the folder first. */
function explicitMoves(root: string, moves: Array<{ from: string; to: string }>, into: string): Candidate[] {
  if (!Array.isArray(moves) || !moves.length) throw new Error('by:"moves" needs moves: [{from:"a.pdf", to:"Taxes/2024/"}, …] (a "to" ending in / keeps the file name)');
  if (moves.length > 3000) throw new Error("At most 3000 moves in one plan; split the list");
  const problems: string[] = [], seen = new Set<string>(), out: Candidate[] = [];
  const relative = (value: unknown): string | undefined => {
    let text = String(value ?? "").replace(/\\/g, "/").trim();
    if (path.isAbsolute(text)) { const rel = path.relative(root, text); if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined; text = rel.split(path.sep).join("/"); }
    text = text.replace(/^(?:\.\/)+/, "");
    return text && !text.split("/").some(part => part === ".." || part === "" || part === ".") ? text : undefined;
  };
  for (const [index, move] of moves.entries()) {
    const label = `moves[${index}]`;
    const from = relative(move?.from);
    if (!from) { problems.push(`${label}.from must be a file inside the folder`); continue; }
    if (seen.has(from)) { problems.push(`${label}: ${from} is listed twice`); continue; }
    seen.add(from);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(root, from));
      const parent = fs.realpathSync(path.dirname(path.join(root, from)));
      if (!within(root, parent)) { problems.push(`${label}: ${from} is reached through a link that leaves the folder`); continue; }
    } catch { problems.push(`${label}: ${from} does not exist`); continue; }
    if (!stat.isFile()) { problems.push(`${label}: ${from} is not a regular file (folders and links are never moved)`); continue; }
    const target = String(move?.to ?? "").replace(/\\/g, "/").trim();
    if (!target) { problems.push(`${label}.to is empty`); continue; }
    const base = path.posix.basename(from);
    const folderPart = target.endsWith("/") ? target : path.posix.dirname(target) === "." ? "" : path.posix.dirname(target);
    const name = target.endsWith("/") ? base : path.posix.basename(target);
    if (!name || /[\x00-\x1f<>:"|?*\\]/.test(name) || name === "." || name === ".." || name.length > 200) { problems.push(`${label}.to has an invalid file name`); continue; }
    let folder: string;
    try { folder = [into, safeFolder(folderPart, `${label}.to`)].filter(Boolean).join("/"); } catch (error: any) { problems.push(String(error.message)); continue; }
    const entry: Entry = { rel: from, name: base, ext: extOf(base), size: stat.size, mtimeMs: stat.mtimeMs };
    out.push({ entry, folder, name, why: "requested" });
  }
  if (problems.length) throw new Error(`The moves list has problems; nothing was planned:\n${problems.slice(0, 8).join("\n")}${problems.length > 8 ? `\n… and ${problems.length - 8} more` : ""}`);
  return out;
}

export type PlanResult = { plan?: Plan; summary: Record<string, any> };
export function journalDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_ORGANIZE_DIR?.trim() || path.join(env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent"), "organize");
}
const PLAN_ID = /^org-[a-z0-9]{6,24}$/;

export async function resolveRoot(input: string, options: { home?: string; allowProject?: boolean } = {}): Promise<string> {
  let stat: fs.Stats;
  try { stat = await fsp.stat(input); } catch { throw new Error(`${input} does not exist`); }
  if (!stat.isDirectory()) throw new Error(`${input} is a file; give the folder that contains the files to organize`);
  const root = await fsp.realpath(input);
  const reason = unsafeRoot(root, options.home, options.allowProject);
  if (reason) throw new Error(`Refusing to organize ${root}: ${reason}.`);
  return root;
}

export async function inventory(root: string, options: { recursive?: boolean; includeHidden?: boolean; maxFiles?: number; signal?: AbortSignal } = {}) {
  const scanned = await walk(root, { recursive: options.recursive === true, includeHidden: options.includeHidden === true, maxFiles: options.maxFiles ?? 3000, signal: options.signal });
  const types = new Map<string, { files: number; bytes: number }>(), extensions = new Map<string, number>();
  let bytes = 0, oldest = Infinity, newest = 0, messyNames = 0;
  for (const file of scanned.files) {
    const type = categoryOf(file.ext), row = types.get(type) ?? { files: 0, bytes: 0 };
    row.files++; row.bytes += file.size; types.set(type, row); bytes += file.size;
    extensions.set(file.ext || "(none)", (extensions.get(file.ext || "(none)") ?? 0) + 1);
    oldest = Math.min(oldest, file.mtimeMs); newest = Math.max(newest, file.mtimeMs);
    if (tidyName(file.name) !== file.name) messyNames++;
  }
  const duplicates = await findDuplicates(root, scanned.files, options.signal);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    files: scanned.files.length, folders: scanned.folders, bytes, truncated: scanned.truncated,
    types: [...types].sort((a, b) => b[1].files - a[1].files).map(([type, row]) => ({ type, ...row })),
    topExtensions: [...extensions].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ext, count]) => ({ ext, count })),
    largest: [...scanned.files].sort((a, b) => b.size - a.size).slice(0, 5).map(file => ({ file: file.rel, bytes: file.size })),
    ...(scanned.files.length ? { modified: { oldest: iso(oldest), newest: iso(newest) } } : {}),
    namesNeedingTidy: messyNames,
    duplicates: { groups: duplicates.groups.length, copies: duplicates.groups.reduce((sum, group) => sum + group.copies.length, 0), wastedBytes: duplicates.wastedBytes, incomplete: duplicates.incomplete, examples: duplicates.groups.slice(0, 3).map(group => ({ keep: group.keep, copies: group.copies.slice(0, 3) })) },
    skipped: scanned.skipped, skippedExamples: scanned.examples,
  };
}

export async function createPlan(root: string, options: PlanOptions, deps: { journalDir: string; signal?: AbortSignal; now?: number }): Promise<PlanResult> {
  const now = deps.now ?? Date.now();
  const into = safeFolder(options.into ?? "", "into");
  const style: Style = options.style ?? "keep";
  const rules = options.by === "rules" ? compileRules(options.rules ?? []) : [];
  const requested = options.by === "moves" ? explicitMoves(root, options.moves ?? [], into) : undefined;
  const scanned: Walk = requested ? { files: requested.map(item => item.entry), folders: 0, skipped: {}, examples: {}, truncated: false } : await walk(root, { recursive: options.recursive === true, includeHidden: options.includeHidden === true, maxFiles: options.maxFiles ?? 3000, signal: deps.signal });
  const duplicates = options.by !== "tidy-names" && options.by !== "moves" && options.duplicates ? await findDuplicates(root, scanned.files, deps.signal) : undefined;
  const duplicateOf = new Map<string, string>();
  if (options.duplicates === "separate" && duplicates) for (const group of duplicates.groups) for (const copy of group.copies) duplicateOf.set(copy, group.keep);

  const candidates: Candidate[] = [];
  let unchanged = 0, unmatched = 0;
  if (requested) for (const item of requested) { const rel = item.folder ? `${item.folder}/${item.name}` : item.name; if (rel === item.entry.rel) unchanged++; else candidates.push(item); }
  else for (const entry of scanned.files) {
    deps.signal?.throwIfAborted();
    const dirOf = path.posix.dirname(entry.rel) === "." ? "" : path.posix.dirname(entry.rel);
    if (options.by === "tidy-names") {
      const name = tidyName(entry.name, style);
      if (name === entry.name) unchanged++; else candidates.push({ entry, folder: dirOf, name, why: "tidy name" });
      continue;
    }
    let folder: string | undefined;
    if (duplicateOf.has(entry.rel)) folder = "Duplicates";
    else if (options.by === "type") folder = categoryOf(entry.ext);
    else if (options.by === "extension") folder = entry.ext ? entry.ext.toUpperCase() : "No extension";
    else if (options.by === "date") folder = options.date === "year" ? String(new Date(entry.mtimeMs).getFullYear()) : `${new Date(entry.mtimeMs).getFullYear()}-${pad(new Date(entry.mtimeMs).getMonth() + 1)}`;
    else for (const rule of rules) { folder = rule(entry, now); if (folder !== undefined) break; }
    if (folder === undefined) { unmatched++; continue; }
    const target = [into, folder].filter(Boolean).join("/");
    if (dirOf === target || (options.recursive && (entry.rel.startsWith(`${target}/`)))) { unchanged++; continue; }
    candidates.push({ entry, folder: target, name: entry.name, why: duplicateOf.has(entry.rel) ? `identical to ${duplicateOf.get(entry.rel)}` : options.by });
  }

  const taken = new Set<string>(), moves: Move[] = [];
  let renamedForCollision = 0;
  for (const candidate of candidates.sort((a, b) => a.entry.rel.localeCompare(b.entry.rel))) {
    const ext = path.posix.extname(candidate.name), stem = candidate.name.slice(0, candidate.name.length - ext.length);
    let attempt = 1, destination = candidate.folder ? `${candidate.folder}/${candidate.name}` : candidate.name;
    const occupied = (rel: string) => taken.has(rel.toLowerCase()) || (rel !== candidate.entry.rel && fs.existsSync(path.join(root, rel)));
    while (occupied(destination)) { attempt++; const name = `${stem} (${attempt})${ext}`; destination = candidate.folder ? `${candidate.folder}/${name}` : name; }
    if (attempt > 1) renamedForCollision++;
    taken.add(destination.toLowerCase());
    moves.push({ from: candidate.entry.rel, to: destination, size: candidate.entry.size, mtimeMs: candidate.entry.mtimeMs, why: candidate.why });
  }

  const folders = new Map<string, { count: number; examples: string[] }>();
  for (const move of moves) {
    const folder = path.posix.dirname(move.to) === "." ? "(top level)" : path.posix.dirname(move.to), row = folders.get(folder) ?? { count: 0, examples: [] };
    row.count++; if (row.examples.length < 3) row.examples.push(path.posix.basename(move.to)); folders.set(folder, row);
  }
  const summary: Record<string, any> = {
    root, mode: options.by, scanned: scanned.files.length, toMove: moves.length, alreadyInPlace: unchanged,
    ...(unmatched ? { noRuleMatched: unmatched } : {}), skipped: scanned.skipped, ...(scanned.truncated ? { truncated: `Only the first ${options.maxFiles ?? 3000} files were considered; raise maxFiles (up to 10000) or organize subfolders separately.` } : {}),
    ...(renamedForCollision ? { renamedToAvoidOverwrite: renamedForCollision } : {}),
    ...(options.by === "tidy-names" ? { renames: moves.slice(0, 12).map(move => ({ from: move.from, to: move.to })) } : { folders: [...folders].sort((a, b) => b[1].count - a[1].count).slice(0, 14).map(([folder, row]) => ({ folder, files: row.count, examples: row.examples })) }),
    ...(duplicates ? { duplicates: { groups: duplicates.groups.length, copies: duplicates.groups.reduce((sum, group) => sum + group.copies.length, 0), wastedBytes: duplicates.wastedBytes, incomplete: duplicates.incomplete, handling: options.duplicates === "separate" ? "later copies move to Duplicates/ (nothing is deleted)" : "reported only; pass duplicates:\"separate\" to gather them in Duplicates/" } } : {}),
  };
  if (!moves.length) return { summary: { ...summary, note: "Nothing to move: every file the rules cover is already where it belongs." } };
  const counted = countFiles(root);
  const plan: Plan = { id: `org-${now.toString(36)}${randomBytes(3).toString("hex")}`, root, mode: options.by, createdAt: now, options, moves, fileCount: counted.count, fileCountExact: counted.exact, status: "planned", done: [], skipped: [], createdDirs: [] };
  savePlan(plan, deps.journalDir);
  summary.planId = plan.id;
  return { plan, summary };
}

/* ───────────── journal ───────────── */

export function savePlan(plan: Plan, journalDir: string): void {
  fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  const file = path.join(journalDir, `${plan.id}.json`), temporary = `${file}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(plan), { mode: 0o600 });
  fs.renameSync(temporary, file);
  const cutoff = Date.now() - 90 * 86_400_000;
  try { for (const name of fs.readdirSync(journalDir)) { if (!name.endsWith(".json") || name === `${plan.id}.json`) continue; const old = path.join(journalDir, name); if (fs.statSync(old).mtimeMs < cutoff) fs.rmSync(old, { force: true }); } } catch { /* pruning is best effort */ }
}
export function loadPlan(id: string, journalDir: string): Plan {
  if (!PLAN_ID.test(id)) throw new Error(`${JSON.stringify(String(id).slice(0, 40))} is not a plan id (they look like org-xxxxxxxx); call action:"plans" to list them`);
  let raw: string;
  try { raw = fs.readFileSync(path.join(journalDir, `${id}.json`), "utf8"); } catch { throw new Error(`No plan ${id}. Plans are kept for 90 days; call action:"plans" to list them, or plan again.`); }
  const plan = JSON.parse(raw) as Plan;
  if (!plan || plan.id !== id || !Array.isArray(plan.moves) || typeof plan.root !== "string") throw new Error(`Plan ${id} is damaged; plan again`);
  return plan;
}
export function listPlans(journalDir: string, limit = 8) {
  let names: string[] = [];
  try { names = fs.readdirSync(journalDir).filter(name => /^org-.*\.json$/.test(name)); } catch { return []; }
  return names.map(name => { try { const plan = JSON.parse(fs.readFileSync(path.join(journalDir, name), "utf8")) as Plan; return { planId: plan.id, root: plan.root, mode: plan.mode, status: plan.status, moves: plan.moves.length, moved: plan.done.filter(done => !done.undone).length, created: new Date(plan.createdAt).toISOString() }; } catch { return undefined; } })
    .filter(Boolean).sort((a: any, b: any) => b.created.localeCompare(a.created)).slice(0, limit) as any[];
}

/* ───────────── applying ───────────── */

const kept = (stat: fs.Stats, size: number, mtimeMs?: number) => stat.isFile() && stat.size === size && (mtimeMs === undefined || Math.abs(stat.mtimeMs - mtimeMs) < 2);
const exists = (file: string) => { try { fs.lstatSync(file); return true; } catch { return false; } };
/** Move a file without ever replacing another: a hard link fails if the name is taken. Returns false when the name was taken. */
function moveNoClobber(source: string, destination: string): boolean {
  try {
    fs.linkSync(source, destination);
    try { fs.unlinkSync(source); } catch (error) { fs.rmSync(destination, { force: true }); throw error; }
    return true;
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS", "EACCES"].includes(error?.code) || !exists(source)) throw error;
  }
  if (exists(destination)) return false;
  try { fs.renameSync(source, destination); return true; } catch (error: any) {
    if (error?.code !== "EXDEV") throw error;
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    if (fs.statSync(destination).size !== fs.statSync(source).size) { fs.rmSync(destination, { force: true }); throw new Error("copy across devices came out a different size"); }
    fs.unlinkSync(source); return true;
  }
}
function freeName(root: string, rel: string): string {
  const ext = path.posix.extname(rel), stem = rel.slice(0, rel.length - ext.length).replace(/ \(\d+\)$/, "");
  for (let attempt = 2; attempt < 200; attempt++) { const candidate = `${stem} (${attempt})${ext}`; if (!exists(path.join(root, candidate))) return candidate; }
  throw new Error(`Could not find a free name for ${rel}`);
}
function ensureFolder(root: string, rel: string, created: string[]): void {
  let current = root;
  for (const part of rel.split("/").filter(Boolean)) {
    current = path.join(current, part);
    if (exists(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`${path.relative(root, current)} is a symbolic link; files are not moved through links`);
      if (!stat.isDirectory()) throw new Error(`${path.relative(root, current)} exists and is not a folder`);
      continue;
    }
    fs.mkdirSync(current); created.push(posix(path.relative(root, current)));
  }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

export async function applyPlan(plan: Plan, deps: { journalDir: string; signal?: AbortSignal; preflight?: (sources: string[], destinations: string[]) => Promise<void> }) {
  if (plan.status === "applied") throw new Error(`Plan ${plan.id} was already applied. Call verify, or undo to reverse it.`);
  if (plan.status === "undone" || plan.status === "partly-undone") throw new Error(`Plan ${plan.id} was undone; plan again to organize anew.`);
  if (Date.now() - plan.createdAt > 24 * 3_600_000) throw new Error(`Plan ${plan.id} is more than a day old and the folder may have changed; plan again.`);
  const root = fs.realpathSync(plan.root), reason = unsafeRoot(root, undefined, plan.options.allowProject === true);
  if (reason) throw new Error(`Refusing to organize ${root}: ${reason}.`);
  plan.skipped = [];
  const already = new Set(plan.done.map(done => done.from));
  const pending = plan.moves.filter(move => !already.has(move.from));
  await deps.preflight?.(pending.map(move => path.join(root, move.from)), pending.map(move => path.join(root, move.to)));
  let aborted = false;
  try {
    for (const [index, move] of pending.entries()) {
      if (deps.signal?.aborted) { aborted = true; break; }
      const source = path.join(root, move.from);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(source); } catch { plan.skipped.push({ from: move.from, reason: "no longer there" }); continue; }
      if (!kept(stat, move.size, move.mtimeMs)) { plan.skipped.push({ from: move.from, reason: "changed since the plan was made" }); continue; }
      let target = move.to;
      ensureFolder(root, path.posix.dirname(target) === "." ? "" : path.posix.dirname(target), plan.createdDirs);
      let moved = false;
      for (let attempt = 0; attempt < 50 && !moved; attempt++) {
        if (exists(path.join(root, target))) target = freeName(root, target);
        moved = moveNoClobber(source, path.join(root, target));
      }
      if (!moved) { plan.skipped.push({ from: move.from, reason: "destination name stayed taken" }); continue; }
      plan.done.push({ from: move.from, to: target, size: move.size });
      if (index % 100 === 99) { savePlan(plan, deps.journalDir); await tick(); }
    }
  } finally {
    plan.status = aborted || plan.done.length + plan.skipped.length < plan.moves.length ? "partial" : "applied";
    plan.appliedAt = Date.now();
    savePlan(plan, deps.journalDir);
  }
  return { moved: plan.done.length - already.size, skipped: plan.skipped, aborted };
}

export function verifyPlan(plan: Plan) {
  const root = fs.realpathSync(plan.root);
  const active = plan.done.filter(done => !done.undone);
  const missing: string[] = [], leftover: string[] = [];
  for (const done of active) {
    try { if (!kept(fs.lstatSync(path.join(root, done.to)), done.size)) missing.push(`${done.to} (size changed)`); } catch { missing.push(done.to); }
    if (exists(path.join(root, done.from)) && done.from !== done.to) leftover.push(done.from);
  }
  const now = countFiles(root);
  const balanced = !plan.fileCountExact || !now.exact ? undefined : now.count === plan.fileCount;
  const empty: string[] = [];
  const stack = [root];
  while (stack.length && empty.length < 10) {
    const dir = stack.pop()!;
    let names: fs.Dirent[]; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    if (!names.length && dir !== root) empty.push(posix(path.relative(root, dir)));
    for (const entry of names) if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
  }
  return {
    planId: plan.id, status: plan.status, moved: active.length, plannedMoves: plan.moves.length, skipped: plan.skipped.length,
    presentAtDestination: active.length - missing.length, missing: missing.slice(0, 10), stillAtOldPath: leftover.slice(0, 10),
    fileCountBefore: plan.fileCount, fileCountNow: now.count, ...(balanced === undefined ? {} : { fileCountUnchanged: balanced }),
    ...(empty.length ? { emptyFolders: empty } : {}),
    ...(balanced === false ? { note: "The file count differs from when the plan was made: files were added or removed by something else. Every file this plan moved is accounted for separately (missing, stillAtOldPath)." } : {}),
    ok: !missing.length && !leftover.length,
  };
}

export async function undoPlan(plan: Plan, deps: { journalDir: string; signal?: AbortSignal; preflight?: (sources: string[], destinations: string[]) => Promise<void> }) {
  if (plan.status === "planned") throw new Error(`Plan ${plan.id} was never applied; there is nothing to undo.`);
  const root = fs.realpathSync(plan.root);
  const active = plan.done.filter(done => !done.undone);
  await deps.preflight?.(active.map(done => path.join(root, done.to)), active.map(done => path.join(root, done.from)));
  const failed: Array<{ file: string; reason: string }> = [];
  let restored = 0;
  try {
    for (const done of [...active].reverse()) {
      if (deps.signal?.aborted) { failed.push({ file: done.to, reason: "undo was interrupted" }); break; }
      const current = path.join(root, done.to), original = path.join(root, done.from);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(current); } catch { failed.push({ file: done.to, reason: "not at the new location any more" }); continue; }
      if (!kept(stat, done.size)) { failed.push({ file: done.to, reason: "the file there is not the one that was moved" }); continue; }
      if (exists(original)) { failed.push({ file: done.to, reason: `the old location ${done.from} is occupied` }); continue; }
      try { ensureFolder(root, path.posix.dirname(done.from) === "." ? "" : path.posix.dirname(done.from), []); if (!moveNoClobber(current, original)) { failed.push({ file: done.to, reason: `the old location ${done.from} is occupied` }); continue; } } catch (error: any) { failed.push({ file: done.to, reason: String(error?.message ?? error).slice(0, 120) }); continue; }
      done.undone = true; restored++;
    }
    for (const folder of [...plan.createdDirs].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(path.join(root, folder)); } catch { /* not empty or already gone: leave it */ } }
  } finally {
    plan.status = plan.done.every(done => done.undone) ? "undone" : "partly-undone";
    plan.undoneAt = Date.now();
    savePlan(plan, deps.journalDir);
  }
  return { restored, failed };
}


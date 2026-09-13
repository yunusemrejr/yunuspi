/**
 * bulk_edit — scoped multi-file text replacement with preview → apply.
 *
 * Replaces the risky `sed -i` / `perl -pi` bash pattern (541 observed calls)
 * with a bounded, workspace-confined tool: binary and oversized files are
 * skipped, the file set is capped, and `apply` only runs with the token
 * returned by the immediately preceding `preview` (drift-safe).
 *
 * Failed commits roll back unchanged targets. Call workdir_snapshot first for
 * non-Git trees when a restore point is needed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Minimatch } from "minimatch";
import { Type } from "typebox";
import {
  checkMutationPolicies,
  canonicalMutationPath,
  containsPath,
  selfMutationDenial,
} from "./lib/self-mutation-guard.ts";
import {
  applyPattern,
  changedPreview,
  compilePattern,
  contentHash,
  planToken,
} from "./lib/bulk-edit.ts";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".cache",
]);
const MAX_SCAN = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MATCHED_FILES = 200;

type Entry = {
  path: string;
  absolute: string;
  matches: number;
  preview: string[];
  hash: string;
  updated: string;
  mode: number;
  identity: string;
};

function safePath(root: string, candidate: string): string {
  if (typeof candidate !== "string" || !candidate || candidate.length > 512)
    throw new Error("path must be a non-empty string up to 512 characters");
  if (candidate.startsWith("-") || /[\0\n\r]/.test(candidate))
    throw new Error(
      "path must not start with '-' or contain control characters",
    );
  const resolved = canonicalMutationPath(candidate, root);
  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(`path escapes the workspace: ${candidate.slice(0, 80)}`);
  return resolved;
}

async function collectFiles(
  root: string,
  glob: string,
  files: unknown,
): Promise<{ list: string[]; binary: number; large: number }> {
  let list: string[] = [];
  if (Array.isArray(files) && files.length) {
    if (files.length > 50) throw new Error("files accepts at most 50 entries");
    list = files.map((file) =>
      path.relative(root, safePath(root, String(file))),
    );
  } else {
    const matcher = new Minimatch(glob, { dot: false });
    const queue = [""];
    let scanned = 0;
    while (queue.length) {
      const rel = queue.shift() as string;
      const absolute = rel ? path.join(root, rel) : root;
      for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
        if (++scanned > MAX_SCAN)
          throw new Error(`scan exceeded ${MAX_SCAN} entries; narrow the glob`);
        const childRel = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) queue.push(childRel);
        } else if (entry.isFile() && matcher.match(childRel)) {
          list.push(childRel);
          if (list.length > MAX_MATCHED_FILES)
            throw new Error(
              `more than ${MAX_MATCHED_FILES} files match; narrow the glob or pass files`,
            );
        }
      }
    }
    list.sort();
  }
  list = [...new Set(list)];

  let binary = 0;
  let large = 0;
  const usable: string[] = [];
  for (const rel of list) {
    const absolute = safePath(root, rel);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    if (stat.size > MAX_FILE_BYTES) {
      large++;
      continue;
    }
    const handle = await fs.open(absolute, "r");
    try {
      const probe = Buffer.alloc(Math.min(stat.size, 8192));
      await handle.read(probe, 0, probe.length, 0);
      if (probe.includes(0)) {
        binary++;
        continue;
      }
    } finally {
      await handle.close();
    }
    usable.push(rel);
  }
  return { list: usable, binary, large };
}

async function buildPlan(
  root: string,
  params: any,
  options: { isRegex?: boolean; ignoreCase?: boolean },
) {
  const regex = compilePattern(String(params.pattern ?? ""), options);
  const glob =
    typeof params.glob === "string" && params.glob ? params.glob : "**/*";
  const { list, binary, large } = await collectFiles(root, glob, params.files);
  const entries: Entry[] = [];
  for (const rel of list) {
    const absolute = safePath(root, rel);
    const stat = await fs.stat(absolute);
    const content = await fs.readFile(absolute, "utf8");
    const { updated, matches } = applyPattern(
      content,
      regex,
      String(params.replacement ?? ""),
      !options.isRegex,
    );
    if (!matches) continue;
    entries.push({
      path: rel,
      absolute,
      matches,
      preview: changedPreview(content, updated),
      hash: contentHash(content),
      updated,
      mode: stat.mode & 0o777,
      identity: `${stat.dev}:${stat.ino}`,
    });
  }
  const maxFiles = Math.min(
    Math.max(Number(params.maxFiles) || 50, 1),
    MAX_MATCHED_FILES,
  );
  if (!entries.length)
    throw new Error("No matches found in the selected files");
  if (entries.length > maxFiles)
    throw new Error(
      `${entries.length} files would change, above maxFiles=${maxFiles}; narrow the scope or raise maxFiles`,
    );
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const token = planToken(
    entries.map((entry) => ({
      path: entry.path,
      hash: contentHash(
        JSON.stringify([entry.hash, entry.mode, entry.identity]),
      ),
      matches: entry.matches,
    })),
    String(params.pattern),
    String(params.replacement ?? ""),
    options,
  );
  return { entries, token, binary, large, scanned: list.length };
}

export default function bulkEdit(pi: any) {
  // An apply token proves an actual preview in this session, for this root.
  // A model-computed digest or another workspace's identical bytes is insufficient.
  const previews = new Map<
    string,
    { root: string; digest: string; expires: number }
  >();
  let applying = false;
  let generation = 0;
  const reset = () => {
    generation++;
    previews.clear();
  };
  pi.on?.("session_start", reset);
  pi.on?.("session_shutdown", reset);
  pi.registerTool({
    name: "bulk_edit",
    label: "Bulk Edit",
    description:
      "Multi-file text replacement with preview then apply. Use this INSTEAD of bash `sed -i` / `perl -pi`: workspace-confined, skips binary and >1 MB files, caps the file set, and apply requires the token returned by preview. Literal by default; set isRegex for regular expressions. Failed commits roll back unchanged targets; concurrent rollback conflicts preserve backups. Snapshot first for durable recovery on non-Git trees.",
    promptSnippet: "Preview and apply a multi-file literal/regex replacement",
    promptGuidelines: [
      "Use bulk_edit (preview, then apply with its token) instead of `sed -i` or `perl -pi` for multi-file replacements.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("preview"), Type.Literal("apply")]),
      pattern: Type.String({ minLength: 1, maxLength: 200 }),
      replacement: Type.String({ maxLength: 1000 }),
      glob: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      files: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
          maxItems: 50,
        }),
      ),
      isRegex: Type.Optional(Type.Boolean()),
      ignoreCase: Type.Optional(Type.Boolean()),
      token: Type.Optional(Type.String({ minLength: 8, maxLength: 128 })),
      maxFiles: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_MATCHED_FILES }),
      ),
    }),
    async execute(
      _id: any,
      params: any,
      signal: any,
      _onUpdate: any,
      ctx: any,
    ) {
      const epoch = generation;
      try {
        const cwd =
          typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
        const root = await fs.realpath(cwd);
        const options = {
          isRegex: !!params.isRegex,
          ignoreCase: !!params.ignoreCase,
        };
        const plan = await buildPlan(root, params, options);
        if (epoch !== generation || signal?.aborted)
          throw new Error(
            "Session changed or operation cancelled; preview again",
          );
        if (params.action === "preview") {
          const token = randomBytes(24).toString("hex");
          while (previews.size >= 8)
            previews.delete(previews.keys().next().value!);
          previews.set(token, {
            root,
            digest: plan.token,
            expires: Date.now() + 15 * 60_000,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action: "preview",
                  token,
                  totalMatches: plan.entries.reduce(
                    (sum, entry) => sum + entry.matches,
                    0,
                  ),
                  files: plan.entries.map((entry) => ({
                    path: entry.path,
                    matches: entry.matches,
                    preview: entry.preview,
                  })),
                  ...(plan.binary || plan.large
                    ? { skipped: { binary: plan.binary, large: plan.large } }
                    : {}),
                }),
              },
            ],
            details: { token, files: plan.entries.length },
          };
        }
        if (typeof params.token !== "string" || params.token.length < 8)
          throw new Error("apply requires the token returned by preview");
        const preview = previews.get(params.token);
        if (
          !preview ||
          preview.root !== root ||
          preview.digest !== plan.token ||
          preview.expires < Date.now()
        )
          throw new Error(
            "workspace changed since preview (token mismatch); run preview again",
          );
        if (signal?.aborted) throw new Error("Cancelled");
        if (applying)
          throw new Error(
            "Another bulk apply is running; preview again after it completes",
          );
        // Validate the entire batch before any writes, including native harness
        // authority. A home-rooted workspace must not confer maintenance access.
        const validate = async (entry: Entry) => {
          const actual = safePath(root, entry.path);
          if (actual !== entry.absolute || !containsPath(root, actual))
            throw new Error("Path changed since preview");
          const denial = selfMutationDenial(actual, root);
          if (denial) throw new Error(denial);
          const stat = await fs.lstat(actual);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            `${stat.dev}:${stat.ino}` !== entry.identity ||
            (stat.mode & 0o777) !== entry.mode ||
            contentHash(await fs.readFile(actual)) !== entry.hash
          )
            throw new Error(`Concurrent edit since preview: ${entry.path}`);
        };
        for (const entry of plan.entries) {
          await checkMutationPolicies(pi, ctx, entry.absolute);
          await validate(entry);
        }
        if (epoch !== generation || signal?.aborted)
          throw new Error(
            "Session changed or operation cancelled; preview again",
          );
        if (applying)
          throw new Error(
            "Another bulk apply is running; preview again after it completes",
          );
        applying = true;
        previews.delete(params.token);
        const written: string[] = [];
        // Stage the complete batch before committing any target. Backups remain
        // on disk until commit succeeds; rollback refuses to overwrite a peer.
        const staged: Array<{entry: Entry; temp: string; backup: string; identity: string; committed: boolean; retain: boolean}> = [];
        try {
          for (const entry of plan.entries) {
            if (signal?.aborted || epoch !== generation) throw new Error("Cancelled before commit");
            await validate(entry);
            const prefix = path.join(path.dirname(entry.absolute), `.${path.basename(entry.absolute)}.bulk-${randomBytes(8).toString("hex")}`);
            const item = {entry, temp: prefix + ".tmp", backup: prefix + ".bak", identity: "", committed: false, retain: false};
            staged.push(item);
            await fs.copyFile(entry.absolute, item.backup, 1 /* COPYFILE_EXCL */);
            if (contentHash(await fs.readFile(item.backup)) !== entry.hash) throw new Error(`Concurrent edit since preview: ${entry.path}`);
            await fs.writeFile(item.temp, entry.updated, {mode: entry.mode, flag: "wx"});
            await fs.chmod(item.temp, entry.mode);
            const stat = await fs.lstat(item.temp);
            item.identity = `${stat.dev}:${stat.ino}`;
          }
          for (const entry of plan.entries) await validate(entry);
          for (const item of staged) {
            if (signal?.aborted || epoch !== generation) throw new Error("Cancelled during commit");
            await validate(item.entry);
            await fs.rename(item.temp, item.entry.absolute);
            item.committed = true;
            written.push(item.entry.path);
          }
          try { pi.events?.emit("harness:mutation-committed", {ctx, paths: written}); } catch { /* files committed */ }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action: "apply",
                  files: written,
                  replacements: plan.entries.reduce(
                    (sum, entry) => sum + entry.matches,
                    0,
                  ),
                }),
              },
            ],
            details: { files: written.length },
          };
        } catch (error) {
          const recovery: string[] = [];
          for (const item of staged.slice().reverse()) {
            if (!item.committed) continue;
            try {
              const actual = safePath(root, item.entry.path);
              const stat = await fs.lstat(actual);
              if (actual !== item.entry.absolute || !stat.isFile() || stat.isSymbolicLink()
                || `${stat.dev}:${stat.ino}` !== item.identity
                || contentHash(await fs.readFile(actual)) !== contentHash(item.entry.updated))
                throw new Error("Concurrent edit prevents rollback");
              await fs.rename(item.backup, actual);
            } catch {
              item.retain = true;
              recovery.push(item.backup);
            }
          }
          throw new Error(`${error instanceof Error ? error.message : "Bulk commit failed"}; ${recovery.length
            ? `rollback incomplete; preserved original backups: ${JSON.stringify(recovery)}`
            : "all committed files rolled back"}`);
        } finally {
          for (const item of staged) {
            await fs.rm(item.temp, {force:true}).catch(() => {});
            if (!item.retain) await fs.rm(item.backup, {force:true}).catch(() => {});
          }
          applying = false;
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "bulk_edit failed",
            },
          ],
        };
      }
    },
  });
}

/** fs_organize: sort, rename and clean up a folder of files without losing any.
 *
 * One tool, a fixed order of work: scan (what is here), plan (a reviewable list of moves, nothing
 * touched), apply (moves with no overwrite and a journal), verify (every file present, file count
 * unchanged), undo (reverse a plan). Weaker models turn "organize my Downloads" into `mv` loops
 * that clobber same-named files, delete "duplicates" and report success without a count; this
 * makes the careful path the short one. Writes go through the harness mutation preflight, so
 * the session's writable-scope policy applies exactly as it does to write and edit. */
import path from "node:path";
import os from "node:os";
import { Type } from "typebox";
import { choices } from "./lib/tool-schema.ts";
import { checkMutationPolicies, canonicalMutationPath } from "./lib/self-mutation-guard.ts";
import { textPath } from "./lib/media-process.ts";
import { applyPlan, createPlan, inventory, journalDirectory, listPlans, loadPlan, resolveRoot, undoPlan, verifyPlan, type PlanOptions, type Rule } from "./lib/fs-organize.ts";

const BY: Record<string, string> = {
  type: "type", types: "type", category: "type", categories: "type", kind: "type", filetype: "type", "file type": "type",
  extension: "extension", ext: "extension", extensions: "extension",
  date: "date", year: "date", month: "date", time: "date", modified: "date",
  rules: "rules", rule: "rules", custom: "rules",
  moves: "moves", move: "moves", explicit: "moves", mapping: "moves", manual: "moves",
  "tidy-names": "tidy-names", tidy: "tidy-names", names: "tidy-names", name: "tidy-names", rename: "tidy-names", clean: "tidy-names", normalize: "tidy-names", "clean-names": "tidy-names",
};
const ACTIONS: Record<string, string> = { organize: "plan", organise: "plan", preview: "plan", dry_run: "plan", "dry-run": "plan", inventory: "scan", list: "plans", execute: "apply", run: "apply", rollback: "undo", revert: "undo", check: "verify" };
const alias = (table: Record<string, string>, key: string) => Object.hasOwn(table, key) ? table[key] : undefined;
const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], details: value });
const cap = <T>(items: T[], limit: number) => items.slice(0, limit);

export default function fsOrganize(pi: any) {
  const running = new Set<string>();
  const expandHome = (value: string) => value.replace(/^~(?=\/|$)/, os.homedir());

  /** Ask the harness whether this session may write in each folder the plan touches. One probe per folder. */
  const preflightFor = (ctx: any) => async (sources: string[], destinations: string[]) => {
    const firstPerFolder = new Map<string, string>();
    for (const file of [...sources, ...destinations]) { const folder = path.dirname(file); if (!firstPerFolder.has(folder)) firstPerFolder.set(folder, file); }
    for (const file of cap([...firstPerFolder.values()], 80)) await checkMutationPolicies(pi, ctx, file, "write");
  };

  pi.registerTool({
    name: "fs_organize",
    label: "Organize Files",
    description: "Sort, rename and clean up the files in a folder safely: nothing is overwritten or deleted, every move is journaled and reversible, and the result is verified. Work in this order. scan {path}: what is in the folder (types, sizes, duplicates, names needing cleanup, what will be left alone). plan {path, by}: a list of moves, nothing touched yet. by: \"type\" (Documents, Images, Videos, Audio, Archives, Code, Data, Installers, Fonts, Spreadsheets, Presentations, Other), \"extension\", \"date\" (date:\"year\"|\"month\"), \"tidy-names\" (style:\"keep\"|\"kebab\"|\"snake\": trims, removes illegal characters, lowercases extensions) or \"moves\" (moves:[{from:\"a.pdf\", to:\"Taxes/2024/\"}]: exactly the moves you decided, for example after reading the files; a to ending in / keeps the name) or \"rules\" (rules:[{ext:[\"pdf\"], nameContains:\"invoice\", glob:\"IMG_*\", regex, olderThanDays, largerThanMB, to:\"Finance/{year}\"}], first match wins; to may use {year} {month} {day} {ext} {type}). Options: recursive (include subfolders; flattens them), into (destination folder below path), duplicates:\"separate\" (identical copies go to Duplicates/, never deleted), includeHidden, maxFiles. apply {planId}: perform the plan; same-name clashes get \" (2)\". verify {planId}: every moved file present, file count unchanged. undo {planId}: put everything back. plans: list recent plans. Only regular files move; symlinks, hidden files, project folders, unfinished downloads, the home folder and system folders are left alone or refused. After apply, report the moved count and folders from the result.",
    promptSnippet: "Organize, sort and rename files in a folder safely (scan, plan, apply, verify, undo)",
    promptGuidelines: [
      "To organize, sort, rename or clean up files and folders, use fs_organize (scan, plan, apply, verify); a shell loop of mv or rm overwrites on name clashes and cannot be undone.",
      "Never delete files while organizing; duplicates go to a Duplicates folder for the user to decide.",
    ],
    parameters: Type.Object({
      action: choices(["scan", "plan", "apply", "verify", "undo", "plans"]),
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "scan, plan: the folder whose files to organize" })),
      planId: Type.Optional(Type.String({ maxLength: 64, description: "apply, verify, undo: the planId a plan returned" })),
      by: Type.Optional(Type.String({ maxLength: 20, description: "plan: type, extension, date, tidy-names, rules or moves" })),
      moves: Type.Optional(Type.Array(Type.Object({ from: Type.String({ minLength: 1, maxLength: 1024 }), to: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: true }), { maxItems: 3000, description: "plan by moves: exact moves, e.g. [{from:\"a.pdf\", to:\"Taxes/2024/\"}]; a to ending in / keeps the file name, otherwise it is the new path" })),
      rules: Type.Optional(Type.Array(Type.Object({
        ext: Type.Optional(Type.Array(Type.String({ maxLength: 20 }), { maxItems: 40 })), glob: Type.Optional(Type.String({ maxLength: 200 })), nameContains: Type.Optional(Type.String({ maxLength: 120 })),
        regex: Type.Optional(Type.String({ maxLength: 200 })), olderThanDays: Type.Optional(Type.Number({ minimum: 0, maximum: 36500 })), largerThanMB: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })),
        to: Type.String({ minLength: 1, maxLength: 400, description: "Destination folder below path; may use {year} {month} {day} {ext} {type}" }),
      }, { additionalProperties: true }), { maxItems: 60, description: "plan by rules: first matching rule wins; files no rule matches stay where they are" })),
      date: Type.Optional(choices(["year", "month"], "plan by date: folder per year or per year-month (default month)")),
      style: Type.Optional(choices(["keep", "kebab", "snake"], "plan by tidy-names: keep the words, or kebab-case or snake_case them")),
      recursive: Type.Optional(Type.Boolean({ description: "plan: include files in subfolders (they are moved out of them); default only the top level" })),
      into: Type.Optional(Type.String({ maxLength: 400, description: "plan: put the new folders below this subfolder of path" })),
      duplicates: Type.Optional(choices(["report", "separate"], "plan: report identical files, or also gather the extra copies in Duplicates/")),
      includeHidden: Type.Optional(Type.Boolean()),
      allowProject: Type.Optional(Type.Boolean({ description: "plan: allow a folder that looks like a software project; rarely right" })),
      maxFiles: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
    }),
    prepareArguments(input: any) {
      if (!input || typeof input !== "object") return input;
      const next: any = { ...input };
      if (typeof next.moves === "string") { try { next.moves = JSON.parse(next.moves); } catch { /* validation reports it */ } }
      if (next.moves && !Array.isArray(next.moves) && typeof next.moves === "object") next.moves = Object.entries(next.moves).map(([from, to]) => ({ from, to }));
      if (Array.isArray(next.moves)) next.moves = next.moves.map((move: any) => move && typeof move === "object" ? { ...move, from: move.from ?? move.source ?? move.src ?? move.file, to: move.to ?? move.destination ?? move.dest ?? move.target ?? move.folder } : move);
      if (typeof next.rules === "string") { try { next.rules = JSON.parse(next.rules); } catch { /* validation reports it */ } }
      if (next.rules && !Array.isArray(next.rules) && typeof next.rules === "object") next.rules = [next.rules];
      if (Array.isArray(next.rules)) next.rules = next.rules.map((rule: any) => rule && typeof rule === "object" ? { ...rule, ...(typeof rule.ext === "string" ? { ext: rule.ext.split(/[\s,]+/).filter(Boolean) } : {}), to: rule.to ?? rule.folder ?? rule.into ?? rule.destination } : rule);
      const raw = typeof next.by === "string" ? next.by.trim().toLowerCase() : undefined;
      if (raw !== undefined) { next.by = alias(BY, raw) ?? raw; if (raw === "year" || raw === "month") next.date ??= raw; }
      if (next.by === undefined && Array.isArray(next.rules)) next.by = "rules";
      if (next.by === undefined && Array.isArray(next.moves)) next.by = "moves";
      if (next.path === undefined) next.path = next.folder ?? next.directory ?? next.dir ?? next.root;
      if (next.planId === undefined) next.planId = next.plan_id ?? next.plan ?? next.id;
      if (typeof next.planId !== "string") delete next.planId;
      next.action ??= next.planId ? "verify" : next.by || next.rules || next.moves ? "plan" : next.path ? "scan" : "plans";
      if (typeof next.action === "string") { const action = next.action.trim().toLowerCase(); next.action = alias(ACTIONS, action) ?? action; }
      return next;
    },
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: unknown, ctx: any) {
      const cwd = ctx?.cwd || process.cwd(), deadline = AbortSignal.timeout(300_000), bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const journalDir = journalDirectory();
      const action = params.action;
      if (action === "plans") { const plans = listPlans(journalDir); return text({ plans, note: plans.length ? "Use planId with apply, verify or undo." : "No plans yet. Start with scan, then plan." }); }
      if (action === "scan" || action === "plan") {
        if (!params.path) throw new Error(`${action} needs path: the folder whose files to organize`);
        const root = await resolveRoot(canonicalMutationPath(textPath(expandHome(params.path)), cwd), { allowProject: params.allowProject === true });
        if (action === "scan") {
          const found = await inventory(root, { recursive: params.recursive, includeHidden: params.includeHidden, maxFiles: params.maxFiles, signal: bounded });
          return text({ root, ...found, next: found.files ? `Choose how to sort and call plan: by "type" suits mixed downloads, "date" suits photos and scans, "tidy-names" fixes messy names${found.duplicates.copies ? ", duplicates:\"separate\" gathers identical copies" : ""}.` : "No movable files found at this level; try recursive:true if the files sit in subfolders." });
        }
        if (!params.by) throw new Error('plan needs by: "type", "extension", "date", "tidy-names", "rules" or "moves"');
        if (!["type", "extension", "date", "tidy-names", "rules", "moves"].includes(params.by)) throw new Error(`by "${params.by}" is not one of type, extension, date, tidy-names, rules, moves`);
        const options: PlanOptions = { by: params.by as PlanOptions["by"], rules: params.rules as Rule[] | undefined, moves: params.moves, date: params.date, style: params.style, recursive: params.recursive, into: params.into, duplicates: params.duplicates, includeHidden: params.includeHidden, allowProject: params.allowProject, maxFiles: params.maxFiles };
        const { plan, summary } = await createPlan(root, options, { journalDir, signal: bounded });
        return text({ ...summary, next: plan ? `Nothing has moved. Review the folders above, then call apply with planId ${plan.id}${summary.noRuleMatched ? " (files no rule matched stay where they are)" : ""}.` : summary.note });
      }
      if (!params.planId) throw new Error(`${action} needs planId (call action:"plans" to list them)`);
      const plan = loadPlan(params.planId, journalDir);
      if (action === "verify") return text({ ...verifyPlan(plan), root: plan.root });
      if (running.has(plan.id)) throw new Error(`Plan ${plan.id} is already being ${action === "apply" ? "applied" : "undone"}`);
      running.add(plan.id);
      try {
        const preflight = preflightFor(ctx);
        if (action === "apply") {
          const result = await applyPlan(plan, { journalDir, signal: bounded, preflight });
          const verification = verifyPlan(plan);
          const moved = plan.done.filter(done => !done.undone).map(done => path.join(plan.root, done.to));
          try { pi.events?.emit?.("harness:mutation-committed", { ctx, paths: moved.slice(0, 500) }); } catch { /* files are committed */ }
          return text({ action: "apply", planId: plan.id, moved: result.moved, skipped: cap(result.skipped, 8), skippedTotal: result.skipped.length, aborted: result.aborted || undefined, verification: { ok: verification.ok, fileCountBefore: verification.fileCountBefore, fileCountNow: verification.fileCountNow, missing: verification.missing, ...(verification.emptyFolders ? { emptyFolders: verification.emptyFolders } : {}) },
            next: verification.ok ? `Done and verified. Tell the user how many files moved and into which folders; undo is available with planId ${plan.id}.${verification.emptyFolders ? " Empty folders were left behind; remove them only if the user wants that." : ""}` : `Verification found a problem (see missing or fileCountNow). Do not report success; call undo with planId ${plan.id} or inspect the listed files.` });
        }
        const result = await undoPlan(plan, { journalDir, signal: bounded, preflight });
        try { pi.events?.emit?.("harness:mutation-committed", { ctx, paths: plan.done.filter(done => done.undone).map(done => path.join(plan.root, done.from)).slice(0, 500) }); } catch { /* files are committed */ }
        return text({ action: "undo", planId: plan.id, restored: result.restored, notRestored: cap(result.failed, 10), notRestoredTotal: result.failed.length, status: plan.status });
      } finally { running.delete(plan.id); }
    },
  });
}

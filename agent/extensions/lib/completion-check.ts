/**
 * The goal completion check: every quality, integrity and delivery check is a step here.
 *
 * Evidence steps (tests, independent review, deliverables, rendered or media review, task requirements)
 * are receipts their owners publish; this module adds the static steps that used to be separate tools
 * (code audit, syntax) and renders the whole picture as one report. `goal({action:"check"})` shows it and
 * `goal({action:"complete"})` refuses while an unresolved step remains, once per distinct set of gaps; a
 * repeated call is a recorded waiver, so the user is never deadlocked.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { auditable, auditSource, type AuditFinding } from "./code-audit.ts";
import { changedFiles, codeQuality } from "./code-quality.ts";
import { checkSourceText, sourceCheckSupported } from "./source-check.ts";
import { readSourceFiles } from "../pi-lens/context-code.mjs";
import type { GateReceipt } from "./completion-gate.ts";

const STATIC_DEADLINE_MS = 10_000;
const MAX_STATIC_FILES = 64;
const MAX_SYNTAX_FILES = 20;
const MAX_LISTED = 5;

const DATA_FORMAT = /\.(?:json|ya?ml|toml)$/i;

const hasGitBaseline = (cwd: string, signal: AbortSignal) =>
	promisify(execFile)("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd, signal, timeout: 5_000 }).then(() => true, () => false);

/** Config and data files only count when Git already tracks them: a modified `package.json` that stopped parsing is a
 * regression, while a new untracked `.json` is arbitrary output (logs, exports) whose format is not ours to judge. */
async function parseCheckable(cwd: string, files: string[], signal: AbortSignal): Promise<string[]> {
	const data = files.filter((file) => DATA_FORMAT.test(file));
	if (!data.length) return files;
	const tracked = await promisify(execFile)("git", ["ls-files", "-z", "--", ...data], { cwd, signal, timeout: 5_000 }).then((r) => new Set(r.stdout.split("\0")));
	return files.filter((file) => !DATA_FORMAT.test(file) || tracked.has(file));
}

/** A session-owned check of current bytes. check followed by complete re-reads the change set but reuses audit and
 * parse results for identical files. External/same-stat edits invalidate by content, not a task counter or mtime.
 * Parsing uses the same safe parser as sourceCheck without its unrelated post-edit style/noise analysis. */
export function createStaticCompletionCheck(check = checkSourceText) {
	const cache = new Map<string, { digest: string; audit: AuditFinding[]; syntax?: Awaited<ReturnType<typeof checkSourceText>> }>();
	return async (cwd: string, signal?: AbortSignal): Promise<GateReceipt[]> => {
		signal?.throwIfAborted();
		const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(STATIC_DEADLINE_MS)]) : AbortSignal.timeout(STATIC_DEADLINE_MS);
		const receipts: GateReceipt[] = [];
		try {
			if (!await hasGitBaseline(cwd, bounded)) { bounded.throwIfAborted(); return receipts; }
			const root = await realpath(cwd);
			const files = await parseCheckable(cwd, (await changedFiles(cwd, "HEAD", bounded)).filter(file => auditable(file) || sourceCheckSupported(file)), bounded);
			const syntaxFiles = new Set(files.filter(sourceCheckSupported).slice(0, MAX_SYNTAX_FILES));
			const high: Array<AuditFinding & { file: string }> = [];
			const failed: string[] = [], unknown: string[] = [];
			const observed: string[] = [];
			let bytes = 0;
			for (let offset = 0; offset < Math.min(files.length, MAX_STATIC_FILES); offset += 20) {
				const snapshots = await readSourceFiles(root, files.slice(offset, Math.min(offset + 20, MAX_STATIC_FILES)), bounded,
					file => auditable(file) || sourceCheckSupported(file), { fileBytes: 512 * 1024, totalBytes: Math.max(1, 12 * 1024 * 1024 - bytes) });
				bytes += snapshots.bytes;
				unknown.push(...snapshots.errors.map((error: { path: string }) => error.path));
				for (const file of snapshots.files) {
					bounded.throwIfAborted();
					observed.push(`${file.path}:${file.digest}`);
					const key = path.join(root, file.path);
					let entry = cache.get(key);
					if (entry?.digest !== file.digest) entry = { digest: file.digest, audit: auditable(file.path) ? auditSource(file.path, file.source, { minSeverity: "high" }) : [] };
					if (syntaxFiles.has(file.path)) {
						const syntax = entry.syntax ?? await check(file.path, file.source, root, bounded);
						if (syntax.status === "passed" || syntax.status === "failed") entry.syntax = syntax;
						if (syntax.status === "failed") failed.push(file.path);
						else if (syntax.status !== "passed") unknown.push(file.path);
					}
					cache.delete(key); cache.set(key, entry);
					while (cache.size > MAX_STATIC_FILES) cache.delete(cache.keys().next().value!);
					high.push(...entry.audit.map(finding => ({ ...finding, file: file.path })));
				}
			}
			const revision = createHash("sha256").update(JSON.stringify({ root, files, observed, unknown })).digest("hex").slice(0, 24);
			if (high.length) {
				receipts.push({
					source: "static-audit", id: "high-severity", revision, state: "unresolved", count: high.length,
					line: `static audit: ${high.length} high-severity finding(s) in changed files: ${high.slice(0, MAX_LISTED).map((finding) => `${finding.line ? `${finding.file}:${finding.line}` : finding.file} ${finding.rule}`).join("; ")}. Fix them, or state why each is acceptable.`,
					brief: `${high.length} high-severity audit finding(s)`,
				});
			}
			if (failed.length) {
				receipts.push({
					source: "syntax", id: "parse-failure", revision, state: "unresolved", count: failed.length,
					line: `syntax: ${failed.length} changed file(s) do not parse: ${failed.slice(0, MAX_LISTED).join(", ")}.`,
					brief: `${failed.length} changed file(s) do not parse`,
				});
			}
			if (unknown.length || files.length > MAX_STATIC_FILES || files.filter(sourceCheckSupported).length > MAX_SYNTAX_FILES) {
				receipts.push({ source: "static-check", id: "coverage", revision, state: "unknown", line: `static check coverage is partial${unknown.length ? `: ${unknown.slice(0, MAX_LISTED).join(", ")}` : ""}; at most ${MAX_STATIC_FILES} files audited and ${MAX_SYNTAX_FILES} parsed. Use current project checks or disclose the remaining coverage.`, brief: "static check coverage partial" });
			}
		} catch (error) {
			signal?.throwIfAborted();
			receipts.push({ source: "static-check", id: "unavailable", state: "unknown", line: `static check could not finish (${String((error as Error)?.message ?? error).slice(0, 120)}); inspect changed files or disclose this verification limit.`, brief: "static check unavailable" });
		}
		return receipts;
	};
}

/** Standalone callers get a fresh check; goal owns one checker for its session. */
export const staticCompletionSteps = (cwd: string, signal?: AbortSignal) => createStaticCompletionCheck()(cwd, signal);

/** Non-blocking source-quality notes for the files changed since HEAD (duplicated blocks, flagged patterns,
 * import cycles), from the local deterministic baseline. They inform `goal check`; they never gate completion. */
export async function staticAdvisories(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(STATIC_DEADLINE_MS)]) : AbortSignal.timeout(STATIC_DEADLINE_MS);
	if (!await hasGitBaseline(cwd, bounded)) return [];
	try {
		const files = (await changedFiles(cwd, "HEAD", bounded)).filter(file => auditable(file));
		if (!files.length) return [];
		// Post-edit hooks already compare bounded project neighbours. Diagnostic completion notes inspect the change,
		// rather than walking 1,500 unchanged files and rebuilding a project-wide duplicate index just to close a goal.
		const report: any = await codeQuality({ operation: "baseline", changed: true, paths: files.slice(0, MAX_STATIC_FILES), limit: 20 }, cwd, bounded);
		const notes: string[] = [];
		const groups: any[] = report.duplicates?.groups ?? [];
		if (groups.length) {
			const sample = groups[0].occurrences?.slice(0, 2).map((spot: any) => `${spot.path}:${spot.start}-${spot.end}`).join(" ~ ");
			notes.push(`${groups.length} duplicated block group(s) touch the changed files${sample ? ` (e.g. ${sample})` : ""}; reuse the existing owner unless the repetition is intended.`);
		}
		const rules = Object.entries(report.counts ?? {}).filter(([, count]) => typeof count === "number" && count > 0).sort((a: any, b: any) => b[1] - a[1]);
		if (rules.length) notes.push(`${rules.reduce((sum, [, count]) => sum + (count as number), 0)} source-quality finding(s): ${rules.slice(0, 3).map(([rule, count]) => `${rule}×${count}`).join(", ")}.`);
		const cycles: any[] = report.structure?.cycles ?? [];
		if (cycles.length) notes.push(`${cycles.length} import cycle(s) among the changed files.`);
		return notes;
	} catch { return []; }
}

export interface CompletionReport {
	/** One line per step, in the order a reader should fix them. */
	lines: string[];
	/** True when every step is settled. */
	clear: boolean;
}

/** Render the criteria and every step receipt as one short report. */
export function completionReport(criteria: readonly { id: string; text: string; status: string; evidence?: string }[], receipts: readonly GateReceipt[]): CompletionReport {
	const lines = criteria.map((criterion) => `${criterion.status === "open" ? "[ ]" : criterion.status === "met" ? "[x]" : "[~]"} ${criterion.id} ${criterion.text}${criterion.evidence ? ` — ${criterion.evidence}` : ""}`);
	for (const receipt of receipts) lines.push(`[!] ${receipt.line}`);
	const open = criteria.some((criterion) => criterion.status === "open");
	return { lines, clear: !open && !receipts.length };
}

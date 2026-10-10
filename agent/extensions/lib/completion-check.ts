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
import { codeAudit } from "./code-audit.ts";
import { changedFiles } from "./code-quality.ts";
import { sourceCheck, sourceCheckSupported } from "./source-check.ts";
import type { GateReceipt } from "./completion-gate.ts";

const STATIC_DEADLINE_MS = 30_000;
const MAX_SYNTAX_FILES = 20;
const MAX_LISTED = 5;

/** Static steps over the files changed against HEAD. Without a Git baseline (no repository or no commit) there is
 * no "changed since" to inspect, so the steps are silent. Quiet when clean; a high-severity audit finding or a
 * file that does not parse becomes an unresolved receipt. Any failure of a step is reported as unknown, never as a pass. */
export async function staticCompletionSteps(cwd: string, signal?: AbortSignal): Promise<GateReceipt[]> {
	const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(STATIC_DEADLINE_MS)]) : AbortSignal.timeout(STATIC_DEADLINE_MS);
	const receipts: GateReceipt[] = [];
	const baseline = await promisify(execFile)("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd, signal: bounded, timeout: 5_000 }).then(() => true, () => false);
	if (!baseline) return receipts;
	try {
		const audit = await codeAudit({ changed: true, minSeverity: "high", limit: 20 }, cwd, bounded);
		const high = audit.findings.filter((finding) => finding.severity === "high");
		if (high.length) {
			receipts.push({
				source: "static-audit", id: "high-severity", state: "unresolved", count: high.length,
				line: `static audit: ${high.length} high-severity finding(s) in changed files: ${high.slice(0, MAX_LISTED).map((finding) => `${finding.line ? `${finding.file}:${finding.line}` : finding.file} ${finding.rule}`).join("; ")}. Fix them, or state why each is acceptable.`,
				brief: `${high.length} high-severity audit finding(s)`,
			});
		}
	} catch (error) {
		if (bounded.aborted) return receipts;
		receipts.push({ source: "static-audit", id: "unavailable", state: "unknown", line: `static audit could not run (${String((error as Error)?.message ?? error).slice(0, 120)}); inspect the changed files yourself.`, brief: "static audit unavailable" });
	}
	try {
		const files = (await changedFiles(cwd, "HEAD", bounded)).filter(sourceCheckSupported).slice(0, MAX_SYNTAX_FILES);
		if (files.length) {
			const result: any = await sourceCheck({ paths: files, cwd, signal: bounded });
			const failed = (result.results ?? []).filter((row: any) => row?.status === "failed");
			if (failed.length) {
				receipts.push({
					source: "syntax", id: "parse-failure", state: "unresolved", count: failed.length,
					line: `syntax: ${failed.length} changed file(s) do not parse: ${failed.slice(0, MAX_LISTED).map((row: any) => row.path).join(", ")}.`,
					brief: `${failed.length} changed file(s) do not parse`,
				});
			}
		}
	} catch { /* an unavailable parser is not evidence of a defect */ }
	return receipts;
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

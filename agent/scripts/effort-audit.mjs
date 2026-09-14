#!/usr/bin/env node
// Offline reasoning-effort audit of session transcripts.
//
// Reports how much thinking budget went to mechanical turns (read/bash/grep/
// edit/test/poll) and what collapsing them into bounded transactions would
// remove. Read-only. The report carries counts and tool names only: never
// transcript text, tool arguments or command strings.
//
// Usage:
//   node scripts/effort-audit.mjs [FILE.jsonl ...]
//   node scripts/effort-audit.mjs [--sessions DIR] [--limit 1..100]
//                                 [--since DAYS] [--threshold N] [--json]
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
	auditSessionFile,
	scanEffortAudit,
	AUDIT_LIMITS,
	EXPENSIVE_REASONING_TOKENS,
} from "./lib/effort-audit.mjs";

const args = process.argv.slice(2);
const files = [];
let sessionsDir = fileURLToPath(new URL("../sessions", import.meta.url));
let limit = 40;
let sinceDays = 30;
let threshold = EXPENSIVE_REASONING_TOKENS;
let asJson = false;

const num = (value, min, max, fallback) => {
	const n = Number(value);
	if (!Number.isFinite(n) || n < min || n > max) return fallback;
	return Math.floor(n);
};

for (let i = 0; i < args.length; i++) {
	const key = args[i];
	if (key === "--json") {
		asJson = true;
		continue;
	}
	const value = args[i + 1];
	if (key === "--sessions" && value) {
		sessionsDir = path.resolve(value);
		i++;
	} else if (key === "--limit") {
		limit = num(value, 1, AUDIT_LIMITS.maxFiles, limit);
		i++;
	} else if (key === "--since") {
		sinceDays = num(value, 0, 3650, sinceDays);
		i++;
	} else if (key === "--threshold") {
		threshold = num(value, 1, 1e6, threshold);
		i++;
	} else if (key === "--help" || key === "-h") {
		console.log(
			"Usage: node scripts/effort-audit.mjs [FILE.jsonl ...]\n" +
				"       [--sessions DIR] [--limit 1..100] [--since DAYS] [--threshold N] [--json]",
		);
		process.exit(0);
	} else if (typeof key === "string" && !key.startsWith("--"))
		files.push(path.resolve(key));
	else {
		console.error(`Unknown option: ${key}`);
		process.exit(2);
	}
}

let report;
try {
	if (files.length > 0) {
		const reports = files.map((f) =>
			auditSessionFile(f, { expensiveReasoningTokens: threshold }),
		);
		const { summarizeEffortAudit } = await import("./lib/effort-audit.mjs");
		report = summarizeEffortAudit(reports, {
			scanned: reports.length,
			available: reports.length,
		});
	} else {
		report = scanEffortAudit({
			sessionsDir,
			maxFiles: limit,
			sinceMs: sinceDays > 0 ? Date.now() - sinceDays * 86_400_000 : 0,
		});
	}
} catch (error) {
	// Keep the report free of filesystem paths and raw exception text.
	console.error(
		`Session effort audit unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
	);
	process.exitCode = 1;
}

if (report) {
	if (asJson) console.log(JSON.stringify(report, null, 2));
	else {
		const t = report.totals;
		const pct = (n) => `${(n * 100).toFixed(1)}%`;
		console.log(
			`sessions scanned      ${report.scanned} (available ${report.available ?? report.scanned})`,
		);
		console.log(
			`tool turns            ${t.turns}  (mechanical ${t.mechanicalTurns}, ${pct(t.mechanicalTurnShare)})`,
		);
		console.log(`reasoning tokens      ${t.reasoningTokens}`);
		console.log(
			`  on mechanical turns ${t.mechanicalReasoningTokens} (${pct(t.mechanicalReasoningShare)})`,
		);
		console.log(
			`expensive mechanical  ${t.expensiveMechanicalTurns} turns (>= ${threshold} reasoning tokens)`,
		);
		console.log(
			`repeated tool calls   ${t.repeatedCalls}   poll-style calls ${t.pollCalls}`,
		);
		console.log(
			`recoverable           ~${report.estimate.recoverableReasoningTokens} reasoning tokens`,
		);
		console.log(
			`requests avoidable    ~${report.estimate.requestsAvoidedByTransactions} (collapse mechanical ops into transactions)`,
		);
		const top = (report.files ?? [])
			.flatMap((f) => f.top.map((x) => ({ ...x, file: f.file })))
			.sort((a, b) => b.reasoning - a.reasoning)
			.slice(0, 8);
		if (top.length > 0) {
			console.log("\ntop mechanical turns by reasoning tokens:");
			for (const row of top)
				console.log(
					`  ${String(row.reasoning).padStart(6)} tok  ${row.tools.join(",")}  ${path.basename(row.file)}#${row.turn}`,
				);
		}
	}
}

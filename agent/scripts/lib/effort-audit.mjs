// Offline, transcript-backed reasoning-effort accounting.
//
// Answers one question: how much thinking budget did *mechanical* work buy?
// A mechanical turn is one whose tool calls only move deterministic state
// (read/bash/grep/find/ls/edit/write/...). Those turns are the ones the
// adaptive policy should cheapen; this module measures the ceiling of that
// saving from real transcripts instead of asserting one.
//
// Disclosure rules (the report is safe to paste anywhere):
//   * no transcript text, no tool arguments, no command strings — repeated
//     identical calls are identified by a short SHA-256 of their JSON;
//   * only counts, token totals, tool names and file paths are emitted;
//   * every scan is bounded (files, bytes, entries) and read-only.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
	MECHANICAL_TOOLS,
	compareModes,
} from "../../extensions/lib/effort-policy.mjs";

export const AUDIT_LIMITS = Object.freeze({
	maxFiles: 100,
	maxFileBytes: 16 * 1024 * 1024,
	maxEntriesPerFile: 4000,
	maxDirectoryEntries: 10_000,
	maxDepth: 1,
	maxTop: 10,
});

/** A turn at/above this many reasoning tokens is "expensive". */
export const EXPENSIVE_REASONING_TOKENS = 512;
/** Reasoning tokens above this share of all output means the turn thought more
 *  than it acted — the signature of a mechanical turn run at full budget. */
export const THOUGHTFUL_RATIO = 1;

const POLL_PATTERN =
	/\b(sleep\s+\d|tail\s+-f|wait_for|bg_status|bg_logs|bg_wait|poll|while\s+true)\b/i;

const shortHash = (value) =>
	createHash("sha256").update(value).digest("hex").slice(0, 10);

const isMechanicalToolSet = (tools) =>
	tools.length > 0 && tools.every((t) => MECHANICAL_TOOLS.has(t));

/**
 * Audit one session transcript (.jsonl). Never throws on malformed lines:
 * a partial transcript still yields a usable report.
 */
export const auditSessionFile = (file, options = {}) => {
	const limits = { ...AUDIT_LIMITS, ...options };
	const threshold =
		options.expensiveReasoningTokens ?? EXPENSIVE_REASONING_TOKENS;
	const report = {
		file,
		turns: 0,
		mechanicalTurns: 0,
		reasoningTokens: 0,
		mechanicalReasoningTokens: 0,
		expensiveMechanicalTurns: 0,
		outputTokens: 0,
		toolCalls: 0,
		repeatedCalls: 0,
		pollCalls: 0,
		errorResults: 0,
		top: [],
		skipped: null,
	};
	let stat;
	try {
		stat = fs.statSync(file);
	} catch {
		report.skipped = "unreadable";
		return report;
	}
	if (!stat.isFile()) {
		report.skipped = "not a file";
		return report;
	}
	if (stat.size > limits.maxFileBytes) {
		report.skipped = "too large";
		return report;
	}

	const raw = fs.readFileSync(file, "utf8");
	const lines = raw.split("\n");
	const entries = [];
	for (const line of lines) {
		if (entries.length >= limits.maxEntriesPerFile) break;
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			/* A resumed session can end mid-write; the last line is not evidence. */
		}
	}

	// Pass 1: tool call -> error, so a turn knows whether its tools failed.
	const errorById = new Map();
	for (const entry of entries) {
		const message = entry?.type === "message" ? entry.message : null;
		if (!message || message.role !== "toolResult") continue;
		if (message.isError) report.errorResults++;
		const id = message.toolCallId;
		if (typeof id === "string") errorById.set(id, message.isError === true);
	}

	// Pass 2: assistant turns.
	let previousMechanicalSignature = null;
	let previousWasPoll = false;
	let repeatStreak = 0;
	let turnIndex = 0;

	for (const entry of entries) {
		const message = entry?.type === "message" ? entry.message : null;
		if (!message || message.role !== "assistant") continue;
		turnIndex++;
		const content = Array.isArray(message.content) ? message.content : [];
		const calls = content.filter((c) => c && c.type === "toolCall");
		const tools = calls.map((c) => c.name).filter((n) => typeof n === "string");
		if (tools.length === 0) continue; // pure-prose turn: not a tool transaction
		report.turns++;
		report.toolCalls += tools.length;

		const usage = message.usage ?? {};
		const reasoning = Number(usage.reasoning) || 0;
		const output = Number(usage.output) || 0;
		const context = (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0);
		report.reasoningTokens += reasoning;
		report.outputTokens += output;

		const errors = calls.filter((c) => errorById.get(c.id) === true).length;
		const mechanical = isMechanicalToolSet(tools);
		if (!mechanical) {
			previousMechanicalSignature = null;
			previousWasPoll = false;
			repeatStreak = 0;
			continue;
		}

		report.mechanicalTurns++;
		report.mechanicalReasoningTokens += reasoning;

		// Repeated identical call: same tool + same arguments, back to back.
		const signature = shortHash(
			JSON.stringify(tools) +
				"|" +
				JSON.stringify(calls.map((c) => c.arguments ?? null)),
		);
		if (signature === previousMechanicalSignature) {
			repeatStreak++;
			report.repeatedCalls++;
		} else repeatStreak = 0;
		previousMechanicalSignature = signature;

		const isPoll =
			tools.every((t) => t.startsWith("bg_")) ||
			POLL_PATTERN.test(JSON.stringify(calls.map((c) => c.arguments ?? null)));
		// A poll loop is reported separately; counting it here too would
		// double-count the same turn against the repeat metric.
		if (isPoll) report.pollCalls++;
		previousWasPoll = isPoll;

		const expensive = reasoning >= threshold;
		if (expensive) report.expensiveMechanicalTurns++;
		if (
			expensive ||
			(reasoning > 0 &&
				reasoning >= output * THOUGHTFUL_RATIO &&
				tools.length <= 2)
		) {
			const comparison = compareModes({
				ops: tools.length,
				contextTokens: context || 8000,
				levels: [message.thinkingLevel ?? "high"],
			});
			report.top.push({
				turn: turnIndex,
				tools: [...new Set(tools)].slice(0, 6),
				reasoning,
				output,
				repeatStreak,
				requestsAvoided: comparison.requestsSaved,
				tokensAvoided: comparison.tokensSaved,
			});
		}
	}
	report.top.sort((a, b) => b.reasoning - a.reasoning);
	report.top = report.top.slice(0, limits.maxTop);
	return report;
};

/** Walk a sessions directory (depth-limited, newest first) and audit it. */
export const scanEffortAudit = ({
	sessionsDir,
	maxFiles = AUDIT_LIMITS.maxFiles,
	maxDepth = AUDIT_LIMITS.maxDepth,
	sinceMs = 0,
	signal,
} = {}) => {
	const found = [];
	const walk = (dir, depth) => {
		if (signal?.aborted || found.length >= maxFiles * 4) return;
		let items = [];
		try {
			items = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		} // unreadable branch: skip it, sibling dirs still audit
		for (const item of items) {
			if (signal?.aborted) return;
			const full = path.join(dir, item.name);
			if (item.isDirectory()) {
				if (depth < maxDepth) walk(full, depth + 1);
				continue;
			}
			if (!item.name.endsWith(".jsonl")) continue;
			let stat;
			try {
				stat = fs.statSync(full);
			} catch {
				continue;
			} // vanished between readdir and stat
			if (!stat.isFile()) continue;
			if (sinceMs && stat.mtimeMs < sinceMs) continue;
			found.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
		}
	};
	walk(sessionsDir, 0);
	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const selected = found.slice(0, maxFiles);
	const reports = selected.map((f) => auditSessionFile(f.file, { signal }));
	return summarizeEffortAudit(reports, {
		sessionsDir,
		scanned: selected.length,
		available: found.length,
	});
};

export const summarizeEffortAudit = (reports, meta = {}) => {
	const totals = reports.reduce(
		(acc, r) => {
			acc.turns += r.turns;
			acc.mechanicalTurns += r.mechanicalTurns;
			acc.reasoningTokens += r.reasoningTokens;
			acc.mechanicalReasoningTokens += r.mechanicalReasoningTokens;
			acc.expensiveMechanicalTurns += r.expensiveMechanicalTurns;
			acc.outputTokens += r.outputTokens;
			acc.toolCalls += r.toolCalls;
			acc.repeatedCalls += r.repeatedCalls;
			acc.pollCalls += r.pollCalls;
			acc.errorResults += r.errorResults;
			return acc;
		},
		{
			turns: 0,
			mechanicalTurns: 0,
			reasoningTokens: 0,
			mechanicalReasoningTokens: 0,
			expensiveMechanicalTurns: 0,
			outputTokens: 0,
			toolCalls: 0,
			repeatedCalls: 0,
			pollCalls: 0,
			errorResults: 0,
		},
	);
	const share = totals.reasoningTokens
		? totals.mechanicalReasoningTokens / totals.reasoningTokens
		: 0;
	const mechanicalTurnShare = totals.turns
		? totals.mechanicalTurns / totals.turns
		: 0;
	// Recoverable estimate: if every mechanical turn ran at `minimal` instead of
	// the level it used, reasoning tokens scale by the model's level ratio.
	const MINIMAL_KEEP = 0.15; // minimal keeps ~15% of a high-level budget
	const recoverableReasoning = Math.round(
		totals.mechanicalReasoningTokens * (1 - MINIMAL_KEEP),
	);
	const collapsedTurns = Math.max(0, totals.toolCalls - totals.mechanicalTurns);
	return {
		...meta,
		totals: {
			...totals,
			mechanicalTurnShare: Number(mechanicalTurnShare.toFixed(4)),
			mechanicalReasoningShare: Number(share.toFixed(4)),
		},
		estimate: {
			/** Reasoning tokens not needed if mechanical turns ran minimal. */
			recoverableReasoningTokens: recoverableReasoning,
			/** Model requests removed by collapsing mechanical ops into one
			 *  deterministic transaction per batch (op count -> 1 request). */
			requestsAvoidedByTransactions: collapsedTurns,
			model: "linear: minimal keeps 15% of the observed reasoning budget",
		},
		files: reports,
	};
};

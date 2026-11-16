import { constants } from "node:fs";
import { opendir, open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { collectSessionDiagnostics } from "./session-diagnostics.ts";
import { collectContextTraffic } from "./session-report.ts";

/**
 * Offline, transcript-backed historical accounting.
 *
 * The session transcript remains the source of truth. This module only keeps
 * bounded candidate metadata while it scans and delegates activity accounting
 * to the existing session-diagnostics/session-metrics owner. It deliberately
 * returns counts and fixed categories, never transcript bodies.
 */

export const SESSION_AUDIT_LIMITS = Object.freeze({
	maxFiles: 100,
	maxFileBytes: 16 * 1024 * 1024,
	maxEntriesPerFile: 2000,
	maxDirectoryEntries: 10_000,
	maxDirectoryEntriesTotal: 100_000,
	maxDirectories: 512,
	maxDepth: 1,
	maxHeaderBytes: 64 * 1024,
	maxToolNames: 512,
});

export type SessionAuditScope = "workspace" | "all";

export interface SessionAuditOptions {
	sessionsDir: string;
	workspace?: string;
	scope?: SessionAuditScope;
	maxFiles?: number;
	maxFileBytes?: number;
	maxEntriesPerFile?: number;
	maxDirectoryEntries?: number;
	maxDirectoryEntriesTotal?: number;
	maxDirectories?: number;
	signal?: AbortSignal;
}

interface Candidate {
	file: string;
	mtimeMs: number;
}

interface ScanState {
	candidateFiles: number;
	selectedFiles: number;
	sessions: number;
	inspected: number;
	truncatedSessions: number;
	sampledOversize: number;
	skippedOversize: number;
	malformedLines: number;
	partialLines: number;
	readFailures: number;
	analysisFailures: number;
	scopeExcluded: number;
	directoriesScanned: number;
	directoryEntriesVisited: number;
	directoryReadFailures: number;
	statFailures: number;
	headerReadFailures: number;
	truncatedDirectories: number;
	tools: Record<string, number>;
	otherTools: number;
	traffic: { totalChars: number; totalResults: number; repeatedContentChars: number; repeatedRequestChars: number; byTool: Record<string, number> };
	failureCategories: Record<string, number>;
	totals: {
		parentToolErrors: number;
		parentModelErrors: number;
		children: number;
		childFailures: number;
		workflowFailures: number;
		skillsOpened: number;
		skillsSuggested: number;
		fanouts: number;
	};
}

interface ParsedHeader {
	type: "session";
	cwd?: string;
}

interface ParsedEntries {
	entries: any[];
	malformedLines: number;
	partialLines: number;
	entryTruncated: boolean;
}

const isAbortError = (error: unknown): boolean =>
	error instanceof Error &&
	(error.name === "AbortError" || /\babort(?:ed|ing)?\b/i.test(error.message));

function checkAborted(signal?: AbortSignal): void {
	if (!signal) return;
	if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
	else if (signal.aborted) throw new Error("Session audit aborted");
}

async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
	checkAborted(signal);
	await new Promise<void>((resolve) => setImmediate(resolve));
	checkAborted(signal);
}

function boundedPositive(value: unknown, fallback: number, maximum: number): number {
	const n = Number(value);
	if (!Number.isFinite(n) || n < 1) return fallback;
	return Math.min(Math.floor(n), maximum);
}

function configFor(options: SessionAuditOptions) {
	return {
		sessionsDir: options.sessionsDir,
		workspace: options.workspace,
		scope: options.scope === "all" ? "all" as const : "workspace" as const,
		maxFiles: boundedPositive(options.maxFiles, SESSION_AUDIT_LIMITS.maxFiles, SESSION_AUDIT_LIMITS.maxFiles),
		maxFileBytes: boundedPositive(options.maxFileBytes, SESSION_AUDIT_LIMITS.maxFileBytes, SESSION_AUDIT_LIMITS.maxFileBytes),
		maxEntriesPerFile: boundedPositive(options.maxEntriesPerFile, SESSION_AUDIT_LIMITS.maxEntriesPerFile, SESSION_AUDIT_LIMITS.maxEntriesPerFile),
		maxDirectoryEntries: boundedPositive(options.maxDirectoryEntries, SESSION_AUDIT_LIMITS.maxDirectoryEntries, SESSION_AUDIT_LIMITS.maxDirectoryEntries),
		maxDirectoryEntriesTotal: boundedPositive(options.maxDirectoryEntriesTotal, SESSION_AUDIT_LIMITS.maxDirectoryEntriesTotal, SESSION_AUDIT_LIMITS.maxDirectoryEntriesTotal),
		maxDirectories: boundedPositive(options.maxDirectories, SESSION_AUDIT_LIMITS.maxDirectories, SESSION_AUDIT_LIMITS.maxDirectories),
		signal: options.signal,
	};
}

function emptyState(): ScanState {
	return {
		candidateFiles: 0,
		selectedFiles: 0,
		sessions: 0,
		inspected: 0,
		truncatedSessions: 0,
		sampledOversize: 0,
		skippedOversize: 0,
		malformedLines: 0,
		partialLines: 0,
		readFailures: 0,
		analysisFailures: 0,
		scopeExcluded: 0,
		directoriesScanned: 0,
		directoryEntriesVisited: 0,
		directoryReadFailures: 0,
		statFailures: 0,
		headerReadFailures: 0,
		truncatedDirectories: 0,
		tools: Object.create(null),
		traffic: { totalChars: 0, totalResults: 0, repeatedContentChars: 0, repeatedRequestChars: 0, byTool: Object.create(null) },
		otherTools: 0,
		failureCategories: Object.create(null),
		totals: {
			parentToolErrors: 0,
			parentModelErrors: 0,
			children: 0,
			childFailures: 0,
			workflowFailures: 0,
			skillsOpened: 0,
			skillsSuggested: 0,
			fanouts: 0,
		},
	};
}

function candidateBefore(a: Candidate, b: Candidate): boolean {
	if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs;
	return a.file < b.file;
}

/** Keep only the newest bounded candidate set while traversing. */
function keepCandidate(candidates: Candidate[], candidate: Candidate, limit: number): void {
	let index = 0;
	while (index < candidates.length && candidateBefore(candidates[index], candidate)) index++;
	if (index >= limit) return;
	candidates.splice(index, 0, candidate);
	if (candidates.length > limit) candidates.pop();
}

async function scanDirectory(
	directory: string,
	depth: number,
	candidates: Candidate[],
	state: ScanState,
	config: ReturnType<typeof configFor>,
	workspacePath?: string,
): Promise<void> {
	checkAborted(config.signal);
	if (state.directoriesScanned >= config.maxDirectories) {
		state.truncatedDirectories++;
		return;
	}
	state.directoriesScanned++;

	let handle;
	try {
		handle = await opendir(directory);
	} catch (error) {
		if (isAbortError(error)) throw error;
		checkAborted(config.signal);
		state.directoryReadFailures++;
		return;
	}

	let entriesInDirectory = 0;
	try {
		for await (const entry of handle) {
			checkAborted(config.signal);
			if (
				entriesInDirectory >= config.maxDirectoryEntries ||
				state.directoryEntriesVisited >= config.maxDirectoryEntriesTotal
			) {
				state.truncatedDirectories++;
				break;
			}
			entriesInDirectory++;
			state.directoryEntriesVisited++;
			if (entry.isSymbolicLink()) continue;
			const file = path.join(directory, entry.name);
			if (entry.isDirectory() && depth < SESSION_AUDIT_LIMITS.maxDepth) {
				await scanDirectory(file, depth + 1, candidates, state, config, workspacePath);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				state.candidateFiles++;
				let details;
				try {
					details = await stat(file);
				} catch (error) {
					if (isAbortError(error)) throw error;
					checkAborted(config.signal);
					state.statFailures++;
					continue;
				}
				if (!details.isFile()) continue;
				// Workspace filtering happens before candidate retention. A newer
				// transcript from another private context therefore cannot evict an
				// older transcript belonging to the active workspace. Only a tiny
				// header prefix is read here; the body is read after selection.
				if (config.scope === "workspace") {
					if (!workspacePath) {
						state.scopeExcluded++;
						continue;
					}
					let header;
					try {
						header = await withAuditFile(file, config.signal, (handle, size) => readHeader(handle, size, config.signal));
					} catch (error) {
						if (isAbortError(error)) throw error;
						checkAborted(config.signal);
						state.headerReadFailures++;
						continue;
					}
					if (!header?.cwd || !(await matchesWorkspace(header.cwd, workspacePath))) {
						state.scopeExcluded++;
						continue;
					}
				}
				keepCandidate(
					candidates,
					{ file, mtimeMs: Number(details.mtimeMs) || 0 },
					config.maxFiles,
				);
			}
			if ((entriesInDirectory & 31) === 0) await yieldToEventLoop(config.signal);
		}
	} catch (error) {
		if (isAbortError(error)) throw error;
		checkAborted(config.signal);
		state.directoryReadFailures++;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function withAuditFile<T>(
	file: string,
	signal: AbortSignal | undefined,
	read: (handle: FileHandle, size: number) => Promise<T>,
): Promise<T> {
	checkAborted(signal);
	const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Expected a regular transcript file");
		return await read(handle, info.size);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function readRange(handle: FileHandle, start: number, length: number, signal?: AbortSignal): Promise<Buffer> {
	const bytes = Buffer.allocUnsafe(length);
	let total = 0;
	while (total < length) {
		checkAborted(signal);
		const { bytesRead } = await handle.read(bytes, total, Math.min(length - total, 64 * 1024), start + total);
		if (!bytesRead) break;
		total += bytesRead;
	}
	checkAborted(signal);
	return bytes.subarray(0, total);
}

async function readHeader(handle: FileHandle, size: number, signal?: AbortSignal): Promise<ParsedHeader | undefined> {
	const bytes = await readRange(handle, 0, Math.min(size, SESSION_AUDIT_LIMITS.maxHeaderBytes), signal);
	const newline = bytes.indexOf(10);
	if (newline < 0 && bytes.length < size) return undefined;
	try {
		const value = JSON.parse(bytes.toString("utf8", 0, newline < 0 ? bytes.length : newline).replace(/^\uFEFF/, ""));
		if (value?.type !== "session") return undefined;
		return {
			type: "session",
			...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
		};
	} catch {
		return undefined;
	}
}


async function readRecentEntries(handle: FileHandle, size: number, maxBytes: number, signal?: AbortSignal) {
	const start = Math.max(0, size - maxBytes);
	// The extra byte tells us if the nominal start is already a record boundary.
	const offset = start > 0 ? start - 1 : 0;
	const bytes = await readRange(handle, offset, size - offset, signal);
	const boundary = start > 0 ? bytes.indexOf(10) : -1;
	return {
		bytes: start > 0 && boundary < 0 ? bytes.subarray(0, 0) : bytes.subarray(boundary + 1),
		oversize: start > 0,
		byteTruncated: start > 0 || bytes.length < size - offset,
	};
}

async function parseEntries(bytes: Buffer, maxEntries: number, signal?: AbortSignal): Promise<ParsedEntries> {
	const entries: any[] = [];
	let end = bytes.lastIndexOf(10);
	const partialLines = bytes.toString("utf8", end + 1).trim() ? 1 : 0;
	let malformedLines = 0;
	let linesRead = 0;
	// Decode newest complete records first. The entry cap bounds JSON parsing
	// even when a transcript contains many small events inside its byte window.
	while (end >= 0 && entries.length < maxEntries) {
		checkAborted(signal);
		const previous = end > 0 ? bytes.lastIndexOf(10, end - 1) : -1;
		const line = bytes.toString("utf8", previous + 1, end);
		if (line.trim()) {
			try { entries.push(JSON.parse(line)); }
			catch { malformedLines++; }
		}
		end = previous;
		if ((++linesRead & 63) === 0) await yieldToEventLoop(signal);
	}
	return { entries: entries.reverse(), malformedLines, partialLines, entryTruncated: end >= 0 };
}

async function canonicalPath(value: unknown): Promise<string | undefined> {
	if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) return undefined;
	try {
		return await realpath(value);
	} catch {
		return path.resolve(value);
	}
}

async function matchesWorkspace(headerCwd: unknown, workspacePath: string | undefined): Promise<boolean> {
	if (!workspacePath || typeof headerCwd !== "string") return false;
	const headerPath = await canonicalPath(headerCwd);
	return !!headerPath && headerPath === workspacePath;
}

function safeToolName(value: unknown): string | undefined {
	const name = String(value ?? "");
	if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) return undefined;
	return name;
}

function addActivity(state: ScanState, report: ReturnType<typeof collectSessionDiagnostics>): void {
	for (const [rawName, value] of Object.entries(report.activity.tools)) {
		const count = Number.isFinite(Number(value)) ? Number(value) : 0;
		const name = safeToolName(rawName);
		if (!name) {
			state.otherTools += count;
			continue;
		}
		if (state.tools[name] === undefined && Object.keys(state.tools).length >= SESSION_AUDIT_LIMITS.maxToolNames) {
			state.otherTools += count;
			continue;
		}
		state.tools[name] = (state.tools[name] ?? 0) + count;
	}
	for (const failure of report.failures) {
		const category = typeof failure.category === "string" ? failure.category : "unclassified";
		state.failureCategories[category] = (state.failureCategories[category] ?? 0) + 1;
	}
	for (const key of Object.keys(state.totals) as (keyof ScanState["totals"])[]) {
		state.totals[key] += Number(report.activity[key]) || 0;
	}
}

function sortedCounts(values: Record<string, number>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(values).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
	);
}

function reportFor(
	state: ScanState,
	config: ReturnType<typeof configFor>,
): Record<string, unknown> {
	const scope = config.scope === "all"
		? "Explicit all scope: newest bounded top-level session files across the harness."
		: "Workspace scope: only session headers whose cwd canonicalizes to the active workspace exactly. Missing or invalid headers are excluded.";
	return {
		sessions: state.sessions,
		inspected: state.inspected,
		truncatedSessions: state.truncatedSessions,
		sampledOversize: state.sampledOversize,
		skippedOversize: state.skippedOversize,
		malformedLines: state.malformedLines,
		partialLines: state.partialLines,
		readFailures: state.readFailures,
		analysisFailures: state.analysisFailures,
		scopeExcluded: state.scopeExcluded,
		candidateFiles: state.candidateFiles,
		selectedFiles: state.selectedFiles,
		directoriesScanned: state.directoriesScanned,
		directoryEntriesVisited: state.directoryEntriesVisited,
		directoryReadFailures: state.directoryReadFailures,
		statFailures: state.statFailures,
		headerReadFailures: state.headerReadFailures,
		truncatedDirectories: state.truncatedDirectories,
		totals: { ...state.totals },
		tools: sortedCounts(state.tools),
		otherTools: state.otherTools,
		traffic: {
			totalReturnedChars: state.traffic.totalChars,
			totalResults: state.traffic.totalResults,
			identicalContentChars: state.traffic.repeatedContentChars,
			exactRequestResultChars: state.traffic.repeatedRequestChars,
			largestContributors: Object.entries(sortedCounts(state.traffic.byTool)).slice(0, 10).map(([tool, chars]) => ({ tool, chars })),
			interpretation: "Raw returned text before context projection; not wire tokens, current occupancy or billed savings. Repetition is counted within each session; exact request/result is a subset of identical content and may be legitimate verification.",
		},
		recentFailureCategories: sortedCounts(state.failureCategories),
		scope,
		limits: {
			maxFiles: config.maxFiles,
			maxFileBytes: config.maxFileBytes,
			maxEntriesPerFile: config.maxEntriesPerFile,
			maxHeaderBytes: SESSION_AUDIT_LIMITS.maxHeaderBytes,
			maxDirectoryEntries: config.maxDirectoryEntries,
			maxDirectoryEntriesTotal: config.maxDirectoryEntriesTotal,
			maxDirectories: config.maxDirectories,
		},
		limitations: [
			"Counts cover the newest complete entries within each selected file's byte window and entry limit. Line diagnostics cover the scanned window; older evidence remains unknown.",
			"Child transcript bodies and nested session files are not scanned; child and workflow values are counted only when their records are retained in the parent transcript.",
			"Failure categories cover at most 12 newest diagnostics per retained session; missing or malformed evidence remains unknown.",
			"No prompts, raw paths, raw errors, model calls or network requests are included.",
			"Recorded counts are evidence of activity and do not establish causal savings, quality or outcome.",
		],
	};
}

/** Scan persisted session transcripts with fixed resource and disclosure bounds. */
export async function scanSessionAudit(options: SessionAuditOptions): Promise<Record<string, unknown>> {
	const config = configFor(options);
	const state = emptyState();
	const candidates: Candidate[] = [];
	checkAborted(config.signal);
	const workspace = config.scope === "workspace"
		? await canonicalPath(config.workspace)
		: undefined;
	await scanDirectory(config.sessionsDir, 0, candidates, state, config, workspace);
	state.selectedFiles = candidates.length;

	for (const candidate of candidates) {
		checkAborted(config.signal);
		let read;
		try {
			read = await withAuditFile(candidate.file, config.signal, async (handle, size) => {
				if (config.scope === "workspace") {
					const header = await readHeader(handle, size, config.signal);
					if (!(await matchesWorkspace(header?.cwd, workspace))) return undefined;
				}
				return readRecentEntries(handle, size, config.maxFileBytes, config.signal);
			});
		} catch (error) {
			if (isAbortError(error)) throw error;
			checkAborted(config.signal);
			state.readFailures++;
			continue;
		}
		if (!read) {
			state.scopeExcluded++;
			continue;
		}
		const parsed = await parseEntries(read.bytes, config.maxEntriesPerFile, config.signal);
		state.malformedLines += parsed.malformedLines;
		state.partialLines += parsed.partialLines;
		if (read.oversize) {
			if (!parsed.entries.length) {
				state.skippedOversize++;
				continue;
			}
			state.sampledOversize++;
		}
		state.sessions++;
		state.inspected += parsed.entries.length;
		if (parsed.entryTruncated || read.byteTruncated) state.truncatedSessions++;
		try {
			const report = collectSessionDiagnostics(parsed.entries, { excerpts: false });
			addActivity(state, report);
			const traffic = collectContextTraffic(parsed.entries);
			state.traffic.totalChars += traffic.totalChars;
			state.traffic.totalResults += traffic.totalResults;
			for (const row of traffic.tools) {
				state.traffic.repeatedContentChars += row.repeatedContentChars;
				state.traffic.repeatedRequestChars += row.repeatedChars;
				let tool = safeToolName(row.tool) ?? "other";
				if (!(tool in state.traffic.byTool) && Object.keys(state.traffic.byTool).length >= SESSION_AUDIT_LIMITS.maxToolNames) tool = "other";
				state.traffic.byTool[tool] = (state.traffic.byTool[tool] ?? 0) + row.chars;
			}
		} catch (error) {
			if (isAbortError(error)) throw error;
			checkAborted(config.signal);
			state.analysisFailures++;
		}
		await yieldToEventLoop(config.signal);
	}
	return reportFor(state, config);
}

/** Descriptive alias for callers that treat the result as an aggregate. */
export const collectSessionAudit = scanSessionAudit;

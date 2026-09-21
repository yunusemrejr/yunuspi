/**
 * Quota-journal bridge: maps request-journal.jsonl lines into QuotaEvents so
 * the deterministic quota-health policy can gate economy model selection on
 * live provider health. Pure functions + one bounded file reader; the reader
 * never throws (missing/corrupt journal = no events = no filtering).
 *
 * Event-source contract (deliberately conservative, no free-text sniffing):
 *   status "end_turn"                      -> "ok"
 *   status "error"                         -> "error"
 *   status "quota_exceeded" / quota:true   -> "quota-exhausted"
 *   anything else                          -> skipped
 * Producers that learn about 429s can record those markers; until then the
 * journal cannot classify exhaustion and selection behaves exactly as before.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QuotaEvent } from "./quota-health.ts";

export const REQUEST_JOURNAL_PATH = join(homedir(), ".pi", "request-journal.jsonl");

/** Journal byte budget: only the tail is read, keeping the seam bounded. */
const JOURNAL_TAIL_BYTES = 64 * 1024;
const JOURNAL_MAX_EVENTS = 64;

function parseJournalLine(raw: string): QuotaEvent | undefined {
	if (!raw.trim()) return undefined;
	let line: unknown;
	try {
		line = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!line || typeof line !== "object") return undefined;
	const record = line as Record<string, unknown>;
	const provider = record.provider;
	if (typeof provider !== "string" || !provider) return undefined;
	const at = Date.parse(typeof record.ts === "string" ? record.ts : "") || 0;
	const quotaFlag = record.quota === true || record.status === "quota_exceeded";
	const kind = quotaFlag
		? "quota-exhausted"
		: record.status === "error"
			? "error"
			: record.status === "end_turn"
				? "ok"
				: undefined;
	if (kind === undefined) return undefined;
	return { provider, at, kind, detail: "request-journal" };
}

/** Parse journal lines into QuotaEvents; unknown/malformed lines are skipped. */
export function mapJournalLinesToQuotaEvents(lines: string[]): QuotaEvent[] {
	if (!Array.isArray(lines)) throw new TypeError("quota-journal: lines must be an array");
	const events: QuotaEvent[] = [];
	for (const line of lines) {
		if (typeof line !== "string") throw new TypeError("quota-journal: lines must be strings");
		const event = parseJournalLine(line);
		if (event) events.push(event);
	}
	return events.slice(-JOURNAL_MAX_EVENTS);
}

/** Read the journal tail (bounded bytes from disk, never the whole file);
 * missing or unreadable journal yields []. A mid-line slice start parses as
 * a skippable partial line, same as before. */
export function readJournalQuotaEvents(path: string = REQUEST_JOURNAL_PATH): QuotaEvent[] {
	let raw: string;
	try {
		const size = statSync(path).size;
		const want = Math.min(Math.max(0, size), JOURNAL_TAIL_BYTES);
		const fd = openSync(path, "r");
		try {
			const buf = Buffer.alloc(want);
			let read = 0;
			while (read < want) {
				const n = readSync(fd, buf, read, want - read, size - want + read);
				if (n <= 0) break;
				read += n;
			}
			raw = buf.subarray(0, read).toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return [];
	}
	return mapJournalLinesToQuotaEvents(raw.split("\n"));
}

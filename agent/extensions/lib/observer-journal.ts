/**
 * Observer journal and read-only investigation tools.
 *
 * The observer packet shows short excerpts (8 KB total). The journal keeps
 * the full text behind every excerpt (user prompts, harness interpretation,
 * reminders, assistant text, provider-returned thinking, tool results, hook
 * and guardian notices) so the observer can look closer during a review with
 * bounded, read-only tools instead of guessing from a truncated line.
 *
 * Nothing here can write, execute, delegate or reach the network. File reads
 * are confined to the session's working directory, skip secret-like paths and
 * are byte-bounded. The journal lives in memory only and is never persisted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export interface JournalEntry { id: string; kind: string; at: number; text: string; tool?: string; }

const ENTRY_MAX_CHARS = 64_000;
const PROMPT_MAX_CHARS = 131_072;
const JOURNAL_MAX_CHARS = 3_000_000;
/** One tool result sent back to the observer model. */
export const OBSERVER_TOOL_RESULT_CHARS = 6_000;
export const OBSERVER_TOOL_ROUNDS = 3;
const PROTECTED_KINDS = new Set(["user prompt", "user reminder", "harness interpretation"]);

const clean = (value: string) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
const timestamp = (entry: JournalEntry) => Number.isFinite(entry.at) && Math.abs(entry.at) <= 8.64e15 ? ` · ${new Date(entry.at).toISOString()}` : "";

export function createObserverJournal(limits: { maxChars?: number } = {}) {
	const maxChars = limits.maxChars ?? JOURNAL_MAX_CHARS;
	const entries = new Map<string, JournalEntry>();
	let size = 0;
	const evict = () => {
		// Oldest ordinary entries go first; user prompts, reminders and the
		// interpretation stay while anything else remains to evict.
		for (const pass of [false, true]) for (const [id, entry] of entries) {
			if (size <= maxChars) return;
			if (!pass && PROTECTED_KINDS.has(entry.kind)) continue;
			entries.delete(id); size -= entry.text.length;
		}
	};
	return {
		add(entry: JournalEntry) {
			const limit = PROTECTED_KINDS.has(entry.kind) ? PROMPT_MAX_CHARS : ENTRY_MAX_CHARS;
			const text = clean(entry.text);
			const bounded = text.length <= limit ? text : `${text.slice(0, limit - 200)}\n[… ${text.length - limit + 200} characters omitted by the observer journal …]`;
			const previous = entries.get(entry.id);
			if (previous) { size -= previous.text.length; entries.delete(entry.id); }
			entries.set(entry.id, { ...entry, text: bounded });
			size += bounded.length;
			evict();
		},
		get: (id: string) => entries.get(id),
		has: (id: string) => entries.has(id),
		list: (kind?: string) => [...entries.values()].filter((entry) => !kind || entry.kind === kind),
		clear() { entries.clear(); size = 0; },
		get size() { return size; },
	};
}
export type ObserverJournal = ReturnType<typeof createObserverJournal>;

/** Tool schemas offered to the observer model (plain JSON Schema). */
export const OBSERVER_TOOLS = [
	{
		name: "session_detail",
		description: "Read the full text behind packet evidence ids (user prompts, interpretation, reminders, assistant text, provider thinking, tool results, hook/guardian notices). Use when an excerpt is truncated and the detail matters for your note. Supports offset/limit in characters.",
		parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, maxItems: 4 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 200, maximum: 6000 } }, required: ["ids"], additionalProperties: false },
	},
	{
		name: "session_search",
		description: "Search this session's journal (all user prompts, reminders, assistant text, thinking, tool results, hooks) for words or a phrase. Returns matching ids with short snippets; follow with session_detail.",
		parameters: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 200 }, kind: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 12 } }, required: ["query"], additionalProperties: false },
	},
	{
		name: "read_file",
		description: "Read a project file (read-only, inside the session working directory) to check a claim against the actual source. offset/limit are 1-based line numbers; at most 400 lines.",
		parameters: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 512 }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 400 } }, required: ["path"], additionalProperties: false },
	},
	{
		name: "grep_files",
		description: "Search project files (read-only) for a regular expression. Returns up to 40 matching lines with paths. Use to verify whether something exists or was changed.",
		parameters: { type: "object", properties: { pattern: { type: "string", minLength: 1, maxLength: 200 }, path: { type: "string", maxLength: 512 }, glob: { type: "string", maxLength: 100 } }, required: ["pattern"], additionalProperties: false },
	},
	{
		name: "book_read",
		description: "Read an Observer Book chapter (list of passages) or a passage in full by id.",
		parameters: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 120 } }, required: ["id"], additionalProperties: false },
	},
] as const;

const SECRET_PATH = /(?:^|[\\/])(?:\.env(?:\.[\w.-]+)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|auth\.json|credentials(?:\.json)?|secrets?(?:\.\w+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^\\/]*\.(?:pem|key|p12|pfx|keystore|jks))$|(?:^|[\\/])(?:\.ssh|\.gnupg|\.aws|\.docker|\.kube)(?:[\\/]|$)/i;

export interface ObserverToolHost {
	journal: ObserverJournal;
	cwd?: string;
	book?: { read(id: string): string | undefined };
}

const truncate = (text: string, limit = OBSERVER_TOOL_RESULT_CHARS) => text.length <= limit ? text : `${text.slice(0, limit - 80)}\n[… truncated; request a narrower range …]`;

function resolveInside(cwd: string | undefined, file: string): string | undefined {
	if (!cwd || typeof file !== "string" || !file.trim() || file.includes("\0")) return undefined;
	let root: string;
	try { root = fs.realpathSync(cwd); } catch { return undefined; }
	const target = path.resolve(root, file);
	let real: string;
	try { real = fs.realpathSync(target); } catch { return undefined; }
	const relative = path.relative(root, real);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	if (SECRET_PATH.test(relative) || relative.split(path.sep).includes("node_modules") && relative.split(path.sep).length > 6) return undefined;
	return real;
}

/** Execute one observer tool call. Never throws; errors are text for the model. */
export function runObserverTool(host: ObserverToolHost, name: string, args: any): { text: string; isError?: boolean; ids?: string[] } {
	try {
		if (name === "session_detail") {
			const ids = Array.isArray(args?.ids) ? args.ids.filter((id: unknown) => typeof id === "string").slice(0, 4) : [];
			if (!ids.length) return { text: "Provide ids from the packet or from session_search.", isError: true };
			const offset = Number.isSafeInteger(args?.offset) && args.offset > 0 ? args.offset : 0;
			const limit = Math.max(200, Math.min(OBSERVER_TOOL_RESULT_CHARS, Number.isSafeInteger(args?.limit) ? args.limit : 3000));
			const per = Math.floor(limit / ids.length);
			const found: string[] = [];
			const parts = ids.map((id: string) => {
				const entry = host.journal.get(id);
				if (!entry) return `${id}: not in the journal (it may be a derived state row or was evicted).`;
				found.push(id);
				const slice = entry.text.slice(offset, offset + per);
				const more = offset + per < entry.text.length ? ` [chars ${offset}-${offset + slice.length} of ${entry.text.length}; use offset to continue]` : "";
				return `${id} (${entry.kind}${entry.tool ? ` · ${entry.tool}` : ""}${timestamp(entry)}):${more}\n${slice}`;
			});
			return { text: truncate(parts.join("\n---\n")), ids: found };
		}
		if (name === "session_search") {
			const query = typeof args?.query === "string" ? args.query.trim().toLowerCase().slice(0, 200) : "";
			if (query.length < 2) return { text: "Query must have at least two characters.", isError: true };
			const words = query.split(/\s+/).filter((word) => word.length > 1);
			const limit = Math.max(1, Math.min(12, Number.isSafeInteger(args?.limit) ? args.limit : 8));
			const rows = host.journal.list(typeof args?.kind === "string" ? args.kind : undefined)
				.map((entry) => {
					const lower = entry.text.toLowerCase();
					const exact = lower.indexOf(query);
					const score = (exact >= 0 ? 10 : 0) + words.filter((word) => lower.includes(word)).length;
					return { entry, score, at: exact >= 0 ? exact : Math.max(0, lower.indexOf(words.find((word) => lower.includes(word)) ?? "\0")) };
				})
				.filter((row) => row.score >= Math.max(1, Math.ceil(words.length / 2)))
				.sort((a, b) => b.score - a.score || b.entry.at - a.entry.at)
				.slice(0, limit);
			if (!rows.length) return { text: `No journal entries match ${JSON.stringify(query)}. Absence here does not prove the work was not done (children, earlier sessions and evicted entries are not searched).` };
			return { text: truncate(rows.map(({ entry, at }) => `${entry.id} (${entry.kind}${entry.tool ? ` · ${entry.tool}` : ""}${timestamp(entry)}): …${entry.text.slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, " ")}…`).join("\n")), ids: rows.map((row) => row.entry.id) };
		}
		if (name === "read_file") {
			const real = resolveInside(host.cwd, args?.path);
			if (!real) return { text: "File unavailable: outside the working directory, secret-like, or missing.", isError: true };
			const stat = fs.statSync(real);
			if (!stat.isFile()) return { text: "Not a regular file.", isError: true };
			if (stat.size > 4 * 1024 * 1024) return { text: "File larger than 4 MiB; use grep_files instead.", isError: true };
			const lines = fs.readFileSync(real, "utf8").split("\n");
			const offset = Math.max(1, Number.isSafeInteger(args?.offset) ? args.offset : 1);
			const limit = Math.max(1, Math.min(400, Number.isSafeInteger(args?.limit) ? args.limit : 200));
			const chunk = lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line.slice(0, 400)}`).join("\n");
			return { text: truncate(`${path.relative(fs.realpathSync(host.cwd!), real)} lines ${offset}-${Math.min(lines.length, offset - 1 + limit)} of ${lines.length}\n${chunk}`) };
		}
		if (name === "grep_files") {
			const pattern = typeof args?.pattern === "string" ? args.pattern.slice(0, 200) : "";
			if (!pattern) return { text: "Provide a pattern.", isError: true };
			const base = args?.path ? resolveInside(host.cwd, args.path) : host.cwd && fs.realpathSync(host.cwd);
			if (!base) return { text: "Path unavailable: outside the working directory, secret-like, or missing.", isError: true };
			const rgArgs = ["--no-heading", "--line-number", "--max-count", "5", "--max-columns", "240", "--max-filesize", "2M", "-g", "!**/.env*", "-g", "!**/*.pem", "-g", "!**/*.key", "-g", "!**/node_modules/**", "-g", "!**/.git/**"];
			if (typeof args?.glob === "string" && /^[\w*?.{},/\[\]-]+$/.test(args.glob)) rgArgs.push("-g", args.glob);
			const result = spawnSync("rg", [...rgArgs, "-e", pattern, "--", base], { cwd: host.cwd, encoding: "utf8", timeout: 4000, maxBuffer: 512 * 1024 });
			if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return { text: "ripgrep is unavailable; use read_file.", isError: true };
			if (result.status === 2) return { text: `Search failed: ${String(result.stderr).slice(0, 200)}`, isError: true };
			const root = fs.realpathSync(host.cwd!);
			const lines = String(result.stdout ?? "").split("\n").filter(Boolean).slice(0, 40).map((line) => line.startsWith(root) ? line.slice(root.length + 1) : line);
			return { text: lines.length ? truncate(lines.join("\n")) : `No matches for ${JSON.stringify(pattern)}.` };
		}
		if (name === "book_read") {
			const body = host.book?.read(String(args?.id ?? ""));
			return body ? { text: truncate(body) } : { text: "Unknown chapter or passage id.", isError: true };
		}
		return { text: `Unknown tool ${JSON.stringify(String(name).slice(0, 60))}. Available: ${OBSERVER_TOOLS.map((tool) => tool.name).join(", ")}.`, isError: true };
	} catch (error) {
		return { text: `Tool failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`, isError: true };
	}
}

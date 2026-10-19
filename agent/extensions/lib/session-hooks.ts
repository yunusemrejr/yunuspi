/**
 * Deterministic, topic-agnostic session hooks.
 *
 * One pre-written line the first time a session hits a surface where the
 * next step is easy to get wrong: an uncertain browser action that failed,
 * and a production deploy that still has to be checked against live bytes.
 *
 * Pure policy only — no pi imports, no subprocesses. The one filesystem reader
 * is nested-instruction discovery at the end of this file: bounded reads of
 * instruction files below an explicit cwd. The extension
 * (`extensions/session-hooks.ts`) owns registration, once-per-session state
 * and telemetry; this module stays unit-testable.
 */
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

export type HookArgs = Record<string, unknown>;

export interface HookRule {
	/** Stable once-per-session key and telemetry hook id. */
	key: string;
	/** Tool names the rule applies to. */
	tools: readonly string[];
	/** One deterministic line; no outcome claims, no blame. */
	line: string;
	/** Extra predicate over the call arguments (tool_call time). */
	when?: (args: HookArgs) => boolean;
	/** Failure recovery has separate receipts from successful first use. */
	onError?: boolean;
}

/** Pushes to production-like remotes and hosted deploy commands. */
const DEPLOY =
	/\bgit\s+push\s+(?:-\S+\s+)*(?:prod\w*|live|deploy\w*|namecheap|heroku|dokku|server|origin\s+(?:prod\w*|live|deploy\w*))\b|\brsync\b[^\n]*\s[\w.-]+@?[\w.-]+:[^\s]|\bscp\b[^\n]*\s[\w.-]+@?[\w.-]+:|\b(?:vercel(?:\s+--prod)?|netlify\s+deploy|fly\s+deploy|wrangler\s+(?:deploy|publish)|firebase\s+deploy|gcloud\s+app\s+deploy|kubectl\s+apply|helm\s+upgrade|docker\s+push)\b/;

const bashCommand = (args: HookArgs): string =>
	typeof args.command === "string" ? args.command : "";

const contains = (pattern: RegExp) => (args: HookArgs) =>
	pattern.test(bashCommand(args));
const isBrowserMutation = (args: HookArgs) =>
	["click", "fill", "press", "select", "check", "hover", "scroll", "drag", "evaluate"].includes(String(args.action)) ||
	(args.action === "wait" && args.kind === "function");

/** First match wins. */
export const HOOK_RULES: readonly HookRule[] = [
	{
		key: "browser-session-recovery", tools: ["browser_session"], onError: true,
		when: isBrowserMutation,
		line: "Reconcile current page, account history or submission receipt before retrying an uncertain action. A timeout may follow a successful post. Save the outcome in the existing plan and continue independent work.",
	},
	{
		key: "browser-session-read-recovery", tools: ["browser_session"], onError: true,
		line: "Use the reported stage and nextStep. For navigation failures check the server task and URL; for inspection failures check current selectors and state before retrying.",
	},
	{
		// Production deploys (live session 2026-09-24 pushed to a production
		// remote) are where "done" must be checked against the real site.
		key: "deploy-verify-live",
		tools: ["bash"],
		line: "After this deploy, verify the LIVE bytes, not the push: fetch each changed asset from the production URL and compare its sha256 with the local file (curl -s URL | sha256sum). A replaced image/CSS/JS served with a long Cache-Control max-age needs a new URL (?v=hash) or a cache purge, or returning visitors keep the old bytes. Keep the previous revision reachable for rollback. For public pages re-run seo_toolkit audit on the production canonical origin for status/robots/canonical/sitemap/schema/links/discovery/cache parity.",
		when: contains(DEPLOY),
	},
];

/** Reuse guidance already delivered on this branch after a worker restart.
 * Exact current lines only: edited rules are offered again. This is advisory
 * suppression, never evidence that a check ran or a requirement passed. */
export function restoredHookKeys(entries: readonly any[]): Set<string> {
	const lines = new Map(HOOK_RULES.map(rule => [`[session-hooks] ${rule.line}`, rule]));
	const shown = new Set<string>();
	for (const entry of entries) {
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role !== "toolResult" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const rule = part?.type === "text" && lines.get(part.text);
			if (rule && rule.tools.includes(message.toolName)) shown.add(rule.key);
		}
		if (shown.size === lines.size) break;
	}
	return shown;
}

/** First matching rule for a tool call, or null when no hook applies. */
export function matchHook(
	toolName: string,
	args: HookArgs = {},
	onError = false,
	result?: { details?: any; content?: unknown },
): HookRule | null {
	for (const rule of HOOK_RULES) {
		if (!!rule.onError !== onError) continue;
		if (!rule.tools.includes(toolName)) continue;
		if (rule.when && !rule.when(args)) continue;
		if (rule.key === 'browser-session-recovery') {
			const failure = result?.details?.failure;
			const text = Array.isArray(result?.content) ? result.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join(' ') : '';
			if (failure?.outcome !== 'unknown' && (failure?.outcome || !/\b(?:timeout|timed out|TimeoutError)\b/i.test(text))) continue;
		}
		return rule;
	}
	return null;
}

/**
 * Conservative "the search found nothing" check over tool-result content.
 * Unknown/ambiguous shapes return false so the hook stays silent rather
 * than annotating a result that did contain matches.
 */
/** A deploy command that ran successfully (same catalogue as deploy-verify-live). */
export function isDeployCommand(toolName: string, args: HookArgs): boolean {
	return toolName === "bash" && DEPLOY.test(bashCommand(args));
}

const LOCAL_URL = /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?:[:/]|$)/i;
const REMOTE_FETCH = /\b(?:curl|wget)\b[^\n]*?(https?:\/\/[^\s'"|;)]+)/g;
const BYTE_COMPARISON = /\b(?:sha(?:1|224|256|384|512)sum|shasum|md5sum|b2sum|cmp|diff|openssl\s+dgst|wc\s+-c)\b|size_download|content-length|etag/i;

/** Evidence that the live site's bytes were compared after a deploy: a remote
 * (non-loopback) fetch combined with a hash, byte or header comparison, or a
 * remote http_request (which reports status, content-length and ETag). A
 * status-only probe or a grep of the HTML proves the page answers, not that the
 * changed bytes are what visitors get. */
export function isLiveByteVerification(toolName: string, args: HookArgs): boolean {
	if (toolName === "http_request") {
		const url = typeof args.url === "string" ? args.url : "";
		return /^https?:\/\//i.test(url) && !LOCAL_URL.test(url);
	}
	if (toolName !== "bash") return false;
	const command = bashCommand(args);
	const remote = [...command.matchAll(REMOTE_FETCH)].some((match) => !LOCAL_URL.test(match[1]));
	return remote && BYTE_COMPARISON.test(command);
}

/** Core read/ls/grep/find/edit attach their own nearest-folder hint (core/tools/path-hints.js). */
export const CORE_PATH_HINT_TOOLS: ReadonlySet<string> = new Set(["read", "ls", "grep", "find", "edit"]);

const MISSING_PATH_PATTERNS: readonly RegExp[] = [
	/ENOENT: no such file or directory, \w+ '([^'\n]{1,400})'/,
	/No such file or directory: '([^'\n]{1,400})'/,
	/cannot (?:access|open|stat) '([^'\n]{1,400})': No such file or directory/,
	/(?:^|\n)[\w.-]+: ([^\s:'"][^:'"\n]{0,399}): No such file or directory/,
	/(?:^|[\s"'`])((?:\/|\.{1,2}\/|~\/)[^\s'"`]{1,400}) does not exist\b/,
];

/**
 * The path a failed tool result says is missing, or undefined. Only the first
 * recognizable "no such file" shape counts; the caller still checks that the
 * path is really absent before hinting, so a stale mention never yields advice.
 */
export function missingPathFromError(text: unknown): string | undefined {
	if (typeof text !== "string" || !text || text.includes("Nearest existing directory")) return undefined;
	for (const pattern of MISSING_PATH_PATTERNS) {
		const found = pattern.exec(text)?.[1]?.trim().replace(/[.,;:]+$/, "");
		if (found && (found.includes("/") || /\.\w{1,8}$/.test(found))) return found;
	}
	return undefined;
}

/* ---------- Nested-scope instructions ----------
 * Core loads AGENTS.md/CLAUDE.md from the cwd and its ancestors into the system
 * prompt. Directories strictly below cwd are never loaded, so when a file tool
 * first touches one, its instruction file is offered once in the tool result. */

/** Core's per-directory candidates in precedence order (core resource-loader). */
export const NESTED_INSTRUCTION_FILES: readonly string[] = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
];
export const NESTED_INSTRUCTION_MAX_BYTES = 16384;
export const NESTED_INSTRUCTION_MAX_PER_RESULT = 3;
export const NESTED_INSTRUCTION_KEY_PREFIX = "nested-instructions:";
const NESTED_INSTRUCTION_HEADER = "<system-reminder>\nAdditional instructions from: ";
const NESTED_PATH_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write", "ls", "find", "grep", "read_many"]);
/** ls/find/grep may name a directory; read/edit/write always name a file. */
const DIRECTORY_TARGET_TOOLS: ReadonlySet<string> = new Set(["ls", "find", "grep"]);
const MAX_PATHS_PER_CALL = 16;
/** Dependency and tool directories carry third-party instruction files, not project guidance. */
const isForeignSegment = (segment: string): boolean =>
	segment.startsWith(".") || segment === "node_modules" || segment === "site-packages" || segment === "vendor";

export interface NestedInstructionBlock {
	/** `nested-instructions:<absolute file path>`, the once-per-session key. */
	key: string;
	/** The system-reminder text appended to the tool result. */
	text: string;
}

/** Path strings a file tool call names. read_many lists one per file. */
export function nestedInstructionPaths(toolName: string, input: HookArgs): string[] {
	if (!NESTED_PATH_TOOLS.has(toolName)) return [];
	const raw: unknown[] = toolName === "read_many"
		? (Array.isArray(input.files) ? (input.files as any[]).slice(0, MAX_PATHS_PER_CALL).map((file) => file?.path) : [])
		: [input.path];
	return raw.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 4096);
}

const isRegularFile = (file: string): boolean => {
	try { return fs.statSync(file).isFile(); } catch { return false; }
};
const isDirectory = (dir: string): boolean => {
	try { return fs.statSync(dir).isDirectory(); } catch { return false; }
};

/** realpath of the longest existing prefix, with the missing tail re-attached. */
function realpathPrefix(target: string): string {
	const tail: string[] = [];
	let current = target;
	for (;;) {
		try { return nodePath.join(fs.realpathSync(current), ...tail); } catch { /* walk up */ }
		const parent = nodePath.dirname(current);
		if (parent === current) return target;
		tail.unshift(nodePath.basename(current));
		current = parent;
	}
}

/** Path segments of `target` strictly below `root`; undefined for root itself or anything outside it. */
function segmentsBelow(root: string, target: string): string[] | undefined {
	const rel = nodePath.relative(root, target);
	if (!rel || nodePath.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${nodePath.sep}`)) return undefined;
	return rel.split(nodePath.sep);
}

/** Reads at most NESTED_INSTRUCTION_MAX_BYTES; a cut never splits a UTF-8 character. */
function readInstructionHead(file: string): { text: string; bytes: number } | undefined {
	let fd: number | undefined;
	try {
		const bytes = fs.statSync(file).size;
		// One look-ahead byte tells whether the cut at the limit splits a character.
		const want = Math.min(bytes, NESTED_INSTRUCTION_MAX_BYTES + 1);
		const buffer = Buffer.alloc(want);
		fd = fs.openSync(file, "r");
		let got = 0;
		while (got < want) {
			const n = fs.readSync(fd, buffer, got, want - got, got);
			if (n === 0) break;
			got += n;
		}
		if (got <= NESTED_INSTRUCTION_MAX_BYTES) return { text: buffer.subarray(0, got).toString("utf8"), bytes };
		let end = NESTED_INSTRUCTION_MAX_BYTES;
		// A continuation byte at `end` belongs to a character that starts earlier; back up to its lead byte.
		while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
		return { text: buffer.subarray(0, end).toString("utf8"), bytes };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* best effort */ }
		}
	}
}

/** Stored text sits inside a system-reminder, so an inner closing tag must not end it early. */
const escapeReminder = (text: string): string => text.split("</system-reminder>").join("<\\/system-reminder>");

function instructionReminder(dirSegments: readonly string[], name: string, head: { text: string; bytes: number }): string {
	const fromPath = [...dirSegments, name].join("/");
	const scope = dirSegments.join("/");
	const truncated = head.bytes > NESTED_INSTRUCTION_MAX_BYTES
		? `\n[truncated: showing first ${NESTED_INSTRUCTION_MAX_BYTES} of ${head.bytes} bytes; read the file for the rest]`
		: "";
	return `${NESTED_INSTRUCTION_HEADER}${fromPath}\n\nThese instructions apply to work under \`${scope}\`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.\n\n${escapeReminder(head.text)}${truncated}\n</system-reminder>`;
}

/**
 * Instruction files a successful file-tool call should carry. For each named
 * path strictly inside `cwd`, the first existing candidate of each directory
 * from cwd's child down to the path's directory, broad to specific. Keys in
 * `shown` are skipped and not counted; at most NESTED_INSTRUCTION_MAX_PER_RESULT
 * are returned. The caller marks the returned keys as shown. Never throws.
 */
export function nestedInstructionBlocks(options: {
	cwd: string;
	toolName: string;
	input: HookArgs;
	shown: ReadonlySet<string>;
}): NestedInstructionBlock[] {
	const blocks: NestedInstructionBlock[] = [];
	try {
		const { cwd, toolName, input, shown } = options;
		if (typeof cwd !== "string" || !cwd) return blocks;
		const base = nodePath.resolve(cwd);
		const root = realpathPrefix(base);
		const seen = new Set<string>();
		for (const raw of nestedInstructionPaths(toolName, input)) {
			if (blocks.length >= NESTED_INSTRUCTION_MAX_PER_RESULT) break;
			const expanded = raw.replace(/^~(?=\/|$)/, os.homedir());
			const target = realpathPrefix(nodePath.resolve(base, expanded));
			const dir = DIRECTORY_TARGET_TOOLS.has(toolName) && isDirectory(target) ? target : nodePath.dirname(target);
			const segments = segmentsBelow(root, dir);
			if (!segments || segments.some(isForeignSegment)) continue;
			for (let depth = 1; depth <= segments.length; depth++) {
				if (blocks.length >= NESTED_INSTRUCTION_MAX_PER_RESULT) break;
				const dirSegments = segments.slice(0, depth);
				const dirAbs = nodePath.join(base, ...dirSegments);
				const name = NESTED_INSTRUCTION_FILES.find((candidate) => isRegularFile(nodePath.join(dirAbs, candidate)));
				if (!name) continue;
				const key = NESTED_INSTRUCTION_KEY_PREFIX + nodePath.join(dirAbs, name);
				if (shown.has(key) || seen.has(key)) continue;
				seen.add(key);
				const head = readInstructionHead(nodePath.join(dirAbs, name));
				if (!head || head.text.trim() === "") continue;
				blocks.push({ key, text: instructionReminder(dirSegments, name, head) });
			}
		}
	} catch {
		/* Discovery is advisory: a failure adds nothing to the result. */
	}
	return blocks;
}

/**
 * Nested-instruction keys already delivered on this branch. Each delivered
 * block names its file relative to the session cwd in its header, so the key
 * is recovered by resolving that path against `cwd`.
 */
export function restoredNestedInstructionKeys(entries: readonly any[], cwd: string | undefined): Set<string> {
	const shown = new Set<string>();
	if (typeof cwd !== "string" || !cwd) return shown;
	for (const entry of entries) {
		// A compaction summarized earlier deliveries away; only later ones are still in context.
		if (entry?.type === "compaction") shown.clear();
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role !== "toolResult" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const text = part?.type === "text" && typeof part.text === "string" ? part.text : "";
			if (!text.startsWith(NESTED_INSTRUCTION_HEADER)) continue;
			const end = text.indexOf("\n", NESTED_INSTRUCTION_HEADER.length);
			if (end < 0) continue;
			const rel = text.slice(NESTED_INSTRUCTION_HEADER.length, end);
			if (!NESTED_INSTRUCTION_FILES.includes(nodePath.basename(rel))) continue;
			shown.add(NESTED_INSTRUCTION_KEY_PREFIX + nodePath.resolve(cwd, rel));
		}
	}
	return shown;
}

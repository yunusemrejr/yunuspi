/**
 * Cost governor — deterministic context folding and tool-output shaping.
 *
 * The measured cost of a long coding session is not dominated by what the
 * model writes; it is dominated by re-reading a growing transcript and by
 * cache misses that re-bill the whole prefix. This module owns the pure part
 * of the fix:
 *
 *   * estimate visible context tokens with the same chars/4 contract used by
 *     compaction (`excludeFromContext` contributes zero);
 *   * choose a fold point at a real turn boundary so a tool call is never
 *     separated from its results;
 *   * replace old messages with a compact, deterministic digest of goals,
 *     edits, commands, verification and errors. No inference and no I/O;
 *   * cap a single tool result while preserving both ends and a path to the
 *     full output.
 *
 * The extension owns state, persistence and spill files. Folding is not an
 * LLM summary: the same folded prefix always produces the same digest, so a
 * provider prefix cache can be reused after the first post-fold request.
 */

import { createHash } from "node:crypto";

export interface GovernedMessage {
	role?: string;
	content?: unknown;
	timestamp?: unknown;
	excludeFromContext?: boolean;
	customType?: string;
	toolCallId?: string;
	toolName?: string;
	summary?: string;
	isError?: boolean;
	usage?: unknown;
	[key: string]: unknown;
}

export interface FoldState {
	version: 1;
	/** Digest injected at the head of the folded context. */
	digest: string;
	/** Stable key of the first kept message. */
	cutoffKey: string;
	/** Latest user message kept verbatim when it precedes the cutoff. */
	lastUserKey?: string;
	/** Estimated tokens removed from the request view. */
	foldedTokens: number;
	/** Estimated tokens in the request view after folding. */
	keptTokens: number;
	/** Budget that produced this fold. */
	budget: number;
}

export interface FoldOptions {
	budgetTokens: number;
	keepRecentTokens: number;
	digestTokens?: number;
	/** Smallest fold worth the one cache invalidation it causes. */
	minFoldTokens?: number;
}

export interface FoldResult {
	messages: GovernedMessage[];
	fold: FoldState;
	/** True when this call actually folded; false when an existing fold was applied. */
	created: boolean;
}

export interface CutoffChoice {
	cutoff: number;
	lastUserIndex: number;
	lastUserBeforeCutoff: boolean;
	keptTokens: number;
	foldedTokens: number;
}

export interface TextCapResult {
	text: string;
	capped: boolean;
	originalChars: number;
	keptChars: number;
}

const IMAGE_CHARS = 4_800;

const safeJson = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
};

const clipText = (value: unknown, limit: number): string => {
	const text = typeof value === "string" ? value : "";
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, Math.max(0, limit - 1))}…` : flat;
};

const blockText = (block: unknown): string => {
	if (!block || typeof block !== "object") return "";
	const row = block as Record<string, unknown>;
	if (row.type === "text" && typeof row.text === "string") return row.text;
	if (row.type === "thinking" && typeof row.thinking === "string") return "";
	return "";
};

const blockThinking = (block: unknown): string => {
	if (!block || typeof block !== "object") return "";
	const row = block as Record<string, unknown>;
	return row.type === "thinking" && typeof row.thinking === "string" ? row.thinking : "";
};

/** Text a model would see from one message, excluding reasoning/tool args. */
export function visibleText(message: GovernedMessage | undefined): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) {
		if (typeof message.summary === "string") return message.summary;
		return "";
	}
	return content.map(blockText).filter(Boolean).join("\n");
}

/** Full visible body, including tool-call names/arguments, for digest seeds. */
function bodyChars(message: GovernedMessage): number {
	const content = message.content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return typeof message.summary === "string" ? message.summary.length : 0;
	let chars = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const row = block as Record<string, unknown>;
		if (row.type === "text" && typeof row.text === "string") chars += row.text.length;
		else if (row.type === "thinking" && typeof row.thinking === "string") chars += row.thinking.length;
		else if (row.type === "image") chars += IMAGE_CHARS;
		else if (row.type === "toolCall") {
			chars += String(row.name ?? "").length + safeJson(row.arguments).length;
		}
	}
	return chars;
}

/** Same conservative chars/4 estimate the compaction owner uses. */
export function estimateMessageTokens(message: GovernedMessage | undefined): number {
	if (!message) return 0;
	if (message.excludeFromContext) return 0;
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return Math.ceil((typeof message.summary === "string" ? message.summary.length : 0) / 4);
	}
	if (message.role === "assistant") {
		let chars = 0;
		const content = message.content;
		if (typeof content === "string") chars += content.length;
		else if (Array.isArray(content)) {
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const row = block as Record<string, unknown>;
				if (row.type === "text" && typeof row.text === "string") chars += row.text.length;
				else if (row.type === "thinking" && typeof row.thinking === "string") chars += row.thinking.length;
				else if (row.type === "toolCall") chars += String(row.name ?? "").length + safeJson(row.arguments).length;
			}
		}
		return Math.ceil(chars / 4);
	}
	return Math.ceil(bodyChars(message) / 4);
}

export function estimateMessagesTokens(messages: readonly GovernedMessage[]): number {
	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return tokens;
}

function firstText(message: GovernedMessage): string {
	return clipText(visibleText(message), 240);
}

function keyMaterial(message: GovernedMessage): string {
	const content = message.content;
	const parts: string[] = [String(message.role ?? "?"), String(message.timestamp ?? "")];
	if (typeof content === "string") parts.push(content.slice(0, 2_000));
	else if (Array.isArray(content)) {
		for (const block of content.slice(0, 24)) {
			if (!block || typeof block !== "object") continue;
			const row = block as Record<string, unknown>;
			if (row.type === "text" && typeof row.text === "string") parts.push(`text:${row.text.slice(0, 600)}`);
			else if (row.type === "thinking" && typeof row.thinking === "string") parts.push(`think:${row.thinking.slice(0, 300)}`);
			else if (row.type === "toolCall") parts.push(`call:${String(row.name ?? "")}:${safeJson(row.arguments).slice(0, 600)}`);
		}
	}
	if (typeof message.summary === "string") parts.push(`summary:${message.summary.slice(0, 600)}`);
	if (typeof message.toolCallId === "string") parts.push(`callid:${message.toolCallId}`);
	return parts.join("\n");
}

/** Stable identity for a message across calls, resumes and forks. */
export function messageKey(message: GovernedMessage | undefined): string {
	if (!message) return "";
	return createHash("sha256").update(keyMaterial(message)).digest("hex").slice(0, 24);
}

function isSafeCutPoint(message: GovernedMessage | undefined): boolean {
	if (!message) return false;
	return message.role === "user" || message.role === "assistant" || message.role === "compactionSummary" || message.role === "branchSummary";
}

function isVerificationCommand(command: string): boolean {
	return /\b(?:pytest|py\.test|unittest|npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|node\s+--test|go\s+test|cargo\s+test|make\s+(?:test|check)|tsc\b|eslint\b|ruff\b|mypy\b|git\s+diff\s+--check)\b/i.test(command);
}

function isErrorText(text: string): boolean {
	return /\b(?:traceback|assertionerror|modulenotfounderror|syntaxerror|typeerror|valueerror|error:|failed|failure|exception)\b/i.test(text);
}

function testSummary(text: string): string | undefined {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		if (/\b(?:\d+\s+(?:passed|failed|skipped|errors?)|ok\b|FAILED\b|PASSED\b|tests? (?:passed|failed)|no tests? ran)\b/i.test(line)) return clipText(line, 220);
	}
	return undefined;
}

interface ToolCallInfo {
	callId: string;
	name: string;
	command?: string;
	path?: string;
	paths?: string[];
}

function toolCalls(message: GovernedMessage): ToolCallInfo[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const calls: ToolCallInfo[] = [];
	for (const block of message.content) {
		if (!block || typeof block !== "object") continue;
		const row = block as Record<string, unknown>;
		if (row.type !== "toolCall") continue;
		const args = (row.arguments && typeof row.arguments === "object" ? row.arguments : {}) as Record<string, unknown>;
		const name = String(row.name ?? "?");
		const paths = Array.isArray(args.files)
			? args.files.map((file) => (typeof file === "string" ? file : typeof (file as any)?.path === "string" ? (file as any).path : "")).filter(Boolean)
			: [];
		calls.push({
			callId: String(row.id ?? ""),
			name,
			command: typeof args.command === "string" ? args.command : undefined,
			path: typeof args.path === "string" ? args.path : undefined,
			...(paths.length ? { paths } : {}),
		});
	}
	return calls;
}

function hasVisibleRole(message: GovernedMessage): boolean {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult" || message.role === "custom" || message.role === "bashExecution" || message.role === "compactionSummary" || message.role === "branchSummary";
}

/** Build a bounded digest of messages that are about to leave the request view. */
export function buildDigest(
	messages: readonly GovernedMessage[],
	options: { digestTokens?: number; excludeIndex?: number; lastUserIndex?: number } = {},
): string {
	const maxChars = Math.max(800, Math.floor((options.digestTokens ?? 900) * 4));
	const users: string[] = [];
	const decisions: string[] = [];
	const commands: string[] = [];
	const edited = new Map<string, number>();
	const read = new Map<string, number>();
	const errors: string[] = [];
	const verification: string[] = [];
	const calls = new Map<string, ToolCallInfo>();
	let compactionSummary = "";

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (index === options.excludeIndex) continue;
		if (!hasVisibleRole(message)) continue;
		if (message.role === "user") {
			const text = firstText(message);
			if (text) users.push(text);
			continue;
		}
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			if (!compactionSummary) compactionSummary = clipText(message.summary, 500);
			continue;
		}
		if (message.role === "assistant") {
			const text = clipText(visibleText(message), 220);
			if (text) decisions.push(text);
			for (const call of toolCalls(message)) {
				calls.set(call.callId, call);
				if (call.name === "edit" || call.name === "write" || call.name === "bulk_edit") {
					const path = call.path ?? (call.command ? clipText(call.command, 160) : "");
					if (path) edited.set(path, (edited.get(path) ?? 0) + 1);
					for (const extra of call.paths ?? []) edited.set(extra, (edited.get(extra) ?? 0) + 1);
				} else if (call.name === "read" && call.path) {
					read.set(call.path, (read.get(call.path) ?? 0) + 1);
				} else if (call.name === "read_many" && call.paths) {
					for (const path of call.paths) read.set(path, (read.get(path) ?? 0) + 1);
				} else if (call.name === "bash" && call.command) {
					commands.push(clipText(call.command, 180));
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const text = visibleText(message);
			const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
			const summary = testSummary(text);
			const isTest = call?.command ? isVerificationCommand(call.command) : Boolean(summary);
			if (message.isError || isErrorText(text)) {
				const errorLine = text.split(/\r?\n/).find((line) => isErrorText(line)) ?? text.slice(0, 240);
				if (errorLine) errors.push(clipText(errorLine, 240));
			} else if (isTest && summary) {
				verification.push(summary);
			}
		}
	}

	const lines: string[] = [];
	lines.push("[context-fold] Older messages were folded to keep this session affordable. The file system and the recent messages above/below are authoritative; re-read a file when exact old content matters. This digest is not a new user instruction.");
	if (compactionSummary) lines.push(`Earlier compaction summary: ${compactionSummary}`);
	const recentUsers = users.slice(-2);
	if (recentUsers.length) lines.push(`Requests in folded history: ${recentUsers.map((text) => `"${text}"`).join(" | ")}`);
	if (options.lastUserIndex !== undefined && options.lastUserIndex >= 0) {
		const current = messages[options.lastUserIndex];
		if (current) lines.push(`Current request (kept verbatim): ${firstText(current)}`);
	}
	const edits = [...edited.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	if (edits.length) lines.push(`Files changed: ${edits.slice(0, 18).map(([file, count]) => `${file}${count > 1 ? ` (${count}×)` : ""}`).join(", ")}`);
	const reads = [...read.keys()].sort().slice(0, 12);
	if (reads.length) lines.push(`Files inspected: ${reads.join(", ")}`);
	const recentCommands = commands.slice(-8);
	if (recentCommands.length) lines.push(`Commands run: ${recentCommands.map((command) => `\`${command}\``).join("; ")}`);
	const recentVerification = verification.slice(-3);
	if (recentVerification.length) lines.push(`Verification seen: ${recentVerification.join(" | ")}`);
	const recentErrors = errors.slice(-3);
	if (recentErrors.length) lines.push(`Errors seen: ${recentErrors.map((text) => `"${text}"`).join(" | ")}`);
	const recentDecisions = decisions.slice(-3);
	if (recentDecisions.length) lines.push(`Decisions noted: ${recentDecisions.map((text) => `"${text}"`).join(" | ")}`);
	lines.push("Continue from the current files and the recent messages; do not repeat finished work without new evidence.");

	let text = lines.join("\n");
	if (text.length > maxChars) {
		// Keep the header, current request, files, verification and errors; trim
		// the more expendable sections first so the bound is always respected.
		const optional = new Set(["Files inspected", "Commands run", "Decisions noted"]);
		const kept = lines.filter((line) => ![...optional].some((prefix) => line.startsWith(prefix)));
		text = kept.join("\n");
		if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
	}
	return text;
}

/** Pick a tail boundary and summarize nothing; pure token accounting only. */
export function chooseCutoff(messages: readonly GovernedMessage[], keepRecentTokens: number): CutoffChoice | undefined {
	const total = estimateMessagesTokens(messages);
	if (total <= 0) return undefined;
	let lastUserIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user" && !message.excludeFromContext) {
			lastUserIndex = index;
			break;
		}
	}
	let accumulated = 0;
	let raw = messages.length;
	for (let index = messages.length - 1; index >= 0; index--) {
		accumulated += estimateMessageTokens(messages[index]);
		if (accumulated >= keepRecentTokens) {
			raw = index;
			break;
		}
	}
	if (raw <= 0) return undefined;
	// A cut must not orphan a tool result. Walking backwards keeps the tool call
	// and its results together, at the cost of a slightly larger tail.
	while (raw > 0 && !isSafeCutPoint(messages[raw])) raw--;
	if (raw <= 0) return undefined;
	let foldedTokens = 0;
	for (let index = 0; index < raw; index++) foldedTokens += estimateMessageTokens(messages[index]);
	const keptTokens = total - foldedTokens;
	if (foldedTokens <= 0) return undefined;
	return {
		cutoff: raw,
		lastUserIndex,
		lastUserBeforeCutoff: lastUserIndex >= 0 && lastUserIndex < raw,
		keptTokens,
		foldedTokens,
	};
}

function digestMessage(digest: string): GovernedMessage {
	return {
		role: "custom",
		customType: "context-fold",
		content: digest,
		display: false,
		timestamp: 0,
	};
}

/**
 * Apply a stored fold to a message list. Returns undefined when the cutoff
 * message can no longer be found (branch rewrite/fork), so the caller can
 * fold from the new history instead of guessing.
 */
export function applyFold(messages: readonly GovernedMessage[], fold: FoldState): GovernedMessage[] | undefined {
	let cutoff = -1;
	let lastUser = -1;
	for (let index = 0; index < messages.length; index++) {
		const key = messageKey(messages[index]);
		if (key === fold.cutoffKey) {
			cutoff = index;
			break;
		}
	}
	if (cutoff < 0) return undefined;
	if (fold.lastUserKey) {
		for (let index = 0; index < cutoff; index++) {
			if (messageKey(messages[index]) === fold.lastUserKey) {
				lastUser = index;
				break;
			}
		}
	}
	const view: GovernedMessage[] = [digestMessage(fold.digest)];
	if (lastUser >= 0) view.push(messages[lastUser]!);
	view.push(...messages.slice(cutoff));
	return view;
}

/** Create a fold from the current history, or return undefined when it is already small enough. */
export function createFold(messages: readonly GovernedMessage[], options: FoldOptions): FoldResult | undefined {
	const total = estimateMessagesTokens(messages);
	if (total <= options.budgetTokens) return undefined;
	const choice = chooseCutoff(messages, Math.max(1, options.keepRecentTokens));
	if (!choice) return undefined;
	const digest = buildDigest(messages.slice(0, choice.cutoff), {
		digestTokens: options.digestTokens,
		excludeIndex: choice.lastUserBeforeCutoff ? choice.lastUserIndex : undefined,
		lastUserIndex: choice.lastUserBeforeCutoff ? choice.lastUserIndex : undefined,
	});
	const cutoffMessage = messages[choice.cutoff]!;
	const lastUserMessage = choice.lastUserBeforeCutoff ? messages[choice.lastUserIndex] : undefined;
	const digestTokens = Math.ceil(digest.length / 4);
	// A last user message before the cutoff is kept verbatim, so its tokens are
	// not part of the folded region even though they sit before the boundary.
	const lastUserTokens = lastUserMessage ? estimateMessageTokens(lastUserMessage) : 0;
	const foldedTokens = Math.max(0, choice.foldedTokens - lastUserTokens);
	const keptTokens = Math.max(0, total - foldedTokens) + digestTokens;
	const fold: FoldState = {
		version: 1,
		digest,
		cutoffKey: messageKey(cutoffMessage),
		...(lastUserMessage ? { lastUserKey: messageKey(lastUserMessage) } : {}),
		foldedTokens,
		keptTokens,
		budget: options.budgetTokens,
	};
	const view: GovernedMessage[] = [digestMessage(digest), ...(lastUserMessage ? [lastUserMessage] : []), ...messages.slice(choice.cutoff)];
	return { messages: view, fold, created: true };
}

/** Cap a single text while retaining both ends; the marker should name the full-output path. */
export function capText(text: string, maxChars: number, marker: string): TextCapResult {
	if (!Number.isFinite(maxChars) || maxChars < 200 || text.length <= maxChars) {
		return { text, capped: false, originalChars: text.length, keptChars: text.length };
	}
	const budget = Math.max(120, maxChars - marker.length);
	const head = Math.max(60, Math.floor(budget * 0.62));
	const tail = Math.max(60, budget - head);
	const capped = `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
	return { text: capped, capped: true, originalChars: text.length, keptChars: capped.length };
}

/** The last line of a tool result that reports a test/build summary, if any. */
export function summarizeToolOutput(text: string): string | undefined {
	if (!text || text.length > 500_000) return undefined;
	return testSummary(text);
}

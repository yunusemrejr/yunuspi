import { createHash } from "node:crypto";

export const GUARDIAN_FEATURE_NAMES = Object.freeze([
	"matchingFailureCount",
	"argumentShapeSimilarity",
	"failureRatio",
	"observedResponseAfterFailure",
	"noPriorSuccess",
	"freshness",
	"sameTool",
	"activeTaskLineage",
	"exactInputFingerprint",
	"typedToolFailure",
	"independentRetryEpisodes",
	"noExplicitRetryDirective",
]);

const SECRET_KEY = /(?:api.?key|token|password|secret|credential|authorization|cookie)/i;
const MAX_STRING_LENGTH = 16384;
const MAX_OBJECT_KEYS = 256;
const MAX_ARRAY_ITEMS = 1024;
const MAX_NODES = 4096;

function boundedEntries(value) {
	const entries = [];
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		entries.push(key);
		if (entries.length > MAX_OBJECT_KEYS) return undefined;
	}
	return entries.sort((a, b) => a.localeCompare(b));
}

function hashValue(hash, value, state, depth = 0) {
	if (++state.nodes > MAX_NODES || depth > 8) return false;
	if (value === null) { hash.update("null;"); return true; }
	if (typeof value === "string") {
		if (value.length > MAX_STRING_LENGTH) return false;
		hash.update("string:").update(String(value.length)).update(":").update(value).update(";");
		return true;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return false;
		hash.update(`number:${Object.is(value, -0) ? "-0" : value};`);
		return true;
	}
	if (typeof value === "boolean") { hash.update(value ? "boolean:1;" : "boolean:0;"); return true; }
	if (typeof value === "bigint") { hash.update(`bigint:${value};`); return true; }
	if (typeof value !== "object") return false;
	if (state.path.has(value)) return false;
	state.path.add(value);
	let valid = true;
	if (Array.isArray(value)) {
		if (value.length > MAX_ARRAY_ITEMS) valid = false;
		else {
			hash.update(`array:${value.length}[`);
			for (const item of value) if (!hashValue(hash, item, state, depth + 1)) { valid = false; break; }
			hash.update("];");
		}
	} else {
		const keys = boundedEntries(value);
		if (!keys) valid = false;
		else {
			hash.update(`object:${keys.length}{`);
			for (const key of keys) {
				if (key.length > 256) { valid = false; break; }
				hash.update("key:").update(key).update("=");
				if (!hashValue(hash, value[key], state, depth + 1)) { valid = false; break; }
			}
			hash.update("};");
		}
	}
	state.path.delete(value);
	return valid;
}

export function fingerprintToolCall(toolName, args) {
	if (typeof toolName !== "string" || toolName.length < 1 || toolName.length > 128 || args === undefined) return undefined;
	const hash = createHash("sha256");
	hash.update("guardian-tool-v1\0").update(toolName).update("\0");
	if (!hashValue(hash, args, { nodes: 0, path: new WeakSet() })) return undefined;
	return hash.digest("hex");
}

function argumentShape(value, state, depth = 0) {
	if (++state.nodes > MAX_NODES || depth > 8) return undefined;
	if (value === null) return "null";
	if (Array.isArray(value)) return value.length <= MAX_ARRAY_ITEMS ? `array:${value.length ? argumentShape(value[0], state, depth + 1) : "empty"}` : undefined;
	if (typeof value !== "object") return typeof value;
	if (state.path.has(value)) return undefined;
	state.path.add(value);
	const keys = boundedEntries(value);
	let result;
	if (keys) {
		const safeKeys = keys.filter((key) => !SECRET_KEY.test(key));
		const parts = safeKeys.map((key) => {
			const child = argumentShape(value[key], state, depth + 1);
			return child === undefined ? undefined : `${key}:${child}`;
		});
		if (parts.every((part) => part !== undefined)) result = parts.join("|");
	}
	state.path.delete(value);
	return result;
}

export function safeToolShape(toolName, args) {
	if (typeof toolName !== "string" || args === undefined) return undefined;
	const shape = argumentShape(args, { nodes: 0, path: new WeakSet() });
	if (shape === undefined) return undefined;
	return `${toolName.slice(0, 128)}|${shape}`.slice(0, 512);
}

// Generated identifiers, clock readings, elapsed times and temporary paths
// change on every attempt, so a retried failure would never look identical.
// Plain numbers (line numbers, counts, status codes) stay significant.
const VOLATILE_FAILURE_TEXT = [
	[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
	[/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>"],
	[/(?:\/tmp|\/var\/folders)\/[^\s'"`:,)]+/g, "<tmp>"],
	[/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<hex>"],
	[/\b1[6-9]\d{8}(?:\d{3})?\b/g, "<epoch>"],
	[/\b\d+(?:\.\d+)?\s?(?:ms|milliseconds?|s|secs?|seconds?)\b/gi, "<duration>"],
];

export function normalizeFailureText(text) {
	let normalized = text;
	for (const [pattern, token] of VOLATILE_FAILURE_TEXT) normalized = normalized.replace(pattern, token);
	return normalized;
}

export function fingerprintFailureResult(result, isError) {
	if (!isError || !result || typeof result !== "object" || !Array.isArray(result.content)) return undefined;
	const pieces = [];
	let total = 0;
	for (const item of result.content.slice(0, 64)) {
		if (!item || item.type !== "text" || typeof item.text !== "string") continue;
		total += item.text.length;
		if (total > 4096) return undefined;
		pieces.push(item.text);
	}
	if (!pieces.length) return undefined;
	return createHash("sha256").update("guardian-error-v2\0").update(normalizeFailureText(pieces.join("\n"))).digest("hex");
}

function norm(value) {
	return Math.max(0, Math.min(1000, Math.round(Number.isFinite(value) ? value : 0)));
}

export function makeRepeatedFailureFeatures({
	priorAttempts,
	shapeSimilarity,
	activeTaskId,
	now = Date.now(),
	userRetryDirective = false,
}) {
	const failures = priorAttempts.filter((attempt) => attempt.failed);
	const failureCount = failures.length;
	const countFeature = norm(Math.min(1000, failureCount * 320));
	const allFailed = priorAttempts.length > 0 && failureCount === priorAttempts.length;
	const responseRatio = failureCount === 0 ? 0 : failures.filter((attempt) => attempt.responseSeen).length / failureCount;
	const lastFailureAt = failures.reduce((latest, attempt) => Math.max(latest, attempt.at), 0);
	const age = lastFailureAt > 0 ? Math.max(0, now - lastFailureAt) : Number.POSITIVE_INFINITY;
	const freshness = Number.isFinite(age) ? norm(1000 * Math.max(0, 1 - age / 120000)) : 0;
	const sameTool = priorAttempts.length > 0 && priorAttempts.every((attempt) => attempt.toolName === priorAttempts[0].toolName);
	const sameTask = priorAttempts.length > 0 && Boolean(activeTaskId) && priorAttempts.every((attempt) => attempt.taskId === activeTaskId);
	const independentEpisodes = failureCount >= 2 && failures.length >= 2 && new Set(failures.map((attempt) => attempt.responseEpoch)).size >= 2;
	return [
		countFeature,
		norm(shapeSimilarity),
		norm(priorAttempts.length ? failureCount / priorAttempts.length * 1000 : 0),
		norm(responseRatio * 1000),
		allFailed ? 1000 : 0,
		freshness,
		sameTool ? 1000 : 0,
		sameTask ? 1000 : 0,
		priorAttempts.length > 0 && priorAttempts.every((attempt) => attempt.fingerprint === priorAttempts[0].fingerprint) ? 1000 : 0,
		failureCount > 0 && failures.every((attempt) => attempt.typedFailure) ? 1000 : 0,
		independentEpisodes ? 1000 : 0,
		userRetryDirective ? 0 : 1000,
	];
}

export function hasExplicitRetryDirective(text) {
	if (typeof text !== "string" || !text) return false;
	if (text.length > 131_072) {
		// Inspect every chunk, including the tail, without allocating multiple
		// full-size masked copies. A quoted match may conservatively suppress a
		// reminder; it can never authorize an action or manufacture a constraint.
		for (let start = 0; start < text.length; start += 16_384) {
			if (/\b(?:retr(?:y(?:ing)?|ies)|repeat(?:ing|ed)?|try\s+again)\b/i.test(text.slice(Math.max(0, start - 64), start + 16_384))) return true;
		}
		return false;
	}
	let content = text;
	// Mask fenced and inline code before checking. An unclosed fence masks to EOF.
	content = content.replace(/```[\s\S]*?(?:```|$)/g, (match) => " ".repeat(match.length));
	content = content.replace(/`[^`]*`/g, (match) => " ".repeat(match.length));
	// Quoted examples are not user constraints. This is a conservative veto only.
	content = content.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (match) => " ".repeat(match.length));
	return /\b(?:retr(?:y(?:ing)?|ies)|repeat(?:ing|ed)?|try\s+again)\b/i.test(content);
}

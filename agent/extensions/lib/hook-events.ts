/**
 * Normalized hook event routing with cheap prefilters and shared pure caches.
 *
 * Every hook keeps its full capabilities. What changes is dispatch cost:
 * hooks subscribe to narrow normalized event classes instead of observing
 * every tool call/result, and a cheap prefilter runs before any expensive
 * logic. Common event parsing (tool name, paths, hashes, metadata) happens
 * once per event and is shared across hooks.
 *
 * Pure computations (path normalization, content hashes, tool metadata) are
 * cached by semantic event identity and reused across hooks. Authorization
 * decisions — which depend on mutable state — are never cached.
 *
 * Dependency-free except node:crypto for stable hashing.
 */
import { createHash } from "node:crypto";

export type HookEventClass =
	| "tool-call"
	| "tool-result"
	| "tool-error"
	| "file-read"
	| "file-write"
	| "command-run"
	| "session-turn"
	| "session-switch"
	| "provider-request"
	| "provider-response"
	| "other";

export interface NormalizedHookEvent {
	/** Semantic identity: same cause, same id — the cache key. */
	id: string;
	class: HookEventClass;
	tool?: string;
	/** Normalized paths touched by the event (bounded). */
	paths: string[];
	/** Content hash when the event carries immutable bytes. */
	contentHash?: string;
	/** Milliseconds since epoch. */
	at: number;
	/** Opaque original payload; hooks read through accessors. */
	raw: unknown;
}

export interface HookSubscription {
	hook: string;
	classes: HookEventClass[];
	/** Cheap prefilter: false skips the hook without expensive work. */
	prefilter?: (event: NormalizedHookEvent) => boolean;
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "").slice(0, 512);
}

function stableHash(parts: string[]): string {
	return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

/** Normalize a raw hook payload into one shared representation. */
export function normalizeHookEvent(raw: unknown, at = Date.now()): NormalizedHookEvent {
	const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const tool = typeof record.tool === "string" ? record.tool.slice(0, 128)
		: typeof record.toolName === "string" ? record.toolName.slice(0, 128) : undefined;
	const kind = typeof record.kind === "string" ? record.kind
		: typeof record.phase === "string" ? record.phase
			: typeof record.type === "string" ? record.type : "";
	const lower = `${kind} ${tool ?? ""}`.toLowerCase();
	let eventClass: HookEventClass = "other";
	if (/tool[_. ]?result|result/.test(lower) && /error|fail/.test(lower)) eventClass = "tool-error";
	else if (/tool[_. ]?result/.test(lower)) eventClass = "tool-result";
	else if (/tool[_. ]?call|before.*tool|tool.*start/.test(lower)) eventClass = "tool-call";
	else if (/write|edit|patch|create|delete|mkdir|rm\b/.test(lower)) eventClass = "file-write";
	else if (/read|cat|load|fetch|get\b/.test(lower)) eventClass = "file-read";
	else if (/bash|exec|command|shell|run\b/.test(lower)) eventClass = "command-run";
	else if (/session.*switch|switch.*session/.test(lower)) eventClass = "session-switch";
	else if (/user.*input|turn|message/.test(lower)) eventClass = "session-turn";
	else if (/provider.*(request|call)|before.*provider/.test(lower)) eventClass = "provider-request";
	else if (/provider.*response|assistant/.test(lower)) eventClass = "provider-response";

	const paths: string[] = [];
	const collect = (value: unknown, depth = 0) => {
		if (paths.length >= 16 || depth > 4) return;
		if (typeof value === "string" && value.length <= 1024 && (value.includes("/") || value.includes("\\")) && value.length >= 2) {
			paths.push(normalizePath(value));
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value.slice(0, 16)) collect(entry, depth + 1);
			return;
		}
		if (value && typeof value === "object") {
			for (const [key, entry] of Object.entries(value).slice(0, 32)) {
				if (/path|file|dir|cwd|root/i.test(key)) collect(entry, depth + 1);
			}
		}
	};
	collect(record);
	const content = typeof record.content === "string" ? record.content
		: typeof record.text === "string" ? record.text : undefined;
	const id = stableHash([eventClass, tool ?? "", ...paths.slice(0, 8), content ? stableHash([content.slice(0, 65536)]) : ""]);
	return {
		id,
		class: eventClass,
		...(tool ? { tool } : {}),
		paths: [...new Set(paths)].slice(0, 16),
		...(content ? { contentHash: stableHash([content.slice(0, 65536)]) } : {}),
		at,
		raw,
	};
}

/** Route one event to subscribed hooks whose prefilter passes. Returns hook names to run. */
export function routeHookEvent(event: NormalizedHookEvent, subscriptions: readonly HookSubscription[]): string[] {
	const runnable: string[] = [];
	for (const subscription of subscriptions) {
		if (!subscription.classes.includes(event.class)) continue;
		if (subscription.prefilter) {
			let pass = false;
			try {
				pass = subscription.prefilter(event) === true;
			} catch {
				pass = false;
			}
			if (!pass) continue;
		}
		runnable.push(subscription.hook);
	}
	return runnable;
}

interface CacheEntry {
	value: unknown;
	pinned: boolean;
}

const MAX_CACHE = 2048;
const pureCache = new Map<string, CacheEntry>();

/**
 * Memoize a pure computation by semantic event identity. Only for functions of
 * immutable event data (parsing, hashes, normalization, metadata). NEVER for
 * authorization decisions or anything reading mutable state.
 */
export function cachedPureComputation<T>(event: NormalizedHookEvent, namespace: string, compute: () => T): T {
	const key = `${namespace}\0${event.id}`;
	const hit = pureCache.get(key);
	if (hit) return hit.value as T;
	const value = compute();
	if (pureCache.size >= MAX_CACHE) {
		const oldest = pureCache.keys().next().value;
		if (oldest !== undefined) pureCache.delete(oldest);
	}
	pureCache.set(key, { value, pinned: false });
	return value;
}

/** Cache introspection for diagnostics (sizes only, never keys). */
export function hookCacheStats(): { entries: number; capacity: number } {
	return { entries: pureCache.size, capacity: MAX_CACHE };
}

/** Clear pure caches (tests and session turnover). */
export function clearHookCaches(): void {
	pureCache.clear();
}

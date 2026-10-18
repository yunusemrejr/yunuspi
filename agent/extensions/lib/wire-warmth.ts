/**
 * Wire warmth — is the provider's cached prefix worth protecting right now?
 *
 * Providers bill a cache hit at a fraction of fresh input (DeepSeek ~1/50), so
 * changing anything ahead of the conversation — the system prompt, the tools
 * array, the thinking mode — re-bills the whole transcript at the fresh rate.
 * Measured on 572 real sessions, tool-set and prompt-head changes were the
 * largest avoidable DeepSeek cost, while the same changes at a few thousand
 * tokens cost almost nothing. This helper answers one question for every
 * owner of a volatile head: "would a change here be expensive?"
 *
 * The answer comes from the session itself: the last assistant message records
 * how many prompt tokens the previous request carried, when it finished and on
 * which route. The warm window is the route's cache TTL, so an idle session
 * (cold cache) can still change freely, and a route switch starts cold.
 * Dollar-weighted: a free route is never warm.
 */
import { cacheProfileFor } from "./lean-policy.ts";

/** Prefix rebuild cost (USD, fresh minus cached rate) above which a head change is worth deferring. */
export const WIRE_BUST_BUDGET_USD = 0.004;
/** Token fallback when the route has no price (unknown cost is treated as cache-priced). */
export const WIRE_BUST_FALLBACK_TOKENS = 16_000;
const MAX_LATCHES = 64;
/** Session entry that makes a latched head text survive a restart, a resume or a reload. */
const LATCH_ENTRY = "head-latch-v1";

export interface WireWarmth {
	warm: boolean;
	prefixTokens: number;
	ageMs: number;
	bustUsd: number;
}

const COLD: WireWarmth = { warm: false, prefixTokens: 0, ageMs: Infinity, bustUsd: 0 };

interface LastRequest {
	tokens: number;
	at: number;
	provider?: string;
	model?: string;
}

/** Prompt size, finish time and route of the newest billed assistant request in a branch. */
export function lastRequestPrefix(entries: readonly any[] | undefined): LastRequest | undefined {
	if (!Array.isArray(entries)) return undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role !== "assistant") continue;
		const usage = message.usage;
		if (!usage || typeof usage !== "object") continue;
		const tokens = Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0);
		if (!(tokens > 0)) continue;
		const stamped = Number(message.timestamp);
		const at = Number.isFinite(stamped) && stamped > 0 ? stamped : Date.parse(String(entry.timestamp ?? ""));
		return {
			tokens,
			at: Number.isFinite(at) ? at : 0,
			provider: typeof message.provider === "string" ? message.provider : undefined,
			model: typeof message.model === "string" ? message.model : undefined,
		};
	}
	return undefined;
}

function branchOf(ctx: any): readonly any[] | undefined {
	try {
		return ctx?.sessionManager?.getBranch?.();
	} catch {
		return undefined;
	}
}

/** Price per million tokens above the cache rate; undefined when the route is unpriced. */
function freshPremiumPerMillion(model: any): number | undefined {
	const cost = model?.cost;
	if (!cost || typeof cost !== "object") return undefined;
	const input = Number(cost.input);
	if (!Number.isFinite(input)) return undefined;
	const cached = Number(cost.cacheRead);
	return Math.max(0, input - (Number.isFinite(cached) ? cached : 0));
}

export function wireWarmth(ctx: any, now = Date.now()): WireWarmth {
	const last = lastRequestPrefix(branchOf(ctx));
	if (!last) return COLD;
	const model = ctx?.model;
	// A cache belongs to a route: after a model or provider switch the new route starts cold.
	if (last.provider && model?.provider && last.provider !== model.provider) return COLD;
	if (last.model && model?.id && last.model !== model.id) return COLD;
	const ttlMs = cacheProfileFor(String(model?.provider ?? ""), String(model?.id ?? "")).ttlSeconds * 1000;
	const ageMs = last.at > 0 ? Math.max(0, now - last.at) : Infinity;
	const premium = freshPremiumPerMillion(model);
	const bustUsd = premium === undefined ? 0 : (last.tokens * premium) / 1e6;
	const worth = premium === undefined ? last.tokens >= WIRE_BUST_FALLBACK_TOKENS : bustUsd >= WIRE_BUST_BUDGET_USD;
	return { warm: ageMs < ttlMs && worth, prefixTokens: last.tokens, ageMs, bustUsd };
}

/** Whether the current branch already carries a hidden message of this type (delivered once, never twice). */
export function branchHasMessage(ctx: any, customType: string): boolean {
	const entries = branchOf(ctx);
	if (!Array.isArray(entries)) return false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "custom_message" && entry.customType === customType) return true;
	}
	return false;
}

const latches = new Map<string, string>();

function sessionKeyOf(ctx: any): string {
	try {
		return `${ctx?.cwd ?? ""}|${ctx?.sessionManager?.getSessionId?.() ?? ""}`;
	} catch {
		return "";
	}
}

function persistedLatch(ctx: any, key: string): string | undefined {
	const entries = branchOf(ctx);
	if (!Array.isArray(entries)) return undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "custom" && entry.customType === LATCH_ENTRY && entry.data?.key === key && typeof entry.data.text === "string") return entry.data.text;
	}
	return undefined;
}

function remember(id: string, text: string): void {
	// Least recently used goes first; reading a latch refreshes it so an active session never loses its text.
	latches.delete(id);
	latches.set(id, text);
	while (latches.size > MAX_LATCHES) latches.delete(latches.keys().next().value as string);
}

/**
 * Text an extension appends to the system prompt, kept byte-stable for the
 * session. Once a session carries the text it keeps carrying exactly that text
 * even if the reason lapses (a tier flip must not rebuild the cached head). The
 * latch is also written to the session, so a restart or reload inside the warm
 * window finds the same bytes instead of recomputing them. A first appearance
 * inside a warm session is refused (returns undefined) and the caller delivers
 * the same words through a persisted message instead.
 */
export function stickyHeadText(ctx: any, key: string, text: string | undefined): string | undefined {
	const id = `${sessionKeyOf(ctx)}|${key}`;
	const prior = latches.get(id) ?? persistedLatch(ctx, key);
	if (prior !== undefined) {
		remember(id, prior);
		return prior;
	}
	if (!text) return undefined;
	if (wireWarmth(ctx).warm) return undefined;
	remember(id, text);
	try {
		ctx?.sessionManager?.appendCustomEntry?.(LATCH_ENTRY, { key, text });
	} catch {
		/* the in-memory latch still holds for this process */
	}
	return text;
}

export function resetStickyHead(): void {
	latches.clear();
}

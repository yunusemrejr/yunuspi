/**
 * Lean harness policy — one small, dependency-free owner for the rules that
 * used to be spread across automatic model selection, helper roles and gates.
 *
 * Principles:
 * - The model the user picked is the model that runs: main session, sub-agents
 *   and goal verification all inherit it. Nothing silently swaps models.
 * - Jev only adjusts thinking effort, for the main agent and sub-agents alike.
 * - Missing capability (e.g. images) is reported honestly; the user may switch.
 * - Switching models mid-session keeps history and the stable prompt prefix,
 *   remaps thinking, and only drops provider-specific ephemeral state.
 * - Suggestions are rare: at most two per session, spaced by real work.
 * - Prompt caching is detected per provider/architecture, never assumed.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelRef {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	/** Input modalities when known, e.g. ["text"] or ["text", "image"]. */
	input?: readonly string[];
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> | null;
}

export function clampThinking(level: string | undefined, model?: ModelRef | null): ThinkingLevel {
	const wanted = (level ?? "medium").toLowerCase() as ThinkingLevel;
	if (!model?.reasoning) return "off";
	if (!THINKING_LEVELS.includes(wanted)) return "medium";
	const map = model.thinkingLevelMap;
	if (map?.[wanted] === null) {
		const idx = THINKING_LEVELS.indexOf(wanted);
		for (let i = idx - 1; i >= 0; i--) if (map?.[THINKING_LEVELS[i]] !== null) return THINKING_LEVELS[i];
		return "off";
	}
	if ((wanted === "xhigh" || wanted === "max" || wanted === "ultra") && map?.[wanted] === undefined) return "high";
	return wanted;
}

/** Sub-agents inherit the main session model exactly; only an explicit user override wins. */
export function resolveChildRoute(
	main: ModelRef,
	explicit?: { provider?: string; id?: string; thinking?: string } | null,
	jevThinking?: string,
): { provider: string; id: string; thinking: ThinkingLevel; inherited: boolean } {
	const inherited = !explicit?.id;
	const target: ModelRef = inherited ? main : { provider: explicit?.provider ?? main.provider, id: explicit!.id!, reasoning: main.reasoning };
	return {
		provider: target.provider,
		id: target.id,
		thinking: clampThinking(explicit?.thinking ?? jevThinking, target),
		inherited,
	};
}

export function modelSupportsImages(model?: ModelRef | null): boolean {
	if (!model) return false;
	const input = model.input ?? (model as { inputModalities?: readonly string[] }).inputModalities;
	return Array.isArray(input) && input.some((m) => String(m).toLowerCase() === "image");
}

/** Honest refusal instead of an automatic switch to an image-capable model. */
export function imageRefusal(model?: ModelRef | null): string {
	const label = model ? `${model.provider}/${model.id}` : "the current model";
	return `I can't process images with ${label} — it has no image input. Switch to an image-capable model (for example via /model) and resend the image; I won't switch models automatically.`;
}

export interface ModelSwitchPlan {
	keepHistory: true;
	rebuildContext: false;
	thinking: ThinkingLevel;
	/** Ephemeral provider state that must not leak across the switch. */
	invalidate: string[];
	costNote: string;
}

/** Mid-session switch: keep the conversation, remap effort, drop only stale provider state. */
export function planModelSwitch(prev: ModelRef, next: ModelRef, currentThinking?: string): ModelSwitchPlan {
	const sameProvider = prev.provider === next.provider;
	return {
		keepHistory: true,
		rebuildContext: false,
		thinking: clampThinking(currentThinking, next),
		invalidate: sameProvider ? ["endpoint-health"] : ["endpoint-health", "provider-session", "compaction-summary-model"],
		costNote: sameProvider
			? "Same provider: history and prompt-prefix cache stay warm; only new turns bill at the new model."
			: "Provider changed: history is kept, the new provider builds its own prefix cache on the next turn.",
	};
}

export type CacheStrategy = "anthropic-breakpoints" | "openai-prefix" | "deepseek-automatic" | "gemini-context" | "openrouter-upstream" | "stable-prefix";

export interface CacheProfile {
	strategy: CacheStrategy;
	/** Keep system prompt + tool schemas byte-stable and first in the request. */
	stablePrefix: true;
	ttlSeconds: number;
	breakpoints: number;
	note: string;
}

/** Detect the best prompt-cache strategy for a provider/model pair. */
export function cacheProfileFor(provider: string, modelId = ""): CacheProfile {
	const p = provider.toLowerCase();
	const m = modelId.toLowerCase();
	const base = { stablePrefix: true as const };
	if (p.includes("anthropic") || m.includes("claude")) return { ...base, strategy: "anthropic-breakpoints", ttlSeconds: 300, breakpoints: 4, note: "Explicit cache breakpoints on system, tools and the last stable history block; 5-minute TTL, refresh on write." };
	if (p.includes("deepseek") || m.includes("deepseek")) return { ...base, strategy: "deepseek-automatic", ttlSeconds: 3600, breakpoints: 0, note: "Automatic on-disk prefix cache: keep the prefix identical and avoid mid-history edits so hits survive." };
	if (p.includes("google") || p.includes("gemini") || m.includes("gemini")) return { ...base, strategy: "gemini-context", ttlSeconds: 3600, breakpoints: 0, note: "Implicit context cache on the stable prefix; pin large stable context explicitly only when it repeats." };
	if (p.includes("openrouter")) return { ...base, strategy: "openrouter-upstream", ttlSeconds: 300, breakpoints: 2, note: "Upstream-dependent: keep provider order pinned and the prefix stable so the upstream cache can hit." };
	if (p.includes("openai") || m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return { ...base, strategy: "openai-prefix", ttlSeconds: 1800, breakpoints: 0, note: "Automatic prefix cache (128-token blocks): longest stable prefix first, no per-request cache keys needed." };
	return { ...base, strategy: "stable-prefix", ttlSeconds: 600, breakpoints: 0, note: "Unknown cache: still keep system+tools byte-stable and append-only; most providers reward an unchanged prefix." };
}

/**
 * Suggestion budget: at most `max` soft tool/skill hints per session.
 * A hint needs relevance above a threshold that rises after each hint, and a
 * minimum number of turns since the last one — so hints decay, never nag.
 */
export class SuggestionBudget {
	readonly max: number;
	private shown = 0;
	private lastTurn = -Infinity;

	constructor(max = 2) { this.max = Math.max(0, Math.floor(max)); }

	shouldShow(turn: number, relevance: number): boolean {
		if (this.shown >= this.max) return false;
		const threshold = 0.6 + 0.2 * this.shown;
		const minGap = 8 * (this.shown + 1);
		return relevance >= threshold && turn - this.lastTurn >= minGap;
	}

	record(turn: number): void { this.shown++; this.lastTurn = turn; }
	get used(): number { return this.shown; }
}

/** Same-model goal verification: compare criteria against recorded evidence only. */
export function openCriteria<T extends { id: string; status: string }>(criteria: readonly T[]): T[] {
	return criteria.filter((c) => c.status === "open");
}

export function selfVerificationPrompt(goalText: string, criteria: readonly { id: string; text?: string; label?: string }[]): string {
	const list = criteria.map((c) => `- ${c.id}: ${c.text ?? c.label ?? ""}`).join("\n");
	return [
		"Verify your own work against the goal before finishing. Use the same model and this session's history — no external reviewer.",
		`Goal: ${goalText}`,
		"Criteria:",
		list || "- (none recorded)",
		"For each criterion, name the concrete evidence you observed (command + result, file + line, rendered output). Mark anything without evidence as open and keep working on it. Do not claim completion for unobserved work.",
	].join("\n");
}

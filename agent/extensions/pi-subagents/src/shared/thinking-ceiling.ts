import { resolveEffectiveThinking, THINKING_LEVELS, type ThinkingLevel } from "./model-info.ts";
export type { ThinkingLevel } from "./model-info.ts";

export const SUBAGENT_THINKING_CEILING_ENV = "PI_SUBAGENT_THINKING_CEILING";

const thinkingLevelRanks = new Map<ThinkingLevel, number>(THINKING_LEVELS.map((level, index) => [level, index]));

export function parseThinkingLevel(value: unknown, field = "thinking level"): ThinkingLevel {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (thinkingLevelRanks.has(trimmed as ThinkingLevel)) return trimmed as ThinkingLevel;
	}
	throw new Error(`Invalid ${field}; expected one of ${THINKING_LEVELS.join(", ")}.`);
}

export function compareThinkingLevels(left: ThinkingLevel, right: ThinkingLevel): number {
	const leftRank = thinkingLevelRanks.get(left);
	const rightRank = thinkingLevelRanks.get(right);
	if (leftRank === undefined || rightRank === undefined) throw new Error(`Invalid thinking level comparison; expected one of ${THINKING_LEVELS.join(", ")}.`);
	return leftRank - rightRank;
}

export function intersectThinkingCeilings(...ceilings: Array<ThinkingLevel | undefined>): ThinkingLevel | undefined {
	const active = ceilings.filter((ceiling): ceiling is ThinkingLevel => ceiling !== undefined);
	if (active.length === 0) return undefined;
	return active.reduce((lowest, ceiling) => compareThinkingLevels(ceiling, lowest) < 0 ? ceiling : lowest);
}

export function decodeThinkingCeiling(value: string | undefined): ThinkingLevel | undefined {
	if (value === undefined || value === "") return undefined;
	return parseThinkingLevel(value, "inherited thinking ceiling");
}

export interface ThinkingCeilingCheck {
	model?: string;
	configThinking?: string | false;
	ceiling?: ThinkingLevel;
	agent?: string;
	runId?: string;
}

export function assertThinkingWithinCeiling(input: ThinkingCeilingCheck): void {
	if (!input.ceiling) return;
	const requested = resolveEffectiveThinking(input.model, input.configThinking);
	if (!requested) return;
	const requestedLevel = parseThinkingLevel(requested, "requested thinking level");
	if (compareThinkingLevels(requestedLevel, input.ceiling) <= 0) return;
	const subject = [input.agent ? `agent '${input.agent}'` : undefined, input.runId ? `run '${input.runId}'` : undefined]
		.filter((value): value is string => Boolean(value))
		.join(" ");
	throw new Error(`Thinking level '${requestedLevel}' exceeds configured maximum '${input.ceiling}'${subject ? ` for ${subject}` : ""}.`);
}

const EFFORT_ENTRY = "jev-effort-v1";

/** Thinking level a helper starts at: the session's configured ceiling (the
 * level the person chose, persisted by the effort controller), else the live
 * level. Each child's own effort controller (Jev) then steps down from it for
 * an easy task, so helpers never pick a level of their own. */
export function sessionThinkingCeiling(entries: readonly unknown[] | undefined, liveLevel: unknown): ThinkingLevel | undefined {
	let ceiling: unknown;
	for (const entry of entries ?? []) {
		const record = entry as { type?: unknown; customType?: unknown; data?: { version?: unknown; ceiling?: unknown } } | undefined;
		if (record?.type === "custom" && record.customType === EFFORT_ENTRY && record.data?.version === 1) ceiling = record.data.ceiling;
	}
	for (const level of [ceiling, liveLevel]) {
		if (typeof level === "string" && thinkingLevelRanks.has(level as ThinkingLevel)) return level as ThinkingLevel;
	}
	return undefined;
}

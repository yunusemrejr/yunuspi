import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { clampSupportedThinkingLevel, getSupportedThinkingLevels, splitKnownThinkingSuffix, THINKING_LEVELS, toModelInfo, type ThinkingLevel } from "../shared/model-info.ts";
import type { DoubleModelRef, DoublePair, DoubleReconciler } from "../../../lib/double.ts";

/**
 * Pair resolution for `/custom-double`: turns what the user typed or picked
 * into exact registry routes. Identity is never guessed: an unknown, ambiguous
 * or unavailable model is an error the user reads, not a substitution.
 */

export type DoubleRegistryModel = Parameters<typeof toModelInfo>[0] & { name?: string };

export type ResolvedDoubleModel = { ok: true; ref: DoubleModelRef } | { ok: false; error: string };

const isThinkingLevel = (value: unknown): value is ThinkingLevel => typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);

/** The session's thinking level, clamped to what this model can actually run. */
export function defaultDoubleThinking(model: DoubleRegistryModel, sessionThinking: string | undefined): string | undefined {
	if (!isThinkingLevel(sessionThinking)) return undefined;
	return clampSupportedThinkingLevel(toModelInfo(model), sessionThinking);
}

export function resolveDoubleModel(
	token: string,
	available: readonly DoubleRegistryModel[],
	options: { sessionProvider?: string; sessionThinking?: string } = {},
): ResolvedDoubleModel {
	const raw = typeof token === "string" ? token.trim() : "";
	if (!raw) return { ok: false, error: "A model is required." };
	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(raw);
	let match = available.find((model) => `${model.provider}/${model.id}` === baseModel);
	if (!match) {
		const byId = available.filter((model) => model.id === baseModel);
		if (byId.length === 1) match = byId[0];
		else if (byId.length > 1) {
			const preferred = byId.filter((model) => model.provider === options.sessionProvider);
			if (preferred.length === 1) match = preferred[0];
			else return { ok: false, error: `"${baseModel}" is carried by ${byId.map((model) => model.provider).sort().join(", ")}; write provider/id.` };
		}
	}
	if (!match) return { ok: false, error: `No available model "${baseModel}". Open /custom-double with no arguments to search the models you can use.` };
	const supported = getSupportedThinkingLevels(toModelInfo(match));
	let thinking: string | undefined;
	if (thinkingSuffix) {
		const level = thinkingSuffix.slice(1);
		if (!supported.includes(level as ThinkingLevel)) {
			return { ok: false, error: `${match.provider}/${match.id} does not support thinking "${level}" (it supports ${supported.join(", ")}).` };
		}
		thinking = level;
	} else {
		thinking = defaultDoubleThinking(match, options.sessionThinking);
	}
	return { ok: true, ref: { provider: match.provider, id: match.id, ...(thinking ? { thinking } : {}) } };
}

/** Deterministic text of a pair for notices and persisted receipts. */
export const pairKey = (pair: DoublePair): string =>
	JSON.stringify([pair.a.provider, pair.a.id, pair.a.thinking ?? "", pair.b.provider, pair.b.id, pair.b.thinking ?? "", pair.reconcile]);

const RECONCILERS: readonly DoubleReconciler[] = ["a", "b", "session"];

function cleanRef(value: unknown): DoubleModelRef | undefined {
	const row = value as { provider?: unknown; id?: unknown; thinking?: unknown } | null | undefined;
	if (!row || typeof row.provider !== "string" || !row.provider.trim() || typeof row.id !== "string" || !row.id.trim()) return undefined;
	if (row.provider.length > 120 || row.id.length > 240) return undefined;
	const thinking = isThinkingLevel(row.thinking) ? row.thinking : undefined;
	return { provider: row.provider.trim(), id: row.id.trim(), ...(thinking ? { thinking } : {}) };
}

/** Reads a stored pair; anything malformed is dropped rather than repaired. */
export function parseStoredPair(value: unknown): DoublePair | undefined {
	const row = value as { a?: unknown; b?: unknown; reconcile?: unknown } | null | undefined;
	if (!row || typeof row !== "object") return undefined;
	const a = cleanRef(row.a);
	const b = cleanRef(row.b);
	if (!a || !b) return undefined;
	const reconcile = RECONCILERS.find((candidate) => candidate === row.reconcile) ?? "a";
	return { a, b, reconcile };
}

export function serializePair(pair: DoublePair): { a: DoubleModelRef; b: DoubleModelRef; reconcile: DoubleReconciler } {
	return {
		a: { provider: pair.a.provider, id: pair.a.id, ...(pair.a.thinking ? { thinking: pair.a.thinking } : {}) },
		b: { provider: pair.b.provider, id: pair.b.id, ...(pair.b.thinking ? { thinking: pair.b.thinking } : {}) },
		reconcile: pair.reconcile,
	};
}

const LAST_PAIR_FILE = "double-pair.json";

/** The pair the user last confirmed, remembered across sessions so `/custom-double` reopens on it. */
export function loadLastPair(agentDir: string | undefined): DoublePair | undefined {
	if (!agentDir) return undefined;
	try {
		const file = path.join(agentDir, LAST_PAIR_FILE);
		if (fs.statSync(file).size > 4096) return undefined;
		return parseStoredPair(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return undefined;
	}
}

export function saveLastPair(agentDir: string | undefined, pair: DoublePair): boolean {
	if (!agentDir) return false;
	const file = path.join(agentDir, LAST_PAIR_FILE);
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, ...serializePair(pair) })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		fs.renameSync(temporary, file);
		return true;
	} catch {
		return false;
	} finally {
		try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
	}
}

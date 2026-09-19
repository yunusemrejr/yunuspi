/**
 * Bounded repeat-loop evidence. reminders.ts owns delivery/caps/lifecycle;
 * pi-observations.ts owns exact output dedup, not a second intervention loop.
 * Long answers, reasoning speed and model names are not loop signals.
 */
import { createHash } from "node:crypto";
import type { ToolResultEvent } from "@yunuspi/coding-agent";

const LOOP_REPEATS = 3;
const LOOP_WINDOW_TURNS = 6;
const LOOP_MAX_CALLS = 16;
const OBSERVATION_TOOLS = new Set([
	"read", "grep", "find", "ls", "symbol_search", "module_report",
	"read_symbol", "read_enclosing", "project_report", "lsp_diagnostics",
	"lens_diagnostics", "ast_grep_search", "ast_grep_outline", "ast_grep_dump",
	"checkpoint_read", "obs_read", "session_self", "web_probe",
	"context_slice", "symbol_expand", "ast_diff", "context_score", "handoff_capsule",
]);

// Incomplete evidence must never generate a nudge. Bound serialization too:
// comparing only a prefix would turn changed tails into false repeats.
function loopFingerprint(value: unknown): string | undefined {
	let chars = 32_768;
	let nodes = 2_048;
	try {
		const text = JSON.stringify(value, (key, item) => {
			chars -= key.length + (typeof item === "string" ? item.length : 0);
			if (--nodes < 0 || chars < 0) throw new Error("loop sample too large");
			if (item && typeof item === "object") {
				const keys = Object.keys(item);
				if (keys.length > nodes) throw new Error("loop sample too wide");
				if (!Array.isArray(item)) {
					// JSON keys are strings; lexical order is intentional.
					return Object.fromEntries(keys.sort().map((k) => [k, item[k]]));
				}
			}
			return item;
		});
		if (text === undefined || text.length > 32_768) return undefined;
		return createHash("sha256").update(text).digest("hex");
	} catch {
		return undefined; // Cyclic, unsupported or oversize tool data: abstain.
	}
}

const GUARD_PREFIX = "[strategy-change-required]";
const PASSIVE_TOOLS = new Set(["process", "wait", "wait_agent", "sleep", "clock", "subagent"]);

function queryShape(event: Pick<ToolResultEvent, "toolName" | "input">) {
	const input = event.input;
	if (!input || typeof input !== "object" || Array.isArray(input)) return;
	const query = input.query;
	// Fuzzy grouping is deliberately restricted to plain words. Never tokenize
	// regexes, paths, flags, quoted literals, identifiers or numeric boundaries.
	if (typeof query !== "string" || query.length > 512 || !/^[A-Za-z ]+$/.test(query)) return;
	const words = query.trim().split(/ +/);
	if (words.length < 4 || words.length > 32) return;
	const {query: _query, ...rest} = input;
	const scope = loopFingerprint([event.toolName, rest, words.filter(word => /^(?:not|no|without|except|exclude|never)$/i.test(word))]);
	if (!scope) return;
	return {scope, words: new Set(words)};
}
function similarQuery(a: ReturnType<typeof queryShape>, b: ReturnType<typeof queryShape>): boolean {
	if (!a || !b || a.scope !== b.scope) return false;
	let overlap = 0;
	for (const word of a.words) if (b.words.has(word)) overlap++;
	return overlap / new Set([...a.words, ...b.words]).size >= 0.8;
}

/** Four completed turns of proven unproductive work gate only seen variants. */
function createStrategyGuard() {
	type Sample = {key: string; result: string; name: string; shape: ReturnType<typeof queryShape>};
	let cluster: {anchor: Sample; variants: Set<string>; count: number} | undefined;
	let pending: Sample[] = [], progressed = false;
	const refused = new Set<string>();
	return {
		record(event: ToolResultEvent) {
			if (progressed || process.env.PI_SEMANTIC_LOOP_GUARD === "off") return;
			const key = loopFingerprint([event.toolName, event.input]);
			if (key && refused.has(key) && event.isError && event.content.some(c => c.type === "text" && c.text.includes(GUARD_PREFIX))) return;
			const action = event.input?.action;
			const passive = PASSIVE_TOOLS.has(event.toolName) || action === "status" || action === "wait" || action === "poll";
			const eligible = !passive && (event.isError || OBSERVATION_TOOLS.has(event.toolName) || event.toolName === "todo" && (action === "get" || action === "list"));
			const evidenceHash = event.details?.piObservation?.resultHash ?? event.details?.observationResultHash;
			const result = key && eligible && event.content.every(c => c.type === "text")
				? typeof evidenceHash === "string" && /^[a-f0-9]{64}$/.test(evidenceHash)
					? evidenceHash
					: loopFingerprint(["result", null, {content: event.content, isError: event.isError === true, details: event.details ?? null}])
				: undefined;
			if (!key || !result) {cluster = undefined; pending = []; progressed = true; refused.clear(); return;}
			const sample = {key, result, name: event.toolName, shape: queryShape(event)};
			const anchor = pending[0] ?? cluster?.anchor;
			if (anchor && (anchor.result !== result || anchor.key !== key && !similarQuery(anchor.shape, sample.shape))) {
				// A new result, changed range/path or genuinely new strategy is progress.
				cluster = undefined; pending = []; refused.clear();
			}
			if (!pending.some(value => value.key === key)) pending.push(sample);
			if (pending.length > LOOP_MAX_CALLS) {cluster = undefined; pending = []; progressed = true; refused.clear();}
		},
		finishTurn() {
			if (!progressed && pending.length) {
				const anchor = pending[0];
				if (!cluster) cluster = {anchor, variants: new Set(), count: 0};
				cluster.count++;
				for (const sample of pending) cluster.variants.add(sample.key);
				if (cluster.variants.size > LOOP_MAX_CALLS) cluster = undefined;
			}
			pending = []; progressed = false;
		},
		block(event: Pick<ToolResultEvent, "toolName" | "input">): string | undefined {
			if (process.env.PI_SEMANTIC_LOOP_GUARD === "off" || !cluster || cluster.count < 4) return;
			const key = loopFingerprint([event.toolName, event.input]);
			// Similarity helps group evidence but NEVER blocks an untried variant.
			if (!key || !cluster.variants.has(key)) return;
			refused.add(key);
			return `${GUARD_PREFIX} ${event.toolName} repeated an unchanged result across ${cluster.count} completed tool turns. This already-tried input is paused for this run. Use the existing evidence, choose a different query/range/tool, or report the blocker. Do not make a cosmetic edit merely to reset the guard. A new user instruction resets it.`;
		},
	};
}

export function createLoopTracker() {
	const strategy = createStrategyGuard();
	type Sample = { key: string; result: string; name: string; error: boolean };
	const pending = new Map<string, Sample>();
	const recent = new Map<string, Sample & { count: number; turn: number }>();
	let turn = 0;
	let progressed = false;
	return {
		nudged: false,
		block: (event: Pick<ToolResultEvent, "toolName" | "input">) => strategy.block(event),
		record(event: ToolResultEvent) {
			strategy.record(event);
			if (this.nudged || progressed) return;
			// Successful actions/waits invalidate old observations. Bash is only
			// eligible with exact-repeat evidence supplied by pi-observations.
			const todoRead = event.toolName === "todo" &&
				(event.input?.action === "list" || event.input?.action === "get");
			const eligible = event.isError || todoRead || OBSERVATION_TOOLS.has(event.toolName) ||
				(event.toolName === "bash" && event.details?.deduplicated === true);
			const key = eligible ? loopFingerprint([event.toolName, event.input]) : undefined;
			const result = key && event.content.every((c) => c.type === "text")
				? loopFingerprint([event.isError, event.content, event.details]) : undefined;
			if (!key || !result || (pending.has(key) && pending.get(key)?.result !== result)) {
				recent.clear();
				pending.clear();
				progressed = true;
				return;
			}
			// Parallel siblings did not see each other's results: count once/turn.
			pending.set(key, { key, result, name: event.toolName, error: event.isError });
			const oldest = pending.keys().next().value;
			if (pending.size > LOOP_MAX_CALLS && oldest !== undefined) pending.delete(oldest);
		},
		finishTurn(): string | undefined {
			strategy.finishTurn();
			turn++;
			let repeated: (Sample & { count: number }) | undefined;
			for (const [key, old] of recent) {
				if (turn - old.turn >= LOOP_WINDOW_TURNS) recent.delete(key);
			}
			for (const sample of pending.values()) {
				const old = recent.get(sample.key);
				const count = old?.result === sample.result ? old.count + 1 : 1;
				recent.delete(sample.key);
				recent.set(sample.key, { ...sample, count, turn });
				const oldest = recent.keys().next().value;
				if (recent.size > LOOP_MAX_CALLS && oldest !== undefined) recent.delete(oldest);
				if (count >= LOOP_REPEATS && !repeated) repeated = { ...sample, count };
			}
			pending.clear();
			progressed = false;
			if (!repeated || this.nudged) return undefined;
			return `[loop-check] ${repeated.name} returned the same ${repeated.error ? "error" : "result"} for identical inputs on ${repeated.count} tool turns. ` +
				"If repetition is intentional, continue. Otherwise use the evidence already gathered, change the query/input, or report the blocker. " +
				"Do not edit just to show progress or skip required checks.";
		},
	};
}

/** Strong local repetition evidence only; never classify by duration/token count. */
export function repeatedReasoningNotice(message: any): string | undefined {
	if (process.env.PI_REASONING_STEERING === "off" || !Array.isArray(message?.content)) return;
	let length = 0;
	const texts: string[] = [];
	for (const block of message.content) {
		if (block.type !== "thinking" || typeof block.thinking !== "string") continue;
		length += block.thinking.length;
		if (length > 128_000 || block.thinking.includes("```")) return;
		texts.push(block.thinking);
	}
	if (length < 2_000) return;
	const paragraphs = texts.join("\n\n").split(/\n\s*\n/);
	if (paragraphs.length > 256) return;
	const counts = new Map<string, { count: number; length: number }>();
	let normalizedLength = 0;
	for (const paragraph of paragraphs) {
		const text = paragraph.replace(/\s+/g, " ").trim();
		normalizedLength += text.length;
		if (text.length < 200 || text.length > 8_192) continue;
		const key = createHash("sha256").update(text).digest("hex");
		const entry = counts.get(key) ?? { count: 0, length: text.length };
		entry.count++;
		counts.set(key, entry);
	}
	// Four exact copies dominating the trace is stronger evidence than a
	// repeated phrase in a proof or a model reviewing a legitimate alternative.
	const redundant = [...counts.values()].filter(e => e.count >= 4)
		.reduce((sum,e) => sum + (e.count - 1) * e.length, 0);
	if (redundant < 1_500 || redundant < normalizedLength * 0.6) return;
	return "[reasoning-check] Long reasoning passages repeated at least four times and dominated this turn. " +
		"Preserve the user's goal and constraints. Use the evidence already gathered; choose the smallest useful check or implementation step, then verify it. " +
		"If ready, answer; if blocked, state the missing fact. Do not restart the analysis or invent certainty. Continue deeper reasoning only when it resolves a specific remaining uncertainty.";
}

/** One recovery request only; never invent unsupported provider fields. */
export function reduceRepeatedReasoningBudget(payload: any): any {
	if (process.env.PI_REASONING_BUDGET_ADAPT === "off" || !payload || typeof payload !== "object") return payload;
	const reduced = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 1024 ? Math.max(1024, Math.floor(n / 2)) : undefined;
	let next = payload;
	for (const [outer, inner] of [["thinking", "budget_tokens"], ["reasoning", "max_tokens"]]) {
		const value = reduced(payload[outer]?.[inner]);
		if (value !== undefined) next = { ...next, [outer]: { ...payload[outer], [inner]: value } };
	}
	const value = reduced(payload.thinking_token_budget);
	if (value !== undefined) next = { ...next, thinking_token_budget: value };
	return next;
}

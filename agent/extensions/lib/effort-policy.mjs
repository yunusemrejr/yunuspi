// Deterministic reasoning-effort policy and interaction-granularity cost model.
//
// Purpose: keep genuinely hard work at full thinking budget while collapsing
// the *mechanical* tail of a task (inspect -> patch -> format -> scoped verify)
// to the cheapest level that cannot skip a check. Every decision here is pure
// and reproducible: no file access, no inference, no clock. Safety comes from
// three invariants, all covered by bench/effort-granularity-test.mjs:
//
//   I1 FLOOR    — advice is never below the floor for the turn's difficulty,
//                 so architecture/planning/ambiguous/complex-debug turns can
//                 never be silently downgraded by an "optimizer".
//   I2 CEILING  — advice never exceeds the configured level unless the human
//                 explicitly asked for deeper reasoning (no runaway spend).
//   I3 NO STICK — a high-effort turn never persists: the very next
//                 non-difficult turn steps all the way back down, so a model
//                 is never left at high effort for mechanical continuations.
//
// Kill switch: PI_EFFORT_POLICY=off -> advise() returns the configured level
// unchanged (policy observes, never decides).

export const LEVELS = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const RANK = Object.freeze(Object.fromEntries(LEVELS.map((l, i) => [l, i])));
export const levelRank = (level) => RANK[level] ?? -1;
export const levelAt = (rank) =>
	LEVELS[Math.max(0, Math.min(LEVELS.length - 1, Math.round(rank)))];

/**
 * Tools that only move deterministic state: inspect, or apply a change that
 * was already decided. `edit` belongs here (the content decision happened in
 * the turn that produced it); `write` does not (it authors whole new content).
 * `bash` is counted as mechanical by name alone — it is overwhelmingly used
 * here for inspection/tests, and the audit reports that as an explicit
 * assumption rather than a measurement.
 */
export const MECHANICAL_TOOLS = Object.freeze(new Set([
	"read", "bash", "grep", "find", "ls", "edit", "obs_read",
	"bg_status", "bg_logs", "bg_kill", "bg_wait", "bg_run",
	"module_report", "project_report", "symbol_search", "checkpoint_read",
	"session_self", "tool_search", "context_slice",
	"evidence_cache", "context_score",
]));

/** Tools whose *use* implies a judgment the policy must not cheapen. */
export const JUDGMENT_TOOLS = Object.freeze(new Set([
	"subagent", "quality_review", "project_intel", "project_tests",
	"handoff_capsule", "bulk_edit", "write", "todo", "skill_review",
]));

// Deliberation markers. Kept narrow on purpose: over-matching would raise cost
// without protecting anything, under-matching is bounded by I1's floor only for
// turns that also carry a hard signal (errors, breadth, explicit ask).
const DEEP_PATTERNS = [
	/\barchitect(ure|ural)?\b/i, /\bdesign\b/i, /\btrade-?off/i, /\bmigrat(e|ion)\b/i,
	/\brefactor\b.*\b(strategy|plan|approach)\b/i, /\broot cause\b/i, /\bdeadlock\b/i,
	/\brace condition\b/i, /\bwhy (is|does|did|would)\b/i, /\bambiguo(us|ity)\b/i,
	/\bplan(ning)?\b/i, /\bweigh\b/i, /\bcompare .*\b(approach|option|design)\b/i,
	/\bdebug\b.*\b(complex|hard|deep|tricky)\b/i, /\binvestigat(e|ion)\b/i,
	/\bprotocol\b/i, /\binvariant\b/i,
];
const EXPLICIT_DEEPER = [
	/\bthink (hard|harder|deeply|carefully|step[- ]by[- ]step)\b/i,
	/\bhigh(er)? (reasoning|effort|thinking)\b/i,
	/\bmax(imum|imal)? (reasoning|effort|thinking)\b/i,
	/\breason(ing)? (at|on) (high|max|xhigh)\b/i,
	/\bdo not (rush|guess)\b/i,
];
const EXPLICIT_CHEAPER = [
	/\b(just|only) (run|apply|do) (it|this|that)\b/i,
	/\bno (need to|need for) (think|analyz|plan)/i,
	/\bminimal (reasoning|effort|thinking)\b/i,
];

export const DEFAULT_POLICY = Object.freeze({
	/** Level the human configured (settings defaultThinkingLevel / /thinking). */
	level: "high",
	/** Absolute floor the policy may ever advise. */
	floor: "minimal",
	/** Consecutive non-difficult turns before the step down applies. */
	stepDownAfter: 1,
	/** Steps down from the configured level once mechanical work is established
	 *  (high -> minimal by default: three steps). */
	maxStepDown: 3,
	/** Enabled=false (or PI_EFFORT_POLICY=off) -> always return `level`. */
	enabled: true,
});

export const classifyTurn = (turn = {}) => {
	const tools = Array.isArray(turn.tools)
		? turn.tools.filter((t) => typeof t === "string")
		: [];
	const text = typeof turn.userText === "string" ? turn.userText : "";
	const errors = Math.max(0, Number(turn.errors) || 0);
	const files = Math.max(0, Number(turn.files) || 0);
	const reasons = [];
	const explicitDeeper = EXPLICIT_DEEPER.some((re) => re.test(text));
	const explicitCheaper = !explicitDeeper && EXPLICIT_CHEAPER.some((re) => re.test(text));
	const deepText = DEEP_PATTERNS.some((re) => re.test(text));

	if (explicitDeeper) reasons.push("explicit deeper request");
	if (deepText) reasons.push("deliberative language");
	// Repeated failure on the same step is genuinely difficult work, not a
	// mechanical continuation: an unresolved error loop needs diagnosis.
	if (errors >= 3) reasons.push(`${errors} consecutive tool errors`);

	let difficulty = "routine";
	if (reasons.length > 0) difficulty = "deep";
	else {
		const judgment = tools.filter((t) => JUDGMENT_TOOLS.has(t));
		if (judgment.length > 0) {
			difficulty = "delicate";
			reasons.push(`judgment tool: ${judgment[0]}`);
		} else if (errors > 0) {
			difficulty = "delicate";
			reasons.push(`${errors} tool error(s) to diagnose`);
		} else if (files >= 5) {
			difficulty = "delicate";
			reasons.push(`${files} files touched`);
		}
	}
	const mechanical =
		tools.length > 0 && tools.every((t) => MECHANICAL_TOOLS.has(t));
	if (mechanical) reasons.push("mechanical tool set");
	if (explicitCheaper) reasons.push("explicit cheaper request");
	return { difficulty, mechanical, explicitDeeper, explicitCheaper, reasons };
};

/**
 * Stateful adviser. One instance per session; call `reset()` at every new
 * human turn so a mechanical streak from one request cannot leak into the next.
 */
export const createEffortController = (options = {}) => {
	const policy = { ...DEFAULT_POLICY, ...options };
	if (process.env.PI_EFFORT_POLICY === "off") policy.enabled = false;
	const base = levelRank(policy.level);
	const floorRank = Math.max(0, levelRank(policy.floor));
	if (base < 0) throw new Error(`unknown configured level: ${policy.level}`);

	let streak = 0;
	let pendingPostDeep = false;
	let last = null;

	const advise = (turn = {}) => {
		const info = classifyTurn(turn);
		if (!policy.enabled) {
			last = {
				level: policy.level, target: policy.level, floor: policy.level,
				difficulty: info.difficulty, mechanical: info.mechanical,
				streak: 0, reasons: ["policy disabled"], disabled: true,
			};
			return last;
		}
		// I2: ceiling is the configured level; only an explicit human ask lifts
		// it, and only one step of headroom above `high`.
		const ceilingRank = info.explicitDeeper
			? Math.max(base, levelRank("high"))
			: base;

		if (info.difficulty === "deep") {
			streak = 0;
			pendingPostDeep = true;
			last = {
				level: levelAt(ceilingRank), target: levelAt(ceilingRank),
				floor: levelAt(ceilingRank), difficulty: "deep",
				mechanical: info.mechanical, streak: 0, reasons: info.reasons,
			};
			return last;
		}

		// I3: the turn right after a deep turn steps all the way down, so high
		// effort is never carried into a mechanical continuation.
		if (pendingPostDeep) {
			streak = policy.maxStepDown;
			pendingPostDeep = false;
		} else streak = Math.min(policy.maxStepDown, streak + 1);

		// Mechanical work gets the full step down as soon as the streak is long
		// enough; there is no reason to pay `medium` for a status check.
		const steps = streak >= policy.stepDownAfter ? policy.maxStepDown : 0;
		let targetRank = Math.max(floorRank, base - steps);
		if (info.explicitCheaper) targetRank = floorRank;

		// I1: floor per difficulty, itself never above the configured level.
		let floorForTurn = floorRank;
		if (info.difficulty === "delicate")
			floorForTurn = Math.min(base, Math.max(floorRank, levelRank("low")));
		targetRank = Math.max(targetRank, floorForTurn);
		targetRank = Math.min(targetRank, ceilingRank);
		targetRank = Math.max(targetRank, floorRank);

		last = {
			level: levelAt(targetRank), target: levelAt(targetRank),
			floor: levelAt(floorForTurn), difficulty: info.difficulty,
			mechanical: info.mechanical, streak, reasons: info.reasons,
		};
		return last;
	};

	return {
		advise,
		reset() { streak = 0; pendingPostDeep = false; last = null; },
		state() { return { streak, pendingPostDeep, last }; },
		policy,
	};
};

/**
 * Linear interaction-granularity cost model.
 *
 * The absolute numbers are an explicit model, not a measurement: they exist so
 * the two execution modes can be compared deterministically offline. Only the
 * ORDERING (transaction mode <= micro-turn mode on requests and tokens for the
 * same op sequence) is claimed by the tests; the constants are overridable.
 */
export const COST_MODEL = Object.freeze({
	/** Tool-call envelope + JSON framing charged per model request. */
	perRequestOverheadTokens: 24,
	/** In micro-turn mode each tool result is resent as context next turn. */
	perOpResultTokens: 96,
	/** In transaction mode each op contributes one compact receipt line. */
	receiptTokensPerOp: 28,
	/** Receipt fixed framing (status/next-effort/verdict). */
	receiptFixedTokens: 40,
	/** Reasoning tokens per request by advised level. */
	reasoningTokensByLevel: Object.freeze({
		off: 0, minimal: 24, low: 96, medium: 320, high: 900, xhigh: 1600, max: 2400,
	}),
});

export const estimateWorkflowCost = ({
	ops = 1,
	mode = "micro",
	contextTokens = 8000,
	levels = ["high"],
	model = COST_MODEL,
} = {}) => {
	const opCount = Math.max(1, Math.round(ops));
	const requests =
		mode === "transaction" ? 1 : opCount + 1; // +1: turn that plans the ops
	const reasoningTokens = levels.reduce(
		(sum, lvl) =>
			sum + (model.reasoningTokensByLevel[lvl] ?? model.reasoningTokensByLevel.high),
		0,
	);
	const overhead = requests * model.perRequestOverheadTokens;
	const resultTokens =
		mode === "transaction"
			? model.receiptFixedTokens + opCount * model.receiptTokensPerOp
			: opCount * model.perOpResultTokens;
	// Micro-turn mode re-reads the whole context once per request; transaction
	// mode pays for it once (the receipt is the only thing that comes back).
	const contextResend = mode === "transaction" ? contextTokens : contextTokens * requests;
	const totalTokens = Math.round(contextResend + overhead + resultTokens + reasoningTokens);
	return { mode, ops: opCount, requests, reasoningTokens, resultTokens, totalTokens };
};

export const compareModes = (opts) => {
	const micro = estimateWorkflowCost({ ...opts, mode: "micro" });
	const transaction = estimateWorkflowCost({ ...opts, mode: "transaction" });
	return {
		micro,
		transaction,
		requestsSaved: micro.requests - transaction.requests,
		tokensSaved: micro.totalTokens - transaction.totalTokens,
		requestRatio: transaction.requests / micro.requests,
		tokenRatio: transaction.totalTokens / micro.totalTokens,
	};
};

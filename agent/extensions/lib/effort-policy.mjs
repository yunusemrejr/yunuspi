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
	"ultra",
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
	"read", "read_many", "bash", "grep", "find", "ls", "edit", "obs_read",
	"bg_status", "bg_logs", "bg_kill", "bg_wait", "bg_run",
	"module_report", "project_report", "symbol_search", "checkpoint_read",
	"session_self", "tool_search", "context_slice",
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
	/\breason(ing)? (at|on) (high|max|xhigh|ultra)\b/i,
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
		off: 0, minimal: 24, low: 96, medium: 320, high: 900, xhigh: 1600, max: 2400, ultra: 3200,
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

// ---------------------------------------------------------------------------
// Jev-assisted per-turn effort routing.
//
// The deterministic policy above owns routine mechanical continuations. This
// additive layer lets the configured typed judge (TypeSafe Jev on OpenRouter)
// make ONE conservative decision per human turn: it may step below the
// configured ceiling only when both Jev scores say the request is simple and
// not deep, and only when re-reading the context at the new level is cheap.
// Quality rules are unchanged: the configured level is a ceiling, the human's
// manual selection wins, unknowns and failures keep the ceiling, `off` is
// never chosen automatically, and a step up is always allowed.
//
// The cost-owner in cost-governor.ts supplies the judge; this module stays
// pure and deterministic so the thresholds, level mapping and cache gate are
// testable without network or clocks.
// ---------------------------------------------------------------------------

/** Minimum Jev evidence before a step down: the two scores must agree. */
export const EFFORT_JUDGE_BARS = Object.freeze({
	simpleStrong: 0.75,
	simpleSome: 0.6,
	deepClear: 0.25,
	deepSome: 0.3,
});

/** Re-reading this many tokens uncached costs more than one easier turn saves. */
export const EFFORT_SWITCH_BUDGET_TOKENS = 4000;

/** Levels a Jev-judged simple turn may step to (never `off`: that changes mode). */
export const EFFORT_JUDGE_TIERS = Object.freeze({ easy: "low", moderate: "medium" });

const EFFORT_GOAL_MARK = /\[goal(?:-tracked)? [a-z0-9]|goal continuing on its own|boosts in force|fronts this goal is judged on|acceptance criteria \(refine with/i;
const EFFORT_CRITICAL = /\b(?:authentication|authorization|credentials?|security|vulnerabilit\w*|billing|payments?|production deploy|deploy\w*.{0,32}production|data loss|delete.{0,20}(?:database|production)|schema migration)\b/i;
const EFFORT_COMPLEX = /\b(?:architect(?:ure|ural)?|redesign|rearchitect|overhaul|rethink|migrat\w+|concurrency|race condition|deadlock|intermittent|root cause|debug|investigate|audit|refactor\w*|optimi[sz]\w+|performance|algorithm|prove|proof|compiler|parser|distributed|end[- ]to[- ]end|cross[- ]file|multiple (?:files|services|modules))\b/i;
const EFFORT_MECHANICAL = /\b(?:typo|spelling|whitespace|indentation|format(?:ting)?|prettier|eslint|gofmt|rustfmt|rename|one[- ]line|bump (?:the )?version|add (?:a )?comment|what does .{0,40} (?:mean|do)|where is|which (?:file|command)|show me|list|print)\b/i;
const EFFORT_WORK = /\b(?:implement|build|create|write|fix|add|remove|change|update|refactor|make|design|port|migrate|run|test|deploy|install|configure|set up|debug|find|search|check|review|analy[sz]e)\b/i;
const EFFORT_ACK = /^\s*(?:ok(?:ay)?|yes|yep|yeah|sure|go on|go ahead|continue|proceed|keep going|please do|do it|thanks?|thank you|great|good|nice|perfect|next|and then\??|retry|try again)\b[\s.!,)]*$/i;

/**
 * Deterministic pre-classification of one human request.
 * - `ceiling`: no automatic demotion is eligible (goal round, preset brief,
 *   prior failures, critical or complex wording, long input, code, stack trace).
 * - `inherit`: short acknowledgement of ongoing work; keep the current level.
 * - `judge`: ask Jev whether the request is genuinely simple.
 * `mechanical` is only a hint; Jev still has to agree before anything moves.
 */
export const classifyEffortRequest = (text, { source = "human", priorFailures = 0 } = {}) => {
	const prompt = String(text ?? "").replace(/\u0000/g, "");
	const flat = prompt.replace(/```[\s\S]*?(?:```|$)/g, " ").trim();
	const reasons = [];
	if (source === "goal" || EFFORT_GOAL_MARK.test(prompt)) return { kind: "ceiling", reasons: ["goal round"] };
	if (priorFailures >= 2) return { kind: "ceiling", reasons: [`previous turn had ${priorFailures} tool failures`] };
	if (!flat) return { kind: "ceiling", reasons: ["no text (attachment-only)"] };
	if (EFFORT_ACK.test(flat) && flat.length <= 80) return { kind: "inherit", reasons: ["short acknowledgement"] };
	if (EFFORT_CRITICAL.test(flat)) return { kind: "ceiling", reasons: ["critical-area cue"] };
	if (EFFORT_COMPLEX.test(flat)) return { kind: "ceiling", reasons: ["complexity cue"] };
	if (prompt.length > 1500 || /```/.test(prompt) || /\bat \S+:\d+:\d+\)?$/m.test(prompt)) return { kind: "ceiling", reasons: ["long input, code or stack trace"] };
	if (flat.length <= 300 && EFFORT_MECHANICAL.test(flat)) return { kind: "judge", reasons: ["mechanical cue"], mechanical: true };
	if (flat.length <= 160 && !EFFORT_WORK.test(flat)) return { kind: "judge", reasons: ["short question"], mechanical: true };
	// A task statement longer than a one-liner is almost never "simple" to the judge, which then abstains and
	// leaves the ceiling; asking costs a model round trip (~0.4 s) before the first request to learn that.
	if (flat.length > 160 && EFFORT_WORK.test(flat)) return { kind: "ceiling", reasons: ["multi-part work request"] };
	return { kind: "judge", reasons: ["no strong ceiling cue"] };
};

/** Two typed noul questions for the shared Jev decision registry. */
export const effortQuestions = () => ({
	deep: { type: "noul", instructions: "Does settling this request need careful multi-step reasoning, such as debugging, design, algorithm work, changes across several files, or verifying subtle behavior?" },
	simple: { type: "noul", instructions: "Is this request simple, mechanical or conversational, so that a quick answer or one small edit would settle it (rename, formatting, short factual question, trivial lookup)?" },
});

const effortScore = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined);

/**
 * Interpret the two Jev scores. Returns a tier only when the evidence is
 * asymmetric in the same direction; everything else abstains (ceiling kept).
 */
export const interpretEffortAnswers = (answers) => {
	const deep = effortScore(answers?.deep?.noul);
	const simple = effortScore(answers?.simple?.noul);
	if (deep === undefined || simple === undefined) return { ok: false, reason: "jev answer unusable" };
	const bars = EFFORT_JUDGE_BARS;
	if (simple >= bars.simpleStrong && deep <= bars.deepClear)
		return { tier: "easy", confidence: Math.min(simple, 1 - deep), simple, deep };
	if (simple >= bars.simpleSome && deep <= bars.deepSome)
		return { tier: "moderate", confidence: Math.min(simple, 1 - deep), simple, deep };
	return { ok: false, reason: "kept ceiling", simple, deep };
};

/** Map a judged tier to a concrete level, clamped by the user's ceiling and the floor. */
export const effortLevelForTier = (tier, ceiling, { shortPlain = false } = {}) => {
	const ceilingRank = levelRank(ceiling);
	if (ceilingRank <= 0) return ceiling;
	let wanted = EFFORT_JUDGE_TIERS[tier];
	if (tier === "easy" && shortPlain) wanted = "minimal";
	const wantedRank = levelRank(wanted);
	if (wantedRank < 0) return ceiling;
	// Never `off` automatically: that changes the mode, not just the budget.
	const floor = Math.min(ceilingRank, 1);
	return levelAt(Math.max(floor, Math.min(ceilingRank, wantedRank)));
};

/** True when the candidate level is below the current level (a cache-costing step). */
export const effortStepDown = (target, current) => levelRank(target) >= 0 && levelRank(current) >= 0 && levelRank(target) < levelRank(current);

/**
 * Cache gate for an automatic level change. Raising is always allowed
 * (quality outranks cache); lowering is allowed only when the context tokens
 * that would have to be re-read at the new level fit inside `budget`.
 * `missTokens` may be a number or a function; unknown cost is treated as all.
 */
export const gateEffortSwitch = (target, current, missTokens, budget = EFFORT_SWITCH_BUDGET_TOKENS) => {
	if (levelRank(target) < 0 || levelRank(current) < 0) return { level: current, reason: "unknown level" };
	if (target === current) return { level: current };
	if (levelRank(target) > levelRank(current)) return { level: target, raised: true };
	let miss = Infinity;
	try {
		miss = typeof missTokens === "function" ? missTokens(target) : missTokens;
	} catch {
		miss = Infinity;
	}
	if (typeof miss !== "number" || !Number.isFinite(miss)) miss = Infinity;
	if (miss <= budget) return { level: target, missTokens: Math.max(0, miss) };
	return { level: current, gated: "cache", missTokens: miss };
};

/** Tokens that a request at `level` would have to re-read uncached. The owner
 * records the prompt size last sent at each level; a level never used before
 * misses the whole current context. */
export const effortMissTokens = (level, marks, contextTokens) => {
	const context = Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : 0;
	const mark = marks?.get?.(level);
	const seen = typeof mark === "number" && Number.isFinite(mark) && mark > 0 ? Math.min(mark, context) : 0;
	return Math.max(0, context - seen);
};

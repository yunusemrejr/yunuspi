/**
 * Canonical task/intent model.
 *
 * Single authority for "what is this task asking for" versus "what does it
 * forbid". Safety/prohibition language constrains execution; it must never be
 * read as evidence that the task itself performs the forbidden thing. A
 * read-only investigation stays read-only even when its prompt says "never
 * deploy" or "do not modify production".
 *
 * Architecture: normalize the prompt into intent segments FIRST (requested
 * verbs, negated verbs, quoted/example spans, environment references,
 * background context, deliverable type, mutation authority, safety-critical
 * domain), then derive the structured intent from those segments. Regular
 * expressions are acceptable only as low-level cue detectors inside the
 * segmenters — never as top-level verdicts over the raw prompt.
 *
 * Dependency-free and pure: safe to import from embedded collectors, tests,
 * and every routing surface.
 */

export type RequestedAction =
	| "investigate"
	| "review"
	| "implement"
	| "plan"
	| "summarize"
	| "answer"
	| "operate"
	| "unknown";

/** Mutation authority granted by the task wording itself. */
export type MutationPermission = "forbidden" | "scoped" | "allowed" | "required" | "unknown";

/** How the task relates to sensitive environments. Mention is not targeting. */
export type EnvironmentSensitivity =
	| "none"
	| "production-mention"
	| "production-target"
	| "safety-critical"
	| "unknown";

export type DecisionCriticality = "advisory" | "standard" | "critical";

export type DeliverableType =
	| "findings"
	| "code-change"
	| "plan"
	| "summary"
	| "answer"
	| "operation"
	| "unknown";

export interface IntentSegments {
	/** Action verbs in requested (non-negated, non-quoted) clauses. */
	requestedVerbs: string[];
	/** Verbs under negation scope ("never deploy" -> deploy). */
	negatedVerbs: string[];
	/** Spans that are examples, quotes, docs, or code — never intent. */
	quotedSpans: string[];
	/** Environment tokens with their clause role (mention vs target). */
	environmentRefs: Array<{ term: string; role: "mention" | "target" | "background" }>;
	/** Clauses that are background context, not instructions. */
	backgroundContext: string[];
	deliverableType: DeliverableType;
	/** Safety-critical domain cues (auth, payments, ...) in requested clauses. */
	safetyCriticalDomain: boolean;
	/** Raw clause count, for boundedness diagnostics. */
	clauseCount: number;
}

export interface TaskIntent {
	requestedAction: RequestedAction;
	/** Actions explicitly forbidden; these constrain execution only. */
	prohibitedActions: string[];
	/** Evidence the deliverable requires (advisory for budget planning). */
	requiredEvidence: string[];
	mutationPermission: MutationPermission;
	environmentSensitivity: EnvironmentSensitivity;
	decisionCriticality: DecisionCriticality;
	segments: IntentSegments;
	/** Human-readable safety notes; never a task-type verdict. */
	safetyNotes: string[];
}

const MAX_TEXT = 32768;
const MAX_CLAUSES = 64;

const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]{1,200}`/g;
const QUOTED = /"(?:[^"\\\n]|\\.){1,200}"|'(?:[^'\\\n]|\\.){1,200}'/g;
/** "e.g. deploy", "like production", "see deployment docs" — examples, not intent. */
const EXAMPLE_PREFIX = /\b(?:e\.g\.|eg\.|i\.e\.|for example|such as|like|see|cf\.|called|named)\s+([^,.;:!?()\n]{1,120})/gi;
const LEAD_QUOTE = /^\s*>.*$/gm;

const NEGATION_HEAD = /\b(?:never|do not|don't|does not|doesn't|must not|mustn't|shall not|should not|shouldn't|cannot|can't|could not|couldn't|will not|won't|would not|wouldn't|no|not|without|forbid(?:den|s)?|prohibit(?:ed|s)?|avoid|stop|prevent|disallow(?:ed|s)?|refuse|decline)\b/i;
const NEGATION_WINDOW = /\b(?:never|do not|don't|does not|doesn't|must not|mustn't|shall not|should not|shouldn't|cannot|can't|could not|couldn't|will not|won't|would not|wouldn't|forbid(?:den|s)?|prohibit(?:ed|s)?|disallow(?:ed|s)?|avoid|prevent)\b([^.;:!?()\n]{0,160})/gi;
/** "but/and/then <verb>" after a prohibition re-opens requested intent. */
const CONTRAST_REOPEN = /\b(?:but|and then|then|however|instead)\b\s+([a-z][^.;:!?()\n]{0,120})/gi;
/** "not just X, Y" / "don't just X, Y": Y is requested, not negated. */
const NOT_JUST_REOPEN = /\b(?:not|do not|don't)\s+just\b[^,;:.!?()]{0,80},\s*([^,;:.!?()\n]{1,120})/gi;
/**
 * File paths are never instructions: verb stems inside filenames ("fix.py",
 * "deploy.yaml", "build.sh") must not flip intent. Paths are masked before
 * verb extraction; a bare filename without a path shape still reads
 * literally ("review the deploy script" keeps its nominal cue).
 */
const FILE_PATH = /\b[\w.~$-][\w.~$/-]*\.(py|ts|tsx|jsx|js|mjs|cjs|go|rs|java|rb|php|swift|kt|scala|c|h|cpp|hpp|cs|md|mdx|json|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|sql|html|css|scss|xml|txt|log|csv|tsv|png|jpg|jpeg|gif|svg|pdf|zip|wasm|lock)\b|\b(?:src|lib|app|tests?|docs?|bin|scripts?|agent|core|config|dist|build|node_modules)(?:\/[\w.~$-]+)+/gi;

const VERB_FORMS: Record<string, string> = {
	investigate: "investigate", investigating: "investigate", investigation: "investigate", trace: "investigate", tracing: "investigate",
	explore: "investigate", exploring: "investigate", scout: "investigate", scouting: "investigate", research: "investigate", researching: "investigate",
	audit: "review", auditing: "review", review: "review", reviewing: "review", inspect: "review", inspecting: "review",
	implement: "implement", implementing: "implement", implementation: "implement", build: "implement", building: "implement",
	fix: "implement", fixing: "implement", patch: "implement", patching: "implement", edit: "implement", editing: "implement",
	modify: "implement", modifying: "implement", refactor: "implement", refactoring: "implement", write: "implement", writing: "implement", touch: "implement", touching: "implement",
	create: "implement", creating: "implement", add: "implement", adding: "implement", remove: "implement", removing: "implement",
	delete: "implement", deleting: "implement", update: "implement", updating: "implement", change: "implement", changing: "implement",
	migrate: "implement", migrating: "implement", merge: "implement", merging: "implement", commit: "implement", committing: "implement",
	plan: "plan", planning: "plan", design: "plan", designing: "plan", propose: "plan", proposing: "plan", draft: "plan", drafting: "plan",
	suggest: "plan", suggesting: "plan",
	summarize: "summarize", summarizing: "summarize", summarise: "summarize", summarising: "summarize", extract: "summarize", extracting: "summarize",
	list: "summarize", listing: "summarize", report: "summarize", reporting: "summarize",
	answer: "answer", answering: "answer", explain: "answer", explaining: "answer", describe: "answer", describing: "answer",
	deploy: "operate", deploying: "operate", deployment: "operate", release: "operate", releasing: "operate", publish: "operate", publishing: "operate", ship: "operate", shipping: "operate",
	restart: "operate", restarting: "operate", rollback: "operate", approve: "operate", approving: "operate", execute: "operate", executing: "operate",
	run: "operate", running: "operate",
};

const ENV_TERMS = /\b(production|prod\b|staging|live environment|live site|customer data|user data|payment data)\b/gi;
/** Targeting is grammatical: the verb must govern the environment term, either
 * directly ("restart prod", "migrate the production database") or through a
 * preposition ("deploy the build to production"). Bare co-occurrence inside a
 * wide window ("fix the deploy script so staging releases work") is a mention. */
const ENV_TARGET_GOVERNED = /\b(deploy(?:ing|ment)?|release|publish|push|ship|roll\s?out|migrate|modify|change|edit|update|delete|drop|truncate|restart|reboot|scale|configure)\b[^,;:!?()\n]{0,64}\b(?:to|in|on|for|of|into|onto|against)\s+(?:the\s+)?(production|prod|staging|live environment|live site|customer data|user data|payment data)\b|\b(modify|change|edit|update|delete|drop|truncate|restart|reboot|scale|configure|migrate)\s+(?:the\s+)?(production|prod|staging|live environment|live site)\b/i;
const SAFETY_DOMAIN = /\b(security|auth(?:entication|orization)?|oauth|login|password|secret|credential|cryptograph\w*|payment|billing|invoice|charge|refund|pii|phi|hipaa|pci|sox|safety-critical|concurrency|race condition|deadlock|migration|schema migration)\b/i;

const READ_ONLY_DELIVERABLE = /\b(review only|suggest fixes only|return findings only|only return findings|findings? only|no file (?:edits?|changes?)|leave (?:files?|code) unchanged|read[- ]only (?:review|audit|inspection|pass|investigation|analysis))\b/i;
const SCOPED_CONSTRAINT = /\bdo not (?:edit|modify|change|touch)\s+(?:files?\s+)?(?:outside|unrelated|other)|except\s+(?:in|under|within)\b/i;
const WRITE_IMPERATIVE = /\b(implement|edit|modify|refactor|fix|patch|apply (?:the )?(?:fix|patch|changes?)|make (?:the )?changes?|create|delete|remove|migrate|commit)\b/i;

const DELIVERABLE_CUES: Array<{ type: DeliverableType; pattern: RegExp }> = [
	{ type: "findings", pattern: /\b(findings?|issues? (?:list|found)|vulnerabilit\w+|diagnos\w+|root ?cause|report of|audit (?:report|results?))\b/i },
	{ type: "code-change", pattern: /\b(fix(?:es)?|patch|pull request|\bPR\b|diff|commit|branch|implementation)\b/i },
	{ type: "plan", pattern: /\b(plan|proposal|design doc|RFC|roadmap|migration plan|rollout plan)\b/i },
	{ type: "summary", pattern: /\b(summary|summar\w+|overview|tldr|tl;dr|digest)\b/i },
	{ type: "operation", pattern: /\b(deploy(?:ment)?|release|rollout|rollback|restart|runbook|incident response)\b/i },
];

export interface ExtractOptions {
	/** Agent role hints read-only vs implementation defaults (e.g. reviewer, worker). */
	agent?: string;
}

function splitClauses(text: string): string[] {
	return text
		.replace(/\\(?:r\\n|n)/g, "\n")
		.split(/(?<=[.;:!?()\n])\s+|\r?\n+/)
		.map((clause) => clause.trim())
		.filter(Boolean)
		.slice(0, MAX_CLAUSES);
}

function verbsIn(span: string): string[] {
	const verbs: string[] = [];
	for (const match of span.toLowerCase().matchAll(/[a-z][a-z-]{1,30}/g)) {
		const canonical = VERB_FORMS[match[0]];
		if (canonical && !verbs.includes(canonical)) verbs.push(canonical);
	}
	return verbs;
}

function collectReopenedSpans(span: string): string[] {
	const spans: string[] = [];
	for (const pattern of [CONTRAST_REOPEN, NOT_JUST_REOPEN]) {
		pattern.lastIndex = 0;
		for (const match of span.matchAll(pattern)) {
			if (match[1]) spans.push(match[1]);
		}
		pattern.lastIndex = 0;
	}
	return spans;
}

function maskFilePaths(text: string): string {
	FILE_PATH.lastIndex = 0;
	const masked = text.replace(FILE_PATH, " ");
	FILE_PATH.lastIndex = 0;
	return masked;
}

function requestedVerbsIn(span: string): string[] {
	// Contrast clauses ("but implement the fix") re-open requested intent, so
	// they are captured BEFORE negation windows are stripped; otherwise the
	// window would swallow the follow-on clause.
	const reopened = collectReopenedSpans(span);
	NEGATION_WINDOW.lastIndex = 0;
	const cleaned = `${span.replace(NEGATION_WINDOW, " ")} ${reopened.join(" ")}`;
	NEGATION_WINDOW.lastIndex = 0;
	return verbsIn(cleaned);
}

/** Text with negation windows removed and contrast clauses preserved. */
function stripNegationWindows(span: string): string {
	const reopened = collectReopenedSpans(span);
	NEGATION_WINDOW.lastIndex = 0;
	const cleaned = `${span.replace(NEGATION_WINDOW, " ")} ${reopened.join(" ")}`;
	NEGATION_WINDOW.lastIndex = 0;
	return cleaned;
}

function negatedVerbsIn(span: string): string[] {
	const verbs: string[] = [];
	for (const match of span.matchAll(NEGATION_WINDOW)) {
		for (const verb of verbsIn(match[1] ?? "")) {
			if (!verbs.includes(verb)) verbs.push(verb);
		}
	}
	return verbs;
}

function maskSpans(text: string, spans: string[]): string {
	let masked = text;
	for (const span of spans) {
		if (span) masked = masked.split(span).join(" ");
	}
	return masked;
}

function collectQuotedSpans(text: string): string[] {
	const spans: string[] = [];
	for (const pattern of [CODE_FENCE, INLINE_CODE, QUOTED, LEAD_QUOTE]) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			if (match[0] && match[0].length <= 2048) spans.push(match[0]);
			if (spans.length >= 64) break;
		}
		pattern.lastIndex = 0;
	}
	EXAMPLE_PREFIX.lastIndex = 0;
	for (const match of text.matchAll(EXAMPLE_PREFIX)) {
		if (match[1]) spans.push(match[1]);
		if (spans.length >= 96) break;
	}
	EXAMPLE_PREFIX.lastIndex = 0;
	return spans;
}

const BACKGROUND_HEAD = /^(?:context|background|note|notes|fyi|for reference|given that|assuming|suppose|in .{0,40} (?:docs?|documentation|architecture|design))\b/i;

function isBackgroundClause(clause: string): boolean {
	return BACKGROUND_HEAD.test(clause.trim());
}

function environmentRefsIn(clause: string): Array<{ term: string; role: "mention" | "target" | "background" }> {
	const refs: Array<{ term: string; role: "mention" | "target" | "background" }> = [];
	ENV_TERMS.lastIndex = 0;
	const matches = [...clause.matchAll(ENV_TERMS)];
	ENV_TERMS.lastIndex = 0;
	if (!matches.length) return refs;
	const background = isBackgroundClause(clause);
	const negated = NEGATION_HEAD.test(clause);
	const governed = !background && !negated && ENV_TARGET_GOVERNED.test(clause);
	for (const match of matches) {
		// A negated clause ("do not touch prod") is never a target, and bare
		// co-occurrence ("staging releases work", "production outage") is a
		// mention. Targeting requires the verb to govern the environment term.
		refs.push({ term: (match[1] ?? "").toLowerCase(), role: background ? "background" : governed ? "target" : "mention" });
	}
	return refs;
}

/**
 * Extract the canonical structured task intent. Safety restrictions constrain
 * execution; they never retype the requested work.
 */
export function extractTaskIntent(task: string, options: ExtractOptions = {}): TaskIntent {
	const text = (task ?? "").slice(0, MAX_TEXT);
	const quotedSpans = collectQuotedSpans(text);
	const masked = maskFilePaths(maskSpans(text, quotedSpans));
	const clauses = splitClauses(masked);

	const requestedVerbs: string[] = [];
	const negatedVerbs: string[] = [];
	const environmentRefs: Array<{ term: string; role: "mention" | "target" | "background" }> = [];
	const backgroundContext: string[] = [];
	let safetyCriticalDomain = false;

	for (const clause of clauses) {
		if (isBackgroundClause(clause)) {
			if (backgroundContext.length < 16) backgroundContext.push(clause.slice(0, 280));
			environmentRefs.push(...environmentRefsIn(clause));
			continue;
		}
		for (const verb of requestedVerbsIn(clause)) {
			if (!requestedVerbs.includes(verb)) requestedVerbs.push(verb);
		}
		for (const verb of negatedVerbsIn(clause)) {
			if (!negatedVerbs.includes(verb)) negatedVerbs.push(verb);
		}
		environmentRefs.push(...environmentRefsIn(clause));
		if (!safetyCriticalDomain && SAFETY_DOMAIN.test(clause) && !NEGATION_HEAD.test(clause)) {
			safetyCriticalDomain = true;
		}
	}

	const safetyNotes: string[] = [];
	const prohibitedActions = negatedVerbs.filter((verb) => !requestedVerbs.includes(verb));
	for (const verb of prohibitedActions) {
		safetyNotes.push(`"${verb}" appears only as a prohibition; it constrains execution, not task type.`);
	}
	for (const verb of negatedVerbs) {
		if (requestedVerbs.includes(verb)) {
			safetyNotes.push(`"${verb}" is both prohibited (scoped) and requested; the requested scope wins.`);
		}
	}
	for (const ref of environmentRefs) {
		if (ref.role !== "target") continue;
		safetyNotes.push(`"${ref.term}" is a requested target; treat as environment-sensitive.`);
		break;
	}

	let deliverableType: DeliverableType = "unknown";
	for (const cue of DELIVERABLE_CUES) {
		if (cue.pattern.test(masked)) {
			deliverableType = cue.type;
			break;
		}
	}

	const hasEnvTarget = environmentRefs.some((ref) => ref.role === "target");
	const requestedAction = requestedActionFrom(requestedVerbs, deliverableType, hasEnvTarget, options.agent);
	const mutationPermission = mutationPermissionFrom(masked, requestedVerbs, requestedAction, options.agent);
	const environmentSensitivity = environmentSensitivityFrom(environmentRefs, safetyCriticalDomain, requestedAction);
	const decisionCriticality = criticalityFrom(requestedAction, mutationPermission, environmentSensitivity, safetyCriticalDomain);
	const requiredEvidence = requiredEvidenceFrom(requestedAction, deliverableType, environmentSensitivity);

	return {
		requestedAction,
		prohibitedActions,
		requiredEvidence,
		mutationPermission,
		environmentSensitivity,
		decisionCriticality,
		segments: {
			requestedVerbs,
			negatedVerbs,
			quotedSpans: quotedSpans.slice(0, 32),
			environmentRefs: environmentRefs.slice(0, 32),
			backgroundContext,
			deliverableType,
			safetyCriticalDomain,
			clauseCount: clauses.length,
		},
		safetyNotes: safetyNotes.slice(0, 16),
	};
}

function requestedActionFrom(verbs: string[], deliverable: DeliverableType, hasEnvTarget: boolean, agent?: string): RequestedAction {
	const reviewer = agent ? /\b(?:advisor|reviewer|oracle)\b/i.test(agent) : false;
	const researcher = agent ? /\b(?:investigate|scout|research(?:er)?)\b/i.test(agent) : false;
	// "operate" dominates only when the environment is actually targeted.
	// Nominal mentions ("the deployment failed", "fix the deploy script",
	// "update the deployment documentation") are reports and code work, not
	// operations — the deliverable cue alone must not promote them.
	if (verbs.includes("operate") && hasEnvTarget) return "operate";
	if (verbs.includes("implement")) return "implement";
	if (verbs.includes("review")) return "review";
	if (verbs.includes("investigate")) return "investigate";
	if (verbs.includes("plan")) return "plan";
	if (verbs.includes("summarize")) return "summarize";
	if (verbs.includes("answer")) return "answer";
	// Bare "operate" without an environment target is the weakest claim: a
	// nominal mention ("the deployment failed") loses to any concrete action.
	if (verbs.includes("operate")) return "operate";
	if (researcher) return "investigate";
	if (reviewer) return "review";
	if (agent === "worker") return "implement";
	if (deliverable === "findings") return "review";
	if (deliverable === "code-change") return "implement";
	if (deliverable === "plan") return "plan";
	if (deliverable === "summary") return "summarize";
	if (deliverable === "operation") return "operate";
	return "unknown";
}

function mutationPermissionFrom(
	masked: string,
	requestedVerbs: string[],
	action: RequestedAction,
	agent?: string,
): MutationPermission {
	const readOnly = READ_ONLY_DELIVERABLE.test(masked);
	const scoped = SCOPED_CONSTRAINT.test(masked);
	// Write imperatives count only outside negation windows: "do not modify
	// production" is a prohibition, not a write imperative.
	const requested = stripNegationWindows(masked);
	const writeImperative = WRITE_IMPERATIVE.test(requested) || requestedVerbs.includes("implement");
	if (readOnly && !writeImperative) return "forbidden";
	if (readOnly && writeImperative) return scoped ? "scoped" : "required";
	if (scoped && writeImperative) return "scoped";
	if (writeImperative || action === "implement" || action === "operate") return "required";
	const reviewer = agent ? /\b(?:advisor|reviewer|oracle)\b/i.test(agent) : false;
	const researcher = agent ? /\b(?:investigate|scout|research(?:er)?)\b/i.test(agent) : false;
	if (reviewer || researcher) return "forbidden";
	if (action === "review" || action === "investigate" || action === "summarize" || action === "answer") return "forbidden";
	if (action === "unknown") return "unknown";
	return "allowed";
}

function environmentSensitivityFrom(
	refs: Array<{ term: string; role: "mention" | "target" | "background" }>,
	safetyCritical: boolean,
	action: RequestedAction,
): EnvironmentSensitivity {
	if (refs.some((ref) => ref.role === "target")) return "production-target";
	if (safetyCritical && (action === "implement" || action === "operate")) return "safety-critical";
	if (refs.length) return "production-mention";
	return "none";
}

function criticalityFrom(
	action: RequestedAction,
	mutation: MutationPermission,
	env: EnvironmentSensitivity,
	safetyCritical: boolean,
): DecisionCriticality {
	if (env === "production-target" || env === "safety-critical") return "critical";
	if (safetyCritical && mutation === "required") return "critical";
	if (mutation === "forbidden" && (action === "investigate" || action === "review" || action === "summarize" || action === "answer" || action === "plan")) {
		return "advisory";
	}
	return "standard";
}

function requiredEvidenceFrom(
	action: RequestedAction,
	deliverable: DeliverableType,
	env: EnvironmentSensitivity,
): string[] {
	const evidence: string[] = [];
	if (action === "review" || action === "investigate" || deliverable === "findings") {
		evidence.push("source-refs", "file-evidence");
	}
	if (action === "implement" || deliverable === "code-change") {
		evidence.push("tests", "diff-evidence");
	}
	if (action === "plan" || deliverable === "plan") evidence.push("plan-artifact");
	if (action === "summarize") evidence.push("source-refs");
	if (action === "operate" || env === "production-target") evidence.push("approval", "rollback-plan");
	if (!evidence.length) evidence.push("final-answer");
	return evidence;
}

/** Advisory/standard/critical level for model-quality gating, from segments. */
export function intentQualityLevel(intent: TaskIntent): "advisory" | "standard" | "critical" {
	return intent.decisionCriticality;
}

/** Domain for model-quality gating, from requested (never prohibited) verbs. */
export function intentDomain(intent: TaskIntent): "coding" | "reasoning" | "general" {
	if (intent.requestedAction === "operate") return "general";
	const verbs = intent.segments.requestedVerbs;
	if (verbs.includes("implement") || verbs.includes("review")) return "coding";
	if (verbs.includes("plan") || verbs.includes("investigate")) {
		return intent.segments.safetyCriticalDomain ? "reasoning" : "coding";
	}
	return "general";
}

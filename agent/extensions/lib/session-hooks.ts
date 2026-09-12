/**
 * Deterministic, topic-agnostic session hooks.
 *
 * One pre-written line of operational guidance the first time a session
 * touches a recurring workflow surface: web research, browser inspection,
 * test runs, linters, mutating git, CI, dependency installs, delegated
 * children, swarms/fusions, and literal searches that found nothing.
 *
 * The guidance is deliberately independent of project, language and task:
 * it encodes workflow discipline (read the evidence, keep scopes bounded,
 * prefer cheap delegation), never claims about a specific codebase.
 *
 * Pure policy only — no pi imports, no I/O, no subprocesses. The extension
 * (`extensions/session-hooks.ts`) owns registration, once-per-session state
 * and telemetry; this module stays unit-testable.
 */

export type HookArgs = Record<string, unknown>;

export interface HookRule {
	/** Stable once-per-session key and telemetry hook id. */
	key: string;
	/** Tool names the rule applies to. */
	tools: readonly string[];
	/** One deterministic line; no outcome claims, no blame. */
	line: string;
	/** Extra predicate over the call arguments (tool_call time). */
	when?: (args: HookArgs) => boolean;
	/**
	 * When true the rule fires only if the tool result carries no matches.
	 * Used for literal-search rules where the useful moment is the miss.
	 */
	needsEmptyResult?: boolean;
}

const TEST_RUNNER =
	/\b(?:npm (?:run )?test\b|npm t\b|npx (?:vitest|jest)\b|pytest\b|python3? -m pytest\b|cargo test\b|go test\b|node --test\b|dotnet test\b|mvn test\b|gradle test\b)/;
const LINTER =
	/\b(?:tsc\b|ruff\b|mypy\b|eslint\b|clippy\b|golangci-lint\b|swiftlint\b)/;
const GIT_WRITE =
	/\bgit\s+(?:commit|push|merge|rebase|reset|cherry-pick|tag|revert)\b/;
const CI = /\bgh (?:run|workflow)\b/;
const INSTALL =
	/\b(?:npm (?:i|install|add)\b|pnpm (?:add|install)\b|yarn add\b|pip3? install\b|cargo add\b|go get\b|apt-get install\b)/;
/** Swarm/fusion surfaces inside a subagent workflow script. */
const FUSION = /\b(?:fuse|fusion|swarm|runs\.lanes)\b/;

const bashCommand = (args: HookArgs): string =>
	typeof args.command === "string" ? args.command : "";

const contains = (pattern: RegExp) => (args: HookArgs) =>
	pattern.test(bashCommand(args));

/**
 * Ordered most-specific-first: the fusion rule must win over the generic
 * delegation rule, and literal-search guidance is keyed on a result property.
 */
export const HOOK_RULES: readonly HookRule[] = [
	{
		key: "web-verify",
		tools: ["web_search"],
		line: "Read the primary sources with fetch_content before concluding; cite only pages that were actually opened.",
	},
	{
		key: "browser-evidence",
		tools: ["render_see"],
		line: "Prefer output:'text' for DOM and labels; for pixel or motion questions capture the specific selector or timestamp instead of inferring from text.",
	},
	{
		key: "tests-first-failure",
		tools: ["bash"],
		line: "Read the first failure verbatim before editing; re-run the narrowed test after the change and never report a failing check as passed.",
		when: contains(TEST_RUNNER),
	},
	{
		key: "lint-first-diagnostic",
		tools: ["bash"],
		line: "Fix the first reported diagnostic and re-run the same linter; do not suppress a rule to silence it.",
		when: contains(LINTER),
	},
	{
		key: "git-write-verify",
		tools: ["bash"],
		line: "Run the project's checks before committing; never commit credentials or runtime state, and push only verified changes.",
		when: contains(GIT_WRITE),
	},
	{
		key: "ci-failing-job",
		tools: ["bash"],
		line: "Inspect the failing job log before re-running (gh run view --log-failed); a re-run alone is not a fix.",
		when: contains(CI),
	},
	{
		key: "deps-pin",
		tools: ["bash"],
		line: "Prefer exact pins and the existing lockfile; widening a version range is a decision to surface, not a default.",
		when: contains(INSTALL),
	},
	{
		key: "subagent-fusion-budget",
		tools: ["subagent"],
		line: "Swarms and fusions stay advisory and cheap: free or low-cost low-thinking models, bounded scopes, and the parent reads disagreements before acting.",
		when: (args) => FUSION.test(JSON.stringify(args)),
	},
	{
		key: "subagent-contract",
		tools: ["subagent"],
		line: "Declare each child's file scope and acceptance up front; one writer per file, and read-only scopes prefer free or low-thinking models.",
	},
	{
		key: "search-fuzzy",
		tools: ["grep", "find"],
		line: "No literal match here — identifier-ranked symbol_search and fuzzy findText cover renames, typos and concept matches that exact patterns miss.",
		needsEmptyResult: true,
	},
];

/** First matching rule for a tool call, or null when no hook applies. */
export function matchHook(
	toolName: string,
	args: HookArgs = {},
): HookRule | null {
	for (const rule of HOOK_RULES) {
		if (!rule.tools.includes(toolName)) continue;
		if (rule.when && !rule.when(args)) continue;
		return rule;
	}
	return null;
}

/**
 * Conservative "the search found nothing" check over tool-result content.
 * Unknown/ambiguous shapes return false so the hook stays silent rather
 * than annotating a result that did contain matches.
 */
export function isEmptySearchResult(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	const text = content
		.filter(
			(part): part is { type?: string; text?: string } =>
				!!part && typeof part === "object",
		)
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("\n")
		.trim();
	if (text.length === 0) return true;
	return /^(?:no (?:matches|files|results)\b|found 0\b)/i.test(text);
}

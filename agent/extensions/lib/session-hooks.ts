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
	/** Failure recovery has separate receipts from successful first use. */
	onError?: boolean;
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
const FUSION = /\b(?:fuse|fusion|swarm|runs\.(?:all|lanes|fuseFragments))\b/;

const bashCommand = (args: HookArgs): string =>
	typeof args.command === "string" ? args.command : "";

const contains = (pattern: RegExp) => (args: HookArgs) =>
	pattern.test(bashCommand(args));
const isExecution = (args: HookArgs) => !args.action;
const isBrowserMutation = (args: HookArgs) =>
	["click", "fill", "press", "select", "check", "hover", "scroll", "drag", "evaluate"].includes(String(args.action)) ||
	(args.action === "wait" && args.kind === "function");

/**
 * Ordered most-specific-first: the fusion rule must win over the generic
 * delegation rule, and literal-search guidance is keyed on a result property.
 */
export const HOOK_RULES: readonly HookRule[] = [
  {
    key: 'host-device-preflight', tools: ['sys_probe'],
    when: args => args.action === 'host' || args.action === 'devices',
    line: 'Preserve network, session ancestors and mounted data. Inspect test entrypoints; prefer isolated bounded experiments and compile-only firmware checks. Device metadata does not verify wiring or authorize writes.',
  },
  {
    key: 'svg-source-evidence', tools: ['artifact_check'],
    when: args => args.operation === 'svg',
    line: 'Review SVG findings against the complete file, then inspect rendered appearance at intended sizes. No resources were fetched; security sanitization, font rendering and animation correctness remain unverified.',
  },
  {
    key: 'graphics-budget-evidence', tools: ['math_check'],
    when: args => args.operation === 'frame_budget' || args.operation === 'render_budget',
    line: 'Keep measurements and render assumptions with the result. Compare the same scene and device before/after optimization; attachment arithmetic excludes other GPU allocations and cannot prove speed or visual fidelity.',
  },
  {
    key: 'ui-source-evidence', tools: ['artifact_check'],
    when: args => args.operation === 'ui',
    line: 'Inspect flagged components against project rules and real status data. Verify rendered typography, contrast and interaction states. Source cues cannot certify design; fix demonstrated defects first.',
  },
	{
		key: "media-recover", tools: ["media_info", "video_frames", "audio_analyze", "media_edit"], onError: true,
		line: "Check the failed path, stream and time window; media_info capabilities reports installed support. Narrow a timed-out job or use existing background tools for long renders; keep completed artifacts.",
	},
	{
		key: "video-sample-evidence", tools: ["video_frames"],
		line: "Inspect the returned frames and timing manifest. Sample more densely around suspected events; sparse frames cannot prove continuous motion, exact event boundaries or unseen content.",
	},
	{
		key: "audio-measurement-scope", tools: ["audio_analyze"],
		line: "Keep the measured window and units with findings. LUFS, sample peak and true peak differ; silence thresholds do not identify speech, and numbers alone do not verify audible quality.",
	},
	{
		key: "media-export-review", tools: ["media_edit"],
		line: "Review the output streams, duration and normalization report, then inspect representative playback for sync and quality. A clean decode does not establish correct edits or intelligibility.",
	},
	{
		key: "music-score-review", tools: ["music_compose"],
		line: "Review the MIDI and audition the WAV for rhythm, harmony and endings. The preview uses simple oscillators; MIDI program changes need a soundfont or DAW for instrument-quality rendering.",
	},
	{
		key: "ffmpeg-source-review", tools: ["bash"],
		when: (args) => /^(?:(?:\/[\w.-]+)+\/)?ffmpeg\s/.test(bashCommand(args).trim()),
		line: "Probe source streams and preserve originals. Set mappings and timing explicitly; use media_edit for bounded presets and inspect decoded output plus representative playback before delivery.",
	},
	{
		key: "browser-session-recovery", tools: ["browser_session"], onError: true,
		when: isBrowserMutation,
		line: "Reconcile current page, account history or submission receipt before retrying an uncertain action. A timeout may follow a successful post. Save the outcome in the existing plan and continue independent work.",
	},
	{
		key: "browser-session-read-recovery", tools: ["browser_session"], onError: true,
		line: "Use the reported stage and nextStep. For navigation failures check the server task and URL; for inspection failures check current selectors and state before retrying.",
	},
	{
		key: "browser-session-workflow", tools: ["browser_session"],
		line: "Verify exact draft and account before submitting. Use fresh targets after changes and wait for an observed condition. On a humanHelp block call request_help once; renew before lease expiry and reacquire after restart.",
		when: isBrowserMutation,
	},
	{
		key: 'source-check-recovery', tools: ['syntax_check'], onError: true,
		line: 'Fix reported syntax errors; use project checks for missing parsers and narrow incomplete batches. Rerun changed files. Syntax alone does not establish type or runtime correctness.',
	},
	{
		key: 'source-check-scope', tools: ['syntax_check'],
		line: 'These receipts cover syntax of the returned source digests. Keep required project types, tests and configuration schema checks. Later edits invalidate this evidence.',
	},
	{
		key: "subagent-recover-evidence",
		tools: ["subagent"],
		onError: true,
		line: "Inspect each child's structured outcome; preserve successful siblings and retry only the failed scope after correcting its cause. Status and retained artifacts can resolve uncertainty without relaunching.",
	},
	{
		key: "browser-recover-state",
		tools: ["render_see"],
		onError: true,
		line: "Use the reported failure stage to check the server, URL or selector before another capture; an unavailable renderer supplies no visual evidence. Reuse the existing server task when it is healthy.",
	},
	{
		key: "background-completion",
		tools: ["bg_run"],
		line: "Keep the returned task ID and continue independent work. Completion normally notifies; inspect that task's status or output if needed instead of repeated shell polling or duplicate launches.",
	},
	{
		key: "form-reconnaissance",
		tools: ["web_probe"],
		line: "Form fields are read-only reconnaissance, not a logged-in browser. Use an available interactive browser for authorized submissions, then verify the resulting page before retrying.",
	},
	{
		key: "task-dependencies",
		tools: ["todo"],
		line: "Plan outcomes and child steps here; batch related edits, reuse IDs after follow-ups, and record evidence before completion. Native tools dispatch runs; active plan files feed session coordination.",
	},
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
		when: (args) => isExecution(args) && (Array.isArray(args.tasks) && args.tasks.length > 1
			|| typeof args.workflowScript === "string" && FUSION.test(args.workflowScript)),
	},
	{
		key: "subagent-contract",
		tools: ["subagent"],
		line: "Declare each child's file scope, required tools, relevant skills and acceptance up front. Keep one writer per file; retain native result handles and use completion notifications for queued work.",
		when: isExecution,
	},
	{
		key: "search-fuzzy",
		tools: ["grep", "find"],
		line: "No literal match here. If code intelligence is available, try identifier-ranked symbol_search or context_code findText with a shorter identifier; first confirm the search path and pattern.",
		needsEmptyResult: true,
	},
];

/** First matching rule for a tool call, or null when no hook applies. */
export function matchHook(
	toolName: string,
	args: HookArgs = {},
	onError = false,
	result?: { details?: any; content?: unknown },
): HookRule | null {
	for (const rule of HOOK_RULES) {
		if (!!rule.onError !== onError) continue;
		if (!rule.tools.includes(toolName)) continue;
		if (rule.when && !rule.when(args)) continue;
		if (rule.key === 'browser-session-recovery') {
			const failure = result?.details?.failure;
			const text = Array.isArray(result?.content) ? result.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join(' ') : '';
			if (failure?.outcome !== 'unknown' && (failure?.outcome || !/\b(?:timeout|timed out|TimeoutError)\b/i.test(text))) continue;
		}
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

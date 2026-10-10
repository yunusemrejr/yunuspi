/**
 * Deterministic, topic-agnostic session hooks.
 *
 * One pre-written line of operational guidance the first time a session
 * touches a recurring workflow surface: web research, browser inspection,
 * test runs, linters, mutating git, CI, dependency installs, delegated
 * children, fan-outs, and literal searches that found nothing.
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
const GIT_WRITE =
	/\bgit\s+(?:commit|push|merge|rebase|reset|cherry-pick|tag|revert)\b/;
const CI = /\bgh (?:run|workflow)\b/;
/** Pushes to production-like remotes and hosted deploy commands. */
const DEPLOY =
	/\bgit\s+push\s+(?:-\S+\s+)*(?:prod\w*|live|deploy\w*|namecheap|heroku|dokku|server|origin\s+(?:prod\w*|live|deploy\w*))\b|\brsync\b[^\n]*\s[\w.-]+@?[\w.-]+:[^\s]|\bscp\b[^\n]*\s[\w.-]+@?[\w.-]+:|\b(?:vercel(?:\s+--prod)?|netlify\s+deploy|fly\s+deploy|wrangler\s+(?:deploy|publish)|firebase\s+deploy|gcloud\s+app\s+deploy|kubectl\s+apply|helm\s+upgrade|docker\s+push)\b/;
/** Interface source files whose first write deserves a rendered look. */
const UI_FILE = /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro|php|twig|erb|hbs)$/i;

const bashCommand = (args: HookArgs): string =>
	typeof args.command === "string" ? args.command : "";

const contains = (pattern: RegExp) => (args: HookArgs) =>
	pattern.test(bashCommand(args));
const isExecution = (args: HookArgs) => !args.action;
const isBrowserMutation = (args: HookArgs) =>
	["click", "fill", "press", "select", "check", "hover", "scroll", "drag", "evaluate"].includes(String(args.action)) ||
	(args.action === "wait" && args.kind === "function");

/**
 * Ordered most-specific-first: the fan-out rule must win over the generic
 * delegation rule, and literal-search guidance is keyed on a result property.
 */
export const HOOK_RULES: readonly HookRule[] = [
	{
		// First interface file of the session: judge the design as rendered,
		// not as source. Open briefs also deserve a deliberate direction.
		key: "ui-first-render",
		tools: ["write", "edit"],
		line: "Use ui_explore early for 320px/mobile/tablet/desktop pixels and measurements; visual_review run then record its runId and every rubric section on the current revision. Check the actual keyboard task with browser_session. Judge hierarchy, type, color, spacing, content and states against this product's identity. Text-only models need permitted vision evidence; source code cannot approve appearance. For public website pages/routes also use seo_toolkit to establish page purpose, inspect raw HTML and verify canonical/crawl/discovery consistency; preserve private app exclusion.",
		when: (args) => typeof args.path === "string" && UI_FILE.test(args.path),
	},
	{
		key: "visual-review-receipt",
		tools: ["visual_review"],
		when: (args) => args.action === 'run',
		line: "Judge every needsVision section from delivered pixels or permitted image_understand on this capture, then record every rubric section with this runId. UNKNOWN stays open. Changed dependencies invalidate the run; measured FAILs require repair or a specific dismissal. Reuse current evidence instead of repeating unchanged captures.",
	},
	{
		key: "video-render-review", tools: ["video_render"],
		line: "Stills return measured text-fit evidence; open full-size hero/detail frames and compare silhouette, material/light, spacing and typography to the brief and references. Previews judge continuous pacing, easing and transitions. Finals need video_qa analyze then explicit art-direction/composition/typography/playback/listening verdicts. A successful render never approves itself.",
	},
	{
		key: "video-qa-review", tools: ["video_qa"],
		when: (args) => args.action === undefined || args.action === 'analyze',
		line: "Fix technical errors, then inspect full-size hero/detail pixels against the stored brief and references, inspect continuous playback and listen to the final encoding. Record separate art-direction, composition, typography, motion, sync and audio verdicts with concrete observations and comparedReferences. Missing vision/playback/listening remains unreviewed; technical passes do not approve design.",
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
		key: "subagent-recover-evidence",
		tools: ["subagent"],
		onError: true,
		line: "Inspect each child's structured outcome; preserve successful siblings and retry only the failed scope after correcting its cause. Status and retained artifacts can resolve uncertainty without relaunching.",
	},
	{
		key: "background-completion",
		tools: ["bg_run"],
		line: "Keep the returned task ID and continue independent work. Completion normally notifies; inspect that task's status or output if needed instead of repeated shell polling or duplicate launches.",
	},
	{
		key: "tests-first-failure",
		tools: ["bash"],
		line: "Read the first failure verbatim before editing; re-run the narrowed test after the change and never report a failing check as passed.",
		when: contains(TEST_RUNNER),
	},
	{
		// Production deploys (live session 2026-09-24 pushed to a production
		// remote) are where "done" must be checked against the real site.
		key: "deploy-verify-live",
		tools: ["bash"],
		line: "After this deploy, verify the LIVE bytes, not the push: fetch each changed asset from the production URL and compare its sha256 with the local file (curl -s URL | sha256sum). A replaced image/CSS/JS served with a long Cache-Control max-age needs a new URL (?v=hash) or a cache purge, or returning visitors keep the old bytes. Keep the previous revision reachable for rollback. For public pages re-run seo_toolkit audit on the production canonical origin for status/robots/canonical/sitemap/schema/links/discovery/cache parity.",
		when: contains(DEPLOY),
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
		key: "subagent-contract",
		tools: ["subagent"],
		line: "Declare each child's file scope, required tools, relevant skills and acceptance up front. Keep one writer per file; retain native result handles and use completion notifications for queued work.",
		when: isExecution,
	},
	{
		key: "search-fuzzy",
		tools: ["grep", "find"],
		line: "No literal match here. If code intelligence is available, try identifier-ranked symbol_search with a shorter identifier; first confirm the search path and pattern.",
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
/** A deploy command that ran successfully (same catalogue as deploy-verify-live). */
export function isDeployCommand(toolName: string, args: HookArgs): boolean {
	return toolName === "bash" && DEPLOY.test(bashCommand(args));
}

const LOCAL_URL = /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?:[:/]|$)/i;
const REMOTE_FETCH = /\b(?:curl|wget)\b[^\n]*?(https?:\/\/[^\s'"|;)]+)/g;
const BYTE_COMPARISON = /\b(?:sha(?:1|224|256|384|512)sum|shasum|md5sum|b2sum|cmp|diff|openssl\s+dgst|wc\s+-c)\b|size_download|content-length|etag/i;

/** Evidence that the live site's bytes were compared after a deploy: a remote
 * (non-loopback) fetch combined with a hash, byte or header comparison, or a
 * remote http_request (which reports status, content-length and ETag). A
 * status-only probe or a grep of the HTML proves the page answers, not that the
 * changed bytes are what visitors get. */
export function isLiveByteVerification(toolName: string, args: HookArgs): boolean {
	if (toolName === "http_request") {
		const url = typeof args.url === "string" ? args.url : "";
		return /^https?:\/\//i.test(url) && !LOCAL_URL.test(url);
	}
	if (toolName !== "bash") return false;
	const command = bashCommand(args);
	const remote = [...command.matchAll(REMOTE_FETCH)].some((match) => !LOCAL_URL.test(match[1]));
	return remote && BYTE_COMPARISON.test(command);
}

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

/** Core read/ls/grep/find/edit attach their own nearest-folder hint (core/tools/path-hints.js). */
export const CORE_PATH_HINT_TOOLS: ReadonlySet<string> = new Set(["read", "ls", "grep", "find", "edit"]);

const MISSING_PATH_PATTERNS: readonly RegExp[] = [
	/ENOENT: no such file or directory, \w+ '([^'\n]{1,400})'/,
	/No such file or directory: '([^'\n]{1,400})'/,
	/cannot (?:access|open|stat) '([^'\n]{1,400})': No such file or directory/,
	/(?:^|\n)[\w.-]+: ([^\s:'"][^:'"\n]{0,399}): No such file or directory/,
	/(?:^|[\s"'`])((?:\/|\.{1,2}\/|~\/)[^\s'"`]{1,400}) does not exist\b/,
];

/**
 * The path a failed tool result says is missing, or undefined. Only the first
 * recognizable "no such file" shape counts; the caller still checks that the
 * path is really absent before hinting, so a stale mention never yields advice.
 */
export function missingPathFromError(text: unknown): string | undefined {
	if (typeof text !== "string" || !text || text.includes("Nearest existing directory")) return undefined;
	for (const pattern of MISSING_PATH_PATTERNS) {
		const found = pattern.exec(text)?.[1]?.trim().replace(/[.,;:]+$/, "");
		if (found && (found.includes("/") || /\.\w{1,8}$/.test(found))) return found;
	}
	return undefined;
}

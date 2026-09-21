/**
 * Task-aware child tool subsets with lazy escalation.
 *
 * Nothing is ever removed: every agent keeps its complete permitted tool set.
 * But a child request only serializes the MINIMAL subset its task needs, so an
 * unrelated utility tool with an incompatible schema cannot fail an otherwise
 * healthy source-code review. The full inventory stays available through
 * discovery (`tool-discovery.ts`) and escalation mid-run.
 *
 * Templates (computed per launch from task intent + agent role):
 *   source-review, repo-recon, browser-review, data-audit, implementation,
 *   web-research, minimal
 *
 * This is the child-side half of the lazy-loading philosophy: specialized
 * capabilities are discovered when useful, never front-loaded onto the wire.
 * Dependency-free and pure; escalation state is caller-owned.
 */
import type { TaskIntent } from "./task-intent-model.ts";

export type ToolSubsetTemplate =
	| "source-review"
	| "repo-recon"
	| "browser-review"
	| "data-audit"
	| "implementation"
	| "web-research"
	| "minimal";

/** Canonical child tool names (subset of the 29 registered tools). */
export const CHILD_TOOL_CATALOG = Object.freeze([
	"read_file",
	"search",
	"bash",
	"write_file",
	"edit_file",
	"apply_patch",
	"web_fetch",
	"web_search",
	"browser",
	"query_data",
	"run_tests",
	"git",
	"todo",
	"memory",
	"contact_supervisor",
	"request_user_input",
	"subagent",
	"exec_background",
	"image",
	"media",
	"utility",
] as const);

export type ChildToolName = (typeof CHILD_TOOL_CATALOG)[number];

/** Minimal wire subset per template. Everything else stays discoverable. */
const TEMPLATE_SUBSETS: Record<ToolSubsetTemplate, readonly ChildToolName[]> = {
	"source-review": ["read_file", "search", "bash", "contact_supervisor"],
	"repo-recon": ["read_file", "search", "bash", "git", "contact_supervisor"],
	"browser-review": ["browser", "read_file", "contact_supervisor"],
	"data-audit": ["query_data", "read_file", "search", "contact_supervisor"],
	implementation: ["read_file", "search", "bash", "write_file", "edit_file", "apply_patch", "run_tests", "git", "contact_supervisor"],
	"web-research": ["web_fetch", "web_search", "contact_supervisor"],
	minimal: ["read_file", "contact_supervisor"],
};

const BROWSER_CUES = /\b(browser|web ?page|dom|screenshot|playwright|puppeteer|headless|click|navigate|viewport|rendered)\b/i;
const DATA_CUES = /\b(sql|sqlite|query|dataset|csv|parquet|data ?frame|analytics|metrics table|warehouse)\b/i;
const WEB_CUES = /\b(web|internet|online|docs site|documentation site|github\.com|arxiv|search the web|look up)\b/i;
const RECON_CUES = /\b(scout|recon|explore|survey|map|inventory|codebase|repository layout|find files|directory)\b/i;
const IMPLEMENT_CUES = /\b(implement|fix|patch|refactor|migrate|edit|modify|create|delete|add tests|build)\b/i;

export interface ToolSubsetPlan {
	template: ToolSubsetTemplate;
	/** Tools serialized into the child request. */
	wire: ChildToolName[];
	/** Permitted but not serialized; available via discovery/escalation. */
	deferred: ChildToolName[];
	/** Why this template was chosen (bounded, diagnostic-safe). */
	reason: string;
}

/**
 * Compute the launch tool subset. `permitted` is the agent's FULL tool set and
 * is never reduced — deferred tools remain permitted. Unknown tasks get the
 * implementation template's breadth only when mutation is required; otherwise
 * repo-recon breadth without write tools.
 */
export function planChildToolSubset(
	intent: TaskIntent | undefined,
	text: string,
	permitted: readonly string[],
	options: { forceTemplate?: ToolSubsetTemplate } = {},
): ToolSubsetPlan {
	const allowed = new Set(permitted);
	const template = options.forceTemplate ?? selectTemplate(intent, text);
	const wanted = TEMPLATE_SUBSETS[template] ?? TEMPLATE_SUBSETS.minimal;
	const wire = wanted.filter((tool): tool is ChildToolName => allowed.has(tool));
	// contact_supervisor is the escalation channel itself; a subset without it
	// cannot lazily grow, so it is always wired when permitted.
	if (allowed.has("contact_supervisor") && !wire.includes("contact_supervisor")) {
		wire.push("contact_supervisor");
	}
	const wired = new Set(wire);
	const deferred = [...allowed].filter((tool): tool is ChildToolName =>
		(CHILD_TOOL_CATALOG as readonly string[]).includes(tool) && !wired.has(tool as ChildToolName),
	);
	return {
		template,
		wire,
		deferred,
		reason: `${template}: ${wire.length} wired, ${deferred.length} deferred-but-permitted`,
	};
}

function selectTemplate(intent: TaskIntent | undefined, text: string): ToolSubsetTemplate {
	const sample = text.slice(0, 8192);
	if (intent) {
		if (intent.requestedAction === "implement" || intent.mutationPermission === "required") return "implementation";
		if (intent.requestedAction === "review") {
			if (BROWSER_CUES.test(sample)) return "browser-review";
			if (DATA_CUES.test(sample)) return "data-audit";
			return "source-review";
		}
		if (intent.requestedAction === "investigate") {
			if (WEB_CUES.test(sample)) return "web-research";
			if (DATA_CUES.test(sample)) return "data-audit";
			if (BROWSER_CUES.test(sample)) return "browser-review";
			return "repo-recon";
		}
		if (intent.requestedAction === "operate" || intent.requestedAction === "plan") return "repo-recon";
		if (intent.requestedAction === "summarize" || intent.requestedAction === "answer") {
			return WEB_CUES.test(sample) ? "web-research" : "minimal";
		}
	}
	if (IMPLEMENT_CUES.test(sample)) return "implementation";
	if (BROWSER_CUES.test(sample)) return "browser-review";
	if (DATA_CUES.test(sample)) return "data-audit";
	if (WEB_CUES.test(sample)) return "web-research";
	if (RECON_CUES.test(sample)) return "repo-recon";
	return "minimal";
}

export interface EscalationRequest {
	/** Tools the child discovered a need for mid-run. */
	tools: string[];
	/** Bounded reason (no prompts, no arguments). */
	reason: string;
}

export interface EscalationGrant {
	granted: string[];
	/** Requested tools outside the permitted set; never granted. */
	denied: string[];
}

/**
 * Escalate deferred tools mid-run. Only already-permitted tools can be
 * granted; escalation never widens authority, it only serializes more of it.
 */
export function escalateChildTools(
	plan: ToolSubsetPlan,
	permitted: readonly string[],
	request: EscalationRequest,
): EscalationGrant {
	const allowed = new Set(permitted);
	const granted: string[] = [];
	const denied: string[] = [];
	for (const tool of request.tools.slice(0, 32)) {
		if (typeof tool !== "string" || !tool) continue;
		if (plan.wire.includes(tool as ChildToolName)) {
			granted.push(tool);
			continue;
		}
		if (allowed.has(tool)) granted.push(tool);
		else denied.push(tool);
	}
	return { granted: [...new Set(granted)], denied: [...new Set(denied)] };
}

/** Estimate serialized tool-schema overhead for route requirements. */
export function estimateToolSchemaTokens(toolCount: number, avgSchemaTokens = 220): number {
	if (!Number.isFinite(toolCount) || toolCount <= 0) return 0;
	return Math.ceil(Math.min(toolCount, 256) * Math.max(0, avgSchemaTokens));
}

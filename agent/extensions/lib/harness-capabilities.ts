/**
 * A small, source-backed index of harness abilities which do not fit cleanly
 * in the tool schema catalogue.  The index is deliberately metadata only:
 * browsing and searching never execute a tool, read a skill, enumerate model
 * providers, or expose credentials.
 *
 * `HARNESS_CAPABILITIES` is the public, path-free catalogue.  Detail lookup
 * resolves its repository-relative source and documentation references from
 * this module's location, so callers running from another project directory
 * do not accidentally resolve them against the active project.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CapabilityOption {
	readonly name: string;
	readonly values?: readonly string[];
	readonly summary: string;
}

/** A capability record as shipped in the static catalogue. */
export interface HarnessCapability {
	readonly id: string;
	readonly group: string;
	readonly summary: string;
	readonly entrypoints: readonly string[];
	readonly tools: readonly string[];
	readonly commands: readonly string[];
	readonly options: readonly CapabilityOption[];
	readonly related: readonly string[];
	/** Repository-relative paths in the static export; absolute in detail. */
	readonly sourceFiles: readonly string[];
	/** Repository-relative in the static export; absolute in detail. */
	readonly doc: string;
}

/**
 * A page row intentionally stays small.  Full entrypoint/option/source data is
 * available only from `getCapabilityDetail`, so a broad search cannot flood a
 * model context with the catalog itself.
 */
export interface CapabilitySummary {
	readonly id: string;
	readonly group: string;
	readonly summary: string;
	/** At most four primary registered tools, when the capability has any. */
	readonly tools?: readonly string[];
}

export interface CapabilityGroupSummary {
	readonly id: string;
	readonly count: number;
	readonly summary: string;
}

export interface CapabilityPage {
	readonly query?: string;
	readonly group?: string;
	readonly results: readonly CapabilitySummary[];
	readonly offset: number;
	readonly limit: number;
	readonly total: number;
	readonly remaining: number;
	readonly groups?: readonly CapabilityGroupSummary[];
}

export interface CapabilityQuery {
	readonly query?: unknown;
	readonly group?: unknown;
	readonly limit?: unknown;
	readonly offset?: unknown;
}

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 8;
const MAX_OFFSET = 10_000;
const MAX_QUERY_CHARS = 256;
const MAX_GROUP_CHARS = 64;

const GROUP_SUMMARIES: Readonly<Record<string, string>> = Object.freeze({
	discovery: "Find installed skills, tools and other optional surfaces.",
	orchestration: "Run children, named workflows, swarms and fusion plans.",
	models: "Inspect agent/model choices and select provider routes explicitly.",
	review: "Request bounded independent review and inspect its evidence.",
	commands: "Use slash commands and lifecycle hooks for recurring operations.",
	safety: "Apply sandbox, mutation and authority boundaries before execution.",
	project: "Query project-scoped graph and dependency evidence.",
	planning: "Maintain durable plans, dependencies and acceptance evidence.",
	async: "Track finite background work and completion delivery.",
	coordination: "Coordinate independent sessions sharing one checkout.",
	memory: "Write and retrieve local durable notes and evidence.",
	diagnostics: "Inspect context, runtime, failure and historical telemetry.",
	engineering: "Use bounded source and structural inspection helpers.",
	web_media: "Research web sources and inspect or transform local media.",
});

const frozen = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

function option(name: string, summary: string, values?: readonly string[]): CapabilityOption {
	return frozen({
		name,
		...(values ? { values: Object.freeze([...values]) } : {}),
		summary,
	});
}

function capability(input: Omit<HarnessCapability, "entrypoints" | "tools" | "commands" | "options" | "related" | "sourceFiles"> & {
	entrypoints?: readonly string[];
	tools?: readonly string[];
	commands?: readonly string[];
	options?: readonly CapabilityOption[];
	related?: readonly string[];
	sourceFiles: readonly string[];
}): HarnessCapability {
	return frozen({
		...input,
		entrypoints: Object.freeze([...(input.entrypoints ?? [])]),
		tools: Object.freeze([...(input.tools ?? [])]),
		commands: Object.freeze([...(input.commands ?? [])]),
		options: Object.freeze([...(input.options ?? [])]),
		related: Object.freeze([...(input.related ?? [])]),
		sourceFiles: Object.freeze([...input.sourceFiles]),
	});
}

/**
 * Stable ids are intentionally few and grouped.  Tool ids here are pointers
 * to executable entrypoints; the live tool catalogue remains authoritative
 * for availability and schemas (including configured name overrides).
 */
export const HARNESS_CAPABILITIES: readonly HarnessCapability[] = Object.freeze([
	capability({
		id: "skill-catalog",
		group: "discovery",
		summary: "Browse and search installed SKILL.md workflows with bounded group and query pages; inspect or defer a tracked skill when a file route requests it.",
		entrypoints: ["skill_review"],
		tools: ["skill_review"],
		options: [
			option("action", "Operation to perform.", ["browse", "search", "inspect", "defer"]),
			option("group", "Capability group id from browse."),
			option("query", "Case-insensitive name or description query."),
			option("skill", "Skill name or file path for inspect/defer."),
			option("reason", "Task-specific rationale required for defer."),
			option("limit", "Page size, 1–8."),
			option("offset", "Metadata page offset."),
		],
		related: ["tool-catalog", "workflow-orchestration"],
		sourceFiles: [
			"agent/extensions/lib/relevant-guidance.ts",
			"agent/extensions/lib/skill-relevance.ts",
			"agent/extensions/lib/capability-groups.ts",
		],
		doc: "agent/public-template/docs/SKILLS-AND-CHECKS.md",
	}),
	capability({
		id: "tool-catalog",
		group: "discovery",
		summary: "Preview active tool schemas by group or query, then explicitly enable selected names while preserving the host's original authority.",
		entrypoints: ["tool_search"],
		tools: ["tool_search"],
		options: [
			option("group", "Tool capability group id."),
			option("query", "Name or description search text."),
			option("names", "Exact tool names to enable, up to 8."),
			option("enable", "Enable query matches only when true."),
			option("limit", "Preview page size, 1–8."),
			option("offset", "Preview page offset."),
		],
		related: ["skill-catalog", "quick-commands"],
		sourceFiles: [
			"agent/extensions/lib/tool-discovery.ts",
			"agent/extensions/lib/capability-groups.ts",
		],
		doc: "agent/public-template/docs/GUIDANCE-AND-DIAGNOSTICS.md",
	}),
	capability({
		id: "hook-guidance",
		group: "commands",
		summary: "Attach one deterministic workflow reminder to the first matching tool result; hooks annotate and recover without blocking or changing authority.",
		entrypoints: ["tool_call", "tool_result", "session_start", "session_switch"],
		options: [
			option("PI_SESSION_HOOKS", "Disable this annotation surface when set to off.", ["on", "off"]),
			option("tool_call", "Match the tool name and input before execution."),
			option("tool_result", "Annotate the corresponding success or failure once."),
		],
		related: ["quick-commands", "safety-bounds"],
		sourceFiles: [
			"agent/extensions/session-hooks.ts",
			"agent/extensions/lib/session-hooks.ts",
		],
		doc: "agent/public-template/docs/GUIDANCE-AND-DIAGNOSTICS.md",
	}),
	capability({
		id: "subagent-dispatch",
		group: "orchestration",
		summary: "Launch one child, native parallel tasks or a sequential chain with explicit context, model, skills, output and acceptance controls.",
		entrypoints: ["subagent", "bg_wait", "runs.run", "runs.all", "runs.steer", "runs.status"],
		tools: ["subagent", "bg_wait"],
		commands: ["run", "subagents", "subagents-stop", "subagents-steer", "subagents-detach"],
		options: [
			option("agent", "Named child agent for one-child execution or management."),
			option("task", "Optional one-child prompt."),
			option("tasks", "1–64 native parallel child objects."),
			option("chain", "1–64 sequential child objects; previous output can flow forward."),
			option("commonTask", "Shared brief for native tasks or chain."),
			option("async", "Run composite or child work in the background."),
			option("context", "Child context mode.", ["fresh", "fork", "profile"]),
			option("model", "Explicit provider/id route with optional :thinking suffix."),
			option("thinking", "Thinking level for supported control actions."),
			option("skill", "Child skill name, names, or false."),
			option("cwd", "Execution project working directory (workdir)."),
			option("worktree", "Use managed per-child Git isolation."),
			option("output", "Inline output path or false."),
			option("timeoutMs", "Positive execution timeout."),
			option("acceptance", "Structured completion contract."),
			option("gate", "Host gate command, mutually exclusive with acceptance."),
		],
		related: ["workflow-orchestration", "agent-model-management", "background-tasks", "swarm-execution", "fusion-review"],
		sourceFiles: [
			"agent/extensions/pi-subagents/src/extension/index.ts",
			"agent/extensions/pi-subagents/src/extension/schemas.ts",
			"agent/extensions/pi-subagents/src/extension/public-execution.ts",
			"agent/extensions/pi-subagents/src/intercom/result-intercom.ts",
		],
		doc: "agent/public-template/docs/SUBAGENT-CONTRACTS.md",
	}),
	capability({
		id: "workflow-orchestration",
		group: "orchestration",
		summary: "Run extension-owned review/run-ci resources or repeatable prompt workflows with bounded arguments and explicit foreground/background flags.",
		entrypoints: ["subagent", "workflow", "workflowScript", "workflowScriptPath", "prompt-workflow"],
		tools: ["subagent"],
		commands: ["prompt-workflow"],
		options: [
			option("workflow", "Named resource; currently review or run-ci.", ["review", "run-ci"]),
			option("args.task", "Required non-empty task for review."),
			option("args.command", "run-ci command.", ["npm test", "npm run typecheck"]),
			option("args.timeoutMs", "run-ci timeout, 1–86400000."),
			option("workflowScript", "Inline filesystem-free workflow body for supported maintenance sessions."),
			option("workflowScriptPath", "Workflow file path relative to request cwd."),
			option("async", "Background execution flag."),
			option("--fork", "Prompt-workflow child context override."),
			option("--fresh", "Prompt-workflow fresh-context override."),
			option("--bg|--async", "Prompt-workflow background flag."),
			option("--subagent", "Prompt-workflow agent override."),
		],
		related: ["subagent-dispatch", "prompt-workflows", "quality-review"],
		sourceFiles: [
			"agent/extensions/pi-subagents/src/workflows/workflow-resources.ts",
			"agent/extensions/pi-subagents/src/extension/public-execution.ts",
			"agent/extensions/pi-subagents/src/extension/schemas.ts",
			"agent/extensions/pi-subagents/src/slash/prompt-workflows.ts",
		],
		doc: "agent/public-template/docs/SUBAGENT-CONTRACTS.md",
	}),
	capability({
		id: "prompt-workflows",
		group: "orchestration",
		summary: "Discover package, user and project Markdown prompt workflows, substitute positional arguments and optionally chain their outputs.",
		entrypoints: ["prompt-workflow", "getPromptDirectories", "discoverPromptWorkflows"],
		commands: ["prompt-workflow"],
		options: [
			option("list", "List discovered prompt workflows."),
			option("$ARGUMENTS|$@", "Substitute all runtime arguments in a prompt body."),
			option("$1..$N", "Substitute one positional runtime argument."),
			option("${N:-fallback}", "Use a fallback when a positional argument is absent."),
			option("chain", "Frontmatter workflow names joined by ' -> '."),
			option("--fork", "Run with fork context."),
			option("--fresh", "Run with fresh context."),
			option("--bg|--async", "Run the workflow in the background."),
			option("--subagent", "Override the declared agent."),
		],
		related: ["workflow-orchestration", "subagent-dispatch"],
		sourceFiles: [
			"agent/extensions/pi-subagents/src/slash/prompt-workflows.ts",
			"agent/extensions/pi-subagents/src/shared/prompt-resources.ts",
		],
		doc: "agent/public-template/docs/SUBAGENT-CONTRACTS.md",
	}),
	capability({
		id: "scope-council",
		group: "review",
		summary: "Automatically deliberate over open-ended change scope with preservation and meaningful-change perspectives under a shared bounded budget; it has no opt-in user tool.",
		entrypoints: ["scope-council-runner", "before_agent_start", "context"],
		options: [
			option("PI_SCOPE_COUNCIL", "Disable automatic scope deliberation when set to off.", ["on", "off"]),
			option("deadlineMs", "Shared council deadline; default 240000."),
			option("tokens", "Aggregate child token ceiling; default 144000."),
			option("tools", "Aggregate child tool ceiling; default 12."),
			option("costUsd", "Aggregate runtime ceiling; default 0.03."),
			option("nativeSubagent", "The council runs only when the native subagent capability is active; project sessions do not provide workflowScript."),
			option("fixedRoute|sameModel|freeOnly|noDelegation", "Constraints that can make the council unavailable."),
		],
		related: ["project-intelligence", "quality-review", "subagent-dispatch"],
		sourceFiles: [
			"agent/extensions/pi-subagents/src/extension/scope-council-runner.ts",
			"agent/extensions/lib/scope-deliberation.ts",
		],
		doc: "agent/public-template/docs/CHANGE-SCOPE.md",
	}),
	capability({
		id: "swarm-execution",
		group: "orchestration",
		summary: "Run separable child investigations in parallel and preserve each outcome, failure and acceptance evidence for parent review.",
		entrypoints: ["subagent.tasks", "runs.all", "runs.recover", "todo.execution:swarm"],
		tools: ["subagent", "todo"],
		options: [
			option("tasks", "Parallel child array with agent/task and per-child options."),
			option("commonTask", "Shared brief injected into every child."),
			option("concurrency", "Positive native task concurrency."),
			option("async", "Keep the composite running without blocking the parent."),
			option("runs.recover", "Build a bounded respawn plan for failed fanout members."),
			option("execution", "Todo execution annotation.", ["swarm"]),
		],
		related: ["subagent-dispatch", "fusion-review", "todo-planning", "agent-model-management"],
		sourceFiles: [
			"agent/extensions/pi-subagents/src/runs/shared/assistance-plan.ts",
			"agent/extensions/pi-subagents/src/runs/shared/swarm-recovery.ts",
			"agent/extensions/pi-subagents/src/workflows/scripted-workflow.ts",
			"agent/extensions/rpiv-todo/tool/types.ts",
		],
		doc: "agent/public-template/docs/MODEL-ROUTING.md",
	}),
	capability({
		id: "fusion-review",
		group: "orchestration",
		summary: "Merge child outputs deterministically with provenance, retaining duplicate, complementary and conflicting sections for review.",
		entrypoints: ["runs.fuse", "runs.fuseFragments", "todo.execution:fusion"],
		tools: ["subagent", "todo"],
		options: [
			option("runs.fuse", "Fuse text outputs from a completed run set."),
			option("runs.fuseFragments", "Fuse structured owner/kind/body/updatedAt fragments."),
			option("fragments[].owner", "Source worker identity."),
			option("fragments[].kind", "Fragment classification.", ["duplicate", "complementary", "conflict"]),
			option("fragments[].body", "Source-preserving fragment body."),
			option("fragments[].updatedAt", "Finite ordering timestamp."),
			option("config.maxBodyChars", "Positive fused-body bound, at most 131072."),
			option("execution", "Todo execution annotation.", ["fusion"]),
		],
		related: ["subagent-dispatch", "swarm-execution", "quality-review"],
		sourceFiles: [
			"agent/extensions/pi-subagents/src/runs/shared/fusion.ts",
			"agent/extensions/pi-subagents/src/workflows/recovery-seam.ts",
			"agent/extensions/pi-subagents/src/workflows/scripted-workflow.ts",
		],
		doc: "agent/public-template/docs/MODEL-ROUTING.md",
	}),
	capability({
		id: "agent-model-management",
		group: "models",
		summary: "List executable agents and their capabilities, inspect or edit scoped definitions, and ask for effective models without hardcoding a provider inventory.",
		entrypoints: ["subagent", "action:list", "action:get", "action:models", "action:create", "action:update"],
		tools: ["subagent"],
		commands: ["subagents", "subagents-models", "subagents-doctor", "subagents-profiles", "subagents-load-profile", "subagents-check-profile"],
		options: [
			option("action", "Management operation.", ["list", "get", "models", "create", "update", "delete", "eject", "disable", "enable", "reset"]),
			option("agent", "Agent name or alias."),
			option("agentScope", "Definition scope.", ["user", "project", "both"]),
			option("capabilities", "Include compact executable capability rows for list."),
			option("config", "Agent config object or JSON for create/update."),
			option("model", "Model selector for models or explicit child route."),
			option("thinking", "Configured thinking level or ceiling."),
			option("skill", "Declared child skill name(s)."),
		],
		related: ["subagent-dispatch", "model-selection", "provider-routing", "skill-catalog"],
		sourceFiles: [
			"agent/extensions/pi-subagents/src/agents/agent-management.ts",
			"agent/extensions/pi-subagents/src/extension/schemas.ts",
			"agent/extensions/pi-subagents/src/slash/slash-commands.ts",
		],
		doc: "agent/public-template/docs/SUBAGENT-CONTRACTS.md",
	}),
	capability({
		id: "model-selection",
		group: "models",
		summary: "Filter the live session model registry by exact name, free eligibility, provider, input modality, tools support or catalog addition month.",
		entrypoints: ["subagent", "action:models", "filterModelsByQuery"],
		tools: ["subagent"],
		commands: ["subagents-models"],
		options: [
			option("action", "Use model listing mode.", ["models"]),
			option("model", "All-token selector query."),
			option("free:true", "Keep eligible free routes after economy checks."),
			option("provider:<id>", "Filter to an exact provider id from the current registry."),
			option("input:<modality>", "Filter advertised input modality."),
			option("tools:true", "Require advertised tool calling support."),
			option("added:this-month|added:YYYY-MM", "Filter provider catalog addition timestamps in UTC."),
			option("model: provider/id:thinking", "Pass an exact route with optional supported thinking suffix."),
		],
		related: ["agent-model-management", "provider-routing", "fusion-review"],
		sourceFiles: [
			"agent/extensions/pi-subagents/src/agents/agent-management.ts",
			"agent/extensions/pi-subagents/src/runs/shared/model-selection.ts",
			"agent/extensions/pi-subagents/src/shared/model-info.ts",
		],
		doc: "agent/public-template/docs/MODEL-ROUTING.md",
	}),
	capability({
		id: "provider-routing",
		group: "models",
		summary: "Inspect and persist OpenRouter provider selection pins for the selected model, with soft order, hard only, metric sorting or raw routing JSON.",
		entrypoints: ["provider", "or-provider", "models.json providers.openrouter.modelOverrides"],
		commands: ["provider", "or-provider"],
		options: [
			option("subcommand", "Provider command operation.", ["list", "status", "order", "only", "sort", "clear", "reset", "json"]),
			option("model", "Optional selected or provider/model target."),
			option("tag", "Exact endpoint tag returned by the live endpoint listing."),
			option("sort key", "Endpoint metric used by sort.", ["price", "latency", "throughput", "uptime"]),
			option("json.only|order|ignore", "Endpoint tag arrays in raw routing JSON."),
			option("json.allow_fallbacks", "Boolean fallback policy in raw routing JSON."),
		],
		related: ["model-selection", "agent-model-management"],
		sourceFiles: [
			"agent/extensions/provider-cmd.ts",
			"agent/extensions/pi-subagents/src/runs/shared/openrouter-endpoints.ts",
		],
		doc: "agent/public-template/docs/MODEL-ROUTING.md",
	}),
	capability({
		id: "model-preferences",
		group: "models",
		summary: "Prefer explicit per-role model/provider choices from llm_preferences.json, with the autonomous selector as fallback when preferences are absent or unusable.",
		entrypoints: ["/models", "llm_preferences.json", "resolveLlmPreferenceChain", "selectAssistanceTeam"],
		options: [
			option("models", "Reusable alias registry of provider/model/thinking/provider_options entries."),
			option("preferences.<role>.models", "Ordered alias list per role: subagents, council, swarm, fusion, quality_review, project_review, error_review, prompt_analysis, main_session_fallback."),
			option("/models", "Open the graphical editor for ordered role routes, upstream pins and canonical JSON recovery."),
			option("thinking", "Explicit level, auto for dynamic logic, or none for off.", ["auto", "none", "low", "medium", "high", "max"]),
			option("provider_options.routing", "OpenRouter backend control; auto preserves normal selection.", ["auto", "pinned", "custom"]),
		],
		related: ["model-selection", "provider-routing", "agent-model-management"],
		sourceFiles: [
			"agent/extensions/pi-subagents/src/runs/shared/llm-preferences.ts",
			"agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts",
			"agent/extensions/model-routing-config.ts",
			"agent/extensions/lib/model-routing-store.ts",
			"agent/extensions/lib/model-routing-metrics.ts",
		],
		doc: "agent/public-template/docs/LLM-PREFERENCES.md",
	}),
	capability({
		id: "quality-review",
		group: "review",
		summary: "Run or inspect bounded read-only aspect reviews, then accept or block only with retained independent evidence and explicit rationale.",
		entrypoints: ["quality_review", "quality-review-followup"],
		tools: ["quality_review"],
		options: [
			option("action", "Review lifecycle operation.", ["inspect", "review", "assess"]),
			option("disposition", "Assessment outcome.", ["accepted", "blocked"]),
			option("reason", "Evidence-based assessment rationale, 20–1200 characters."),
			option("dismissals", "Blocking finding ids with concrete dismissal reasons."),
		],
		related: ["scope-council", "project-intelligence", "source-intelligence"],
		sourceFiles: [
			"agent/extensions/lib/quality-review.ts",
			"agent/extensions/lib/quality-review-signals.ts",
		],
		doc: "agent/public-template/docs/RECOVERY-AND-TESTING.md",
	}),
	capability({
		id: "review-coordination",
		group: "review",
		summary: "Coordinate distinct review kinds (quality, project, error) with trivial-work suppression, stuck-signal gating and cooldowns; the main agent stays the invoker.",
		entrypoints: ["review-coordinator", "quality_review", "prompt-workflow council", "subagent worker briefs"],
		tools: ["quality_review", "subagent"],
		options: [
			option("kind", "Review kind with a distinct purpose and owner.", ["quality", "project", "error", "council", "swarm", "fusion"]),
			option("isTrivialChangeRequest", "Formatting/lint/trivial-cleanup suppression for automatic checks."),
			option("evaluateStuckSignal", "Strong stuck-pattern detection with transient exclusion."),
			option("shouldSuggestReview", "Cooldown, session-cap and recent-run gating for suggestions."),
		],
		related: ["quality-review", "scope-council", "subagent-dispatch"],
		sourceFiles: [
			"agent/extensions/lib/review-coordinator.ts",
		],
		doc: "agent/public-template/docs/REVIEWS-AND-COUNCILS.md",
	}),
	capability({
		id: "session-observer",
		group: "review",
		summary: "Periodic independent reviewer that talks to the main agent about the live session, grounded in the Observer Book: 58 doctrine chapters (engineering, design, color, typography, web, media, operations, science, marketing, communication and more) selected by deterministic session triggers, plus per-project margin notes it keeps; advisory only, never authority.",
		entrypoints: ["session_observer preference role", "/observer-book"],
		commands: ["observer-book", "models"],
		options: [
			option("/observer-book [toc|read <id>|margins [clear]|on|off]", "Read the book and its current selection, manage this project's margin notes, or disable the book for this session."),
			option("PI_OBSERVER_BOOK", "Set to off to review without the book."),
			option("PI_OBSERVER_BOOK_DIR", "Directory of extra user chapters (default ~/.pi/settings/observer-book); off disables user chapters."),
			option("PI_OBSERVER_MARGINS|PI_OBSERVER_MARGINS_DIR", "Disable margin notes or relocate their per-project store (default under the agent memory directory)."),
			option("PI_SESSION_OBSERVER", "Set to off to disable periodic observation entirely; the /models Session Observer role chooses the route."),
		],
		related: ["quality-review", "review-coordination", "micro-intelligence", "session-coordination"],
		sourceFiles: [
			"agent/extensions/session-observer.ts",
			"agent/extensions/lib/session-observer.ts",
			"agent/extensions/lib/observer-book.ts",
		],
		doc: "agent/public-template/docs/SESSION-OBSERVER.md",
	}),
	capability({
		id: "quick-commands",
		group: "commands",
		summary: "Use the installed slash-command surface for session controls, model/provider routing, plans, reminders, project graph, observations and background work.",
		entrypoints: ["pi.getCommands", "registerCommand"],
		commands: [
			"cost", "self", "metrics", "obs", "effort", "reminder", "graph", "provider", "or-provider", "models",
			"todos", "memory-prime", "bg", "tasks", "bg-tasks", "bg-clear", "bg-update", "jobs", "logs", "kill",
			"subagents", "run", "subagents-doctor", "subagents-inspect-rpc", "subagents-refine", "subagents-fleet",
			"subagents-detach", "subagents-stop", "subagents-steer", "subagents-models", "subagents-profiles",
			"subagents-load-profile", "subagents-refresh-provider-models", "subagents-generate-profiles", "subagents-check-profile",
			"subagents-watchdog", "prompt-workflow", "google-account",
			"sys-prompt", "used", "errors", "commands", "guardian", "observer-book",
		],
		options: [
			option("pi.getCommands()", "Read the live command registry; command availability can depend on loaded extensions and configuration."),
			option("/self", "Current-session diagnostics."),
			option("/cost|/metrics|/obs", "Session accounting, metrics and observations."),
			option("/sys-prompt|/used|/errors|/commands|/models", "Separate-window popups: system prompt, session usage, detailed errors, command list, graphical model routing."),
			option("/guardian on|off|status|stats|debug", "Guardian supervision for this session only; on by default, off stops analysis and intervention."),
			option("/effort", "Thinking control alias owned by the extension."),
			option("/graph", "Open the project intelligence viewer."),
			option("/todos", "Show the hierarchical action plan."),
		],
		related: ["tool-catalog", "context-diagnostics", "todo-planning", "background-tasks"],
		sourceFiles: [
			"agent/extensions/session-signals.ts",
			"agent/extensions/model-routing-config.ts",
			"agent/extensions/lib/session-telemetry.ts",
			"agent/extensions/thinking.ts",
			"agent/extensions/project-intelligence.ts",
			"agent/extensions/rpiv-todo/todo.ts",
			"agent/extensions/pi-background-tasks/src/extension.ts",
		],
		doc: "agent/public-template/docs/GUIDANCE-AND-DIAGNOSTICS.md",
	}),
	capability({
		id: "safety-bounds",
		group: "safety",
		summary: "Inspect host/session dependencies and device candidates before guarded operations; run disposable experiments with path, process, resource and authority boundaries. Recognized connectivity, power and session-destructive shell commands are blocked; unavailable isolation fails closed.",
		entrypoints: ["sys_probe", "sandbox_run", "filesystem-safety", "harness:mutation-preflight"],
		tools: ["sys_probe", "sandbox_run", "git_info"],
		options: [
			option("sys_probe.action", "Read host resources, network/power/session metadata or device candidates without opening devices.", ["host", "devices", "listeners", "services", "processes", "service_detail", "journal"]),
			option("command", "Inline sandbox Bash script."),
			option("files[].path", "Relative disposable destination."),
			option("files[].content|source", "Exactly one inline fixture or project source."),
			option("timeoutMs", "Sandbox execution timeout, 1000–120000."),
			option("background", "Opt in to the existing background-task owner for disposable experiments; completion arrives without polling."),
			option("maxOutputBytes", "Sandbox output bound, 1024–65536."),
			option("PI_WRITE_DEGENERATION", "Disable the repeated-write degeneration heuristic only when set to 0.", ["0"]),
			option("PI_SIBLING_STALE_WRITES", "Restore advisory-only sibling write behavior when off."),
		],
		related: ["session-coordination", "subagent-dispatch", "quick-commands"],
		sourceFiles: [
			"agent/extensions/sandbox.ts",
			"agent/extensions/filesystem-safety.ts",
			"agent/extensions/lib/host-operation-safety.ts",
			"agent/extensions/sys-probe.ts",
			"agent/extensions/siblings.ts",
		],
		doc: "agent/public-template/docs/SECURITY.md",
	}),
	capability({
		id: "project-intelligence",
		group: "project",
		summary: "Query and maintain project-scoped architecture and dependency evidence, inspect versions and impact, or open the live graph viewer.",
		entrypoints: ["project_intel", "graph", "project_intelligence"],
		tools: ["project_intel"],
		commands: ["graph"],
		options: [
			option("action", "Graph operation.", ["query", "impact", "inspect", "update", "record", "retract", "refresh", "health", "history"]),
			option("query|focus", "Search text or exact entity key."),
			option("direction", "Impact traversal direction.", ["incoming", "outgoing", "both"]),
			option("hops", "Traversal depth, 0–6."),
			option("limit", "Candidate bound, 1–40."),
			option("maxChars", "Response bound, 400–6000."),
			option("types|relations", "Entity or relationship filters."),
			option("expectedVersion", "Required optimistic version for updates."),
		],
		related: ["scope-council", "quality-review", "todo-planning", "source-intelligence"],
		sourceFiles: [
			"agent/extensions/project-intelligence.ts",
			"agent/extensions/lib/project-intelligence/query.mjs",
			"agent/extensions/lib/project-intelligence/store.mjs",
		],
		doc: "agent/public-template/docs/PROJECT-INTELLIGENCE.md",
	}),
	capability({
		id: "todo-planning",
		group: "planning",
		summary: "Maintain a durable hierarchical plan with dependencies, execution annotations, file scopes and evidence-backed completion.",
		entrypoints: ["todo", "todos"],
		tools: ["todo"],
		commands: ["todos"],
		options: [
			option("action", "Plan mutation.", ["create", "update", "list", "get", "delete", "clear", "batch"]),
			option("view", "List projection.", ["tree", "frontier"]),
			option("execution", "Native orchestration annotation.", ["self", "subagent", "swarm", "fusion"]),
			option("parentId|blockedBy", "Hierarchy and dependency ids."),
			option("files", "Explicit relative paths in a task scope."),
			option("acceptance|evidence", "Completion contract and observed verification."),
			option("refs", "Project fact, observation or source references."),
			option("operations", "Atomic create/update/delete batch, up to 32."),
		],
		related: ["session-coordination", "swarm-execution", "fusion-review", "memory-notes"],
		sourceFiles: [
			"agent/extensions/rpiv-todo/todo.ts",
			"agent/extensions/rpiv-todo/tool/types.ts",
			"agent/extensions/rpiv-todo/state/plan.ts",
		],
		doc: "agent/public-template/docs/ACTION-PLANS.md",
	}),
	capability({
		id: "background-tasks",
		group: "async",
		summary: "Track explicit shell jobs in the local background registry, receive durable completion notifications and inspect bounded output by task id.",
		entrypoints: ["bg_run", "bg_status", "bg_logs", "bg_kill", "background-task-notification"],
		tools: ["bg_run", "bg_status", "bg_logs", "bg_kill"],
		commands: ["bg", "tasks", "bg-tasks", "bg-clear", "bg-update", "jobs", "logs", "kill"],
		options: [
			option("name", "Short task name."),
			option("command", "Shell command to start."),
			option("isAgent", "Whether the command launches an LLM/agent process."),
			option("description", "Optional task context."),
			option("timeoutSeconds", "Positive task timeout."),
			option("notifyOnCompletion", "Deliver the durable terminal notification."),
			option("triggerOnCompletion", "Request an agent wake for a finite task or explicitly opted-in service."),
			option("taskId", "Task id or unambiguous prefix for status/logs/kill."),
			option("maxBytes|tail", "Bound and direction for log reads."),
		],
		related: ["subagent-dispatch", "session-coordination", "quick-commands"],
		sourceFiles: [
			"agent/extensions/pi-background-tasks/src/extension.ts",
			"agent/extensions/pi-background-tasks/src/core/registry.ts",
			"agent/extensions/pi-background-tasks/src/core/completion-wake.ts",
		],
		doc: "agent/public-template/docs/GUIDANCE-AND-DIAGNOSTICS.md",
	}),
	capability({
		id: "subagent-intercom",
		group: "async",
		summary: "Coordinate a child with its supervisor through explicit decision, interview or progress messages and deliver grouped run receipts; targets are run/session scoped and completed children may be unreachable.",
		entrypoints: ["contact_supervisor", "subagent_supervisor", "subagent:result-intercom", "intercomBridge"],
		tools: ["contact_supervisor", "subagent_supervisor"],
		options: [
			option("reason", "Child-to-supervisor message kind.", ["need_decision", "interview_request", "progress_update"]),
			option("message", "Bounded question, update or reply text."),
			option("interview", "Structured supervisor questions for interview_request."),
			option("action", "Parent supervisor operation.", ["list", "send", "ask", "reply", "pending", "status"]),
			option("to|replyTo", "Explicit intercom target or pending request id."),
			option("intercomBridge.mode", "Child bridge activation mode.", ["off", "fork-only", "always"]),
			option("intercomBridge.resultDelivery", "Deliver grouped completion receipts to an acknowledged intercom listener."),
			option("PI_INTERCOM_SESSION_ID|PI_SUBAGENT_INTERCOM_SESSION_NAME", "Optional target identity used by the native bridge."),
			option("PI_INTERCOM_ASK_TIMEOUT_MS", "Native supervisor reply wait bound."),
		],
		related: ["subagent-dispatch", "session-coordination", "background-tasks"],
		sourceFiles: [
			"agent/extensions/pi-subagents/src/intercom/intercom-bridge.ts",
			"agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts",
			"agent/extensions/pi-subagents/src/intercom/result-intercom.ts",
			"agent/extensions/pi-subagents/src/shared/types.ts",
		],
		doc: "agent/public-template/docs/SUBAGENT-CONTRACTS.md",
	}),
	capability({
		id: "session-coordination",
		group: "coordination",
		summary: "Coordinate independent Pi sessions through checkout scope/check receipts and explicitly addressed asynchronous local peer messages across projects. Each session keeps its own goals, plans, observer and guardian state; peer advice carries no user authority.",
		entrypoints: ["session_coordinate", "sibling-bridge", "todo-plan-changed", "session-peer-message"],
		tools: ["session_coordinate"],
		options: [
			option("action", "Coordination operation.", ["status", "publish", "clear", "prepare_check", "send"]),
			option("scope", "Default checkout discovery; all explicitly lists independent roots across projects.", ["checkout", "all"]),
			option("to|recipientEpoch|message", "Send 1–2000 characters of untrusted peer advice to the full session ID and current epoch from status. Atomic inbox delivery is visible, does not wake idle inference, and never merges goals. Stale/absent recipients and full inboxes return errors."),
			option("objective", "Bounded objective text, up to 240 characters."),
			option("note", "Bounded handoff note, up to 500 characters."),
			option("files", "Up to 32 absolute or cwd-resolved scopes; prepare_check requires 1–8 regular input files <=256 KiB each."),
			option("checkName|command", "Name and exact next authorized bash command to observe. This tool never executes it; freshness covers declared inputs only."),
			option("PI_SIBLING_STALE_WRITES", "Disable stale-read write blocking when set to off."),
			option("coordinationRoot", "Canonical same-checkout identity joins nested paths and symlink aliases."),
		],
		related: ["todo-planning", "background-tasks", "safety-bounds"],
		sourceFiles: [
			"agent/extensions/siblings.ts",
			"agent/extensions/rpiv-todo/state/plan.ts",
		],
		doc: "agent/public-template/docs/ACTION-PLANS.md",
	}),
	capability({
		id: "memory-retrieval",
		group: "memory",
		summary: "Read durable global/project notes, scratchpad and daily logs; search prior memory with qmd keyword, semantic or deep modes and check search health.",
		entrypoints: ["memory_read", "memory_search", "memory_status", "memory-prime"],
		tools: ["memory_read", "memory_search", "memory_status"],
		commands: ["memory-prime"],
		options: [
			option("target", "Memory read target.", ["long_term", "project", "scratchpad", "daily", "list"]),
			option("date", "Daily log date in YYYY-MM-DD form."),
			option("query", "Prior-memory search text."),
			option("mode", "qmd search mode.", ["keyword", "semantic", "deep"]),
			option("limit", "Search result bound."),
			option("scope", "Memory priming scope.", ["project", "global"]),
			option("on|off", "Control selective memory priming, enabled by default with project/task relevance checks."),
		],
		related: ["memory-notes", "memory-evidence", "context-diagnostics"],
		sourceFiles: [
			"agent/extensions/pi-memory/index.ts",
			"agent/extensions/pi-memory/priming.ts",
		],
		doc: "agent/public-template/docs/LOCAL-INTELLIGENCE.md",
	}),
	capability({
		id: "memory-notes",
		group: "memory",
		summary: "Record future-session notes, project-scoped decisions and checklist state, with recoverable forget/restore operations and bounded compaction handoffs.",
		entrypoints: ["memory_write", "scratchpad", "memory_forget", "memory_restore"],
		tools: ["memory_write", "scratchpad", "memory_forget", "memory_restore"],
		options: [
			option("target", "Write target.", ["long_term", "project", "daily"]),
			option("content", "Markdown note to append."),
			option("mode", "Write mode; append is the supported mode.", ["append"]),
			option("action", "Scratchpad or restore operation."),
			option("match", "Case-insensitive memory_forget match."),
			option("recoveryId", "Recovery record id for memory_restore."),
			option("text", "Scratchpad item or substring."),
		],
		related: ["memory-retrieval", "memory-evidence", "todo-planning"],
		sourceFiles: [
			"agent/extensions/pi-memory/index.ts",
			"agent/extensions/pi-memory/priming.ts",
			"agent/extensions/pi-memory/mutation.ts",
		],
		doc: "agent/public-template/docs/LOCAL-INTELLIGENCE.md",
	}),
	capability({
		id: "memory-evidence",
		group: "memory",
		summary: "Keep small verbatim project observations with SHA256 provenance and retrieve unchanged evidence from the active session branch; inferred claims and unattributed URLs are rejected.",
		entrypoints: ["evidence_cache", "claim_check", "context_score", "handoff_capsule"],
		tools: ["evidence_cache", "claim_check", "context_score", "handoff_capsule"],
		options: [
			option("action", "Evidence cache operation.", ["put", "query"]),
			option("source", "Local project source path or attributable source id."),
			option("quote", "Verbatim observation to cache."),
			option("query", "Evidence relevance query."),
			option("claims", "Up to 12 quotations/interpretations with explicit source excerpts and optional expected hashes; matches establish provenance, never real-world truth."),
			option("goal", "Goal used to build a handoff capsule."),
			option("items", "Bounded context items for scoring or capsule extraction."),
			option("maxChars", "Capsule output bound; default 2200."),
		],
		related: ["memory-notes", "memory-retrieval", "context-diagnostics"],
		sourceFiles: [
			"agent/extensions/pi-memory/context-tools.ts",
			"agent/extensions/pi-memory/context-evidence.ts",
			"agent/extensions/pi-memory/context-salience.ts",
		],
		doc: "agent/public-template/docs/LOCAL-INTELLIGENCE.md",
	}),
	capability({
		id: "context-diagnostics",
		group: "diagnostics",
		summary: "Inspect selected-model full-window context occupancy and 80% automatic compaction threshold alongside separate runtime, failure, efficiency and past-session diagnostics.",
		entrypoints: ["session_self", "session_audit", "self", "cost", "metrics", "sys-prompt", "used", "errors", "commands"],
		tools: ["session_self", "session_audit"],
		commands: ["self", "cost", "metrics", "sys-prompt", "used", "errors", "commands"],
		options: [
			option("view", "Session diagnostic view.", ["session", "context", "runtime", "failures", "efficiency"]),
			option("scope", "Past-session audit scope.", ["workspace", "all"]),
			option("contextWindow", "Selected model's full context window."),
			option("contextWindowPercent", "Current tokens divided by full context window."),
			option("compactionTrigger", "Inclusive automatic threshold at 80% of full window."),
			option("usablePercent", "Separate output/safety headroom pressure diagnostic."),
		],
		related: ["memory-retrieval", "quick-commands", "quality-review"],
		sourceFiles: [
			"agent/extensions/session-signals.ts",
			"agent/extensions/lib/session-signals.ts",
			"agent/extensions/lib/session-audit.ts",
			"agent/extensions/lib/session-telemetry.ts",
		],
		doc: "agent/public-template/docs/GUIDANCE-AND-DIAGNOSTICS.md",
	}),
	capability({
		id: "source-intelligence",
		group: "engineering",
		summary: "Inspect bounded syntax, advisory code-noise patterns, AST context, symbols, callers/callees and Git structure without executing project code; output limits and omitted coverage remain visible.",
		entrypoints: ["syntax_check", "context_slice", "symbol_expand", "ast_diff", "git_info"],
		tools: ["syntax_check", "context_slice", "symbol_expand", "ast_diff", "git_info"],
		options: [
			option("paths", "Explicit source files for context_slice or symbol_expand."),
			option("task", "Task identifiers used to rank context_slice results."),
			option("symbol", "Symbol name for bounded expansion."),
			option("maxHops|maxNodes|maxChars", "AST and response bounds."),
			option("path", "Source path for syntax or Git inspection."),
			option("base|before|after", "Git base or supplied source pair for ast_diff."),
			option("action", "Git inspection operation.", ["scope", "status", "diff", "log", "show", "branch"]),
		],
		related: ["quality-review", "project-intelligence", "safety-bounds"],
		sourceFiles: [
			"agent/extensions/lib/source-check.ts",
			"agent/extensions/lib/code-noise.mjs",
			"agent/extensions/pi-lens/context-tools.ts",
			"agent/extensions/git-tools.ts",
		],
		doc: "agent/public-template/docs/GUIDANCE-AND-DIAGNOSTICS.md",
	}),
	capability({
		id: "artifact-numeric-checks",
		group: "engineering",
		summary: "Check SVG references and source cues, image/text metadata, measured frame timing, render attachment memory and numerical/ML metrics locally with bounded results and no model calls. These checks do not certify visual quality, physical safety or GPU performance.",
		entrypoints: ["artifact_check", "math_check"],
		tools: ["artifact_check", "math_check"],
		options: [
			option("artifact_check.operation", "Explicit artifact inspection.", ["svg", "ui", "image", "text"]),
			option("path|text", "One workspace path or supported inline source; SVG is bounded to 64 KiB."),
			option("math_check.operation", "Deterministic numeric calculation.", ["frame_budget", "render_budget", "summarize", "compare", "classify", "vectors", "split_overlap"]),
			option("values|target_fps", "Observed frame durations in milliseconds and target rate."),
			option("width|height|pixel_ratio|bytes_per_pixel|samples|buffers", "Explicit render attachment assumptions; excludes other allocations and driver overhead."),
		],
		related: ["source-intelligence", "web-and-media", "safety-bounds"],
		sourceFiles: ["agent/extensions/lib/small-tools.ts", "agent/extensions/lib/svg-check.ts", "agent/extensions/lib/numeric-checks.ts"],
		doc: "agent/public-template/docs/SKILLS-AND-CHECKS.md",
	}),
	capability({
		id: "web-and-media",
		group: "web_media",
		summary: "Search and read web sources, operate browser tabs with DOM refs, screenshots, console JavaScript and condition waits, ask for CAPTCHA help, and analyze local media through bounded tools.",
		entrypoints: ["web_search", "source_check", "fetch_content", "get_search_content", "web_research", "web_probe", "browser_session", "wait_for", "render_see", "media_info", "video_frames", "audio_analyze", "media_edit", "music_compose", "image_ocr"],
		tools: ["web_search", "source_check", "fetch_content", "get_search_content", "web_research", "web_probe", "browser_session", "wait_for", "render_see", "media_info", "video_frames", "audio_analyze", "media_edit", "music_compose", "image_ocr"],
		commands: ["websearch", "search", "curator", "google-account"],
		options: [
			option("query|queries", "One or several search angles."),
			option("provider", "Configured search route or explicit provider list."),
			option("fallbackProviders", "Research routes tried after an empty or failed preceding route."),
			option("sourceUrls", "Known HTTP sources for bounded background research."),
			option("readPages", "Research source page bound, 0–8."),
			option("recencyFilter|domainFilter", "Search narrowing filters."),
			option("workflow", "Search workflow.", ["none", "summary-review", "auto-summary"]),
			option("url|urls", "Web or local source targets."),
			option("mode", "Fetch mode.", ["readable", "raw", "answer"]),
			option("action", "Browser or media operation selected by the tool schema."),
			option("session|tab|ref|frame", "Reuse owned browser handles and fresh DOM targets, including popup tabs and iframe ids."),
			option("kind|state|timeoutMs", "Browser wait condition: element, text, URL, load or JavaScript predicate."),
			option("query|offset|maxChars", "Search and paginate rendered page text with browser_session read."),
			option("reason", "request_help asks the user about a blocking verification challenge with a screenshot."),
			option("path|times|count|width|height", "Local media and frame bounds."),
		],
		related: ["source-intelligence", "safety-bounds", "background-tasks"],
			sourceFiles: [
				"agent/extensions/pi-web-access/index.ts",
				"agent/extensions/pi-web-access/research-jobs.ts",
				"agent/extensions/pi-web-access/web-probe.ts",
				"agent/extensions/lib/browser-session.ts",
				"agent/extensions/render-and-wait.ts",
				"agent/extensions/media-tools.ts",
		],
		doc: "agent/public-template/docs/ISOLATION-AND-WEB.md",
	}),
	capability({
		id: "creative-studio",
		group: "web_media",
		summary: "Author editable local 3D scenes and fixed-clock animations, render H.264 video and posters, compose clip transitions and mix local audio. Three.js studio/clay/toon/wireframe styles, keyframes, camera and lights; no hosted generation or model calls.",
		entrypoints: ["scene_create", "scene_render", "video_compose", "audio_mix"],
		tools: ["scene_create", "scene_render", "video_compose", "audio_mix", "music_compose", "media_info", "video_frames", "audio_analyze"],
		options: [option("scene", "Versioned declarative objects, materials, camera, lights and keyframes; inspect the live schema for bounds."), option("outputDir", "Fresh workspace artifact directory; originals preserved."), option("path", "Local scene or media source, never a URL."), option("clips|tracks", "Explicit bounded timeline and audio inputs, with decode verification.")],
		related: ["web-and-media", "artifact-numeric-checks", "background-tasks"],
		sourceFiles: ["agent/extensions/media-tools.ts", "agent/extensions/lib/scene-studio.ts", "agent/extensions/lib/media-timeline.ts", "agent/scripts/scene-runtime.mjs"],
		doc: "agent/public-template/docs/ASYNC-AND-STUDIO.md",
	}),
	capability({
		id: "video-studio",
		group: "web_media",
		summary: "Produce code-first videos: Remotion projects driven by one master video.json timeline, reusable SVG/Canvas primitives, local Piper narration with measured durations, seeded procedural music/sfx, stills contact sheets, scene previews, decode-verified finals and automated picture/loudness/sync QA with mandatory visual review.",
		entrypoints: ["video_project", "video_render", "video_qa", "narration_tts", "audio_synth"],
		tools: ["video_project", "video_render", "video_qa", "narration_tts", "audio_synth", "video_frames", "media_info", "audio_analyze"],
		options: [option("dir", "Video project directory inside the workspace (video.json + src/)."), option("mode", "stills with contact sheet, preview of a scene or seconds range, or final.", ["stills", "preview", "final"]), option("action", "Project init/check/install or narration status/install/synthesize."), option("kind", "Procedural audio music bed or sound effect.", ["music", "sfx"])],
		related: ["creative-studio", "web-and-media", "background-tasks"],
		sourceFiles: ["agent/extensions/video-studio.ts", "agent/extensions/lib/video-studio.ts", "agent/scripts/video-render.mjs", "agent/skills/procedural-audio/scripts/synth.py"],
		doc: "agent/public-template/docs/VIDEO-STUDIO.md",
	}),
	capability({
		id: "rendered-design-review",
		group: "engineering",
		summary: "Collect rendered typography, spacing, surface effects, solid-color text contrast, overflow, motion and bounded placeholder/adjacent-label repetition, animated status pills, copy density, font proliferation, heavy border panels and quantified-claim evidence candidates. Compare viewport/state screenshots using design skills; intentional repetition is allowed, with no aesthetic score or compliance claim.",
		entrypoints: ["design_audit"],
		tools: ["design_audit", "render_see", "browser_session", "web_asset_check"],
		options: [option("source", "Local HTML or HTTP(S) page, inspected in the existing isolated browser."), option("width|height|colorScheme|reducedMotion", "Explicit responsive/theme/motion test condition."), option("output", "text for measurements; both includes pixels for vision-capable models.", ["text", "both"])],
		related: ["web-and-media", "source-intelligence"],
		sourceFiles: ["agent/extensions/render-and-wait.ts", "agent/scripts/render-design-state.mjs", "agent/scripts/render-noise-state.mjs"],
		doc: "agent/public-template/docs/ASYNC-AND-STUDIO.md",
	}),
	capability({
		id: "delivery-preflight",
		group: "engineering",
		summary: "Inspect GitHub Actions workflow dependencies/matrix bounds, static web asset references for hosting, and Ubuntu unit/journal metadata without running workflows, publishing sites or mutating services. Source-backed findings with explicit unresolved expressions.",
		entrypoints: ["workflow_probe", "web_asset_check", "sys_probe"],
		tools: ["workflow_probe", "web_asset_check", "sys_probe", "git_info", "package_probe", "env_audit"],
		options: [option("path|project", "Explicit workflow YAML and project root."), option("files|asset_root|public_path", "Explicit HTML/CSS/manifest sources and hosting asset boundary."), option("sys_probe.action", "Inspect systemd unit fields or metadata-only journal pages.", ["service_detail", "journal"])],
		related: ["source-intelligence", "safety-bounds", "rendered-design-review"],
		sourceFiles: ["agent/extensions/lib/utility-mcp/catalog.mjs", "agent/extensions/sys-probe.ts"],
		doc: "agent/public-template/docs/ASYNC-AND-STUDIO.md",
	}),

	capability({
		id: "bounded-operations",
		group: "engineering",
		summary: "Search explicit workspace roots and local Maildir/mbox exports with scan limits, source hashes and stale-page rejection. Prepare inert SSH argv or inspect one explicit server banner without authenticating or executing remote commands.",
		entrypoints: ["workspace_search", "local_mail_search", "local_mail_read", "ssh_plan", "net_probe"],
		tools: ["workspace_search", "local_mail_search", "local_mail_read", "ssh_plan", "net_probe"],
		options: [option("root|path", "Explicit workspace-contained root or local mail export; hidden content is opt-in."), option("query|mode|kind", "Literal content/path or mail-field search; bounded and paginated."), option("snapshot|message_hash", "Current snapshot identity required for continuation or reading mail."), option("host|port|user", "One explicit SSH target; no ranges, configuration execution or automatic connection.")],
		related: ["source-intelligence", "memory-evidence", "safety-bounds"],
		sourceFiles: ["agent/extensions/utility-tools.ts", "agent/extensions/lib/utility-mcp/local_operations.py", "agent/extensions/lib/utility-mcp/net.mjs"],
		doc: "agent/public-template/docs/ASYNC-AND-STUDIO.md",
	}),

	capability({
		id: "local-intelligence",
		group: "models",
		summary: "Local ML/statistical evidence ranking, context scoring and extractive handoffs; optional Kompress SLM paragraph selection. Automatic helpers run only when configured and eligible; discovery neither loads models nor starts inference.",
		entrypoints: ["context_score", "handoff_capsule", "evidence_cache", "session_self"],
		tools: ["context_score", "handoff_capsule", "evidence_cache", "session_self"],
		options: [
			option("context_score", "Rank supplied items by task relevance and protected evidence; scores are priorities, not probabilities."),
			option("handoff_capsule", "Prepare a short extractive handoff instead of copying an entire session."),
			option("automatic preprocessing", "Optional local SLM selects original paragraphs; unavailable workers preserve source text. No direct inference tool is implied."),
		],
		related: ["memory-evidence", "context-diagnostics", "skill-catalog"],
		sourceFiles: ["agent/extensions/lib/local-intelligence.mjs", "agent/extensions/lib/mini-preprocessor.ts", "agent/extensions/pi-memory/context-tools.ts"],
		doc: "agent/public-template/docs/LOCAL-INTELLIGENCE.md",
	}),
	capability({
		id: "research-toolkit",
		group: "web_media",
		summary: "Plan research angles and capture lead/company/contact candidates plus provenance-aware source notes with source URLs, retrieved-at timestamps and hashes. Local-only; compose with web_search/fetch_content/web_research and verify primary sources.",
		entrypoints: ["research_toolkit"],
		tools: ["research_toolkit"],
		options: [
			option("action", "Toolkit operation.", ["plan", "lead", "company", "source"]),
			option("goal|context", "Research goal and optional context for plan."),
			option("name|company|role|domain", "Candidate identity fields for lead/company."),
			option("sourceUrl|retrievedAt", "Required http(s) provenance and timestamp."),
			option("evidence|quote", "Bounded verbatim evidence for lead/company/source."),
		],
		related: ["web-and-media", "memory-evidence", "safety-bounds"],
		sourceFiles: [
			"agent/extensions/research-toolkit.ts",
		],
		doc: "agent/public-template/docs/ISOLATION-AND-WEB.md",
	}),
	capability({
		id: "agentmail-email",
		group: "communication",
		summary: "Send and read email through AgentMail (outreach and inbox triage) with an environment-provided API key: inbox discovery, bounded sends with a required subject, compact inbox listing, full-text search, and single-message reads.",
		entrypoints: ["agentmail_status", "agentmail_send", "agentmail_messages", "agentmail_search", "agentmail_message"],
		tools: ["agentmail_status", "agentmail_send", "agentmail_messages", "agentmail_search", "agentmail_message"],
		options: [
			option("AGENTMAIL_API_KEY", "Required environment variable; read at call time and never persisted, logged or echoed."),
			option("AGENTMAIL_INBOX_ID", "Default sender inbox (usually the sending address) used when a call omits inboxId."),
			option("AGENTMAIL_BASE_URL", "Optional endpoint override, for example another AgentMail region."),
			option("to|cc|bcc|replyTo|subject|text|html|labels", "Send fields; a subject and a text or html body are required, and CR/LF is rejected."),
			option("inboxId|limit|pageToken|from|to|subject|labels|ascending|includeSpam|includeTrash", "Inbox listing scope and filters; list rows stay compact and carry a preview, and nextPageToken pages through every page."),
			option("q|before|after", "Full-text search query with optional ISO timestamp bounds; rows carry per-field match highlights."),
			option("includeHtml", "Opt-in HTML body on a single-message read."),
		],
		related: ["web-and-media", "safety-bounds"],
		sourceFiles: ["agent/extensions/agentmail.ts", "agent/extensions/http-tools.ts"],
		doc: "agent/public-template/docs/EMAIL.md",
	}),
	capability({
		id: "micro-intelligence",
		group: "models",
		summary: "Deterministic/Needle3/Smol/Kompress/Jev helper stack for discovery re-ranking, evidence triage, intent pre-screening and request advisories; Jev is a bounded remote OpenRouter advisory and deterministic owners keep authority when helpers are unavailable.",
		entrypoints: ["micro_status"],
		tools: ["micro_status"],
		options: [
			option("PI_MICRO_INTELLIGENCE", "Set to off to disable the lifecycle extension; routing, eligibility, safety and truth stay with existing owners."),
			option("PI_NEEDLE", "Set to off to disable Needle re-ranking, or PI_NEEDLE_SHADOW=1 to measure without applying."),
			option("PI_MICRO_ADVISORY", "Set to off to skip the per-request Jev advisory batch."),
			option("PI_JEV", "Set to off to disable remote Jev calls. When enabled, bounded task/request excerpts (maximum 32768 characters) may be sent to OpenRouter."),
		],
		related: ["local-intelligence", "tool-catalog", "skill-catalog", "context-diagnostics"],
		sourceFiles: [
			"agent/extensions/micro-intelligence.ts",
			"agent/extensions/lib/needle-runtime.ts",
			"agent/extensions/lib/jev-client.ts",
			"agent/extensions/lib/micro-intelligence/metrics.ts",
		],
		doc: "agent/public-template/docs/MICRO-INTELLIGENCE.md",
	}),
] as const);

const CATALOG_BY_ID = new Map(HARNESS_CAPABILITIES.map((record) => [record.id, record]));

function asText(value: unknown, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizedPage(input: CapabilityQuery): { query: string; group: string; limit: number; offset: number } {
	const limit = Number.isSafeInteger(input.limit)
		? Math.min(MAX_LIMIT, Math.max(1, Number(input.limit)))
		: DEFAULT_LIMIT;
	const offset = Number.isSafeInteger(input.offset)
		? Math.min(MAX_OFFSET, Math.max(0, Number(input.offset)))
		: 0;
	return {
		query: asText(input.query, MAX_QUERY_CHARS),
		group: asText(input.group, MAX_GROUP_CHARS).toLowerCase(),
		limit,
		offset,
	};
}

function summary(record: HarnessCapability): CapabilitySummary {
	return {
		id: record.id,
		group: record.group,
		summary: record.summary,
		...(record.tools.length ? { tools: record.tools.slice(0, 4) } : {}),
	};
}

function page(records: readonly HarnessCapability[], params: ReturnType<typeof normalizedPage>, extra: { query?: string; group?: string; groups?: readonly CapabilityGroupSummary[] } = {}): CapabilityPage {
	const selected = records.slice(params.offset, params.offset + params.limit).map(summary);
	return {
		...(extra.query ? { query: extra.query } : {}),
		...(extra.group ? { group: extra.group } : {}),
		results: selected,
		offset: params.offset,
		limit: params.limit,
		total: records.length,
		remaining: Math.max(0, records.length - params.offset - selected.length),
		...(extra.groups ? { groups: extra.groups } : {}),
	};
}

function groupOverview(records: readonly HarnessCapability[] = HARNESS_CAPABILITIES): readonly CapabilityGroupSummary[] {
	const counts = new Map<string, number>();
	for (const record of records) counts.set(record.group, (counts.get(record.group) ?? 0) + 1);
	return Object.freeze([...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, count]) => frozen({ id, count, summary: GROUP_SUMMARIES[id] ?? "Grouped harness capabilities." })));
}

function searchHaystack(record: HarnessCapability): string {
	return [
		record.id,
		record.group,
		record.summary,
		...record.entrypoints,
		...record.tools,
		...record.commands,
		...record.options.flatMap((item) => [item.name, item.summary, ...(item.values ?? [])]),
	].join(" ").toLowerCase();
}

function queryTerms(query: string): string[] {
	return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(Boolean);
}

/** Search records by every query term, ranked by executable field matches. */
export function searchCapabilities(input: CapabilityQuery = {}): CapabilityPage {
	const params = normalizedPage(input);
	const scoped = params.group
		? HARNESS_CAPABILITIES.filter((record) => record.group === params.group)
		: HARNESS_CAPABILITIES;
	const terms = queryTerms(params.query);
	if (params.query && terms.length === 0) return page([], params, { query: params.query, group: params.group || undefined });
	const exactQuery = params.query.toLowerCase();
	const ranked = scoped
		.map((record, index) => {
			const haystack = searchHaystack(record);
			let score = terms.length ? 0 : 1;
			let matchedTerms = 0;
			if (terms.length && record.id === exactQuery) score += 100_000;
			for (const term of terms) {
				if (!haystack.includes(term)) continue;
				matchedTerms++;
				if (record.id === term) score += 10_000;
				else if (record.id.includes(term)) score += 500;
				if (record.entrypoints.some((value) => value.toLowerCase() === term)) score += 300;
				if (record.tools.some((value) => value.toLowerCase() === term)) score += 250;
				if (record.commands.some((value) => value.toLowerCase() === term || value.toLowerCase().includes(term))) score += 180;
				if (record.group === term) score += 140;
				if (record.summary.toLowerCase().includes(term)) score += 40;
			}
			// Natural-language searches often include a qualifier that is not
			// present in a concise record. Multi-term queries must still ground
			// at least two terms: a single generic match (update/system/install)
			// otherwise returns junk with confidence. Single-term lookups and
			// entirely unknown queries keep the one-match and empty rules.
			if (terms.length && matchedTerms < (terms.length > 1 ? 2 : 1)) return undefined;
			if (terms.length) score += matchedTerms * 100;
			return { record, score, index };
		})
		.filter((value): value is { record: HarnessCapability; score: number; index: number } => value !== undefined)
		.sort((left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id) || left.index - right.index)
		.map((value) => value.record);
	return page(ranked, params, { query: params.query || undefined, group: params.group || undefined });
}

/** Browse the grouped catalogue or one deterministic group page. */
export function browseCapabilities(input: CapabilityQuery = {}): CapabilityPage {
	const params = normalizedPage(input);
	const scoped = params.group
		? HARNESS_CAPABILITIES.filter((record) => record.group === params.group)
		: HARNESS_CAPABILITIES;
	return page(scoped, params, { group: params.group || undefined, groups: groupOverview() });
}

function repositoryReferenceCandidates(reference: string): string[] {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const workspaceRoot = path.resolve(moduleDir, "../../..");
	const agentRoot = path.resolve(moduleDir, "../..");
	const relative = reference.replaceAll("\\", "/");
	const withoutAgent = relative.replace(/^agent\//, "");
	const distributionDoc = relative.replace(/^agent\/public-template\/docs\//, "docs/");
	return [...new Set([
		...(distributionDoc !== relative ? [path.resolve(agentRoot, "runtime", distributionDoc)] : []),
		path.resolve(workspaceRoot, relative),
		path.resolve(workspaceRoot, withoutAgent),
		path.resolve(agentRoot, withoutAgent),
		path.resolve(workspaceRoot, distributionDoc),
	])];
}

function resolveRepositoryReference(reference: string): string {
	const candidates = repositoryReferenceCandidates(reference);
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

/** Return one full record with absolute source and documentation paths. */
export function getCapabilityDetail(id: unknown): (Omit<HarnessCapability, "sourceFiles" | "doc"> & { sourceFiles: readonly string[]; doc: string }) | undefined {
	if (typeof id !== "string") return undefined;
	const record = CATALOG_BY_ID.get(id.trim().toLowerCase());
	if (!record) return undefined;
	return {
		id: record.id,
		group: record.group,
		summary: record.summary,
		entrypoints: [...record.entrypoints],
		tools: [...record.tools],
		commands: [...record.commands],
		options: record.options.map((item) => ({ name: item.name, ...(item.values ? { values: [...item.values] } : {}), summary: item.summary })),
		related: [...record.related],
		sourceFiles: record.sourceFiles.map(resolveRepositoryReference),
		doc: resolveRepositoryReference(record.doc),
	};
}

// Compatibility aliases keep the discovery integration small and make the
// module convenient to consume from tests or future public tools.
export const listCapabilities = browseCapabilities;
export const detailCapability = getCapabilityDetail;
export const CAPABILITY_CATALOG = HARNESS_CAPABILITIES;

export default {
	HARNESS_CAPABILITIES,
	browseCapabilities,
	searchCapabilities,
	getCapabilityDetail,
};

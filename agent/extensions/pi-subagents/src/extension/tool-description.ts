/**
 * Subagent tool description + prompt metadata.
 *
 * WHY (2026-08-31 fork minimization): upstream shipped three description
 * variants (default ~2.4KB, full ~12KB, compact ~10KB) plus a custom-file
 * templating path; this fork's config never sets toolDescriptionMode, so only
 * the default variant is reachable. External-CLI agents were retired from the
 * fork (no claude/codex/cursor CLIs installed, zero run history). The
 * remaining text stays: workflowScript contract, runs.* API surface, key
 * semantics, resume/steer, safety essentials.
 */

import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { SELF_MUTATION_ALLOWED } from "../../../lib/self-mutation-guard.ts";

export const DEFAULT_SUBAGENT_TOOL_DESCRIPTION = `Delegate independent work to configured native Pi subagents when it saves time; respect user limits on delegation. A child uses its configured model/thinking or inherits defaults; do not assume a particular cost or thinking level. For execution, omit action and use {agent, task?} for one child. For multi-step or parallel work, make exactly ONE top-level subagent call with async:true and launch children only inside that workflow: runs.run('key',{agent,task}) per child, await runs.all([{key,agent,task},...]) for parallel children (ordered array result — index/destructure/.map, not by key). workflowScript rejects nested async function/arrow/method helpers: use top-level await, plain helper functions, or explicit Promise chains. Every workflow has a finite supervisor deadline (10m by default; pass timeoutMs for a different bound), so a stalled script cannot hold the parent indefinitely. For bounded parallel sequential chains use runs.lanes([{key,stages:[{key,agent,task},{key,resume:'previous',task},...]}]). Swarm/fusion seams (await them; advisory, no children launched): runs.recover(results, config?) maps a failed-fanout result array to a bounded respawn plan ({degraded, respawnPlan:[{key,attempt,notBeforeMs}]}; config maxRespawnRounds/baseBackoffMs, backoff capped 60s) — launch the planned keys yourself with runs.run; runs.fuse(results, config?) merges child outputs into one advisory body, auto-parsing fenced fragment blocks from fusion-mode workers (plain outputs become complementary sections); runs.fuseFragments(fragments, config?) fuses pre-classified fragments — both return {strategy, fusedBody, provenance}. Use action:'validate' with a script input to check it without launching children. Only structuredOutput.verdict === 'blocked' blocks a stage. Use action only for management/control.

Native shared briefs: use {commonTask:"shared requirements",tasks:[{agent:"worker",task:"first file scope"},{agent:"worker",task:"second file scope"}],async:true}, or chain. commonTask is injected once into each native child, reducing repeated parent request text; each child still receives those tokens. For writers, declare acceptance.files:{scope:["index.html"],unchanged:["widget.js"],unchangedScripts:["index.html"]} per child when applicable. Exact cwd-relative files only (32 files, 1 MiB each, 8 MiB total). The harness compares before/after bytes and scripts, existing h1 counts, and static HTML/PHP container balance before accepting completion. It does not infer paths or preservation contracts from prose, execute claimed commands, validate rendered behavior, or prove which concurrent writer caused a change. Keep one writer per file; verify visuals separately.

Skills: children do not inherit the full skill catalog by default. For each subtask, select relevant skills from the descriptions; pass skills:['name'] in runs.run/runs.all child options, or give exact SKILL.md paths in task text. Have the child read and apply them before relevant work; never copy the entire catalog or widen its tool permissions.

Models: a child defaults to its agent config or the parent model. To honor a user-specified model/provider/thinking request ("spawn GLM-5.3-flash from together with max thinking as a reviewer"), set model per child as 'provider/id:thinking' where thinking is off|minimal|low|medium|high|xhigh|max. Find candidates with {action:'models', model:'glm 5.3 flash'} — a substring filter listing registry matches with their supported thinking levels — then copy an exact provider/id from it. For a manual free-model fusion, query {action:'models',model:'free:true provider:openrouter added:this-month'} (or provider:orcarouter; added:YYYY-MM is also supported). Dates mean provider catalog additions in UTC, not release dates; unknown dates are excluded. Use the returned exact routes in a bounded runs.all workflow, then runs.fuse; retain failed members and disagreements for parent review. Never broaden an empty provider/date result silently. For visual inspection use {action:'models',model:'input:image tools:true'} (combine with a provider/name to narrow); listings show advertised inputs, tool support and economy status; tools:true excludes unknown or unsupported tool calling needed to read local images. A default child may inherit your text-only model: select a permitted image model explicitly, use context:'fresh', and give a read-only child absolute image paths to read plus the visual question. Do not substitute source/DOM inspection for seeing pixels. When several providers carry the model, prefer the one the user named (their order matters); if the user named no provider, pick the best registry match. If the filter finds no match, tell the user and ask — never silently substitute a different model or provider. Steering a running child changes its task, never its model: to change model/provider/thinking, stop the child and respawn with the new model. Read the pi-subagents skill for orchestration details.`;

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate independent work through an async workflow; respect user model/provider constraints.";

export const SUBAGENT_TOOL_PROMPT_GUIDELINES = [
	"Use subagent for useful independent work, not mandatory ceremony on small tasks; honor requests not to delegate. List available agents if unsure. Use one async workflowScript for orchestration (await runs calls; runs.all returns an ordered array), and one writer per worktree. Resolve requested model/provider/thinking with action=models, then set model='provider/id:thinking'; never silently substitute. Native async runs notify on completion—do not poll to wait. Prefer proven free routes (any configured provider, e.g. OpenRouter or OrcaRouter) for read-only or advisory work; swarms and fusions stay advisory on cheap or free low-thinking models, and paid-but-cheap escalation follows the task's quality needs. When the main model is itself cheap or free, inheriting it is fine. See the subagent tool and skill for detailed contracts.",
];

// Advertise only orchestration that this process can execute. The shared-VM
// workflow guard remains authoritative; changing cwd never grants that power.
const PROJECT_DESCRIPTION = `Delegate useful independent work to native Pi subagents while respecting user model/provider and delegation limits. For one child use {agent,task,async:true}. For parallel children use {tasks:[{agent,task},...],async:true}; for sequential stages use {chain:[{agent,task},...],async:true}. Keep one writer per worktree. Native async completion notifications wake the parent; continue independent work without polling. workflowScript is unavailable in this project session because its JavaScript worker shares harness filesystem authority. Use declarative tasks/chain or individual children; do not retry workflowScript or change cwd to enable it. Use action only for management/control.\n\n` + DEFAULT_SUBAGENT_TOOL_DESCRIPTION.split('\n\n').slice(1).join('\n\n')
 .replace("skills:['name'] in runs.run/runs.all child options", "skill:['name'] in native child/task options")
 .replace("Use the returned exact routes in a bounded runs.all workflow, then runs.fuse", "Use the returned exact routes in a bounded tasks array, then compare their outputs");
const PROJECT_GUIDELINES = ["Use subagent for useful independent work. In this project session use native async children, tasks arrays or chains; workflowScript is unavailable. Respect requested models and one writer per worktree. Select relevant skills per child. Native completion notifications arrive without polling. Prefer proven free routes for read-only children, and keep swarms or fusions on cheap or free low-thinking models."];

export interface ToolDescriptionOptions {
	cwd?: string;
	agentDir?: string;
	warn?: (message: string) => void;
}

export interface SubagentToolPromptMetadata {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

function warn(options: ToolDescriptionOptions | undefined, message: string): void {
	(options?.warn ?? console.warn)(`[pi-subagents] ${message}`);
}

function isToolDescriptionMode(value: unknown): value is ToolDescriptionMode {
	return value === "full" || value === "compact" || value === "custom";
}

export function buildSubagentToolPromptMetadata(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}): SubagentToolPromptMetadata {
	if (config.toolDescriptionMode !== undefined) return {};
	return {
		promptSnippet: SELF_MUTATION_ALLOWED ? SUBAGENT_TOOL_PROMPT_SNIPPET : "Delegate independent work through native async children or declarative tasks/chains; respect user constraints.",
		promptGuidelines: SELF_MUTATION_ALLOWED ? SUBAGENT_TOOL_PROMPT_GUIDELINES : PROJECT_GUIDELINES,
	};
}

export function resolveToolDescriptionMode(config: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): ToolDescriptionMode {
	const mode = config.toolDescriptionMode;
	if (mode === undefined) return "full";
	if (isToolDescriptionMode(mode)) return mode;
	warn(options, `Ignoring invalid toolDescriptionMode ${JSON.stringify(mode)}; expected "full", "compact", or "custom".`);
	return "full";
}

/**
 * WHY: fork ships one description. full/compact/custom modes collapse to it —
 * the retired variants are dead weight (no custom description file exists,
 * and mode is unset in settings). "custom" still resolves as a mode for the
 * type contract; it just renders the default text.
 */
export function buildSubagentToolDescription(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, options?: ToolDescriptionOptions): string {
	if (config.toolDescriptionMode === undefined) return SELF_MUTATION_ALLOWED ? DEFAULT_SUBAGENT_TOOL_DESCRIPTION : PROJECT_DESCRIPTION;
	const mode = resolveToolDescriptionMode(config, options);
	if (mode !== "full") warn(options, `toolDescriptionMode "${mode}" retired in this fork; using the default description.`);
	return SELF_MUTATION_ALLOWED ? DEFAULT_SUBAGENT_TOOL_DESCRIPTION : PROJECT_DESCRIPTION;
}

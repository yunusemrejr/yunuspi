/** Keep the callable contract on the wire; schemas carry field details. */
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { SELF_MUTATION_ALLOWED } from "../../../lib/self-mutation-guard.ts";

const NATIVE_EXECUTION = `Delegate independent work when useful; honor user delegation, model/provider and budget limits. Omit action to execute. One child: {agent,task,async:true}; parallel: {tasks:[{agent,task},...],async:true}; sequential: {chain:[{agent,task},...],async:true}. commonTask shares requirements without repeating the parent request; every child still receives those tokens. Use fresh context for bounded investigations; fork when the child needs the conversation. Keep one writer per worktree. Completion notifications wake the parent; continue independent work without polling.`;

const SHARED_CONTRACT = `Control: {action:"status",id:"run-id"} inspects a run; view:"transcript" reads retained output and view:"fleet" shows the fleet. get requires agent and reads its definition. Resume uses a zero-based child index and its saved launch contract; only an explicit resume may revive a stopped child. Steering changes the task, never the model; stop and respawn to change model/provider/thinking. Only structuredOutput.verdict === 'blocked' blocks a stage. Preserve successful siblings and retry only a failed scope after fixing its cause.

Models: configured/explicit routes and thinking remain exact; inherited routes use task-aware quality and health gates before economy preferences. Price is not quality evidence. Resolve a requested route with {action:'models',model:'name provider:vendor'}, then copy the exact provider/id:thinking (off|minimal|low|medium|high|xhigh|max|ultra). Never silently substitute a missing requested model/provider. Filters include free:true, provider:openrouter, added:this-month or added:YYYY-MM (UTC catalog additions, unknown dates excluded). For pixels use model:'input:image tools:true', select a permitted image-capable route and give absolute image paths to a fresh read-only child. Text/source inspection cannot approve appearance.

Tools/skills: {action:'list',capabilities:true,agent:'name'} exposes that agent's tools and hard constraints. Match them to the task; a read-only child cannot implement changes. Carry scope, original constraints, evidence inputs and an observable success check. Children do not inherit the full skill catalog. Offer skills:['name'] in runs.run/runs.all child options or exact SKILL.md paths in task text when useful. Skills are optional docs, not prerequisites; user instructions, tool contracts and safety boundaries take precedence. Discovery and child claims are not execution evidence. Never widen the host's tool ceiling.

Evidence/authority: acceptance.files:{scope:['file'],unchanged:['other'],unchangedScripts:['index.html']} checks exact cwd-relative files against baselines (32 files, 1 MiB each, 8 MiB total). It does not prove rendered behavior, execute claimed tests or attribute concurrent writes; verify results in the parent. Children default to commit=false and push=false at the tool layer; integration Git mutations and publish runners are blocked. gitAuthority:true delegates that authority per launch only when the user authorized it, and never to nested children.`;

export const DEFAULT_SUBAGENT_TOOL_DESCRIPTION = NATIVE_EXECUTION + `

For scripted orchestration use workflowScript with async:true: await runs.run('key',{agent,task}) or await runs.all([{key,agent,task},...]) (ordered array, not a key map); runs.lanes runs parallel sequential chains. Use top-level await, plain helpers or Promise chains; nested async function/arrow/method helpers are rejected. Composite supervisor deadline: 10m by default, override timeoutMs when needed. action:'validate' checks a script without launching children. Await runs.recover(results,config?) for an advisory respawnPlan (launch planned keys yourself), runs.fuse(results,config?) or runs.fuseFragments(fragments,config?) for {strategy,fusedBody,provenance}. These helpers do not launch children.

` + SHARED_CONTRACT;

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate useful independent work; respect user constraints.";
export const SUBAGENT_TOOL_PROMPT_GUIDELINES = [
 "Choose useful bounded delegation and reuse native completion handles. Account for announced helpers, preserve disagreements and verify child claims. Skills remain optional; explicit model/provider/thinking selections remain exact.",
];

// Project sessions can execute declarative children, not the shared-VM script.
const PROJECT_DESCRIPTION = NATIVE_EXECUTION + `

workflowScript is unavailable in this project session because its worker shares harness filesystem authority. Use native children, tasks or chain; changing cwd does not enable scripts.

` + SHARED_CONTRACT.replace("skills:['name'] in runs.run/runs.all child options", "skill:['name'] in native child/task options");
const PROJECT_GUIDELINES = SUBAGENT_TOOL_PROMPT_GUIDELINES;

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

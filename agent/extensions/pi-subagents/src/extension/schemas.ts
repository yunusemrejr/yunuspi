/**
 * TypeBox schemas for subagent + bg_wait tool parameters.
 *
 * WHY (2026-08-31 fork minimization): upstream serialized ~18KB of schema per
 * session — nested acceptance/budget/preflight/lane trees plus long prose.
 * Pi validates args with Value.Check against this schema, and Type.Object
 * leaves additionalProperties open, so a field dropped here never rejects a
 * call: the executor still receives it verbatim. Dropping a field only hides
 * its guidance from the model. Kept: fields the harness flows use (delegate,
 * review, resume, steer, missions, scheduling, list/get/models, watchdog),
 * each as a one-liner; heavy nested trees became loose objects. Retired
 * fields (lane evidence, calendar schedules, dynamic-parallel specs, share/
 * artifacts/sessionDir/debug knobs) remain functional-but-undocumented.
 */

import { Type } from "typebox";

/** WHY: pi validates the whole tree; nested prose is guidance we do not need. */
function keepTopLevelParameterDescriptions<T>(schema: T): T {
	return pruneNestedDescriptions(schema, []) as T;
}

function pruneNestedDescriptions(value: unknown, path: string[]): unknown {
	if (!value || typeof value !== "object") return value;
	const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) continue;
		if (key === "description" && !isTopLevelParameterDescription(path)) continue;
		if ("value" in descriptor) {
			const nextPath = typeof key === "string" ? [...path, key] : path;
			descriptor.value = pruneNestedDescriptions(descriptor.value, nextPath);
		}
		Object.defineProperty(result, key, descriptor);
	}
	return result;
}

function isTopLevelParameterDescription(path: string[]): boolean {
	return path.length === 2 && path[0] === "properties";
}

/** Loose bounded object: validation passes any plain-JSON shape. */
function Loose(description?: string) {
	return Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true, ...(description ? { description } : {}) }));
}

const SubagentParamProperties = {
	agent: Type.Optional(Type.String({ description: "Agent for one-child execution, or target for agent management actions." })),
	task: Type.Optional(Type.String({ description: "Optional one-child task; requires agent. Cannot combine with action, workflowScript, or workflowScriptPath." })),
	commonTask: Type.Optional(Type.String({ minLength: 1, maxLength: 48000, description: "Shared brief supplied once for native agent/tasks/chain; injected into every child task. Saves parent request duplication, not child input tokens." })),
	tasks: Type.Optional(Type.Array(Type.Unsafe({ type: "object", additionalProperties: true }), { minItems: 1, maxItems: 64, description: "Native parallel children: [{agent,task,acceptance?,cwd?,model?},...]. Use commonTask for the shared brief and short branch-specific tasks." })),
	chain: Type.Optional(Type.Array(Type.Unsafe({ type: "object", additionalProperties: true }), { minItems: 1, maxItems: 64, description: "Native sequential steps: [{agent,task},...]; {previous} carries prior output. Supports nested parallel groups." })),
	action: Type.Optional(Type.String({ minLength: 1, description: "Management/control action (list, get, models, status, resume, steer, create/update/delete, mission.*, watchdog.*, schedule.*). Omit for execution." })),
	async: Type.Optional(Type.Boolean({ description: "Run in background (default unless asyncByDefault:false). false only when the parent must block." })),
	model: Type.Optional(Type.String({ description: "Child model override (provider/id; bare ids resolve only when unique). Thinking suffix on the string, e.g. 'provider/id:high'. With action='models' it filters the registry listing instead." })),
	thinking: Type.Optional(Type.Unsafe({ anyOf: [{ type: "string" }, { type: "boolean" }], description: "Thinking level for action='watchdog.configure' only (off/minimal/low/medium/high/xhigh/max, inherit, or false). Ignored on dispatch." })),
	context: Type.Optional(Type.String({ enum: ["fresh", "fork", "profile"], description: "fresh/fork branch from the parent session; profile uses the agent's declared defaultContext. Omitted: config defaultSubagentContext wins." })),
	cwd: Type.Optional(Type.String({ description: "Execution cwd (or target project directory for project.* actions)." })),
	worktree: Type.Optional(Type.Boolean({ description: "Managed isolation: each workflow child gets a separate git worktree; per-child override allowed." })),
	gitAuthority: Type.Optional(Type.Boolean({ description: "Delegate Git commit/push authority to this call's children (single child) or as the per-child default for tasks/chain steps; per-step gitAuthority overrides. Every child is otherwise read-only at the tool layer regardless of prompt text: git commit/push/merge and publish runners are blocked; the parent owns integration." })),
	output: Type.Optional(Type.Unsafe({ anyOf: [{ type: "string" }, { type: "boolean" }], description: "Default child output file (string) or false. Durable workflow handoff: return the child's outputReference/outputPathMapping/artifactPaths." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Timeout. Foreground/single async runs use config timeoutMs else 30m; async composites use a 10m supervisor deadline unless explicitly overridden." })),
	outputSchema: Loose("JSON schema for a single child's structured output."),
	acceptance: Loose("Acceptance contract. files:{scope:[exact relative paths],unchanged:[files],unchangedScripts:[HTML files]} adds independent baseline checks before completion; no globs."),
	gate: Type.Optional(Type.String({ minLength: 1, description: "Host gate command; cannot combine with acceptance." })),
	workflowScript: Type.Optional(Type.String({ minLength: 1, description: "Inline JavaScript statement body (filesystem-free sandbox): return runs.run(key,{agent,task,...}) / await runs.all([...]) / runs.steer / runs.host / runs.status / await runs.recover(results,config?) (bounded respawn plan for failed fanout) / await runs.fuse(results,config?) or runs.fuseFragments(fragments,config?) (advisory merge, returns {strategy,fusedBody,provenance}) / emit / console. runs.all resolves to an ordered array, not a key map. Top-level await or plain helper functions only (no nested async/arrow helpers). async:false blocks the parent; never for reviews/gates." })),
	workflowScriptPath: Type.Optional(Type.String({ minLength: 1, description: "Path to a workflow file; relative paths resolve against the request cwd. Mutually exclusive with workflowScript and workflow." })),
	workflow: Type.Optional(Type.String({ minLength: 1, description: "Extension-owned workflow resource {workflow:'review',args:{...}}: policy-aware script + authority resolution." })),
	args: Loose("Bounded plain-JSON args for workflow resources."),
	mission: Loose("Mission object ({title|summary, objective?, labels?}), missionId string, or false for none. goal:true requires budget:{tokens}."),
	missionId: Type.Optional(Type.String({ description: "Attach an existing mission." })),
	missionUpdate: Loose("Mission update payload for mission.update (objective, budget, summary, labels, decisions, artifacts)."),
	summary: Type.Optional(Type.String({ description: "Mission close summary for mission.close." })),
	// Management action params.
	id: Type.Optional(Type.String({ description: "Run id/prefix for status/debug.run, interrupt, steer, resume, or mission.attach-run." })),
	dir: Type.Optional(Type.String({ description: "Async run directory for status/debug.run, stop, resume, or steer." })),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child index for transcript-tail status views." })),
	childId: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Stable child identity for child-scoped stop requests." })),
	view: Type.Optional(Type.String({ enum: ["fleet", "transcript"], description: "status view: fleet overview, or transcript (with id/dir + index) to tail output." })),
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Max transcript lines for status view='transcript' (default 80)." })),
	message: Type.Optional(Type.String({ description: "Follow-up for resume, guidance for steer, or startup prompt for project.open." })),
	mode: Type.Optional(Type.String({ enum: ["steer", "follow_up", "auto", "plan", "apply"], description: "steer delivery mode; plan/apply for worktree.cleanup (plan only today)." })),
	capabilities: Type.Optional(Type.Boolean({ description: "action='list': compact capability rows without system prompts." })),
	name: Type.Optional(Type.String({ description: "Human-readable name for action='schedule.create'." })),
	at: Type.Optional(Type.String({ description: "schedule.create one-shot trigger: '+10m' or ISO timestamp." })),
	every: Type.Optional(Type.String({ description: "schedule.create recurring interval: '30m', '6h', '2d', '2w'." })),
	sessionOnly: Type.Optional(Type.Boolean({ description: "schedule.create: record creating session only." })),
	scope: Type.Optional(Type.String({ enum: ["session", "user", "project"], description: "watchdog.configure scope (default session)." })),
	target: Type.Optional(Type.String({ enum: ["main", "children", "child"], description: "watchdog action target." })),
	additional: Type.Optional(Type.Integer({ minimum: 1, description: "grant-spawn-budget: launches to add (root parent, user-confirmed only)." })),
	focus: Type.Optional(Type.Boolean({ description: "Focus the new Herdr pane for inspector.open/project.open." })),
	config: Type.Optional(Type.Unsafe({ anyOf: [{ type: "object", additionalProperties: true }, { type: "string" }], description: "Agent config for create/update: object or JSON string." })),
};

const SubagentParamsSchema = Type.Object(SubagentParamProperties);

export const SubagentParams = keepTopLevelParameterDescriptions(SubagentParamsSchema);

export function createSubagentParamsSchema(): typeof SubagentParams {
	return SubagentParams;
}

const SubagentWaitParamsSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Wait for one async/detached run by id or prefix. Ordinary async runs notify natively — use only for work without a native wake." })),
	all: Type.Optional(Type.Boolean({ description: "Wait for ALL runs active at call start (same-turn need only)." })),
	nonBlocking: Type.Optional(Type.Boolean({ description: "Resolve id once, persist a wake subscription, return immediately (detached/provider work without native delivery)." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Give up after N ms (runs keep going); defaults to config waitTool.defaultTimeoutMs else 30m. Expiry is a non-error result." })),
	stopOnAttention: Type.Optional(Type.Boolean({ description: "Blocking waits stop when a run needs attention (default true); false keeps waiting." })),
});

export const SubagentWaitParams = keepTopLevelParameterDescriptions(SubagentWaitParamsSchema);

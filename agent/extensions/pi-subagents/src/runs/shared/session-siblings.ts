/**
 * What a child knows about the others at work in its session. Two readers of
 * the same memory of launches: the refusal of an identical launch while its
 * twin still runs, and the "Also at work in this session" block of a child's
 * brief.
 *
 * A launch is remembered by its run id and counts as running while the job
 * tracker still lists that run as alive; nothing here has to hear when a run
 * ends.
 */
import type { SubagentState } from "../../shared/types.ts";

/** A native child a call names: `key` is set only when it has a task of its own. */
export interface LaunchedChild {
	agent: string;
	label: string;
	key?: string;
}

interface Memory {
	launches: Map<string, { startedAt: number; children: LaunchedChild[] }>;
	/** Key of a call refused once, with the run it was refused for; the same call sent again runs. */
	refused: Map<string, string>;
}

type Item = Record<string, unknown>;
type SessionState = Pick<SubagentState, "asyncJobs">;

/** A run counts while the tracker still lists it as at work; paused and stopped runs are finished there. */
const ALIVE = new Set(["queued", "running"]);
/** A child of a live run is at work until its own step has ended. */
const STEP_AT_WORK = new Set(["pending", "running"]);
const MAX_LINES = 4;
const LABEL_CHARS = 100;
/** Where the child's own task starts after a `commonTask` expansion. */
const CHILD_TASK_MARK = "\n\nChild task:\n";
const memories = new WeakMap<object, Memory>();

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

function memoryOf(state: SessionState): Memory {
	let memory = memories.get(state);
	if (!memory) memories.set(state, (memory = { launches: new Map(), refused: new Map() }));
	return memory;
}

/** Visit every native child of a call in launch order (single, `tasks`, `chain` steps and their parallel members); `edit` may return a replacement. */
export function mapChildren<T extends object>(params: T, edit: (item: Item, index: number) => Item): T {
	const call = params as Item;
	let index = 0;
	const one = (value: unknown): unknown => (value && typeof value === "object" && !Array.isArray(value) ? edit(value as Item, index++) : value);
	const step = (value: unknown): unknown => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return value;
		const record = value as Item;
		if (Array.isArray(record.parallel)) return { ...record, parallel: record.parallel.map(one) };
		if (record.parallel && typeof record.parallel === "object") return { ...record, parallel: one(record.parallel) };
		return one(record);
	};
	if (Array.isArray(call.tasks)) return { ...params, tasks: call.tasks.map(one) };
	if (Array.isArray(call.chain)) return { ...params, chain: call.chain.map(step) };
	return typeof call.agent === "string" ? (one(call) as T) : params;
}

/** The children a call names, in launch order. */
export function launchChildren(params: object): LaunchedChild[] {
	const children: LaunchedChild[] = [];
	mapChildren(params, (item, index) => {
		const task = typeof item.task === "string" ? item.task : "";
		const mark = task.lastIndexOf(CHILD_TASK_MARK);
		children[index] = {
			agent: String(item.agent ?? ""),
			label: flat(mark >= 0 ? task.slice(mark + CHILD_TASK_MARK.length) : task).slice(0, LABEL_CHARS),
			...(flat(task) ? { key: `${item.agent}\n${flat(task)}` } : {}),
		};
		return item;
	});
	return children;
}

/** Remember a launched run's children for as long as its job is alive. */
export function rememberLaunch(state: SessionState, runId: string, children: LaunchedChild[]): void {
	if (children.length) memoryOf(state).launches.set(runId, { startedAt: Date.now(), children });
}

function running(state: SessionState): { id: string; startedAt: number; child: LaunchedChild }[] {
	const { launches } = memoryOf(state);
	const alive: { id: string; startedAt: number; child: LaunchedChild }[] = [];
	for (const [id, launch] of launches) {
		const job = state.asyncJobs.get(id);
		if (!job || !ALIVE.has(job.status)) {
			launches.delete(id);
			continue;
		}
		launch.children.forEach((child, index) => {
			const step = job.steps?.[index];
			if (!step || step.agent !== child.agent || STEP_AT_WORK.has(step.status)) alive.push({ id, startedAt: launch.startedAt, child });
		});
	}
	return alive;
}

/**
 * The refusal for a launch whose agent and task match a child that is still
 * running, or undefined. A match is refused once; the same call sent again runs.
 */
export function refuseTwinLaunch(state: SessionState, children: LaunchedChild[]): string | undefined {
	const { refused } = memoryOf(state);
	const alive = running(state);
	for (const [key, id] of refused) {
		if (!alive.some((other) => other.id === id && other.child.key === key)) refused.delete(key);
	}
	const twins = children.flatMap((child) => {
		const twin = child.key ? alive.find((other) => other.child.key === child.key) : undefined;
		return twin ? [{ key: child.key as string, twin }] : [];
	});
	const fresh = twins.filter(({ key, twin }) => refused.get(key) !== twin.id);
	for (const { key, twin } of twins) {
		if (fresh.length) refused.set(key, twin.id);
		else refused.delete(key);
	}
	if (!fresh.length) return undefined;
	const { id, startedAt } = fresh[0].twin;
	const minutes = Math.max(1, Math.ceil((Date.now() - startedAt) / 60_000));
	return `already running as ${id} since ${minutes} min; its report will arrive; send the call again to run a second one`;
}

/**
 * Add to each child's brief the block naming the others at work: the other
 * children of the same `tasks` batch, then the children still running from
 * earlier calls, at most four lines.
 */
export function withSiblingBlocks<T extends object>(state: SessionState, params: T, children: LaunchedChild[]): T {
	const batch = Array.isArray((params as Item).tasks);
	const earlier = running(state).map(({ child }) => child);
	return mapChildren(params, (item, index) => {
		if (typeof item.task !== "string" || !item.task.trim()) return item;
		const others = [...(batch ? children.filter((_, other) => other !== index) : []), ...earlier].filter((child) => child.label);
		if (!others.length) return item;
		const lines = others.slice(0, MAX_LINES).map((child) => `- ${child.agent}: ${child.label}`);
		return { ...item, task: `${item.task}\n\nAlso at work in this session:\n${lines.join("\n")}` };
	});
}

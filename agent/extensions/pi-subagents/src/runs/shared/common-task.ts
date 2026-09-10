/** Expand a native shared brief exactly once, before either executor serializes it. */
export function expandCommonTask<T extends { commonTask?: string; task?: string; agent?: string; tasks?: unknown[]; chain?: unknown[]; action?: string; workflowScript?: string; workflowScriptPath?: string }>(input: T): T {
	if (input.commonTask === undefined) return input;
	if (typeof input.commonTask !== "string" || !input.commonTask.trim() || input.commonTask.length > 48_000) throw new Error("commonTask must be a non-empty string of at most 48000 characters.");
	if (input.action !== undefined || input.workflowScript !== undefined || input.workflowScriptPath !== undefined) throw new Error("commonTask is for native agent/tasks/chain execution; pass shared context explicitly inside workflowScript.");
	const { commonTask, ...rest } = input;
	const prefix = (task: unknown, fallback = "") => {
		if (task !== undefined && typeof task !== "string") throw new Error("Child task must be a string.");
		return `Shared brief:\n${commonTask}\n\nChild task:\n${task ?? fallback}`;
	};
	const child = (value: unknown, fallback = "") => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Native child must be an object.");
		const item = value as Record<string, unknown>;
		return { ...item, task: prefix(item.task, fallback) };
	};
	if (input.tasks !== undefined) {
		if (!Array.isArray(input.tasks)) throw new Error("tasks must be an array.");
		return { ...rest, tasks: input.tasks.map((item) => child(item)) } as T;
	}
	if (input.chain !== undefined) {
		if (!Array.isArray(input.chain)) throw new Error("chain must be an array.");
		return { ...rest, chain: input.chain.map((value) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Chain step must be an object.");
			const step = value as Record<string, unknown>;
			if (Array.isArray(step.parallel)) return { ...step, parallel: step.parallel.map((item) => child(item, "{previous}")) };
			if (step.parallel !== undefined) return { ...step, parallel: child(step.parallel, "{previous}") };
			return child(step, "{previous}");
		}) } as T;
	}
	if (!input.agent) throw new Error("commonTask requires a native agent, tasks, or chain.");
	return { ...rest, task: prefix(input.task) } as T;
}

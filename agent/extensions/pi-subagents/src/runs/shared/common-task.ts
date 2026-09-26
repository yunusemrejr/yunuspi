/**
 * Append a bounded Task State Graph slice to a child brief. The slice is
 * advisory parent-side context (goal, relevant requirements/decisions/files/
 * failures/evidence); children stay read-only and their results return with
 * subagent provenance, never as verified facts. Fail-open: any graph trouble
 * leaves the brief untouched.
 */
export function attachTaskStateSlice<T extends { task?: string }>(input: T, slice?: () => string): T {
	if (typeof input.task !== "string" || !input.task.trim()) return input;
	let text = "";
	try {
		text = typeof slice === "function" ? slice() : "";
	} catch {
		return input;
	}
	if (!text || !text.trim() || text === "(task state unavailable)") return input;
	const block = `\n\nTask context (shared Task State Graph, advisory — verify before relying):\n${text.slice(0, 1500)}`;
	if (input.task.includes("Task context (shared Task State Graph")) return input;
	if (input.task.length + block.length > 48_000) return input;
	return { ...input, task: `${input.task}${block}` };
}

/** Focus hints for a child slice: requirement ids, file-like tokens, keywords. */
export function taskSliceFocus(brief: string): string[] {
	const focus: string[] = [];
	for (const match of String(brief ?? "").matchAll(/\bR\d{1,3}\b/g)) focus.push(match[0]);
	for (const match of String(brief ?? "").matchAll(/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.[a-z0-9]{1,8}\b/gi)) focus.push(match[0].toLowerCase());
	return [...new Set(focus)].slice(0, 8);
}

type SliceBrief = { task?: unknown };

/** Attach a task-state slice to every native child brief in one dispatch (top-level task, tasks[], chain[]). */
export function attachTaskStateSliceDeep<T extends SliceBrief & { tasks?: unknown[]; chain?: unknown[] }>(
	input: T,
	resolve: (brief: string) => string,
): T {
	let next: T = input;
	const apply = (brief: unknown): unknown => {
		if (typeof brief !== "string" || !brief.trim()) return brief;
		try {
			const out = attachTaskStateSlice({ task: brief }, () => resolve(brief));
			return out.task;
		} catch {
			return brief;
		}
	};
	if (typeof next.task === "string") next = { ...next, task: apply(next.task) as string };
	if (Array.isArray(next.tasks)) {
		next = {
			...next,
			tasks: next.tasks.map((item) => {
				if (!item || typeof item !== "object" || Array.isArray(item)) return item;
				const record = item as Record<string, unknown>;
				return { ...record, task: apply(record.task) };
			}),
		};
	}
	if (Array.isArray(next.chain)) {
		const step = (value: unknown): unknown => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return value;
			const record = value as Record<string, unknown>;
			if (Array.isArray(record.parallel)) return { ...record, parallel: record.parallel.map(step) };
			if (record.parallel && typeof record.parallel === "object") return { ...record, parallel: step(record.parallel) };
			return { ...record, task: apply(record.task) };
		};
		next = { ...next, chain: next.chain.map(step) };
	}
	return next;
}

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

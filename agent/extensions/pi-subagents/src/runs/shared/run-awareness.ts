import type { ExtensionAPI } from "@yunuspi/coding-agent";

/** A child is told how long it has worked and what it has spent this rarely. */
export const AWARENESS_MINUTES = 10;
export const AWARENESS_TOOL_CALLS = 40;

export interface RunAwareness {
	/** Whole minutes since the child's first event. */
	minutes: number;
	toolCalls: number;
	/** Reported spend; absent when the provider or plan gives no price. */
	usd?: number;
}

/** Spend as people read it; empty for an amount that rounds to nothing. */
const money = (usd: number): string => {
	const text = usd >= 0.1 ? usd.toFixed(2) : usd >= 0.001 ? usd.toFixed(3) : usd.toFixed(4);
	return Number(text) > 0 ? `$${text}` : "";
};

/** The one line a child gets at its first tool result past ten minutes or
 *  another forty calls: its own figures, and what not to spend the rest on. */
export function runAwarenessNote({ minutes, toolCalls, usd }: RunAwareness): string {
	const spend = usd === undefined ? "" : money(usd);
	const figures = [minutes > 0 ? `${minutes} min` : "under 1 min", `${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`];
	if (spend) figures.push(spend);
	return `This assignment so far: ${figures.join(", ")}. Checks and tests that this task does not need, or that cannot fail because of your change, are waste: skip them and report when the task is done.`;
}

/**
 * Children register this in their own process: the main session's facts line
 * covers a parent, but a child only hears from its parent when it is steered,
 * so it can run long and spend without knowing it. The note is a message of
 * its own, sent after a tool result, and it is advisory: nothing is stopped.
 */
export function registerRunAwareness(pi: ExtensionAPI, deps: { now?: () => number } = {}): void {
	const now = deps.now ?? Date.now;
	const startedAt = now();
	let toolCalls = 0;
	let usd = 0;
	let priced = false;
	let notedMinutes = 0;
	let notedCalls = 0;
	const sendUserMessage = (pi as { sendUserMessage?: (content: string, options: { deliverAs: "steer" }) => unknown }).sendUserMessage;
	const onRuntimeEvent = pi.on as unknown as (
		event: string,
		handler: (event: { message?: any }) => unknown,
	) => void;
	onRuntimeEvent("tool_call", () => {
		toolCalls += 1;
	});
	onRuntimeEvent("message_end", (event) => {
		const cost = event?.message?.usage?.cost;
		const total = typeof cost?.total === "number" && Number.isFinite(cost.total) && cost.total > 0 ? cost.total : 0;
		if (total > 0) {
			priced = true;
			usd += total;
		}
	});
	onRuntimeEvent("tool_result", () => {
		const minutes = Math.floor((now() - startedAt) / 60_000);
		if (minutes < notedMinutes + AWARENESS_MINUTES && toolCalls < notedCalls + AWARENESS_TOOL_CALLS) return undefined;
		notedMinutes = minutes;
		notedCalls = toolCalls;
		try {
			sendUserMessage?.(runAwarenessNote({ minutes, toolCalls, ...(priced ? { usd } : {}) }), { deliverAs: "steer" });
		} catch {
			// The figures are advisory; a note that could not be queued changes nothing.
		}
		return undefined;
	});
}

/**
 * Wires the needed check (needed.ts) to the session. It is an extension of its
 * own because reminders.ts and session-facts.ts stand down inside a subagent,
 * and a worker is held against its brief by the same check.
 *
 * The note rides on the tool result that crossed the sign: the model reads it
 * with that result, before its next step, and nothing is blocked or queued.
 */
import type { ExtensionAPI } from "@yunuspi/coding-agent";
import { askJev } from "./lib/jev-client.ts";
import { askTypedDecision } from "./lib/micro-intelligence/jev-decisions.ts";
import { Needed, type DetourAsk } from "./lib/needed.ts";

const DECISION_TIMEOUT_MS = 1_500;

export default function neededCheck(pi: ExtensionAPI): void {
	const worker = process.env.PI_SUBAGENT_CHILD === "1";
	let reported = false;
	const report = (error: unknown): void => {
		if (reported) return;
		reported = true;
		try {
			console.error(`[needed] the check failed and stays out of the way: ${error instanceof Error ? error.name : "error"}`);
		} catch {
			/* logging itself must never throw */
		}
	};

	const ask: DetourAsk = async (state) => {
		const judged = await askTypedDecision("detour", { state }, {
			judge: (site, evidence, questions, options) => askJev(site, evidence, questions, { pi, signal: options?.signal, timeoutMs: DECISION_TIMEOUT_MS }),
		});
		const probability = judged.verdict?.detour;
		return judged.ok && typeof probability === "number" ? probability : undefined;
	};
	const needed = new Needed({ worker, ask });

	const reset = (): void => needed.end();
	pi.on("session_start", reset);
	pi.on("session_switch", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", reset);

	// The main agent's request is what the person typed; a machine message (a worker's report) is not one.
	// A worker's request is its brief: the first prompt it is given.
	pi.on("input", (event: any) => {
		try {
			if (event?.source !== "extension") needed.request(String(event?.originalText ?? event?.text ?? ""));
		} catch (error) {
			report(error);
		}
		return undefined;
	});
	if (worker) {
		pi.on("before_agent_start", (event: any) => {
			try {
				needed.request(String(event?.prompt ?? ""));
			} catch (error) {
				report(error);
			}
			return undefined;
		});
	}

	pi.on("tool_result", async (event: any, ctx: any) => {
		try {
			const note = await needed.observe(event, ctx?.cwd ?? process.cwd());
			if (note) return { content: [...(event.content ?? []), { type: "text" as const, text: note }] };
		} catch (error) {
			report(error);
		}
		return undefined;
	});
}

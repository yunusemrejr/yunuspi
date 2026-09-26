/**
 * Completion gate — deploys and whole-plan completion wait for verification.
 *
 * Sessions shipped with zero review rounds and empty test checks because the
 * verification sources (project tests, quality review, deploy) only annotated
 * final answers. This pure module decides when a tool call is a "done" moment
 * (a production deploy, or the call that closes the last open todo) and turns
 * unresolved verification receipts into a refusal. The refusal is issued once
 * per distinct receipt-head set (see gateHead): repeating the completion call
 * records an explicit waiver instead, so a user who asked to ship anyway is
 * never deadlocked, and the waiver stays visible in the session. Sources stay
 * owned by their subsystems.
 */

export interface PlanTask {
	id: number;
	status?: string;
}

type Mutation = { action?: string; id?: number; status?: string };

const OPEN = (task: PlanTask) => task.status !== "completed" && task.status !== "deleted";

/** True when this todo call leaves no open task while completing at least one. */
export function completesPlan(tasks: readonly PlanTask[], params: Mutation & { operations?: Mutation[] }): boolean {
	const ops: Mutation[] = params?.action === "batch" ? (Array.isArray(params.operations) ? params.operations : []) : [params ?? {}];
	const closing = new Set<number>();
	let completes = false;
	for (const op of ops) {
		if (op?.action === "create" && op.status !== "completed" && op.status !== "deleted") return false;
		if (op?.action === "update" && typeof op.id === "number" && (op.status === "completed" || op.status === "deleted")) {
			closing.add(op.id);
			if (op.status === "completed") completes = true;
		}
		if (op?.action === "delete" && typeof op.id === "number") closing.add(op.id);
		if (op?.action === "create" && op.status === "completed") completes = true;
	}
	if (!completes) return false;
	return tasks.filter(OPEN).every((task) => closing.has(task.id));
}

export interface GateDecision {
	block: boolean;
	waived: boolean;
	key: string;
	reason?: string;
}

/** Key a line by its source and receipt head. Producers append free-text
 * detail after a second ': ' (a reworded verdict, a fresh assessment
 * reason); that detail must not reset a refusal the agent already answered,
 * or the waiver is unreachable: following the refusal's own advice to assess
 * rewords the line and refuses afresh, stalling the session end. Lines with
 * fewer segments key whole, so new counts and new states still refuse afresh.
 * Display keeps the full lines; only the key is headed. */
const gateHead = (line: string): string => {
	const first = line.indexOf(": ");
	if (first < 0) return line;
	const second = line.indexOf(": ", first + 2);
	return second < 0 ? line : line.slice(0, second);
};

/** Refuse once per receipt-head set and moment; a retry with no new receipt head is a waiver. */
export function completionGate(moment: "deploy" | "plan-complete", lines: readonly string[], refused: ReadonlySet<string>): GateDecision {
	const key = `${moment}\0${lines.map(gateHead).join("\n")}`;
	if (!lines.length) return { block: false, waived: false, key };
	if (refused.has(key)) return { block: false, waived: true, key };
	const what = moment === "deploy" ? "Deploy" : "Completing the last open task";
	return {
		block: true,
		waived: false,
		key,
		reason: `${what} refused: verification is unresolved.\n${lines.map((line) => `- ${line}`).join("\n")}\nResolve these first (run the project's real test suites; run quality_review review and assess it). If the user explicitly wants to proceed anyway, repeat the same call: it will proceed as a recorded waiver, and the final report must name each unresolved item.`,
	};
}

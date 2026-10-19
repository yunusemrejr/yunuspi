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

export interface GateReceipt {
	source: string;
	id: string;
	revision?: string;
	state: string;
	count?: number;
	line: string;
	/** Short human wording for the transcript footer; `line` stays the full text addressed to the agent. */
	brief?: string;
	/** A repeated agent call is not a human waiver of unfinished media review. */
	requiresUserWaiver?: boolean;
}

export const gateReceiptKey = (receipt: GateReceipt): string =>
	`${receipt.source}\0${receipt.id}\0${receipt.revision ?? ""}\0${receipt.state}\0${receipt.count ?? ""}`;

/** Refuse once per receipt set and moment; a retry with no new receipt is a
 * recorded waiver. Identity is structural (source/id/revision/state/count):
 * rewording a rendered line never resets a refusal, while a new revision,
 * state or count refuses afresh. Display keeps the full lines. */
export function completionGateReceipts(moment: "deploy" | "plan-complete", receipts: readonly GateReceipt[], refused: ReadonlySet<string>): GateDecision {
	const key = `${moment}\0${receipts.map(gateReceiptKey).join("\n")}`;
	if (!receipts.length) return { block: false, waived: false, key };
	const protectedReview = receipts.some(receipt => receipt.requiresUserWaiver);
	if (refused.has(key) && !protectedReview) return { block: false, waived: true, key };
	const what = moment === "deploy" ? "Deploy" : "Completing the last open task";
	return {
		block: true,
		waived: false,
		key,
		reason: `${what} refused: verification is unresolved.\n${receipts.map((receipt) => `- ${receipt.line}`).join("\n")}\n${protectedReview ? 'Review the current delivered media and record honest video_qa verdicts: frames from the export for the picture, video_qa action:"listen" for narration and mix. A repeated completion call cannot approve unreviewed or failed media.' : moment === "deploy"
			? "Resolve these first: run the project's real checks (a passing run of its test or build command counts automatically) and settle open reviews. Do not resend this call just to get past the check. Only when the user explicitly told you to proceed anyway does the same call again record a waiver; the final report must then name each unresolved item."
			: "Resolve the ones that bear on what the user asked for: run the project's real checks (a passing run of its test or build command counts automatically) and settle open reviews. A check that does not apply to the requested deliverable (for example a viewer page around a requested video) is not work to do: call complete again with reason naming each such item and why. That waiver is recorded and shown to the user; a call without a reason is refused again."}`,
	};
}

/** Key a legacy line by its source and receipt head. Producers append
 * free-text detail after a second ': ' (a reworded verdict, a fresh
 * assessment reason); that detail must not reset a refusal the agent already
 * answered, or the waiver is unreachable: following the refusal's own advice
 * to assess rewords the line and refuses afresh, stalling the session end.
 * Lines with fewer segments key whole, so new counts and new states still
 * refuse afresh. Display keeps the full lines; only the key is headed.
 * Legacy string producers only; structured receipts key structurally. */
const gateHead = (line: string): string => {
	const first = line.indexOf(": ");
	if (first < 0) return line;
	const second = line.indexOf(": ", first + 2);
	return second < 0 ? line : line.slice(0, second);
};

/** Refuse once per receipt-head set and moment; a retry with no new receipt head is a waiver. */
export function completionGate(moment: "deploy" | "plan-complete", lines: readonly string[], refused: ReadonlySet<string>): GateDecision {
	return completionGateReceipts(moment, lines.map((line) => ({ source: "", id: gateHead(line), state: "unresolved", line })), refused);
}

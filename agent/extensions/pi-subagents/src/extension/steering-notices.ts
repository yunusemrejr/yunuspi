import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SteeringNotice, SubagentState } from "../shared/types.ts";

export const SUBAGENT_STEERING_MESSAGE_TYPE = "subagent_steering_notice";

export interface SubagentSteeringMessageDetails extends SteeringNotice {
	source?: "async";
	asyncDir?: string;
	noticeText?: string;
}

export function formatSteeringNotice(details: Pick<SubagentSteeringMessageDetails, "runId" | "requestId" | "state" | "message">): string {
	return [
		`Subagent steering ${details.state}: ${details.runId}`,
		`Request: ${details.requestId}`,
		details.message,
		"Inspect the run status before sending another correction.",
	].join("\n");
}

/** Delivered steering notices per session state. A retried or replayed
 * terminal event for the same request with identical content must not wake
 * the model again; changed content still delivers. Keyed off the session
 * state object so entries die with the session (no cross-session leak), with
 * a bound so a long-lived session cannot grow the set without limit. */
const seenSteeringNotices = new WeakMap<object, Set<string>>();
const MAX_SEEN_STEERING = 200;
function steeringNoticeKey(details: SubagentSteeringMessageDetails): string {
	const contentHash = createHash("sha256").update(details.noticeText ?? details.message ?? "").digest("hex").slice(0, 16);
	return `${details.runId}\0${details.requestId}\0${details.state}\0${contentHash}`;
}

export function handleSubagentSteeringNotice(input: {
	pi: Pick<ExtensionAPI, "sendMessage">;
	state: SubagentState;
	details: SubagentSteeringMessageDetails;
}): void {
	if (!input.details || (input.details.state !== "failed" && input.details.state !== "partial" && input.details.state !== "recovered")) return;
	if (!input.state.currentSessionId || input.details.currentSessionId !== input.state.currentSessionId) return;
	const key = steeringNoticeKey(input.details);
	let seen = seenSteeringNotices.get(input.state);
	if (!seen) {
		seen = new Set();
		seenSteeringNotices.set(input.state, seen);
	}
	if (seen.has(key)) return;
	seen.add(key);
	if (seen.size > MAX_SEEN_STEERING) {
		const oldest = seen.values().next().value;
		if (oldest !== undefined) seen.delete(oldest);
	}
	const noticeText = input.details.noticeText ?? formatSteeringNotice(input.details);
	input.pi.sendMessage({
		customType: SUBAGENT_STEERING_MESSAGE_TYPE,
		content: noticeText,
		display: true,
		details: { ...input.details, noticeText },
	}, { triggerTurn: true });
}

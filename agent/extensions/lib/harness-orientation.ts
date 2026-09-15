/**
 * Small first-prompt orientation for the human session.
 *
 * This is deliberately a fixed note: it does not inspect the task with a
 * model, launch a child, or require a tool call.  A sidecar receipt keeps a
 * reload/resume from repeating it while leaving the session transcript and
 * reminder state schema untouched.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RECEIPT_VERSION = 1;
const RECEIPT_PREFIX = "harness-orientation-";
const deliveredInProcess = new Set<string>();

function safeSessionId(sid: string): string {
	return sid.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 160) || "unknown";
}

export function orientationReceiptFile(
	sid: string,
	dir = path.join(os.homedir(), ".pi", "reminders"),
): string {
	return path.join(dir, `${RECEIPT_PREFIX}${safeSessionId(sid)}.json`);
}

/** True only for a receipt written by this helper. */
export function hasOrientationReceipt(
	sid: string,
	dir = path.join(os.homedir(), ".pi", "reminders"),
): boolean {
	if (!sid) return false;
	if (deliveredInProcess.has(sid)) return true;
	try {
		const raw = JSON.parse(fs.readFileSync(orientationReceiptFile(sid, dir), "utf8")) as {
			version?: unknown;
			deliveredAt?: unknown;
		};
		return raw?.version === RECEIPT_VERSION &&
			typeof raw.deliveredAt === "number" && Number.isFinite(raw.deliveredAt);
	} catch {
		return false;
	}
}

/** Persist a metadata-only receipt; the in-process mark also closes races. */
export function markOrientationDelivered(
	sid: string,
	dir = path.join(os.homedir(), ".pi", "reminders"),
): boolean {
	if (!sid) return false;
	if (deliveredInProcess.has(sid)) return true;
	try {
		fs.mkdirSync(dir, { recursive: true });
		const target = orientationReceiptFile(sid, dir);
		const tmp = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(
			tmp,
			JSON.stringify({ version: RECEIPT_VERSION, deliveredAt: Date.now() }),
			{ encoding: "utf8", mode: 0o600 },
		);
		fs.renameSync(tmp, target);
		deliveredInProcess.add(sid);
		return true;
	} catch {
		try {
			fs.unlinkSync(`${orientationReceiptFile(sid, dir)}.${process.pid}.tmp`);
		} catch {
			/* best effort cleanup; the reminder hook must stay ambient-safe */
		}
		return false;
	}
}

function userOptedOut(prompt: unknown): boolean {
	if (typeof prompt !== "string") return false;
	return /\b(?:no|without|never|do not|don't)\s+(?:use|inspect|read|load)\s+(?:any\s+)?(?:tools?|skills?|workflows?)\b/i.test(prompt) ||
		/\b(?:no|without)\s+(?:tools?|skills?|workflows?)\b/i.test(prompt);
}

/**
 * Return the fixed, optional note for a human's first prompt.  Discovery
 * names are included only when the corresponding surface is active.
 */
export function buildHarnessOrientation(
	activeTools: readonly string[] = [],
	prompt?: unknown,
): string | undefined {
	if (userOptedOut(prompt)) return undefined;
	const tools = new Set(activeTools);
	let discovery = "";
	if (tools.has("tool_search") && tools.has("skill_review")) {
		discovery =
			" If useful, browse tool_search for optional tools or skill_review for optional workflows.";
	} else if (tools.has("tool_search")) {
		discovery = " If useful, browse tool_search for optional tools.";
	} else if (tools.has("skill_review")) {
		discovery = " If useful, browse skill_review for optional workflows.";
	}
	return (
		"Quick orientation: briefly inspect relevant harness tools, skills, or workflows that may help; " +
		"understand the options, then focus promptly on the user's request." +
		discovery +
		" No deep exploration or forced call is required; user and project instructions win." +
		" Prefer existing harness tools over shell reimplementation; bounded reviews, councils, swarms and fusion exist for genuinely hard or broad work."
	);
}

export const HARNESS_ORIENTATION_RECEIPT_PREFIX = RECEIPT_PREFIX;

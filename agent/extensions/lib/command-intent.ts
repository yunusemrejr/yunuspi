/**
 * Did the user ask for this?
 *
 * The filesystem guard frames a command whose consequence reaches beyond the
 * project (command-consequence.ts). This module reads the user's own messages
 * and answers `requested` or `unrequested`: first the typed judge,
 * then, when that is unavailable or unsure, the session's own model in one
 * fresh question that sees nothing but the user's words, the command and its
 * effect. No answer leaves the decision with the guard, which asks the user or
 * refuses. A judge can spare the user a prompt; it never lifts a block.
 *
 * Evidence is the user's messages only. Tool output, web pages and the
 * command text were not written by the user and are never read as permission.
 */
import { createHash } from "node:crypto";
import { goalUserWords } from "./goal-state.ts";
import {
	askTypedDecision, COMMAND_INTENTS, COMMAND_REQUEST_CRITERIA, COMMAND_REQUEST_INSTRUCTIONS,
} from "./micro-intelligence/jev-decisions.ts";
import type { JudgeFn } from "./micro-intelligence/review.ts";
import { goalAssignment } from "./presets.ts";
import { safeText } from "./project-intelligence/privacy.mjs";

export type CommandIntent = (typeof COMMAND_INTENTS)[number];
export interface IntentReading { intent?: CommandIntent; by?: "judge" | "model" }
export interface IntentPorts {
	/** The typed judge; absent when it is switched off. */
	judge?: JudgeFn;
	/** One fresh question to the session model, answered in text. */
	ask?: (prompt: string, signal?: AbortSignal) => Promise<string>;
	signal?: AbortSignal;
}

/** The first request and the latest five: where a standing instruction such as
 * "push when you are done" and the current ask both live. */
const MAX_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 1500;
const MAX_COMMAND_CHARS = 1200;
const MODEL_ANSWER_MS = 25_000;

const isIntent = (value: unknown): value is CommandIntent => (COMMAND_INTENTS as readonly unknown[]).includes(value);

/** A session entry of this type marks a user-role message the harness wrote
 * itself (a follow-up prompt, a worker's result): never the user's words. */
export const HARNESS_INPUT_ENTRY = "harness-input-v1";
const messageText = (content: unknown): string => typeof content === "string" ? content
	: Array.isArray(content)
		? content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n")
		: "";
/** What identifies one message across the input event and the session entry. */
export const inputDigest = (text: string): string => createHash("sha256").update(text.trim()).digest("hex").slice(0, 24);

/** The user's own messages on a session branch, oldest first, with secrets
 * masked. A message goal mode sent in the user's name contributes the goal
 * the user typed, not the criteria and instructions wrapped around it. */
export function userWords(entries: unknown): string[] {
	if (!Array.isArray(entries)) return [];
	const texts: string[] = [];
	// Counted, so a message the user later types with the same text still counts.
	const harness = new Map<string, number>();
	for (const entry of entries)
		if (entry?.type === "custom" && entry.customType === HARNESS_INPUT_ENTRY && typeof entry.data?.digest === "string")
			harness.set(entry.data.digest, (harness.get(entry.data.digest) ?? 0) + 1);
	for (const entry of entries) {
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role !== "user") continue;
		const raw = messageText(message.content);
		const digest = harness.size ? inputDigest(raw) : "", written = harness.get(digest) ?? 0;
		if (written > 0) { harness.set(digest, written - 1); continue; }
		const goal = goalUserWords(raw);
		const own = (goal === undefined ? raw : goalAssignment(goal)).trim();
		if (own) texts.push(own);
	}
	const kept = texts.length > MAX_MESSAGES ? [texts[0], ...texts.slice(1 - MAX_MESSAGES)] : texts;
	return kept.map((text) => safeText(text, MAX_MESSAGE_CHARS));
}

function modelQuestion(state: { userMessages: readonly string[]; command: string; effect: string }): string {
	return [
		COMMAND_REQUEST_INSTRUCTIONS,
		...COMMAND_INTENTS.map((id) => `- ${id}: ${COMMAND_REQUEST_CRITERIA[id]}`),
		`userMessages:\n${state.userMessages.map((text, at) => `${at + 1}. ${JSON.stringify(text)}`).join("\n")}`,
		`command: ${JSON.stringify(state.command)}`,
		`effect: ${state.effect}`,
		`Answer with exactly one word: ${COMMAND_INTENTS.join(", ")}.`,
	].join("\n\n");
}

/** The verdict word when the reply is that word and nothing else. "Not
 * requested." names the word and means the opposite, so anything longer than
 * the bare word is no answer. */
export function readModelAnswer(reply: string): CommandIntent | undefined {
	const word = reply.trim().toLowerCase().replace(/^[\s"'`*_([]+|[\s"'`*_.!)\]]+$/g, "");
	return isIntent(word) ? word : undefined;
}

/**
 * Read whether the user asked for `effect`. With no user message there is
 * nothing to rely on, so the answer is `unrequested` without asking anyone.
 */
export async function commandIntent(command: string, effect: string, words: readonly string[], ports: IntentPorts): Promise<IntentReading> {
	if (!words.length) return { intent: "unrequested" };
	const state = { userMessages: [...words], command: safeText(command, MAX_COMMAND_CHARS), effect: /^this command /i.test(effect.trim()) ? effect.trim() : `This command ${effect.trim()}.` };
	const typed = await askTypedDecision("command-request", { state }, { judge: ports.judge, signal: ports.signal });
	const judged = typed.ok ? typed.verdict?.intent : undefined;
	if (isIntent(judged)) return { intent: judged, by: "judge" };
	if (!ports.ask || ports.signal?.aborted) return {};
	try {
		const intent = readModelAnswer(await ports.ask(modelQuestion(state), ports.signal));
		return intent ? { intent, by: "model" } : {};
	} catch {
		return {};
	}
}

/** The session model as the fallback judge: one bounded request that carries
 * only the question, through the registry's own credentials. */
export function sessionModelAsker(ctx: any, record?: (entry: Record<string, unknown>) => void): IntentPorts["ask"] {
	const model = ctx?.model, registry = ctx?.modelRegistry;
	if (typeof model?.id !== "string" || typeof registry?.completeSimple !== "function") return undefined;
	return async (prompt, signal) => {
		const deadline = AbortSignal.timeout(MODEL_ANSWER_MS);
		const response = await registry.completeSimple(model, {
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		}, { maxTokens: 1024, maxRetries: 0, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
		// The session's cost total includes this judge: one usage entry per answered request.
		try {
			if (response?.usage) record?.({ id: `command-judge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, owner: "command-judge", provider: model.provider, model: model.id, status: response.stopReason === "error" || response.stopReason === "aborted" ? "failed" : "completed", usage: response.usage });
		} catch { /* accounting never blocks the judgment */ }
		if (response?.stopReason === "error" || response?.stopReason === "aborted") throw Error(response.errorMessage || "no answer");
		return (response?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
	};
}

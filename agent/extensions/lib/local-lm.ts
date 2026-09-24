/**
 * Client for the local language model (Qwen3.5-0.8B via llama.cpp, loopback).
 *
 * The model answers bounded yes/no judgements with a calibrated probability
 * (P(yes) from the first-token distribution of a few-shot prompt) and powers
 * the line selector in smol-preprocessor.ts. It never generates prose that
 * reaches the main agent. One request runs at a time; a small queue absorbs
 * bursts and anything beyond it is refused as busy. Three consecutive
 * failures pause use for a minute. Every real inference is reported to the
 * health sink as ml.local.inference so the TUI pulse can show it working.
 */
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sessionObservability } from "./session-observability.ts";

export const LOCAL_LM_MODEL = "Qwen3.5-0.8B";
export const LOCAL_LM_ENDPOINT = "http://127.0.0.1:18736/completion";

export interface LocalLmRuntime { version: 2; enabled: true; model: typeof LOCAL_LM_MODEL; endpoint: typeof LOCAL_LM_ENDPOINT; apiKey: string; execution: "background"; timeoutMs: number }

export function validLocalLmRuntime(value: unknown): value is LocalLmRuntime {
	const v = value as LocalLmRuntime;
	return v?.version === 2 && v.enabled === true && v.model === LOCAL_LM_MODEL && v.endpoint === LOCAL_LM_ENDPOINT && v.execution === "background"
		&& typeof v.apiKey === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(v.apiKey)
		&& Number.isSafeInteger(v.timeoutMs) && v.timeoutMs >= 1000 && v.timeoutMs <= 8000;
}

export function localLmRuntimePath(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(env.PI_LOCAL_LM_ASSETS || join(agentDir, "local-models", "qwen3.5-0.8b"), "runtime.json");
}

/** Bounded, symlink-refusing read of the runtime descriptor. */
export async function loadLocalLmRuntime(path = localLmRuntimePath()): Promise<LocalLmRuntime | undefined> {
	if (process.env.PI_LOCAL_LM === "off" || process.env.PI_SMOL_PREPROCESSOR === "off") return undefined;
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const info = await handle.stat();
		if (!info.isFile() || info.size > 8192) return undefined;
		const buffer = Buffer.alloc(8193);
		let length = 0;
		while (length < buffer.length) {
			const read = await handle.read(buffer, length, buffer.length - length, length);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		if (length > 8192) return undefined;
		const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
		return validLocalLmRuntime(value) ? value : undefined;
	} catch { return undefined; }
	finally { await handle?.close().catch(() => {}); }
}

export type Judgement = { ok: true; p: number; ms: number } | { ok: false; reason: "unavailable" | "busy" | "paused" | "timeout" | "failed" | "cancelled" };

function note(data: Record<string, unknown>) {
	try { sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.("ml.local.inference", data); } catch { /* telemetry is optional */ }
}

/** P(yes) from the first generated token's top candidates. */
export function yesProbability(body: any): number | undefined {
	const first = Array.isArray(body?.completion_probabilities) ? body.completion_probabilities[0] : undefined;
	const candidates = first?.top_logprobs ?? first?.top_probs ?? first?.probs;
	if (!Array.isArray(candidates)) return undefined;
	let yes = 0, no = 0;
	for (const candidate of candidates) {
		const token = String(candidate?.token ?? candidate?.tok_str ?? "").trim().toLowerCase();
		const p = typeof candidate?.logprob === "number" ? Math.exp(candidate.logprob) : typeof candidate?.prob === "number" ? candidate.prob : 0;
		if (token.startsWith("yes")) yes += p;
		else if (token.startsWith("no")) no += p;
	}
	return yes + no > 0 ? yes / (yes + no) : undefined;
}

export function createLocalLm(options: { runtime?: LocalLmRuntime; fetch?: typeof fetch; now?: () => number; queueLimit?: number } = {}) {
	let runtime = options.runtime, loaded = Boolean(options.runtime), loading: Promise<void> | undefined, loadedAt = 0;
	const request = options.fetch ?? fetch, now = options.now ?? Date.now, queueLimit = options.queueLimit ?? 8;
	let active = false, failures = 0, pausedUntil = 0;
	const queue: Array<() => void> = [];
	const stats = { answered: 0, failed: 0, busy: 0, totalMs: 0 };
	const ensure = async () => {
		// A missing descriptor is re-checked at most once a minute, so a model
		// installed while sessions run is picked up without a restart.
		if (loaded && (runtime || now() - loadedAt < 60_000)) return;
		loading ??= loadLocalLmRuntime().then((value) => { runtime = value; loaded = true; loadedAt = now(); }).finally(() => { loading = undefined; });
		await loading;
	};
	const slot = () => new Promise<void>((resolve) => { if (!active) { active = true; resolve(); } else queue.push(() => { active = true; resolve(); }); });
	const release = () => { active = false; queue.shift()?.(); };
	return {
		get available() { return Boolean(runtime) && now() >= pausedUntil; },
		/** Synchronous readiness; starts loading the descriptor when unknown. */
		ready(): boolean { if (!loaded || (!runtime && now() - loadedAt >= 60_000)) void ensure(); return Boolean(runtime) && now() >= pausedUntil; },
		stats: () => ({ ...stats, model: runtime ? LOCAL_LM_MODEL : undefined, paused: now() < pausedUntil }),
		/** Few-shot yes/no judgement. `prompt` must end where the answer begins. */
		async judge(prompt: string, purpose: string, signal?: AbortSignal): Promise<Judgement> {
			await ensure();
			if (!runtime) return { ok: false, reason: "unavailable" };
			if (now() < pausedUntil) return { ok: false, reason: "paused" };
			if (active && queue.length >= queueLimit) { stats.busy++; return { ok: false, reason: "busy" }; }
			await slot();
			const started = now();
			const controller = new AbortController();
			const abort = () => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
			try {
				if (signal?.aborted) return { ok: false, reason: "cancelled" };
				const response = await request(runtime.endpoint, { method: "POST", redirect: "error", signal: controller.signal,
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtime.apiKey}` },
					body: JSON.stringify({ prompt: prompt.slice(-12_000), n_predict: 1, temperature: 0, n_probs: 10, cache_prompt: true }) });
				if (!response.ok) throw new Error(`http ${response.status}`);
				const text = await response.text();
				if (text.length > 65_536) throw new Error("oversized response");
				const p = yesProbability(JSON.parse(text));
				if (p === undefined) throw new Error("no probabilities");
				const ms = now() - started;
				failures = 0; stats.answered++; stats.totalMs += ms;
				note({ decision: "answered", purpose, durationMs: ms, count: 1 });
				return { ok: true, p, ms };
			} catch {
				const cancelled = signal?.aborted === true, timedOut = !cancelled && controller.signal.aborted;
				if (!cancelled && ++failures >= 3) { pausedUntil = now() + 60_000; failures = 0; }
				stats.failed++;
				note({ decision: cancelled ? "cancelled" : timedOut ? "timeout" : "failed", purpose, durationMs: now() - started, count: 1 });
				return { ok: false, reason: cancelled ? "cancelled" : timedOut ? "timeout" : "failed" };
			} finally {
				clearTimeout(timer); signal?.removeEventListener("abort", abort); release();
			}
		},
	};
}

let shared: ReturnType<typeof createLocalLm> | undefined;
export function localLm() { return shared ??= createLocalLm(); }
export function resetLocalLmForTests(next?: ReturnType<typeof createLocalLm>) { shared = next; }

const RELEVANCE_EXAMPLES = `Decide if a skill guide helps an AI agent with a task. The skill must match the task's actual domain or technology.
Task: Write a REST API in Go with PostgreSQL.
Skill kubernetes-operators: Build Kubernetes operators and CRDs.
Helps: no
Task: Redesign the landing page of a SaaS product.
Skill frontend-design: Coherent browser UI: structure, composition, type, color, motion.
Helps: yes
Task: Fix a memory leak in a Rust CLI.
Skill brand-kit-acme: Acme Corp brand colors and slide templates.
Helps: no
Task: Build an e-commerce site in PHP on shared hosting.
Skill php-app: Secure PHP applications on FPM and cPanel hosting.
Helps: yes
`;
/** Calibrated on real session pairs: 0.88 accuracy at this threshold. */
export const SKILL_RELEVANCE_THRESHOLD = 0.66;
const oneLine = (value: string, max: number) => value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export function skillRelevancePrompt(task: string, skill: { name: string; description: string }): string {
	return `${RELEVANCE_EXAMPLES}Task: ${oneLine(task, 600)}\nSkill ${oneLine(skill.name, 80)}: ${oneLine(skill.description, 320)}\nHelps:`;
}

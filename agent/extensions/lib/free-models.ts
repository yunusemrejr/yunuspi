/**
 * The one owner of free OpenRouter models in a session.
 *
 * OpenRouter lets an account send a fixed number of requests a day to its
 * ":free" models. This module finds out which of them can do real work (a short
 * probe of five checks, then every child that runs on one keeps the score
 * honest), how fast each one answers, and how much of the day's allowance is
 * left. A `legwork` child that can use one is launched on the best of them
 * and falls back to the next, and finally to the role's own model, when a free
 * endpoint is rate limited or down. Everything lives in
 * <agentDir>/free-models.json. A pick is a synchronous read of that file; the
 * network is only touched by the parent session, in the background, through
 * `refreshCatalog`, `refreshQuota` and `runProbes`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireDirectoryLock } from "../../scripts/lib/directory-lock.mjs";
import { agentHealthDir, classifyFailure, type FailureKind } from "../pi-subagents/src/runs/shared/provider-health.ts";
import { splitKnownThinkingSuffix } from "../pi-subagents/src/shared/model-info.ts";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";
const PROVIDER = "openrouter";

export const CATALOG_TTL_MS = 60 * 60_000;
export const QUOTA_TTL_MS = 2 * 60_000;
export const REPROBE_MS = 14 * 24 * 60 * 60_000;
export const MIN_CONTEXT = 64_000;
/** Requests a day the probe may spend, of the account's own allowance. */
export const PROBE_DAILY_REQUESTS = 60;
export const PROBES_PER_START = 3;
/** Free requests are limited to 20 a minute for the whole account: two children at a time. */
export const MAX_FREE_CHILDREN = 2;
/** Requests each running free child may still need; held back from the day's remainder. */
export const RESERVE_PER_CHILD = 30;
export const MIN_REMAINING = 40;
const LEASE_MS = 30 * 60_000;
const BASE_COOLDOWN_MS = 10 * 60_000;
const MAX_COOLDOWN_MS = 2 * 60 * 60_000;
const PROBE_CLAIM_MS = 10 * 60_000;
const SPEED_SAMPLES = 20;
/** Shorter answers measure the request's latency, not the model's speed. */
const MIN_SPEED_TOKENS = 10;
export const IQ_FLOOR = { writes: 70, reads: 50 } as const;
const PICKS = 3;
/** Failure kinds that mean this free endpoint, not the task, is the problem. */
const ENDPOINT_FAILURES: readonly FailureKind[] = ["quota-rate", "provider-outage", "route-failure", "model-failure"];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface PoolEntry {
	id: string;
	context: number;
}

interface ProbeScore {
	at: number;
	passed: number;
	items: number;
	/** The first three checks (tool call, tool result, strict JSON) all passed. */
	gate: boolean;
}

interface ModelStats {
	probe?: ProbeScore;
	/** Children that ran on this model, and how many finished well. */
	runs: number;
	successes: number;
	/** Output tokens per second, newest last. */
	speeds: number[];
	cooldownUntil: number;
	consecutiveFailures: number;
	probingUntil: number;
}

interface Lease {
	route: string;
	pid: number;
	until: number;
}

export interface FreeState {
	version: 1;
	catalog?: { at: number; models: PoolEntry[] };
	quota?: { used: number; limit: number; remaining: number; at: number };
	/** Keyed by route ("openrouter/<id>"). */
	models: Record<string, ModelStats>;
	leases: Lease[];
	probes: { day: string; count: number };
	/** The last refresh that failed, shown by /team until a quota read succeeds. */
	error?: { at: number; message: string };
}

export function freeModelsFile(): string {
	return path.join(agentHealthDir(), "free-models.json");
}

const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);
const routeOf = (id: string): string => `${PROVIDER}/${id}`;

function emptyState(): FreeState {
	return { version: 1, models: Object.create(null), leases: [], probes: { day: "", count: 0 } };
}

function readProbe(value: unknown): ProbeScore | undefined {
	const v = value as Partial<ProbeScore> | null;
	if (!v || typeof v !== "object") return undefined;
	if (!Number.isFinite(v.at) || !Number.isFinite(v.passed) || !Number.isFinite(v.items) || typeof v.gate !== "boolean") return undefined;
	return { at: v.at!, passed: v.passed!, items: v.items!, gate: v.gate };
}

/** Tolerant read: a missing or damaged file reads as no data, so free routing stays off. */
export function readState(): FreeState {
	try {
		const raw = JSON.parse(fs.readFileSync(freeModelsFile(), "utf8"));
		if (!raw || typeof raw !== "object" || raw.version !== 1) return emptyState();
		const state = emptyState();
		if (raw.catalog && Array.isArray(raw.catalog.models)) {
			const models = raw.catalog.models.filter((m: PoolEntry) => m && typeof m.id === "string" && Number.isFinite(m.context));
			state.catalog = { at: num(raw.catalog.at), models: models.map((m: PoolEntry) => ({ id: m.id, context: m.context })) };
		}
		const q = raw.quota;
		if (q && Number.isFinite(q.used) && Number.isFinite(q.limit) && Number.isFinite(q.remaining) && Number.isFinite(q.at)) {
			state.quota = { used: q.used, limit: q.limit, remaining: q.remaining, at: q.at };
		}
		for (const [route, m] of Object.entries<any>(raw.models ?? {})) {
			if (!m || typeof m !== "object") continue;
			state.models[route] = {
				probe: readProbe(m.probe),
				runs: num(m.runs),
				successes: num(m.successes),
				speeds: Array.isArray(m.speeds) ? m.speeds.filter((s: unknown) => typeof s === "number" && Number.isFinite(s) && s > 0).slice(-SPEED_SAMPLES) : [],
				cooldownUntil: num(m.cooldownUntil),
				consecutiveFailures: num(m.consecutiveFailures),
				probingUntil: num(m.probingUntil),
			};
		}
		if (Array.isArray(raw.leases)) {
			state.leases = raw.leases.filter((l: Lease) => l && typeof l.route === "string" && Number.isInteger(l.pid) && Number.isFinite(l.until));
		}
		if (raw.probes && typeof raw.probes.day === "string") state.probes = { day: raw.probes.day, count: num(raw.probes.count) };
		if (raw.error && typeof raw.error.message === "string") state.error = { at: num(raw.error.at), message: raw.error.message };
		return state;
	} catch {
		return emptyState();
	}
}

/** Locked read-modify-write, persisted atomically with mode 0600. */
export function mutateState<T>(mutator: (state: FreeState) => T): T {
	const file = freeModelsFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const release = acquireDirectoryLock(`${file}.lock`, { waitMs: 3_000, label: "free-models state lock" });
	try {
		const state = readState();
		const result = mutator(state);
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
		fs.renameSync(tmp, file);
		return result;
	} finally {
		release();
	}
}

function statsFor(state: FreeState, route: string): ModelStats {
	return (state.models[route] ??= { runs: 0, successes: 0, speeds: [], cooldownUntil: 0, consecutiveFailures: 0, probingUntil: 0 });
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

export function activeLeases(state: FreeState, now: number): Lease[] {
	return state.leases.filter((lease) => lease.until > now && alive(lease.pid));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const baseRoute = (route: string): string => splitKnownThinkingSuffix(route).baseModel;

/** A free OpenRouter model. `openrouter/free` is a router that may pick any model, so it never counts. */
export function isFreeRoute(route: string): boolean {
	const base = baseRoute(route);
	return base.startsWith(`${PROVIDER}/`) && base.endsWith(":free") && !base.startsWith(`${PROVIDER}/${PROVIDER}/`);
}

/** The routes a child may move through when a free model leads its list (at least two, at most eight); none otherwise. */
export function recoveryRoutes(routes: readonly string[] | undefined): string[] {
	const bases = [...new Set((routes ?? []).map(baseRoute))];
	return bases.length >= 2 && bases.length <= 8 && isFreeRoute(bases[0]!) ? bases : [];
}

/** PI_SUBAGENT_RECOVERY_ROUTES of a child: "[]" switches its recovery off. */
export const recoveryRoutesEnv = (routes: readonly string[] | undefined): string => JSON.stringify(recoveryRoutes(routes));

// ---------------------------------------------------------------------------
// Pool, IQ, speed, pick
// ---------------------------------------------------------------------------

/** The free models a session may use, from OpenRouter's public model list. */
export function poolFromCatalog(rows: unknown, now: number): PoolEntry[] {
	if (!Array.isArray(rows)) return [];
	const pool: PoolEntry[] = [];
	for (const row of rows as any[]) {
		const id = row?.id;
		if (typeof id !== "string" || !id.endsWith(":free")) continue;
		const lower = id.toLowerCase();
		if (lower.startsWith(`${PROVIDER}/`) || lower.startsWith("anthropic/") || lower.includes("claude")) continue;
		if (!row.architecture?.output_modalities?.includes?.("text")) continue;
		if (!row.supported_parameters?.includes?.("tools")) continue;
		const context = num(row.context_length);
		if (context < MIN_CONTEXT) continue;
		const ends = [row.expiration_date, row.deprecation?.deprecation_date].filter((value) => value !== undefined && value !== null);
		if (ends.some((value) => !(Date.parse(String(value)) > now))) continue;
		pool.push({ id, context });
	}
	return pool;
}

/** 0 to 100: the share of the probe's checks and of the children's runs that went well. */
export function iqOf(stats: ModelStats | undefined): number | undefined {
	if (!stats?.probe) return undefined;
	return (100 * (stats.probe.passed + stats.successes)) / (stats.probe.items + stats.runs);
}

/** Median output tokens per second over the samples; 0 when there are none. */
export function speedOf(stats: ModelStats | undefined): number {
	const sorted = [...(stats?.speeds ?? [])].sort((a, b) => a - b);
	if (!sorted.length) return 0;
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function cooldownMs(consecutiveFailures: number): number {
	return Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** Math.max(0, consecutiveFailures - 1));
}

/** Whether the day's free allowance has room, with a reserve for the free children already running. */
export function quotaUsable(state: FreeState, now: number): boolean {
	const quota = state.quota;
	if (!quota || utcDay(quota.at) !== utcDay(now)) return false;
	return quota.remaining - RESERVE_PER_CHILD * activeLeases(state, now).length >= MIN_REMAINING;
}

export interface FreePick {
	route: string;
	iq: number;
	speed: number;
	score: number;
}

/** Pool models that passed the gate and are not cooling down. */
function usableModels(state: FreeState, now: number): Omit<FreePick, "score">[] {
	const usable: Omit<FreePick, "score">[] = [];
	for (const { id } of state.catalog?.models ?? []) {
		const route = routeOf(id);
		const stats = state.models[route];
		const iq = iqOf(stats);
		if (iq === undefined || !stats!.probe!.gate || stats!.cooldownUntil > now) continue;
		usable.push({ route, iq, speed: speedOf(stats) });
	}
	return usable;
}

/** A child that can change files needs a stronger model than one that only reads. */
export const agentWritesFiles = (tools: readonly string[] | undefined): boolean =>
	!tools || tools.some((tool) => tool === "edit" || tool === "write" || tool === "apply_patch");

/**
 * The free routes a legwork child may run on, best first (up to three), or none
 * when the quota, the two-children limit or the models' scores leave nothing.
 * score = 0.6 x IQ/100 + 0.4 x speed/(fastest usable model).
 */
export function pickFreeRoutes(input: { writes: boolean; now?: number; state?: FreeState }): FreePick[] {
	const now = input.now ?? Date.now();
	const state = input.state ?? readState();
	if (!quotaUsable(state, now) || activeLeases(state, now).length >= MAX_FREE_CHILDREN) return [];
	const usable = usableModels(state, now);
	const fastest = Math.max(0, ...usable.map((model) => model.speed));
	const floor = input.writes ? IQ_FLOOR.writes : IQ_FLOOR.reads;
	return usable
		.filter((model) => model.iq >= floor)
		.map((model) => ({ ...model, score: 0.6 * (model.iq / 100) + 0.4 * (fastest > 0 ? model.speed / fastest : 0) }))
		.sort((a, b) => b.score - a.score || a.route.localeCompare(b.route))
		.slice(0, PICKS);
}

/** The `/team` line: what the free models can do right now, in plain words. */
export function freeSummary(setting: "on" | "off", now = Date.now(), state = readState()): string {
	if (setting === "off") return "off";
	const { quota } = state;
	const parts = ["on"];
	parts.push(quota && utcDay(quota.at) === utcDay(now) ? `${quota.remaining} of ${quota.limit} left today` : "quota not read yet");
	const usable = usableModels(state, now);
	const measured = Object.values(state.models).some((stats) => stats.probe);
	parts.push(usable.length ? `${usable.length} usable` : measured ? "none usable now" : "no model measured yet");
	const next = pickFreeRoutes({ writes: false, now, state })[0];
	if (next) parts.push(`next: ${next.route.slice(PROVIDER.length + 1)} (IQ ${Math.round(next.iq)}, ${Math.round(next.speed)} tok/s)`);
	if (state.error) parts.push(`last check failed: ${state.error.message}`);
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Outcomes: cooldowns, leases, children's results
// ---------------------------------------------------------------------------

/** Runs inside mutateState. */
function applyFailure(state: FreeState, route: string, now: number): void {
	const stats = statsFor(state, route);
	stats.consecutiveFailures += 1;
	stats.cooldownUntil = now + cooldownMs(stats.consecutiveFailures);
}

function applySuccess(state: FreeState, route: string): void {
	const stats = statsFor(state, route);
	stats.runs += 1;
	stats.successes += 1;
	stats.consecutiveFailures = 0;
	stats.cooldownUntil = 0;
}

/** A rate limit, upstream or provider error on a free model: it rests 10 minutes, doubling per repeat, up to 2 hours. */
export function noteFreeFailure(route: string, now = Date.now()): void {
	mutateState((state) => applyFailure(state, baseRoute(route), now));
}

/** Whether the error text is the endpoint's fault (a limit, an outage, an empty answer) and not the task's. */
export function isEndpointFailure(error: string | undefined | null): boolean {
	const kind = classifyFailure(error)?.kind;
	return kind !== undefined && ENDPOINT_FAILURES.includes(kind);
}

/** Whether a route is free and resting after a failure. */
export function isCoolingDown(route: string, now = Date.now(), state = readState()): boolean {
	return isFreeRoute(route) && (state.models[baseRoute(route)]?.cooldownUntil ?? 0) > now;
}

export interface FreeRun {
	/** The child ended; `model` is the route it ended on. Call once. */
	finish(outcome: { model?: string; ok: boolean; error?: string }): void;
}

/**
 * Held for as long as a child that starts on a free model runs, so that no more
 * than two run at once and the day's remainder is not spent twice. Bookkeeping
 * never changes what a child returns: a state file that cannot be written
 * leaves the child unrecorded.
 */
export function beginFreeRun(routes: readonly string[] | undefined): FreeRun | undefined {
	const first = routes?.[0] ? baseRoute(routes[0]) : undefined;
	if (!first || !isFreeRoute(first)) return undefined;
	const lease: Lease = { route: first, pid: process.pid, until: Date.now() + LEASE_MS };
	try {
		mutateState((state) => {
			state.leases = [...activeLeases(state, Date.now()), lease];
		});
	} catch {
		return undefined;
	}
	let finished = false;
	return {
		finish({ model, ok, error }) {
			if (finished) return;
			finished = true;
			const ended = model ? baseRoute(model) : first;
			const now = Date.now();
			try {
				mutateState((state) => {
					const mine = state.leases.indexOf(state.leases.find((l) => l.route === lease.route && l.pid === lease.pid && l.until === lease.until)!);
					if (mine >= 0) state.leases.splice(mine, 1);
					state.leases = activeLeases(state, now);
					if (!isFreeRoute(ended)) return;
					if (ok) applySuccess(state, ended);
					else if (isEndpointFailure(error)) applyFailure(state, ended, now);
					else statsFor(state, ended).runs += 1;
				});
			} catch {
				/* Quota bookkeeping cannot alter a child's result. */
			}
		},
	};
}

// ---------------------------------------------------------------------------
// OpenRouter: catalog and quota
// ---------------------------------------------------------------------------

type Fetch = typeof fetch;

async function getJson(fetchImpl: Fetch, url: string, key: string | undefined, timeoutMs = 15_000): Promise<any> {
	const response = await fetchImpl(url, {
		headers: key ? { authorization: `Bearer ${key}` } : {},
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`${new URL(url).pathname} answered ${response.status}`);
	return response.json();
}

/** An empty pool is read again with the quota: at a session's start the OpenRouter models may not be registered yet. */
export const catalogStale = (state: FreeState, now: number): boolean =>
	!state.catalog || now - state.catalog.at >= (state.catalog.models.length ? CATALOG_TTL_MS : QUOTA_TTL_MS);
export const quotaStale = (state: FreeState, now: number): boolean => !state.quota || now - state.quota.at >= QUOTA_TTL_MS;

/** The pool: OpenRouter's free models that the session's registry also has. */
export async function refreshCatalog(input: { registered: ReadonlySet<string>; fetchImpl?: Fetch; now?: number }): Promise<void> {
	const now = input.now ?? Date.now();
	const json = await getJson(input.fetchImpl ?? fetch, `${OPENROUTER_API}/models`, undefined);
	const models = poolFromCatalog(json?.data, now).filter((model) => input.registered.has(model.id));
	mutateState((state) => {
		state.catalog = { at: now, models };
	});
}

/** How many of the day's free requests are left, from the account's own counter. */
export async function refreshQuota(input: { key: string; fetchImpl?: Fetch; now?: number }): Promise<void> {
	const now = input.now ?? Date.now();
	const json = await getJson(input.fetchImpl ?? fetch, `${OPENROUTER_API}/key`, input.key);
	const q = json?.data?.free_model_daily_requests;
	if (!q || !Number.isFinite(q.used) || !Number.isFinite(q.limit) || !Number.isFinite(q.remaining)) {
		throw new Error("/key has no free_model_daily_requests counter");
	}
	mutateState((state) => {
		state.quota = { used: q.used, limit: q.limit, remaining: q.remaining, at: now };
		state.error = undefined;
	});
}

export function noteRefreshError(message: string, now = Date.now()): void {
	mutateState((state) => {
		state.error = { at: now, message: message.slice(0, 200) };
	});
}

// ---------------------------------------------------------------------------
// The probe: five checks that measure what a free model can do
// ---------------------------------------------------------------------------

interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: unknown[];
	tool_call_id?: string;
}

interface ProbeItem {
	/** The first three items decide whether a model is ever picked. */
	gate: boolean;
	messages: ChatMessage[];
	tools?: unknown[];
	check(message: { content?: unknown; tool_calls?: any[] }): boolean;
}

const READ_FILE_TOOL = {
	type: "function",
	function: {
		name: "read_file",
		description: "Read a text file and return its content.",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
};
const CONFIG_PATH = "config/service-7.yaml";
const CONFIG_TEXT = "# service-7\ntimeout_ms: 4500\nretries: 3\nold_retries: 9\n";
const text = (message: { content?: unknown }): string => (typeof message.content === "string" ? message.content : "");
/** The reply without a code fence around it. */
const unfenced = (value: string): string => value.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();

/** About 6k tokens of log lines with one line carrying the asked-for error code. */
export function needleLog(): { log: string; timestamp: string } {
	let seed = 20261102;
	const next = (): number => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const decoys = new Map([[40, "E4471"], [90, "E4147"], [170, "E1417"], [200, "E4410"]]);
	const services = ["ingest", "billing", "search", "mailer", "scheduler"];
	const start = Date.parse("2026-11-02T08:00:00Z");
	const lines: string[] = [];
	let timestamp = "";
	let at = start;
	for (let i = 0; i < 230; i++) {
		at += 1000 + Math.floor(next() * 40_000);
		const stamp = new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
		const code = i === 131 ? "E4417" : decoys.get(i) ?? "OK";
		if (i === 131) timestamp = stamp;
		const level = code === "OK" ? "INFO " : "ERROR";
		lines.push(`${stamp} ${level} ${services[Math.floor(next() * services.length)]}[${1000 + Math.floor(next() * 8000)}] job=${Math.floor(next() * 90000)} code=${code} took=${Math.floor(next() * 900)}ms`);
	}
	return { log: lines.join("\n"), timestamp };
}

export function probeItems(): ProbeItem[] {
	const call = { id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: CONFIG_PATH }) } };
	const question = `What is the value of retries in ${CONFIG_PATH}? Read the file with the tool; do not guess.`;
	const { log, timestamp } = needleLog();
	return [
		{
			gate: true,
			messages: [{ role: "user", content: question }],
			tools: [READ_FILE_TOOL],
			check(message) {
				const first = message.tool_calls?.[0]?.function;
				if (first?.name !== "read_file") return false;
				try {
					return JSON.parse(first.arguments).path === CONFIG_PATH;
				} catch {
					return false;
				}
			},
		},
		{
			gate: true,
			messages: [
				{ role: "user", content: `${question} Then answer with the number only.` },
				{ role: "assistant", content: null, tool_calls: [call] },
				{ role: "tool", tool_call_id: "call_1", content: CONFIG_TEXT },
			],
			tools: [READ_FILE_TOOL],
			check: (message) => unfenced(text(message)).replace(/[.\s]/g, "") === "3",
		},
		{
			gate: true,
			messages: [{ role: "user", content: 'Reply with only a JSON object that has exactly the keys "name", "port" and "tags": name is the string alpha, port is the number 8080, tags is the array ["a","b"]. No other text.' }],
			check(message) {
				try {
					const value = JSON.parse(unfenced(text(message)));
					return JSON.stringify(Object.keys(value).sort()) === '["name","port","tags"]' && value.name === "alpha" && value.port === 8080 && JSON.stringify(value.tags) === '["a","b"]';
				} catch {
					return false;
				}
			},
		},
		{
			gate: false,
			messages: [{ role: "user", content: "What exactly does this JavaScript print? Reply with the printed lines only.\n\nconst a = [10, 9, 1, 100];\na.sort();\nconsole.log(a.join(','));\nvar fs = [];\nfor (var i = 0; i < 3; i++) fs.push(() => i);\nconsole.log(fs.map((f) => f()).join(''));" }],
			check: (message) => unfenced(text(message)).split("\n").map((line) => line.trim()).join("|") === "1,10,100,9|333",
		},
		{
			gate: false,
			messages: [{ role: "user", content: `${log}\n\nWhich timestamp has the log line with code=E4417? Reply with that timestamp only.` }],
			check(message) {
				const found = text(message).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g);
				return !!found && found.every((stamp) => stamp === timestamp);
			},
		},
	];
}

export type ProbeOutcome =
	| { unavailable: true; requests: number }
	| { unavailable?: false; passed: number; items: number; gate: boolean; speeds: number[]; requests: number };

/**
 * Five direct chat requests to one free model, at temperature 0 and with room
 * for hidden reasoning. A rate limit, an outage or a timeout is not a failed
 * check: the probe is left for later.
 */
export async function probeModel(input: { id: string; key: string; fetchImpl?: Fetch; timeoutMs?: number }): Promise<ProbeOutcome> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const items = probeItems();
	let passed = 0;
	let gate = true;
	let requests = 0;
	const speeds: number[] = [];
	for (const item of items) {
		const started = performance.now();
		requests += 1;
		let json: any;
		try {
			const response = await fetchImpl(`${OPENROUTER_API}/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${input.key}`, "content-type": "application/json" },
				body: JSON.stringify({ model: input.id, messages: item.messages, ...(item.tools ? { tools: item.tools } : {}), max_tokens: 3000, temperature: 0 }),
				signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
			});
			if (!response.ok) return { unavailable: true, requests };
			json = await response.json();
		} catch {
			return { unavailable: true, requests };
		}
		const message = json?.choices?.[0]?.message;
		if (json?.error || !message) return { unavailable: true, requests };
		const tokens = num(json.usage?.completion_tokens);
		if (tokens >= MIN_SPEED_TOKENS) speeds.push((tokens * 1000) / Math.max(1, performance.now() - started));
		if (item.check(message)) passed += 1;
		else if (item.gate) gate = false;
		if (!gate) break;
	}
	return { passed, items: items.length, gate, speeds, requests };
}

/** Pool models that have never been probed or whose probe is old, never one resting or being probed. */
export function probeCandidates(state: FreeState, now: number): string[] {
	return (state.catalog?.models ?? [])
		.map((model) => routeOf(model.id))
		.filter((route) => {
			const stats = state.models[route];
			return (!stats?.probe || now - stats.probe.at >= REPROBE_MS) && (stats?.cooldownUntil ?? 0) <= now && (stats?.probingUntil ?? 0) <= now;
		});
}

/** Probes up to three models, one at a time, within the day's probe allowance and the account's. */
export async function runProbes(input: { key: string; fetchImpl?: Fetch; now?: number; max?: number; timeoutMs?: number }): Promise<string[]> {
	const probed: string[] = [];
	const items = probeItems().length;
	for (const route of probeCandidates(readState(), input.now ?? Date.now()).slice(0, input.max ?? PROBES_PER_START)) {
		const now = input.now ?? Date.now();
		const claimed = mutateState((state) => {
			const day = utcDay(now);
			if (state.probes.day !== day) state.probes = { day, count: 0 };
			const room = PROBE_DAILY_REQUESTS - state.probes.count >= items && (state.quota?.remaining ?? 0) - items >= MIN_REMAINING;
			const stats = statsFor(state, route);
			if (!room || stats.probingUntil > now) return false;
			stats.probingUntil = now + PROBE_CLAIM_MS;
			return true;
		});
		if (!claimed) break;
		const outcome = await probeModel({ id: route.slice(PROVIDER.length + 1), key: input.key, fetchImpl: input.fetchImpl, timeoutMs: input.timeoutMs });
		mutateState((state) => {
			state.probes.count += outcome.requests;
			const stats = statsFor(state, route);
			stats.probingUntil = 0;
			if (outcome.unavailable) return applyFailure(state, route, now);
			stats.probe = { at: now, passed: outcome.passed, items: outcome.items, gate: outcome.gate };
			stats.speeds = [...stats.speeds, ...outcome.speeds].slice(-SPEED_SAMPLES);
		});
		if (!outcome.unavailable) probed.push(route);
	}
	return probed;
}

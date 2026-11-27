/**
 * How much of the ChatGPT subscription's weekly quota is used, and how much of
 * that one session added.
 *
 * The usage endpoint answers one GET with the account's rate windows. One
 * window lasts a week; a short one may sit beside it. The reading is kept in
 * <agentDir>/codex-usage.json together with each session's first reading (its
 * baseline) and the time of the last attempt to read, so every process on the
 * machine shares one reading and the network is asked at most once a minute,
 * whether the last try worked or not. Judgments (the facts line, the
 * consultant's breaker) read that file synchronously and never wait for the
 * network; only the refresh points call `readCodexUsage`. A reading older than
 * six hours, or from before its window's reset, is unknown, and so is a
 * session baseline taken in an earlier window.
 *
 * Nothing here throws and nothing is shown to the user: a missing credential,
 * a failed request or an unreadable file leaves the figure unknown.
 */
import { VERSION, getAgentDir } from "@yunuspi/coding-agent";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CODEX_PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const STATE_FILE = "codex-usage.json";
/** One deadline for the whole refresh: credential, request and body. */
const TIMEOUT_MS = 4_000;
/** The endpoint is asked at most this often across processes, after a failure too. */
const REFRESH_MS = 60_000;
/** A forced refresh (after a call that spent quota) may come this soon after the last attempt. */
const FORCED_REFRESH_MS = 10_000;
const SESSION_KEEP_MS = 8 * 24 * 60 * 60_000;
const MAX_BODY_BYTES = 65_536;
const WEEK_SECONDS = 604_800;
/** A window counts as the weekly one within a day of a week. */
const WEEK_TOLERANCE_SECONDS = 86_400;
/** Two reset times closer than this are the same window. */
const SAME_WINDOW_MS = 300_000;
/** A reading older than this is not stated as the current quota. */
const STALE_MS = 6 * 60 * 60_000;

export interface CodexUsage {
	/** 0 to 100, share of the weekly window used. */
	weeklyPercent: number;
	/** Epoch milliseconds when the weekly window resets. */
	weeklyResetAt?: number;
	/** 0 to 100, share of the short window when the plan has one. */
	shortPercent?: number;
	limitReached: boolean;
	/** Epoch milliseconds of the reading. */
	at: number;
}

interface SessionBaseline {
	baseline: number;
	at: number;
	/** The reset time of the window the baseline was taken in. */
	resetAt?: number;
}

interface UsageState {
	last?: CodexUsage;
	/** Epoch milliseconds of the last try to read, successful or not. */
	lastAttemptAt?: number;
	sessions: Map<string, SessionBaseline>;
}

export interface CodexCredential {
	access: string;
	accountId: string;
}

export interface CodexUsageOptions {
	/** Resolves the OAuth credential; without one no request is made. */
	credential: () => Promise<CodexCredential | undefined>;
	/** The session whose baseline a first reading sets. */
	sessionId?: string;
	/** After a call that spent quota: ask again sooner than a minute after the last try. */
	force?: boolean;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const percent = (value: number): number => Math.min(100, Math.max(0, value));
const stateFile = (): string => join(getAgentDir(), STATE_FILE);

/**
 * The payload as one reading, or undefined when it holds no weekly window. Only
 * the numbers the figures need are read; anything else is ignored.
 */
export function parseCodexUsage(payload: unknown, at: number): CodexUsage | undefined {
	const limit = (payload as { rate_limit?: Record<string, unknown> } | null | undefined)?.rate_limit;
	if (!limit || typeof limit !== "object") return undefined;
	const windows = [limit.primary_window, limit.secondary_window]
		.map((raw) => raw as Record<string, unknown> | null | undefined)
		.filter((window): window is Record<string, unknown> => !!window && typeof window === "object" && finite(window.used_percent) && finite(window.limit_window_seconds));
	const weekly = windows.find((window) => Math.abs((window.limit_window_seconds as number) - WEEK_SECONDS) <= WEEK_TOLERANCE_SECONDS);
	if (!weekly) return undefined;
	const short = windows.find((window) => window !== weekly);
	const resetAt = finite(weekly.reset_at) ? weekly.reset_at * 1000 : finite(weekly.reset_after_seconds) ? at + weekly.reset_after_seconds * 1000 : undefined;
	return {
		weeklyPercent: percent(weekly.used_percent as number),
		...(resetAt === undefined ? {} : { weeklyResetAt: resetAt }),
		...(short ? { shortPercent: percent(short.used_percent as number) } : {}),
		limitReached: limit.limit_reached === true,
		at,
	};
}

function readState(): UsageState {
	const state: UsageState = { sessions: new Map() };
	try {
		const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as { last?: Record<string, unknown>; lastAttemptAt?: unknown; sessions?: Record<string, unknown> };
		const last = raw?.last;
		if (last && finite(last.weeklyPercent) && finite(last.at)) {
			state.last = {
				weeklyPercent: percent(last.weeklyPercent),
				...(finite(last.weeklyResetAt) ? { weeklyResetAt: last.weeklyResetAt } : {}),
				...(finite(last.shortPercent) ? { shortPercent: percent(last.shortPercent) } : {}),
				limitReached: last.limitReached === true,
				at: last.at,
			};
		}
		if (finite(raw?.lastAttemptAt)) state.lastAttemptAt = raw.lastAttemptAt;
		for (const [id, entry] of Object.entries(raw?.sessions ?? {})) {
			const row = entry as Record<string, unknown> | null;
			if (row && finite(row.baseline) && finite(row.at)) {
				state.sessions.set(id, { baseline: percent(row.baseline), at: row.at, ...(finite(row.resetAt) ? { resetAt: row.resetAt } : {}) });
			}
		}
	} catch {
		/* No file yet, or one that cannot be read: nothing is known. */
	}
	return state;
}

/** Atomic write; a reader sees the old file or the new one, never half. */
function writeState(state: UsageState, now: number): void {
	try {
		const file = stateFile();
		const sessions = [...state.sessions].filter(([, row]) => now - row.at <= SESSION_KEEP_MS);
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		try {
			writeFileSync(temporary, JSON.stringify({ last: state.last, lastAttemptAt: state.lastAttemptAt, sessions: Object.fromEntries(sessions) }), { mode: 0o600 });
			chmodSync(temporary, 0o600);
			renameSync(temporary, file);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	} catch {
		/* The quota figures are advisory; the reading stays in this call's result. */
	}
}

/** Read the file again, change it, write it unless nothing changed: another process may have written since the last read. */
function updateState(now: number, change: (state: UsageState) => boolean | void): void {
	const state = readState();
	if (change(state) !== false) writeState(state, now);
}

const sameWindow = (a: number | undefined, b: number | undefined): boolean => a === undefined || b === undefined || Math.abs(a - b) <= SAME_WINDOW_MS;

/** The reading when it can still stand for the quota now: recent, and its window has not reset since. */
function current(state: UsageState, now: number): CodexUsage | undefined {
	const last = state.last;
	if (!last || now - last.at > STALE_MS || now < last.at) return undefined;
	return last.weeklyResetAt !== undefined && now >= last.weeklyResetAt ? undefined : last;
}

/**
 * A session's first reading is its baseline and is never overwritten, with two
 * exceptions that both mean the quota restarted: the window's reset time moved
 * (a new week), or the reading fell below the baseline. The session then
 * counts from that reading.
 */
function withBaseline(state: UsageState, sessionId: string | undefined, usage: CodexUsage): boolean {
	if (!sessionId) return false;
	const known = state.sessions.get(sessionId);
	if (known && sameWindow(known.resetAt, usage.weeklyResetAt) && usage.weeklyPercent >= known.baseline) return false;
	state.sessions.set(sessionId, {
		baseline: usage.weeklyPercent,
		at: known?.at ?? usage.at,
		...(usage.weeklyResetAt === undefined ? {} : { resetAt: usage.weeklyResetAt }),
	});
	return true;
}

export function noteSessionBaseline(sessionId: string, usage: CodexUsage): void {
	updateState(usage.at, (state) => withBaseline(state, sessionId, usage));
}

/** Points the quota moved since the session's baseline; undefined while the reading, the baseline or their window is unknown. */
function deltaOf(state: UsageState, sessionId: string, now: number): number | undefined {
	const last = current(state, now);
	const known = state.sessions.get(sessionId);
	if (!last || !known || !sameWindow(known.resetAt, last.weeklyResetAt)) return undefined;
	return Math.max(0, last.weeklyPercent - known.baseline);
}

/** Points of the weekly quota this session added since its first reading; undefined while unknown. */
export function codexSessionDelta(sessionId: string, now = Date.now()): number | undefined {
	return deltaOf(readState(), sessionId, now);
}

/**
 * True when the account has no quota left, or the quota moved `points` since
 * the session's baseline (0 or less switches the points check off). An old
 * reading, or one from a window that has reset, is unknown and denies nothing.
 */
export function codexSessionOverBudget(sessionId: string | undefined, points: number, now = Date.now()): boolean {
	const state = readState();
	const last = current(state, now);
	if (!last) return false;
	if (last.limitReached) return true;
	if (!sessionId || !(points > 0)) return false;
	const delta = deltaOf(state, sessionId, now);
	return delta !== undefined && delta >= points;
}

/** The quota as the facts line states it; undefined when no current reading exists. */
export function codexQuotaText(sessionId: string | undefined, now = Date.now()): string | undefined {
	const last = current(readState(), now);
	if (!last) return undefined;
	const delta = sessionId ? codexSessionDelta(sessionId, now) : undefined;
	const added = delta !== undefined && delta >= 1 ? `, this session +${Math.round(delta)}` : "";
	return `GPT quota: ${Math.round(last.weeklyPercent)}% of the week used${added}`;
}

/** The promise's value, or undefined once the signal aborts; the promise itself is left to finish unobserved. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	promise.catch(() => undefined);
	return new Promise((resolve, reject) => {
		if (signal.aborted) return resolve(undefined);
		signal.addEventListener("abort", () => resolve(undefined), { once: true });
		promise.then(resolve, reject);
	});
}

/** The body as text, or undefined once it passes the byte cap; the rest of the stream is not read. */
async function boundedText(response: Response): Promise<string | undefined> {
	const reader = response.body?.getReader?.();
	if (!reader) {
		const text = await response.text();
		return Buffer.byteLength(text) > MAX_BODY_BYTES ? undefined : text;
	}
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return text + decoder.decode();
		bytes += value.byteLength;
		if (bytes > MAX_BODY_BYTES) {
			await reader.cancel().catch(() => undefined);
			return undefined;
		}
		text += decoder.decode(value, { stream: true });
	}
}

/**
 * One GET of the usage endpoint, shared across processes: the file records the
 * last attempt before the request goes out, and a minute must pass after it
 * (ten seconds when forced) whether it worked or not. Credential, request and
 * body share one 4 s deadline and the caller's signal. Returns the fresh or
 * shared reading, or undefined when there is no credential or the request
 * fails.
 */
export async function readCodexUsage(options: CodexUsageOptions): Promise<CodexUsage | undefined> {
	try {
		const now = options.now ?? Date.now;
		const shared = readState();
		const sinceAttempt = shared.lastAttemptAt === undefined ? Infinity : now() - shared.lastAttemptAt;
		if (sinceAttempt >= 0 && sinceAttempt < (options.force ? FORCED_REFRESH_MS : REFRESH_MS)) {
			const reading = current(shared, now());
			if (reading && options.sessionId) noteSessionBaseline(options.sessionId, reading);
			return reading;
		}
		updateState(now(), (state) => { state.lastAttemptAt = now(); });
		const timeout = AbortSignal.timeout(TIMEOUT_MS);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		const credential = await until(options.credential(), signal);
		if (!credential || signal.aborted) return undefined;
		const response = await (options.fetchImpl ?? fetch)(USAGE_URL, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${credential.access}`,
				"chatgpt-account-id": credential.accountId,
				originator: "yunuspi",
				"User-Agent": `pi/${VERSION} (${process.platform}; node/${process.version}; ${process.arch})`,
			},
			signal,
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			return undefined;
		}
		const body = await boundedText(response);
		if (body === undefined) return undefined;
		const usage = parseCodexUsage(JSON.parse(body), now());
		if (!usage) return undefined;
		updateState(usage.at, (state) => {
			state.last = usage;
			withBaseline(state, options.sessionId, usage);
		});
		return usage;
	} catch {
		return undefined;
	}
}

function accountIdOf(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && id.length > 0 && id.length <= 512 && !/[\x00-\x20\x7f]/.test(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

/** An available openai-codex model whose provider the registry says is signed in with OAuth; an API key is not a ChatGPT login. */
function codexModelOf(registry: any): any {
	const model = registry?.getAvailable?.().find((candidate: any) => candidate?.provider === CODEX_PROVIDER);
	return model && registry.isUsingOAuth?.(model) === true ? model : undefined;
}

/**
 * The ChatGPT OAuth credential through the model registry, which refreshes an
 * expired token. Without an OAuth login for openai-codex nothing is returned,
 * whatever an API key looks like, so no other secret reaches the network.
 */
export async function codexCredentialOf(registry: any): Promise<CodexCredential | undefined> {
	try {
		const model = codexModelOf(registry);
		if (!model) return undefined;
		const resolved = await registry.getApiKeyAndHeaders(model);
		const access = resolved?.ok ? resolved.apiKey : undefined;
		if (typeof access !== "string" || !access) return undefined;
		const accountId = accountIdOf(access);
		return accountId ? { access, accountId } : undefined;
	} catch {
		return undefined;
	}
}

const TEAM_MODEL_FIELDS = ["helper", "legwork", "sublegwork", "advisor", "consultant"] as const;

/** True when the session or any team role may run on the ChatGPT subscription. */
export function usesCodex(team: Partial<Record<(typeof TEAM_MODEL_FIELDS)[number], string>>, sessionModel?: { provider?: string }): boolean {
	return sessionModel?.provider === CODEX_PROVIDER || TEAM_MODEL_FIELDS.some((field) => team[field]?.startsWith(`${CODEX_PROVIDER}/`) === true);
}

/** The id of the session a context belongs to; undefined when it has none. */
export function sessionIdOf(ctx: any): string | undefined {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A refresh for one session through its context's registry; a first reading
 * sets the session's baseline. Without an OAuth login for openai-codex nothing
 * is read, not even a shared reading. The registry is taken now, so a context
 * that goes stale while the refresh runs in the background does no harm.
 */
export function readCodexUsageFor(ctx: any, options: Pick<CodexUsageOptions, "force" | "signal"> = {}): Promise<CodexUsage | undefined> {
	try {
		const registry = ctx?.modelRegistry;
		if (!codexModelOf(registry)) return Promise.resolve(undefined);
		return readCodexUsage({ ...options, sessionId: sessionIdOf(ctx), credential: () => codexCredentialOf(registry) });
	} catch {
		return Promise.resolve(undefined);
	}
}

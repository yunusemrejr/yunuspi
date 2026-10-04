import { execFile } from "node:child_process";
import { fetchRemoteUrl, loadFetchContentDomainPolicy, loadSsrfConfig, type Lookup } from "./ssrf-protection.ts";

/**
 * One GitHub REST client for the web-access tools: the repository API view of
 * fetch_content and github_search. It needs no `gh` CLI. Requests are anonymous
 * unless GITHUB_TOKEN/GH_TOKEN is set or an installed `gh` holds a login, in
 * which case its token is read once and reused. A token is only ever sent to
 * api.github.com; every request goes through the shared SSRF-checked fetch.
 */

export const GITHUB_API = "https://api.github.com";
const HOST = "api.github.com";
const MAX_BODY_BYTES = 6_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const TOKEN_TTL_MS = 300_000;
const CACHE_TTL_MS = 60_000;
const CACHE_ENTRIES = 64;

export interface GitHubRateLimit {
	resource?: string;
	limit?: number;
	remaining?: number;
	/** ISO time when the window resets. */
	resetAt?: string;
}

export interface GitHubRestResponse<T = unknown> {
	ok: boolean;
	status: number;
	data?: T;
	/** Raw body for `raw: true` requests. */
	text?: string;
	rate: GitHubRateLimit;
	authenticated: boolean;
	/** API error message, when the response carried one. */
	message?: string;
	/** Set when the request was refused for rate limiting. */
	retryAfterSeconds?: number;
	cached?: boolean;
}

export interface GitHubRestOptions {
	query?: Record<string, string | number | boolean | undefined>;
	/** Return the body as text with the raw media type instead of parsing JSON. */
	raw?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Explicit token; `null` forces an anonymous request. Tests and callers that already hold one. */
	token?: string | null;
	fetch?: typeof fetch;
	lookup?: Lookup;
}

/** Test seam: a deterministic transport so suites need neither network nor DNS. */
export const githubRestTransport: { fetch?: typeof fetch; lookup?: Lookup } = {};

let tokenCache: { value: string | undefined; at: number } | undefined;
const responseCache = new Map<string, { at: number; response: GitHubRestResponse }>();

export function resetGitHubRestState(): void {
	tokenCache = undefined;
	responseCache.clear();
}

function ghAuthToken(signal?: AbortSignal): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("gh", ["auth", "token"], { timeout: 5000, ...(signal ? { signal } : {}) }, (error, stdout) => {
			const token = error ? "" : stdout.trim();
			resolve(token && !/\s/.test(token) ? token : undefined);
		});
	});
}

/** The token a request would carry, or undefined for an anonymous request. */
export async function githubToken(signal?: AbortSignal): Promise<string | undefined> {
	const fromEnv = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
	if (fromEnv) return fromEnv;
	if (tokenCache && Date.now() - tokenCache.at < TOKEN_TTL_MS) return tokenCache.value;
	const value = await ghAuthToken(signal);
	if (!signal?.aborted) tokenCache = { value, at: Date.now() };
	return value;
}

function rateFrom(headers: Headers): GitHubRateLimit {
	const number = (name: string) => {
		const value = Number(headers.get(name));
		return headers.get(name) !== null && Number.isFinite(value) ? value : undefined;
	};
	const reset = number("x-ratelimit-reset");
	const resource = headers.get("x-ratelimit-resource") ?? undefined;
	const limit = number("x-ratelimit-limit"), remaining = number("x-ratelimit-remaining");
	return {
		...(resource ? { resource } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(remaining !== undefined ? { remaining } : {}),
		...(reset !== undefined ? { resetAt: new Date(reset * 1000).toISOString() } : {}),
	};
}

function retryAfter(response: Response, rate: GitHubRateLimit): number | undefined {
	const limited = response.status === 429 || (response.status === 403 && (rate.remaining === 0 || response.headers.has("retry-after")));
	if (!limited) return undefined;
	const raw = response.headers.get("retry-after");
	const header = raw === null || raw.trim() === "" ? NaN : Number(raw);
	if (Number.isFinite(header) && header >= 0) return Math.max(1, Math.ceil(header));
	const reset = rate.resetAt ? Date.parse(rate.resetAt) : NaN;
	return Number.isFinite(reset) ? Math.max(1, Math.ceil((reset - Date.now()) / 1000)) : 60;
}

async function readBounded(response: Response): Promise<string | null> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.length;
			if (bytes > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); return null; }
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

function requestUrl(path: string, query: GitHubRestOptions["query"]): URL {
	if (!path.startsWith("/")) throw new Error("GitHub paths must start with / and target api.github.com");
	const url = new URL(path, GITHUB_API);
	for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
	return url;
}

/** One bounded GET against api.github.com. Never throws for HTTP failures: the
 * status, message and rate-limit state come back so callers can explain them. */
export async function githubRest<T = unknown>(path: string, options: GitHubRestOptions = {}): Promise<GitHubRestResponse<T>> {
	const url = requestUrl(path, options.query);
	if (url.hostname !== HOST) throw new Error("GitHub requests must target api.github.com");
	const token = options.token === undefined ? await githubToken(options.signal) : options.token ?? undefined;
	const authenticated = Boolean(token);
	const cacheKey = `${options.raw ? "raw" : "json"}\0${authenticated ? "auth" : "anon"}\0${url.href}`;
	const hit = responseCache.get(cacheKey);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...(hit.response as GitHubRestResponse<T>), cached: true };

	const headers: Record<string, string> = {
		Accept: options.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
		"User-Agent": "yunuspi-web-access",
		"X-GitHub-Api-Version": "2022-11-28",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
	const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const ssrf = loadSsrfConfig();
	const transportFetch = options.fetch ?? githubRestTransport.fetch, transportLookup = options.lookup ?? githubRestTransport.lookup;
	const response = await fetchRemoteUrl(url, { headers, signal }, {
		allowRanges: ssrf.allowRanges,
		trustEnvProxy: ssrf.trustEnvProxy,
		domainPolicy: loadFetchContentDomainPolicy(),
		signal,
		...(transportFetch ? { fetch: transportFetch } : {}),
		...(transportLookup ? { lookup: transportLookup } : {}),
		// A redirect must never carry the credential to another host.
		onRedirect: ({ to, init }) => {
			if (to.hostname.toLowerCase() === HOST) return init;
			const { Authorization: _drop, ...rest } = (init.headers ?? {}) as Record<string, string>;
			return { ...init, headers: rest };
		},
	});
	const rate = rateFrom(response.headers);
	const body = await readBounded(response);
	const result: GitHubRestResponse<T> = { ok: response.ok && body !== null, status: response.status, rate, authenticated };
	if (body === null) {
		result.message = "GitHub response exceeded the size bound";
		return result;
	}
	if (response.ok) {
		if (options.raw) result.text = body;
		else {
			try { result.data = JSON.parse(body) as T; } catch { result.ok = false; result.message = "GitHub returned a response that is not JSON"; }
		}
	} else {
		try {
			const parsed = JSON.parse(body) as { message?: unknown };
			if (typeof parsed.message === "string") result.message = parsed.message.slice(0, 300);
		} catch { /* The status line is the message. */ }
		const wait = retryAfter(response, rate);
		if (wait !== undefined) result.retryAfterSeconds = wait;
	}
	if (result.ok) {
		responseCache.set(cacheKey, { at: Date.now(), response: result });
		while (responseCache.size > CACHE_ENTRIES) responseCache.delete(responseCache.keys().next().value!);
	}
	return result;
}

/** Percent-encode each segment of a repository-relative path, keeping slashes. */
export function encodeRepoPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

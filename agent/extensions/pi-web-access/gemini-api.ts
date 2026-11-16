import { existsSync, readFileSync } from "node:fs";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { getWebSearchConfigPath } from "./utils.ts";
import { startWebUsage, type WebUsageOptions } from "./web-usage.ts";
import {
	isGeminiAdcAvailable,
	getAdcAccessToken,
	getAdcProject,
	getAdcLocation,
	getVertexApiBase,
	isVertexHost,
} from "./gemini-adc.ts";

const DEFAULT_API_HOST = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";
export const API_BASE = `${DEFAULT_API_HOST}/${API_VERSION}`;
const CONFIG_PATH = getWebSearchConfigPath();
export const DEFAULT_MODEL = "gemini-3.6-flash";

interface GeminiApiConfig {
	geminiApiKey?: unknown;
	geminiBaseUrl?: unknown;
	cloudflareApiKey?: unknown;
}

let cachedConfig: GeminiApiConfig | null = null;

function loadConfig(): GeminiApiConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as GeminiApiConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeBaseUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().replace(/\/+$/, "");
	return normalized.length > 0 ? normalized : null;
}

function isCloudflareGateway(): boolean {
	return getApiHost().includes("gateway.ai.cloudflare.com");
}

export async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Gemini",
		configuredValue: loadConfig().geminiApiKey,
		environmentValue: process.env.GEMINI_API_KEY,
		signal,
	});
}

export function getApiHost(): string {
	return (
		normalizeBaseUrl(process.env.GOOGLE_GEMINI_BASE_URL) ??
		normalizeBaseUrl(loadConfig().geminiBaseUrl) ??
		DEFAULT_API_HOST
	);
}

export function getVersionedApiBase(): string {
	const project = getAdcProject();
	const location = getAdcLocation();
	if (isGeminiAdcAvailable() && project && location) {
		return getVertexApiBase(project, location);
	}
	return `${getApiHost()}/${API_VERSION}`;
}

export function getUploadBase(): string {
	return `${getApiHost()}/upload/${API_VERSION}`;
}

function getLegacyCloudflareApiKey(): string | null {
	return normalizeApiKey(process.env.CLOUDFLARE_API_KEY) ?? normalizeApiKey(loadConfig().cloudflareApiKey);
}

async function resolveCloudflareApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Cloudflare",
		configuredValue: loadConfig().cloudflareApiKey,
		environmentValue: process.env.CLOUDFLARE_API_KEY,
		signal,
	});
}

export function getCloudflareApiKey(): string | null {
	return getLegacyCloudflareApiKey();
}

export function isGatewayConfigured(): boolean {
	return isCloudflareGateway() && hasCredentialSource({
		provider: "Cloudflare",
		configuredValue: loadConfig().cloudflareApiKey,
		environmentValue: process.env.CLOUDFLARE_API_KEY,
	});
}

export function buildAuthHeaders(apiKey: string | null = null, cloudflareApiKey: string | null = getLegacyCloudflareApiKey()): Record<string, string> {
	if (!isCloudflareGateway()) return apiKey ? { "x-goog-api-key": apiKey } : {};
	return cloudflareApiKey ? { "cf-aig-authorization": `Bearer ${cloudflareApiKey}` } : {};
}

function redactGeminiCredentials(text: string, apiKey: string | null | undefined, cloudflareApiKey: string | null | undefined, adcToken?: string | null): string {
	let out = redactCredential(redactCredential(text, apiKey), cloudflareApiKey);
	if (adcToken) out = redactCredential(out, adcToken);
	return out;
}

const responseCredentials = new WeakMap<Response, {
	apiKey: string | null | undefined;
	cloudflareApiKey: string | null | undefined;
	adcToken?: string | null;
}>();

export function redactGeminiApiResponse(response: Response, text: string, apiKey?: string | null, adcToken?: string | null): string {
	const credentials = responseCredentials.get(response);
	return redactGeminiCredentials(text, credentials?.apiKey ?? apiKey, credentials?.cloudflareApiKey, credentials?.adcToken ?? adcToken);
}

export async function fetchGeminiApi(
	url: string | URL,
	init: RequestInit = {},
	apiKey?: string | null,
	onDispatch?: (provider: string) => void,
): Promise<Response> {
	const parsedUrl = new URL(url);
	for (const name of parsedUrl.searchParams.keys()) {
		if (["key", "api_key"].includes(name.toLowerCase())) {
			throw new Error("Gemini API credential query parameters are not allowed");
		}
	}
	const project = getAdcProject();
	const location = getAdcLocation();
	const adcMode = isGeminiAdcAvailable() && !!project && !!location && isVertexHost(parsedUrl.origin);
	let adcToken: string | null = null;
	if (adcMode) {
		adcToken = await getAdcAccessToken(init.signal ?? undefined);
	}
	const resolvedApiKey = adcMode ? null : (apiKey === undefined ? await getApiKey(init.signal ?? undefined) : apiKey);
	const cloudflareApiKey = isCloudflareGateway() ? await resolveCloudflareApiKey(init.signal ?? undefined) : null;
	const allowedOrigins = new Set([
		new URL(getApiHost()).origin,
		new URL(DEFAULT_API_HOST).origin,
		...(adcMode ? [parsedUrl.origin] : []),
	]);
	const needsAuth = resolvedApiKey || isGatewayConfigured() || adcMode;
	if (needsAuth && !allowedOrigins.has(parsedUrl.origin)) {
		throw new Error("Gemini API request host is not allowed");
	}
	const headers = new Headers(init.headers);
	headers.delete("x-goog-api-key");
	headers.delete("cf-aig-authorization");
	headers.delete("authorization");
	if (adcMode && adcToken) {
		headers.set("Authorization", `Bearer ${adcToken}`);
	} else {
		for (const [name, value] of Object.entries(buildAuthHeaders(resolvedApiKey, cloudflareApiKey))) {
			headers.set(name, value);
		}
	}
	try {
		init.signal?.throwIfAborted();
		onDispatch?.(adcMode ? "google-vertex"
			: parsedUrl.hostname === "gateway.ai.cloudflare.com" ? "cloudflare-ai-gateway"
			: parsedUrl.origin === DEFAULT_API_HOST ? "google"
			: "gemini-gateway");
		// Fetch strips Authorization across origins but forwards custom key
		// headers. A resumable upload URL is a separate, validated request.
		const response = await fetch(parsedUrl, { ...init, headers, redirect: needsAuth ? "error" : init.redirect });
		responseCredentials.set(response, { apiKey: resolvedApiKey, cloudflareApiKey, adcToken });
		return response;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const redactedMessage = redactGeminiCredentials(message, resolvedApiKey, cloudflareApiKey, adcToken);
		if (redactedMessage === message) throw error;
		const redactedError = new Error(redactedMessage);
		if (error instanceof Error) redactedError.name = error.name;
		throw redactedError;
	}
}

function hasGeminiApiKeySource(): boolean {
	return hasCredentialSource({
		provider: "Gemini",
		configuredValue: loadConfig().geminiApiKey,
		environmentValue: process.env.GEMINI_API_KEY,
	});
}

export function isGeminiApiAvailable(): boolean {
	return isGeminiAdcAvailable() || hasGeminiApiKeySource() || isGatewayConfigured();
}

/**
 * Whether the Gemini Files-API paths (YouTube and local video analysis) can
 * authenticate. These use the Gemini Files API and metadata endpoints, which do
 * not support ADC, so they still require an API key or a Cloudflare gateway.
 */
export function isGeminiApiAvailableWithVideo(): boolean {
	return hasGeminiApiKeySource() || isGatewayConfigured();
}

export interface GeminiApiOptions extends WebUsageOptions {
	apiKey?: string;
	model?: string;
	mimeType?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface GeminiGenerateContentResult {
	text: string;
	finishReason?: string;
	blockReason?: string;
}

interface GeminiUsageResponse {
	usageMetadata?: {
		promptTokenCount?: unknown;
		cachedContentTokenCount?: unknown;
		candidatesTokenCount?: unknown;
		thoughtsTokenCount?: unknown;
		toolUsePromptTokenCount?: unknown;
	};
}

function geminiTokenUsage(metadata: GeminiUsageResponse["usageMetadata"]) {
	const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	const prompt = count(metadata?.promptTokenCount);
	const cached = count(metadata?.cachedContentTokenCount);
	const candidates = count(metadata?.candidatesTokenCount);
	const reasoning = count(metadata?.thoughtsTokenCount);
	const toolInput = count(metadata?.toolUsePromptTokenCount);
	const cacheRead = cached !== undefined && (prompt === undefined || cached <= prompt) ? cached : undefined;
	return {
		// Tool results are fed back as additional input. Cached prompt tokens
		// and thinking tokens each appear once in their respective totals.
		...(prompt !== undefined || toolInput !== undefined ? { input: (prompt ?? 0) - (prompt === undefined ? 0 : cacheRead ?? 0) + (toolInput ?? 0) } : {}),
		...(cacheRead !== undefined ? { cacheRead } : {}),
		...(candidates !== undefined || reasoning !== undefined ? { output: (candidates ?? 0) + (reasoning ?? 0) } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
	};
}

export async function fetchGeminiContent<T>(
	model: string,
	body: Record<string, unknown>,
	signal: AbortSignal,
	apiKey: string | null,
	options: WebUsageOptions,
): Promise<{ response: Response; data?: T }> {
	let finishUsage: ReturnType<typeof startWebUsage> | undefined;
	try {
		const response = await fetchGeminiApi(`${getVersionedApiBase()}/models/${model}:generateContent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		}, apiKey, provider => { finishUsage = startWebUsage(options, provider, model); });
		if (!response.ok) {
			finishUsage?.("failed");
			return { response };
		}
		const data = await response.json() as T & GeminiUsageResponse;
		// Free tiers, ADC billing and gateway terms depend on the account.
		// GenerateContent has token counts but no per-request dollar receipt.
		finishUsage?.("completed", geminiTokenUsage(data?.usageMetadata));
		return { response, data };
	} catch (error) {
		finishUsage?.(signal.reason?.name === "TimeoutError" ? "timeout" : signal.aborted ? "cancelled" : "failed");
		throw error;
	}
}

export async function queryGeminiApiWithInlineData(
	prompt: string,
	data: string,
	mimeType: string,
	options: GeminiApiOptions = {},
): Promise<GeminiGenerateContentResult> {
	const signal = withTimeout(options.signal, options.timeoutMs ?? 120000);
	const apiKey = isGeminiAdcAvailable() ? null : (options.apiKey ?? await getApiKey(signal));
	if (!apiKey && !isGatewayConfigured() && !isGeminiAdcAvailable()) {
		throw new Error(
			"Gemini API not configured. Either:\n" +
			`  1. Configure geminiApiKey in ${CONFIG_PATH} or set GEMINI_API_KEY\n` +
			"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
			"  3. Set geminiAuth to \"adc\" with a Google Cloud ADC (GOOGLE_APPLICATION_CREDENTIALS) + project/location"
		);
	}

	const model = options.model ?? DEFAULT_MODEL;
	const body = {
		contents: [
			{
				role: "user",
				parts: [
					{ inlineData: { mimeType, data } },
					{ text: prompt },
				],
			},
		],
	};

	const { response: res, data: response } = await fetchGeminiContent<GenerateContentResponse>(model, body, signal, apiKey, options);
	if (!res.ok) {
		const errorText = redactGeminiApiResponse(res, await res.text(), apiKey);
		throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
	}

	const candidate = response?.candidates?.[0];
	const text = candidate?.content?.parts
		?.map((part) => part.text)
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join("\n") ?? "";

	return {
		text,
		...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}),
		...(response?.promptFeedback?.blockReason ? { blockReason: response.promptFeedback.blockReason } : {}),
	};
}

export async function queryGeminiApiWithVideo(
	prompt: string,
	videoUri: string,
	options: GeminiApiOptions = {},
): Promise<string> {
	const signal = withTimeout(options.signal, options.timeoutMs ?? 120000);
	const apiKey = options.apiKey ?? await getApiKey(signal);
	if (!apiKey && !isGatewayConfigured()) {
		throw new Error(
			"Gemini API not configured. Either:\n" +
			`  1. Configure geminiApiKey in ${CONFIG_PATH} or set GEMINI_API_KEY\n` +
			"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing"
		);
	}

	const model = options.model ?? DEFAULT_MODEL;

	const fileData: Record<string, string> = { fileUri: videoUri };
	if (options.mimeType) fileData.mimeType = options.mimeType;

	const body = {
		contents: [
			{
				role: "user",
				parts: [
					{ fileData },
					{ text: prompt },
				],
			},
		],
	};

	const { response: res, data } = await fetchGeminiContent<GenerateContentResponse>(model, body, signal, apiKey, options);
	if (!res.ok) {
		const errorText = redactGeminiApiResponse(res, await res.text(), apiKey);
		throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
	}

	const text = data?.candidates?.[0]?.content?.parts
		?.map((p) => p.text)
		.filter(Boolean)
		.join("\n");

	if (!text) throw new Error("Gemini API returned empty response");
	return text;
}

interface GenerateContentResponse extends GeminiUsageResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{ text?: string }>;
		};
		finishReason?: string;
	}>;
	promptFeedback?: {
		blockReason?: string;
	};
}

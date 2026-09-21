import { VERSION } from "../config.js";
import { fetchWithRetry } from "../utils/management-http.js";
import { getPiUserAgent } from "../utils/pi-user-agent.js";
const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
const REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
function mergeModels(baseline, dynamic) {
    const merged = [...baseline];
    for (const model of dynamic) {
        const index = merged.findIndex((entry) => entry.id === model.id);
        if (index >= 0)
            merged[index] = model;
        else
            merged.push(model);
    }
    return merged;
}
// Validate network and disk at the same boundary. Additive catalog fields survive;
// malformed rows cannot replace working built-ins or poison the next session.
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveLimit = value => Number.isSafeInteger(value) && value > 0;
// Providers whose built-in catalogs intentionally ship an empty baseUrl because
// the endpoint comes from user config (e.g. an Azure resource URL). Their
// remote rows may carry "" too; every other provider must ship http(s).
const EMPTY_BASE_URL_PROVIDERS = new Set(["azure-openai-responses"]);
function validCatalogModel(model, providerId) {
    if (!isRecord(model) || typeof model.id !== "string" || !model.id.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(model.id) ||
        typeof model.name !== "string" || typeof model.api !== "string" || !model.api || typeof model.baseUrl !== "string" ||
        typeof model.reasoning !== "boolean" || !Array.isArray(model.input) || !model.input.length ||
        !model.input.every(value => typeof value === "string") || !positiveLimit(model.contextWindow) || !positiveLimit(model.maxTokens) ||
        !isRecord(model.cost) || !["input", "output", "cacheRead", "cacheWrite"].every(key => Number.isFinite(model.cost[key]) && model.cost[key] >= 0)) return false;
    if (model.thinkingLevelMap !== undefined && (!isRecord(model.thinkingLevelMap) ||
        !Object.values(model.thinkingLevelMap).every(value => value === null || typeof value === "string" && value.length > 0))) return false;
    if (model.cost.tiers !== undefined && (!Array.isArray(model.cost.tiers) || !model.cost.tiers.every(tier =>
        isRecord(tier) && Number.isFinite(tier.inputTokensAbove) && tier.inputTokensAbove >= 0 &&
        ["input", "output", "cacheRead", "cacheWrite"].every(key => tier[key] === undefined || Number.isFinite(tier[key]) && tier[key] >= 0)))) return false;
    if (model.cost.missing !== undefined && (!Array.isArray(model.cost.missing) || !model.cost.missing.every(key => typeof key === "string"))) return false;
    if (model.compat !== undefined && (!isRecord(model.compat) || !Object.entries(model.compat).every(([key, value]) =>
        !/^(supports|requires|sendSession)/.test(key) || typeof value === "boolean"))) return false;
    if (model.samplingParams !== undefined && !isRecord(model.samplingParams)) return false;
    if (model.baseUrl === "" && EMPTY_BASE_URL_PROVIDERS.has(providerId)) return true;
    try { if (!["https:", "http:"].includes(new URL(model.baseUrl).protocol)) return false; } catch { return false; }
    return true;
}
function parseCatalog(providerId, value, strict = true) {
    const entries = Array.isArray(value) ? value
        : isRecord(value) && Array.isArray(value.models) ? value.models
        : isRecord(value) ? Object.values(value) : [];
    const models = new Map();
    for (const model of entries) {
        if (validCatalogModel(model, providerId) && !models.has(model.id))
            models.set(model.id, { ...model, provider: providerId, maxTokens: Math.min(model.maxTokens, model.contextWindow) });
    }
    if (strict && models.size === 0) throw new Error(`Invalid or empty model catalog for provider "${providerId}"`);
    return [...models.values()];
}
function remoteModels(entry, localGeneratedAt) {
    if (!entry)
        return [];
    const freshness = entry.lastModified ?? entry.validatedAt;
    if (localGeneratedAt !== undefined && (freshness === undefined || freshness <= localGeneratedAt)) {
        return [];
    }
    return entry.models;
}
/** Add a persisted pi.dev catalog overlay to a static built-in provider. */
export function withRemoteCatalog(provider, catalogBaseUrl = DEFAULT_CATALOG_BASE_URL, localGeneratedAt) {
    let dynamicModels = [];
    return {
        ...provider,
        getModels: () => mergeModels(provider.getModels(), dynamicModels),
        refreshModels: async (context) => {
            const stored = context.stored;
            const restored = parseCatalog(provider.id, remoteModels(stored, localGeneratedAt), false);
            if (!(await context.publish({
                update: () => {
                    dynamicModels = restored;
                },
            }))) {
                return;
            }
            if (!context.allowNetwork || context.signal.aborted)
                return;
            if (!context.force &&
                stored?.checkedAt !== undefined &&
                (stored.lastModified !== undefined || stored.validatedAt !== undefined) &&
                Date.now() >= stored.checkedAt &&
                Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS &&
                restored.length > 0) {
                return;
            }
            // Only revalidate when a cached body backs the validator, so a 304 can never
            // leave the overlay empty.
            const validator = restored.length ? stored?.etag : undefined;
            const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
            const response = await fetchWithRetry(url, {
                headers: {
                    accept: "application/json",
                    "User-Agent": getPiUserAgent(VERSION),
                    ...(validator ? { "if-none-match": validator } : {}),
                },
                signal: context.signal,
            }, { attemptTimeoutMs: REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS });
            if (context.signal.aborted)
                return;
            const checkedAt = Date.now();
            // Unchanged: dynamicModels already holds the stored overlay, so only the
            // freshness window moves.
            if (response.status === 304 && stored) {
                await context.publish({ persist: { ...stored, checkedAt } });
                return;
            }
            if (response.status === 404 || response.status === 501) {
                await context.publish({
                    persist: {
                        ...(stored ?? { models: [] }),
                        checkedAt,
                        lastModified: 0,
                        validatedAt: undefined,
                        etag: undefined,
                    },
                });
                return;
            }
            if (!response.ok) {
                // Transient failure: the cached body and its validator stay valid, so keep the
                // etag and let the next refresh revalidate instead of downloading the catalog.
                await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt } });
                throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
            }
            const refreshed = parseCatalog(provider.id, await response.json());
            const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
            if (context.signal.aborted)
                return;
            const entry = {
                models: refreshed,
                checkedAt,
                lastModified: Number.isNaN(lastModified) ? undefined : lastModified,
                validatedAt: Number.isNaN(lastModified)
                    ? Math.max(checkedAt, (localGeneratedAt ?? 0) + 1)
                    : undefined,
                etag: response.headers.get("etag") ?? undefined,
            };
            const published = remoteModels(entry, localGeneratedAt);
            await context.publish({
                persist: entry,
                update: () => {
                    dynamicModels = published;
                },
            });
        },
    };
}

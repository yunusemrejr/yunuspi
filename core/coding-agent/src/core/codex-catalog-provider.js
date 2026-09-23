import { createHash } from "node:crypto";
import { VERSION } from "../config.js";
import { getPiUserAgent } from "../utils/pi-user-agent.js";

const BASE_URL = "https://chatgpt.com/backend-api";
// Catalog protocol version, independent of this client's product version.
const CATALOG_URL = `${BASE_URL}/codex/models?client_version=0.155.0`;
const CATALOG_SOURCE = "openai-codex-account-v1";
const TTL_MS = 15 * 60_000;
const MAX_BODY_BYTES = 1_048_576;
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const positive = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);

function identity(credential) {
    if (credential?.type !== "oauth" || typeof credential.access !== "string" || !credential.access)
        return undefined;
    let accountId = credential.accountId;
    if (!accountId) {
        try { accountId = JSON.parse(Buffer.from(credential.access.split(".")[1], "base64url").toString())["https://api.openai.com/auth"]?.chatgpt_account_id; }
        catch { return undefined; }
    }
    if (typeof accountId !== "string" || !accountId || accountId.length > 512 || /[\x00-\x20\x7f]/.test(accountId))
        return undefined;
    return { accountId, scope: createHash("sha256").update(`${CATALOG_SOURCE}\0${accountId}`).digest("hex") };
}

function cachedModels(entry, scope) {
    if (!scope || entry?.catalogSource !== CATALOG_SOURCE || entry.credentialScope !== scope ||
        !positive(entry.validatedAt) || !Array.isArray(entry.models)) return undefined;
    const rows = entry.models.filter(model => model?.provider === "openai-codex" && model.api === "openai-codex-responses" &&
        model.baseUrl === BASE_URL && identifier(model.id) && typeof model.name === "string" &&
        typeof model.reasoning === "boolean" && positive(model.contextWindow) && positive(model.maxTokens) && model.maxTokens <= model.contextWindow &&
        Array.isArray(model.input) && model.input.length > 0 && model.input.every(value => value === "text" || value === "image") &&
        model.cost && ["input", "output", "cacheRead", "cacheWrite"].every(key => Number.isFinite(model.cost[key]) && model.cost[key] >= 0) &&
        (!model.thinkingLevelMap || typeof model.thinkingLevelMap === "object" && Object.values(model.thinkingLevelMap).every(value => value === null || typeof value === "string")));
    return rows.length ? rows : undefined;
}

function parseModels(payload, baseline) {
    if (!Array.isArray(payload?.models)) throw new Error("Invalid OpenAI Codex model catalog");
    const byId = new Map(baseline.map(model => [model.id, model]));
    const rows = new Map();
    for (const row of payload.models.slice(0, 512)) {
        if (!identifier(row?.slug) || row.visibility !== "list" || row.supported_in_api === false || !positive(row.context_window)) continue;
        const input = [...new Set((Array.isArray(row.input_modalities) ? row.input_modalities : []).filter(value => value === "text" || value === "image"))];
        const efforts = [...new Set((Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels : []).map(value => value?.effort).filter(value => levels.includes(value) && value !== "off"))];
        if (!input.length) continue;
        const previous = byId.get(row.slug);
        const outputKnown = positive(row.max_output_tokens) || previous && !previous.outputLimitEstimated;
        // The discovery API does not usually publish output limits or prices.
        // New IDs get a conservative client allowance, never invented facts.
        const maxTokens = Math.min(row.context_window, positive(row.max_output_tokens) ? row.max_output_tokens : previous?.maxTokens ?? 16_384);
        rows.set(row.slug, {
            ...(previous ?? {}), id: row.slug,
            name: typeof row.display_name === "string" && row.display_name.length <= 200 ? row.display_name : row.slug,
            provider: "openai-codex", api: "openai-codex-responses", baseUrl: BASE_URL,
            contextWindow: row.context_window, maxTokens, outputLimitEstimated: !outputKnown,
            input, reasoning: efforts.length > 0,
            thinkingLevelMap: Object.fromEntries(levels.map(level => [level, efforts.includes(level) ? level : null])),
            cost: previous?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, missing: ["input", "output", "cacheRead", "cacheWrite"] },
        });
    }
    if (!rows.size) throw new Error("Invalid or empty OpenAI Codex model catalog");
    return [...rows.values()];
}

async function readCatalog(response) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty OpenAI Codex model catalog");
    const chunks = []; let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_BODY_BYTES) throw new Error("OpenAI Codex model catalog exceeds size limit");
            chunks.push(Buffer.from(value));
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => {}); }
}

/** Discover visible models from the configured Codex account, without inference. */
export function withOpenAICodexCatalog(provider) {
    let dynamic;
    return {
        ...provider,
        getModels: () => dynamic ?? provider.getModels(),
        refreshModels: async context => {
            const owner = identity(context.credential);
            const restored = cachedModels(context.stored, owner?.scope);
            if (!await context.publish({ update: () => { dynamic = restored; } })) return;
            if (!context.allowNetwork || context.signal.aborted || !owner) return;
            const stored = restored ? context.stored : undefined;
            const now = Date.now();
            if (!context.force && positive(stored?.checkedAt) && now >= stored.checkedAt && now - stored.checkedAt < TTL_MS) return;
            const signal = AbortSignal.any([context.signal, AbortSignal.timeout(4_000)]);
            const response = await fetch(CATALOG_URL, {
                signal, redirect: "error",
                headers: {
                    accept: "application/json", authorization: `Bearer ${context.credential.access}`,
                    "chatgpt-account-id": owner.accountId, originator: "yunuspi", "User-Agent": getPiUserAgent(VERSION),
                    ...(typeof stored?.etag === "string" && stored.etag.length <= 512 ? { "if-none-match": stored.etag } : {}),
                },
            });
            context.signal.throwIfAborted();
            const checkedAt = Date.now();
            if (response.status === 304 && stored) {
                await context.publish({ persist: { ...stored, checkedAt } });
                return;
            }
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                throw new Error(`OpenAI Codex model catalog request failed: ${response.status}`);
            }
            const models = parseModels(await readCatalog(response), provider.getModels());
            context.signal.throwIfAborted();
            await context.publish({
                persist: { models, catalogSource: CATALOG_SOURCE, credentialScope: owner.scope, checkedAt, validatedAt: checkedAt, etag: response.headers.get("etag") ?? undefined },
                update: () => { dynamic = models; },
            });
        },
    };
}

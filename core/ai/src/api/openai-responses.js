import OpenAI from "openai";
import { clampThinkingLevel } from "../models.js";
import { splitDeferredTools } from "../utils/deferred-tools.js";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { getPiUserAgent } from "../utils/pi-user-agent.js";
import { getProviderEnvValue } from "../utils/provider-env.js";
import { retryProviderRequest } from "../utils/provider-retry.js";
import { createGrammarToolInputProperties } from "./constrained-sampling.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { clampOpenAIPromptCacheKey, isOpenAIEndpoint } from "./openai-prompt-cache.js";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";
const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
function hasHeader(headers, name) {
    if (!headers)
        return false;
    const expected = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === expected && value !== null && value.trim().length > 0)
            return true;
    }
    return false;
}
function getClientApiKey(provider, apiKey, headers) {
    if (apiKey)
        return apiKey;
    if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization"))
        return "unused";
    throw new Error(`No API key for provider: ${provider}`);
}
function detectSessionAffinityFormat(model) {
    return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}
/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention, env) {
    if (cacheRetention) {
        return cacheRetention;
    }
    if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
        return "long";
    }
    return "short";
}
function getCompat(model) {
    return {
        supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
        sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
        supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? isOpenAIEndpoint(model.baseUrl),
        supportsStrictMode: model.compat?.supportsStrictMode ?? false,
        supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
        supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
        supportsToolSearch: model.compat?.supportsToolSearch ?? false,
        supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
        supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
    };
}
function getPromptCacheRetention(compat, cacheRetention) {
    return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
        ? "24h"
        : undefined;
}
function getPromptCacheOptions(compat, cacheRetention) {
    if (!compat.supportsExplicitPromptCacheMode)
        return undefined;
    if (cacheRetention === "none")
        return { mode: "explicit" };
    if (cacheRetention === "long" && compat.supportsLongCacheRetention)
        return { ttl: "30m" };
    return undefined;
}
function formatOpenAIResponsesError(error) {
    return formatProviderError(normalizeProviderError(error), "OpenAI API error");
}
/**
 * Generate function for OpenAI Responses API
 */
export const stream = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    // Start async processing
    (async () => {
        const output = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "pending",
            timestamp: Date.now(),
        };
        try {
            // Create OpenAI client
            const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
            const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
            const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
            const compat = getCompat(model);
            const grammarToolInputProperties = createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools);
            const client = createClient(model, context, apiKey, options?.headers, options?.fetch, cacheSessionId);
            let params = buildParams(model, context, options, compat, grammarToolInputProperties);
            const nextParams = await options?.onPayload?.(params, model);
            if (nextParams !== undefined) {
                params = nextParams;
            }
            const requestOptions = {
                ...(options?.signal ? { signal: options.signal } : {}),
                ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
                maxRetries: 0,
            };
            const { data: openaiStream, response } = await retryProviderRequest(() => client.responses.create(params, requestOptions).withResponse(), {
                maxRetries: options?.maxRetries,
                maxRetryDelayMs: options?.maxRetryDelayMs,
                signal: options?.signal,
            });
            await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
            stream.push({ type: "start", partial: output });
            await processResponsesStream(openaiStream, output, stream, model, {
                serviceTier: options?.serviceTier,
                grammarToolInputProperties,
                applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
            });
            if (options?.signal?.aborted) {
                throw new Error("Request was aborted");
            }
            if (output.stopReason === "pending") {
                throw new Error("OpenAI Responses stream ended without a stop reason");
            }
            if (output.stopReason === "aborted" || output.stopReason === "error") {
                throw new Error(output.errorMessage || "An unknown error occurred");
            }
            stream.push({ type: "done", reason: output.stopReason, message: output });
            stream.end();
        }
        catch (error) {
            for (const block of output.content) {
                delete block.index;
                // Streaming scratch buffers are only used during parsing; never persist them.
                delete block.partialJson;
                delete block.customInput;
            }
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage = formatOpenAIResponsesError(error);
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
    })();
    return stream;
};
export const streamSimple = (model, context, options) => {
    getClientApiKey(model.provider, options?.apiKey, options?.headers);
    const base = {
        ...buildBaseOptions(model, context, options, options?.apiKey),
        toolChoice: options?.toolChoice,
    };
    const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
    const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
    return stream(model, context, {
        ...base,
        reasoningEffort,
    });
};
function createClient(model, context, apiKey, optionsHeaders, fetch, sessionId) {
    const compat = getCompat(model);
    const headers = { "User-Agent": getPiUserAgent(), ...model.headers };
    if (model.provider === "github-copilot") {
        const hasImages = hasCopilotVisionInput(context.messages);
        const copilotHeaders = buildCopilotDynamicHeaders({
            messages: context.messages,
            hasImages,
        });
        Object.assign(headers, copilotHeaders);
    }
    if (sessionId) {
        if (compat.sessionAffinityFormat === "openrouter") {
            headers["x-session-id"] = sessionId;
        }
        else {
            if (compat.sessionAffinityFormat === "openai") {
                headers.session_id = sessionId;
            }
            headers["x-client-request-id"] = sessionId;
        }
    }
    // Merge options headers last so they can override defaults
    if (optionsHeaders) {
        Object.assign(headers, optionsHeaders);
    }
    return new OpenAI({
        apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
        fetch,
        defaultHeaders: headers,
    });
}
function buildParams(model, context, options, compat = getCompat(model), grammarToolInputProperties = createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools)) {
    if (options?.reasoningEffort !== undefined) {
        const level = clampThinkingLevel(model, options.reasoningEffort === "none" ? "off" : options.reasoningEffort);
        options = { ...options, reasoningEffort: level === "off" ? undefined : level };
    }
    const deferredToolsMode = compat.supportsAdditionalTools
        ? "additional-tools"
        : compat.supportsToolSearch
            ? "tool-search"
            : undefined;
    const toolPlacement = splitDeferredTools(context, deferredToolsMode !== undefined);
    const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
        grammarToolInputProperties,
        deferredTools: toolPlacement.deferred,
        deferredToolsMode,
        toolOptions: {
            supportsStrictMode: compat.supportsStrictMode,
            supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
        },
    });
    const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
    const params = {
        model: model.id,
        input: messages,
        stream: true,
        prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
        prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
        prompt_cache_options: getPromptCacheOptions(compat, cacheRetention),
        store: false,
    };
    if (options?.maxTokens && compat.supportsMaxOutputTokens) {
        params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
    }
    if (options?.temperature !== undefined) {
        params.temperature = options?.temperature;
    }
    if (options?.serviceTier !== undefined) {
        params.service_tier = options.serviceTier;
    }
    if (toolPlacement.immediate.length > 0) {
        params.tools = convertResponsesTools(toolPlacement.immediate, {
            supportsStrictMode: compat.supportsStrictMode,
            supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
        });
    }
    if (options?.toolChoice !== undefined) {
        params.tool_choice = options.toolChoice;
    }
    if (model.reasoning) {
        if (options?.reasoningEffort || options?.reasoningSummary) {
            const effort = options?.reasoningEffort
                ? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
                : clampThinkingLevel(model, "medium");
            params.reasoning = {
                effort: effort,
                summary: options?.reasoningSummary || "auto",
            };
            params.include = ["reasoning.encrypted_content"];
        }
        else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
            params.reasoning = {
                effort: (model.thinkingLevelMap?.off ?? "none"),
            };
        }
        if (model.provider === "xai")
            params.include = ["reasoning.encrypted_content"];
    }
    // Last so custom keys override the named request fields.
    if (options?.samplingParams) {
        Object.assign(params, options.samplingParams);
    }
    return params;
}
function getServiceTierCostMultiplier(model, serviceTier) {
    if (!serviceTier || ['auto','default','standard'].includes(serviceTier)) return 1;
    // Official per-model ratios, verified 2026-09-12. A single 2x multiplier
    // overprices GPT-5 mini, GPT-4.1, GPT-4o and o-series fast requests.
    const fast = {'gpt-6-astra':2,'gpt-5.6-sol':2,'gpt-5.6-terra':2,'gpt-5.6-luna':2,
      'gpt-5.5':2.5,'gpt-5.4':2,'gpt-5.4-mini':2,'gpt-5.3-codex':2,
      'gpt-5.2':2,'gpt-5.1':2,'gpt-5':2,'gpt-5-mini':1.8,
      'gpt-4.1':1.75,'gpt-4.1-mini':1.75,'gpt-4.1-nano':2,
      'gpt-4o':1.7,'gpt-4o-2024-05-13':1.75,'gpt-4o-mini':5/3,'o3':1.75,'o4-mini':20/11};
    const id = Object.hasOwn(fast,model.id) ? model.id : model.id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    if (serviceTier === 'fast' || serviceTier === 'priority') return fast[id];
    if (serviceTier === 'flex' && ['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna',
      'gpt-5.5','gpt-5.5-pro','gpt-5.4','gpt-5.4-pro','gpt-5.4-mini','gpt-5.4-nano',
      'gpt-5.2','gpt-5.1','gpt-5','gpt-5-mini','gpt-5-nano','o3','o4-mini'].includes(id)) return 0.5;
    return undefined;
}
function applyServiceTierPricing(usage, serviceTier, model) {
    let host = '';
    try { const url = new URL(model.baseUrl); if (url.protocol === 'https:') host = url.hostname; } catch {}
    usage.cost.serviceTier = serviceTier ?? 'default';
    // An OpenAI-compatible wire format does not imply OpenAI's price schedule.
    if (model.provider !== 'openai' || !['api.openai.com', 'us.api.openai.com', 'eu.api.openai.com'].includes(host)) {
        if (serviceTier && !['auto', 'default', 'standard'].includes(serviceTier)) usage.cost.complete = false;
        return;
    }
    if (serviceTier && !['auto', 'default', 'standard', 'flex', 'batch', 'priority', 'fast'].includes(serviceTier)) usage.cost.complete = false;
    let multiplier = getServiceTierCostMultiplier(model, serviceTier);
    const input = usage.input + usage.cacheRead + usage.cacheWrite;
    const unavailableFast = ['fast','priority'].includes(serviceTier) &&
      (/^gpt-5\.[45](?:-\d{4}-\d{2}-\d{2})?$/.test(model.id) && input > 272000 || host === 'eu.api.openai.com' && model.id === 'gpt-6-astra');
    if (multiplier === undefined || unavailableFast) { usage.cost.complete = false; multiplier = 1; }
    // Official schedule, 2026-09-12. Unknown regional models stay partial.
    // https://developers.openai.com/api/docs/pricing
    if (host !== 'api.openai.com') {
        if (/^(gpt-6-astra|gpt-5\.6-(sol|terra|luna)|gpt-5\.[45](?:-mini|-nano|-pro)?)(?:-\d{4}-\d{2}-\d{2})?$/.test(model.id)) multiplier *= 1.1;
        else usage.cost.complete = false;
    }
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) usage.cost[key] *= multiplier;
    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
    usage.cost.multiplier = multiplier;
}

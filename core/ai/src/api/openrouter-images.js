import OpenAI from "openai";
import { calculateCost } from "../models.js";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.js";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.js";
import { retryProviderRequest } from "../utils/provider-retry.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
export const generateImages = async (model, context, options) => {
    const output = {
        api: model.api,
        provider: model.provider,
        model: model.id,
        output: [],
        stopReason: "stop",
        timestamp: Date.now(),
    };
    try {
        const apiKey = options?.apiKey;
        if (!apiKey) {
            throw new Error(`No API key for provider: ${model.provider}`);
        }
        const client = createClient(model, apiKey, options?.headers, options?.fetch);
        let params = buildParams(model, context);
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
            params = nextParams;
        }
        const requestOptions = {
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
            maxRetries: 0,
        };
        const { data: response, response: rawResponse } = await retryProviderRequest(() => client.chat.completions
            .create(params, requestOptions)
            .withResponse(), {
            maxRetries: options?.maxRetries,
            maxRetryDelayMs: options?.maxRetryDelayMs,
            signal: options?.signal,
        });
        await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);
        const imageResponse = response;
        output.responseId = imageResponse.id;
        if (imageResponse.usage) {
            output.usage = parseUsage(imageResponse.usage, model);
        }
        const choice = imageResponse.choices[0];
        if (choice) {
            const content = choice.message.content;
            if (typeof content === "string" && content.length > 0) {
                output.output.push({ type: "text", text: content });
            }
            for (const image of choice.message.images ?? []) {
                const imageUrl = typeof image.image_url === "string" ? image.image_url : image.image_url?.url;
                if (!imageUrl?.startsWith("data:"))
                    continue;
                const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (!matches)
                    continue;
                output.output.push({
                    type: "image",
                    mimeType: matches[1],
                    data: matches[2],
                });
            }
        }
        return output;
    }
    catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = formatProviderError(normalizeProviderError(error));
        return output;
    }
};
function createClient(model, apiKey, optionsHeaders, fetch) {
    return new OpenAI({
        apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
        fetch,
        defaultHeaders: providerHeadersToRecord({ ...model.headers, ...optionsHeaders }),
    });
}
function buildParams(model, context) {
    const content = context.input.map((item) => {
        if (item.type === "text") {
            return {
                type: "text",
                text: sanitizeSurrogates(item.text),
            };
        }
        return {
            type: "image_url",
            image_url: {
                url: `data:${item.mimeType};base64,${item.data}`,
            },
        };
    });
    return {
        model: model.id,
        messages: [
            {
                role: "user",
                content,
            },
        ],
        stream: false,
        modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
    };
}
function parseUsage(rawUsage, model) {
    let countsComplete = true;
    const validCount = value => Number.isSafeInteger(value) && value >= 0;
    const count = (value, required = false) => {
        if (value === undefined && !required) return 0;
        if (validCount(value)) return value;
        countsComplete = false;
        return 0;
    };
    const promptTokens = count(rawUsage.prompt_tokens, true);
    const completionTokens = count(rawUsage.completion_tokens, true);
    const output = Math.min(completionTokens, Number.MAX_SAFE_INTEGER - promptTokens);
    const details = rawUsage.prompt_tokens_details;
    if (details !== undefined && (!details || typeof details !== "object" || Array.isArray(details))) countsComplete = false;
    const reportedCachedTokens = count(details?.cached_tokens);
    const reportedWriteTokens = count(details?.cache_write_tokens);
    // OpenRouter reports cache hits and writes as independent counters. Keep
    // them disjoint, bounded by the reported prompt, and flag malformed counts
    // as partial instead of publishing negative costs or concatenated totals.
    const cacheReadTokens = Math.min(reportedCachedTokens, promptTokens);
    const cacheWriteTokens = Math.min(reportedWriteTokens, promptTokens - cacheReadTokens);
    if (cacheReadTokens !== reportedCachedTokens || cacheWriteTokens !== reportedWriteTokens || output !== completionTokens) countsComplete = false;
    const input = promptTokens - cacheReadTokens - cacheWriteTokens;
    const usage = {
        input,
        output,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        totalTokens: promptTokens + output,
        cacheReadReported: validCount(details?.cached_tokens) && cacheReadTokens === reportedCachedTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(model, usage);
    usage.cost.complete = usage.cost.complete && countsComplete;
    // The official account charge includes routing discounts/fees which a
    // catalog estimate cannot reconstruct. Upstream cost is separate evidence.
    let official = false;
    try {
        const endpoint = new URL(model.baseUrl);
        official = model.provider === "openrouter" && endpoint.protocol === "https:" && endpoint.hostname === "openrouter.ai";
    } catch {}
    if (official && Number.isFinite(rawUsage.cost) && rawUsage.cost >= 0) {
        usage.cost.estimatedTotal = usage.cost.total;
        usage.cost.total = rawUsage.cost;
        usage.cost.source = "provider-reported";
        usage.cost.complete = true;
        const upstream = rawUsage.cost_details?.upstream_inference_cost;
        if (Number.isFinite(upstream) && upstream >= 0) usage.cost.upstreamInferenceCost = upstream;
        if (rawUsage.is_byok === true) usage.cost.byok = true;
    }
    return usage;
}

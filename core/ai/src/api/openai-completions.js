import OpenAI from "openai";
import { calculateCost, clampThinkingLevel } from "../models.js";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { shortHash } from "../utils/hash.js";
import { headersToRecord } from "../utils/headers.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { getPiUserAgent } from "../utils/pi-user-agent.js";
import { getProviderEnvValue } from "../utils/provider-env.js";
import { retryProviderRequest } from "../utils/provider-retry.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { appendGrammarToolInputJsonDelta, createGrammarToolInputProperties, getGrammarToolInput, getJsonSchemaToolParameters, resolveGrammarConstrainedSampling, resolveJsonSchemaStrictSampling, } from "./constrained-sampling.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { clampOpenAIPromptCacheKey, isOpenAIEndpoint } from "./openai-prompt-cache.js";
import { buildBaseOptions, clampThinkingBudgetToAnswerRoom, thinkingBudgetForLevel } from "./simple-options.js";
import { transformMessages } from "./transform-messages.js";
/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
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
function hasToolHistory(messages) {
    for (const msg of messages) {
        if (msg.role === "toolResult") {
            return true;
        }
        if (msg.role === "assistant") {
            if (msg.content.some((block) => block.type === "toolCall")) {
                return true;
            }
        }
    }
    return false;
}
function getDeferredToolNames(messages) {
    const names = new Set();
    for (const message of messages) {
        if (message.role === "toolResult") {
            for (const name of message.addedToolNames ?? []) {
                names.add(name);
            }
        }
    }
    return names;
}
function getToolsByName(tools, names) {
    if (!tools)
        return [];
    const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    return Array.from(names)
        .map((name) => toolsByName.get(name))
        .filter((tool) => tool !== undefined);
}
function isTextContentBlock(block) {
    return block.type === "text";
}
function isThinkingContentBlock(block) {
    return block.type === "thinking";
}
function isToolCallBlock(block) {
    return block.type === "toolCall";
}
function isImageContentBlock(block) {
    return block.type === "image";
}
function isReasoningDetailObject(detail) {
    return typeof detail === "object" && detail !== null && !Array.isArray(detail);
}
function hasValidCommonReasoningDetailFields(candidate) {
    return ((candidate.id === undefined || candidate.id === null || typeof candidate.id === "string") &&
        (candidate.format === undefined || typeof candidate.format === "string") &&
        (candidate.index === undefined || typeof candidate.index === "number"));
}
function isOpenAIReasoningDetail(detail) {
    if (!isReasoningDetailObject(detail) || !hasValidCommonReasoningDetailFields(detail)) {
        return false;
    }
    switch (detail.type) {
        case "reasoning.summary":
            return typeof detail.summary === "string";
        case "reasoning.encrypted":
            return typeof detail.data === "string";
        case "reasoning.text":
            return (typeof detail.text === "string" &&
                (detail.signature === undefined || detail.signature === null || typeof detail.signature === "string"));
        default:
            return false;
    }
}
function parseOpenAIReasoningDetails(signature) {
    if (!signature)
        return undefined;
    try {
        const parsed = JSON.parse(signature);
        return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isOpenAIReasoningDetail) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function parseLegacyEncryptedReasoningDetail(signature) {
    if (!signature)
        return undefined;
    try {
        const parsed = JSON.parse(signature);
        return isOpenAIReasoningDetail(parsed) &&
            parsed.type === "reasoning.encrypted" &&
            typeof parsed.id === "string" &&
            parsed.id.length > 0 &&
            parsed.data.length > 0
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
function fillMissingCommonReasoningDetailFields(target, source) {
    target.id ??= source.id;
    target.format ||= source.format;
    target.index ??= source.index;
}
function appendOpenAIReasoningDetail(details, detail) {
    const lastDetail = details[details.length - 1];
    if (detail.type === "reasoning.text" && lastDetail?.type === "reasoning.text") {
        lastDetail.text += detail.text;
        lastDetail.signature ||= detail.signature;
        fillMissingCommonReasoningDetailFields(lastDetail, detail);
        return;
    }
    if (detail.type === "reasoning.summary" && lastDetail?.type === "reasoning.summary") {
        lastDetail.summary += detail.summary;
        fillMissingCommonReasoningDetailFields(lastDetail, detail);
        return;
    }
    details.push({ ...detail });
}
const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"];
function isOpenAICompletionsReasoningField(field) {
    return OPENAI_COMPLETIONS_REASONING_FIELDS.includes(field);
}
function resolveCacheRetention(cacheRetention, env) {
    if (cacheRetention) {
        return cacheRetention;
    }
    if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
        return "long";
    }
    return "short";
}
export const stream = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
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
        // `reasoning_details` are replay metadata, not user-visible stream deltas.
        // Keep them in memory during streaming and serialize once when the block is finalized.
        let streamedReasoningDetails;
        const applyStreamedReasoningDetails = (block) => {
            if (streamedReasoningDetails !== undefined) {
                block.thinkingSignature = JSON.stringify(streamedReasoningDetails);
            }
        };
        try {
            const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
            const compat = getCompat(model);
            const grammarToolInputProperties = createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools);
            const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
            const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
            const client = createClient(model, context, apiKey, options?.headers, options?.fetch, cacheSessionId, compat);
            let params = buildParams(model, context, options, compat, cacheRetention, grammarToolInputProperties);
            const nextParams = await options?.onPayload?.(params, model);
            if (nextParams !== undefined) {
                params = nextParams;
            }
            const requestOptions = {
                ...(options?.signal ? { signal: options.signal } : {}),
                ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
                maxRetries: 0,
            };
            const { data: openaiStream, response } = await retryProviderRequest(() => client.chat.completions.create(params, requestOptions).withResponse(), {
                maxRetries: options?.maxRetries,
                maxRetryDelayMs: options?.maxRetryDelayMs,
                signal: options?.signal,
            });
            await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
            stream.push({ type: "start", partial: output });
            let textBlock = null;
            let thinkingBlock = null;
            let hasFinishReason = false;
            const toolCallBlocksByIndex = new Map();
            const toolCallBlocksById = new Map();
            const blocks = output.content;
            const getContentIndex = (block) => blocks.indexOf(block);
            const getCustomToolCallInput = (block) => {
                const property = block.customInput?.property;
                if (property === undefined)
                    return "";
                const value = block.arguments[property];
                return typeof value === "string" ? value : "";
            };
            const appendCustomToolCallInput = (block, nextInput, close) => {
                const customInput = block.customInput;
                if (!customInput)
                    return undefined;
                const delta = appendGrammarToolInputJsonDelta(customInput.jsonBuffer, customInput.property, nextInput, close);
                block.arguments = { [customInput.property]: nextInput };
                return delta;
            };
            const finishBlock = (block) => {
                const contentIndex = getContentIndex(block);
                if (contentIndex === -1) {
                    return;
                }
                if (block.type === "text") {
                    stream.push({
                        type: "text_end",
                        contentIndex,
                        content: block.text,
                        partial: output,
                    });
                }
                else if (block.type === "thinking") {
                    applyStreamedReasoningDetails(block);
                    stream.push({
                        type: "thinking_end",
                        contentIndex,
                        content: block.thinking,
                        partial: output,
                    });
                }
                else if (block.type === "toolCall") {
                    if (block.customInput) {
                        const delta = appendCustomToolCallInput(block, getCustomToolCallInput(block), true);
                        if (delta !== undefined) {
                            stream.push({
                                type: "toolcall_delta",
                                contentIndex,
                                delta,
                                partial: output,
                            });
                        }
                    }
                    else {
                        block.arguments = parseStreamingJson(block.partialArgs);
                    }
                    // Finalize in-place and strip the scratch buffers so replay only
                    // carries parsed arguments.
                    delete block.partialArgs;
                    delete block.customInput;
                    delete block.streamIndex;
                    stream.push({
                        type: "toolcall_end",
                        contentIndex,
                        toolCall: block,
                        partial: output,
                    });
                }
            };
            const ensureTextBlock = () => {
                if (!textBlock) {
                    textBlock = { type: "text", text: "" };
                    blocks.push(textBlock);
                    stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
                }
                return textBlock;
            };
            const ensureThinkingBlock = (thinkingSignature) => {
                if (!thinkingBlock) {
                    thinkingBlock = {
                        type: "thinking",
                        thinking: "",
                        thinkingSignature,
                    };
                    blocks.push(thinkingBlock);
                    stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
                }
                return thinkingBlock;
            };
            const ensureToolCallBlock = (toolCall) => {
                const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
                const name = toolCall.function?.name ?? toolCall.custom?.name ?? "";
                let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
                if (!block && toolCall.id) {
                    block = toolCallBlocksById.get(toolCall.id);
                }
                if (!block) {
                    // Note: the "input" fallback here should/must not be taken.  in case the LLM makes up
                    // a tool we don't knwo about, we at least have a place to stash our stuff.
                    const customInputProperty = toolCall.custom && !toolCall.function ? (grammarToolInputProperties.get(name) ?? "input") : undefined;
                    const hasCustomInput = customInputProperty !== undefined;
                    block = {
                        type: "toolCall",
                        id: toolCall.id || "",
                        name,
                        arguments: hasCustomInput ? { [customInputProperty]: "" } : {},
                        partialArgs: hasCustomInput ? undefined : "",
                        customInput: hasCustomInput
                            ? { property: customInputProperty, jsonBuffer: { input: "", started: false, closed: false } }
                            : undefined,
                        streamIndex,
                    };
                    if (streamIndex !== undefined) {
                        toolCallBlocksByIndex.set(streamIndex, block);
                    }
                    if (toolCall.id) {
                        toolCallBlocksById.set(toolCall.id, block);
                    }
                    blocks.push(block);
                    stream.push({
                        type: "toolcall_start",
                        contentIndex: getContentIndex(block),
                        partial: output,
                    });
                }
                if (streamIndex !== undefined && block.streamIndex === undefined) {
                    block.streamIndex = streamIndex;
                    toolCallBlocksByIndex.set(streamIndex, block);
                }
                if (toolCall.id) {
                    toolCallBlocksById.set(toolCall.id, block);
                }
                if (!block.name && name) {
                    block.name = name;
                }
                if (toolCall.custom && !toolCall.function && !block.customInput) {
                    const customInputProperty = grammarToolInputProperties.get(block.name) ?? "input";
                    block.arguments = { [customInputProperty]: "" };
                    block.customInput = {
                        property: customInputProperty,
                        jsonBuffer: { input: "", started: false, closed: false },
                    };
                    delete block.partialArgs;
                }
                return block;
            };
            for await (const chunk of openaiStream) {
                if (!chunk || typeof chunk !== "object")
                    continue;
                // OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
                // and each chunk in a streamed completion carries the same id.
                output.responseId ||= chunk.id;
                if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
                    output.responseModel ||= chunk.model;
                }
                if (chunk.usage) {
                    output.usage = parseChunkUsage(chunk.usage, model, chunk.service_tier ?? options?.samplingParams?.service_tier);
                }
                const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
                if (!choice)
                    continue;
                // Fallback: some providers (e.g., Moonshot) return usage
                // in choice.usage instead of the standard chunk.usage
                if (!chunk.usage && choice.usage) {
                    output.usage = parseChunkUsage(choice.usage, model, chunk.service_tier ?? options?.samplingParams?.service_tier);
                }
                if (choice.finish_reason) {
                    output.rawStopReason = choice.finish_reason;
                    const finishReasonResult = mapStopReason(choice.finish_reason);
                    output.stopReason = finishReasonResult.stopReason;
                    if (finishReasonResult.errorMessage) {
                        output.errorMessage = finishReasonResult.errorMessage;
                    }
                    hasFinishReason = true;
                }
                if (choice.delta) {
                    if (choice.delta.content !== null &&
                        choice.delta.content !== undefined &&
                        choice.delta.content.length > 0) {
                        const block = ensureTextBlock();
                        block.text += choice.delta.content;
                        stream.push({
                            type: "text_delta",
                            contentIndex: getContentIndex(block),
                            delta: choice.delta.content,
                            partial: output,
                        });
                    }
                    // Some endpoints return reasoning in reasoning_content (llama.cpp),
                    // or reasoning (other openai compatible endpoints)
                    // Use the first non-empty reasoning field to avoid duplication
                    // (e.g., chutes.ai returns both reasoning_content and reasoning with same content)
                    const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
                    const deltaFields = choice.delta;
                    let foundReasoningField = null;
                    for (const field of reasoningFields) {
                        const value = deltaFields[field];
                        if (typeof value === "string" && value.length > 0) {
                            foundReasoningField = field;
                            break;
                        }
                    }
                    if (foundReasoningField) {
                        const delta = deltaFields[foundReasoningField];
                        if (typeof delta === "string" && delta.length > 0) {
                            const thinkingSignature = model.provider === "opencode-go" && foundReasoningField === "reasoning"
                                ? "reasoning_content"
                                : foundReasoningField;
                            const block = ensureThinkingBlock(thinkingSignature);
                            block.thinking += delta;
                            stream.push({
                                type: "thinking_delta",
                                contentIndex: getContentIndex(block),
                                delta,
                                partial: output,
                            });
                        }
                    }
                    if (choice?.delta?.tool_calls) {
                        for (const toolCall of choice.delta.tool_calls) {
                            const block = ensureToolCallBlock(toolCall);
                            if (!block.id && toolCall.id) {
                                block.id = toolCall.id;
                                toolCallBlocksById.set(toolCall.id, block);
                            }
                            const name = toolCall.function?.name ?? toolCall.custom?.name;
                            if (!block.name && name) {
                                block.name = name;
                            }
                            let delta = "";
                            if (toolCall.function?.arguments) {
                                delta = toolCall.function.arguments;
                                block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
                                block.arguments = parseStreamingJson(block.partialArgs);
                            }
                            else if (toolCall.custom?.input) {
                                const nextInput = getCustomToolCallInput(block) + toolCall.custom.input;
                                delta = appendCustomToolCallInput(block, nextInput, false) ?? "";
                            }
                            stream.push({
                                type: "toolcall_delta",
                                contentIndex: getContentIndex(block),
                                delta,
                                partial: output,
                            });
                        }
                    }
                    const reasoningDetails = choice.delta.reasoning_details;
                    if (Array.isArray(reasoningDetails)) {
                        for (const detail of reasoningDetails) {
                            if (!isOpenAIReasoningDetail(detail))
                                continue;
                            ensureThinkingBlock("");
                            streamedReasoningDetails ??= [];
                            // Keep provider replay data in the existing signature slot. OpenRouter streams
                            // reasoning_details as deltas: consecutive text/summary deltas are merged into
                            // logical entries, while encrypted entries remain opaque and discrete.
                            appendOpenAIReasoningDetail(streamedReasoningDetails, detail);
                        }
                    }
                }
            }
            for (const block of blocks) {
                finishBlock(block);
            }
            if (options?.signal?.aborted) {
                throw new Error("Request was aborted");
            }
            if (output.stopReason === "aborted") {
                throw new Error("Request was aborted");
            }
            if (!hasFinishReason && !compat.supportsFinishReason) {
                output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
            }
            if (output.stopReason === "error") {
                throw new Error(output.errorMessage || "Provider returned an error stop reason");
            }
            if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
                throw new Error("Stream ended without finish_reason");
            }
            stream.push({ type: "done", reason: output.stopReason, message: output });
            stream.end();
        }
        catch (error) {
            for (const block of output.content) {
                if (block.type === "thinking") {
                    applyStreamedReasoningDetails(block);
                }
                delete block.index;
                // Streaming scratch buffers are only used during parsing; never persist them.
                delete block.partialArgs;
                delete block.customInput;
                delete block.streamIndex;
            }
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage = formatProviderError(normalizeProviderError(error));
            // Some providers via OpenRouter give additional information in this field.
            // normalizeProviderError already stringifies the parsed body (error.error)
            // into errorMessage, so only append the raw metadata when it is not already
            // present to avoid double-printing it.
            const rawMetadata = error?.error?.metadata?.raw;
            if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) {
                output.errorMessage += `\n${rawMetadata}`;
            }
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
        thinkingBudgets: options?.thinkingBudgets,
    });
};
function createClient(model, context, apiKey, optionsHeaders, fetch, sessionId, compat = getCompat(model)) {
    const headers = { "User-Agent": getPiUserAgent(), ...model.headers };
    if (model.provider === "github-copilot") {
        const hasImages = hasCopilotVisionInput(context.messages);
        const copilotHeaders = buildCopilotDynamicHeaders({
            messages: context.messages,
            hasImages,
        });
        Object.assign(headers, copilotHeaders);
    }
    if (sessionId && compat.sendSessionAffinityHeaders) {
        if (compat.sessionAffinityFormat === "openrouter") {
            headers["x-session-id"] = sessionId;
        }
        else {
            if (compat.sessionAffinityFormat === "openai") {
                headers.session_id = sessionId;
            }
            headers["x-client-request-id"] = sessionId;
            headers["x-session-affinity"] = sessionId;
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
function buildParams(model, context, options, compat = getCompat(model), cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env), grammarToolInputProperties = createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools)) {
    // Direct SDK calls share the same capability clamp as sessions and workers.
    if (options?.reasoningEffort !== undefined) {
        const level = clampThinkingLevel(model, options.reasoningEffort === "none" ? "off" : options.reasoningEffort);
        options = { ...options, reasoningEffort: level === "off" ? undefined : level };
    }
    const messages = convertMessages(model, context, compat, { grammarToolInputProperties });
    const cacheControl = getCompatCacheControl(compat, cacheRetention);
    const params = {
        model: model.id,
        messages,
        stream: true,
        prompt_cache_key: (isOpenAIEndpoint(model.baseUrl) && cacheRetention !== "none") ||
            (cacheRetention === "long" && compat.supportsLongCacheRetention)
            ? clampOpenAIPromptCacheKey(options?.sessionId)
            : undefined,
        prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
    };
if (cacheRetention !== 'none' && model.provider === 'cerebras' && options?.sessionId) {
      let official = false;
      try { official = new URL(model.baseUrl).hostname === 'api.cerebras.ai'; } catch {}
      if (official) params.prompt_cache_key = clampOpenAIPromptCacheKey(options.sessionId);
    } /* PI_CACHE_AFFINITY_V1 */
    if (compat.supportsUsageInStreaming !== false) {
        params.stream_options = { include_usage: true };
    }
    if (compat.supportsStore) {
        params.store = false;
    }
    if (options?.maxTokens) {
        if (compat.maxTokensField === "max_tokens") {
            params.max_tokens = options.maxTokens;
        }
        else {
            params.max_completion_tokens = options.maxTokens;
        }
    }
    if (options?.temperature !== undefined) {
        params.temperature = options.temperature;
    }
    const deferredToolNames = compat.deferredToolsMode === "kimi" ? getDeferredToolNames(context.messages) : new Set();
    const activeTools = context.tools?.filter((tool) => !deferredToolNames.has(tool.name));
    if (activeTools && activeTools.length > 0) {
        params.tools = convertTools(activeTools, compat);
        if (compat.zaiToolStream) {
            params.tool_stream = true;
        }
    }
    else if (hasToolHistory(context.messages)) {
        // Anthropic (via LiteLLM/proxy) requires tools param when conversation has tool_calls/tool_results
        params.tools = [];
    }
    if (cacheControl) {
        applyAnthropicCacheControl(messages, params.tools, cacheControl);
    }
    if (options?.toolChoice) {
        params.tool_choice = options.toolChoice;
    }
    if (compat.vllmPriority !== undefined) {
        params.priority = compat.vllmPriority;
    }
    const thinkingTokenBudgetField = resolveThinkingTokenBudgetField(compat);
    const thinkingBudget = !options?.reasoningEffort && model.reasoning && model.thinkingLevelMap?.off !== null
        ? compat.thinkingTokenBudgetOff : resolveClampedThinkingBudget(model, options, params);
    if (compat.thinkingFormat === "zai" && model.reasoning) {
        const zaiParams = params;
        if (options?.reasoningEffort || model.thinkingLevelMap?.off !== null)
            zaiParams.thinking = options?.reasoningEffort ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
        if (options?.reasoningEffort && compat.supportsReasoningEffort) {
            const mappedEffort = model.thinkingLevelMap?.[options.reasoningEffort];
            const effort = mappedEffort === undefined ? options.reasoningEffort : mappedEffort;
            if (typeof effort === "string") {
                zaiParams.reasoning_effort = effort;
            }
        }
    }
    else if (compat.thinkingFormat === "qwen" && model.reasoning) {
        if (options?.reasoningEffort || model.thinkingLevelMap?.off !== null)
            params.enable_thinking = !!options?.reasoningEffort;
        if (options?.reasoningEffort && compat.supportsReasoningEffort) {
            const effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
            if (typeof effort === "string") {
                params.reasoning_effort = effort;
            }
        }
    }
    else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
        if (options?.reasoningEffort || model.thinkingLevelMap?.off !== null) {
            params.chat_template_kwargs = {
                enable_thinking: !!options?.reasoningEffort,
                preserve_thinking: true,
            };
        }
    }
    else if (compat.thinkingFormat === "chat-template" && model.reasoning) {
        const chatTemplateKwargs = buildChatTemplateValues(model, options, compat.chatTemplateKwargs, thinkingBudget);
        if (chatTemplateKwargs) {
            params.chat_template_kwargs = chatTemplateKwargs;
        }
        if (options?.reasoningEffort && model.compat?.supportsReasoningEffort === true)
            params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
    }
    else if (compat.thinkingFormat === "baseten" && model.reasoning) {
        const basetenParams = params;
        const chatTemplateArgs = buildChatTemplateValues(model, options, compat.chatTemplateArgs, thinkingBudget);
        if (chatTemplateArgs) {
            basetenParams.chat_template_args = chatTemplateArgs;
        }
        if (compat.supportsReasoningEffort) {
            const requestedEffort = options?.reasoningEffort;
            const mappedEffort = requestedEffort ? model.thinkingLevelMap?.[requestedEffort] : model.thinkingLevelMap?.off;
            const effort = mappedEffort === undefined ? requestedEffort : mappedEffort;
            if (typeof effort === "string") {
                basetenParams.reasoning_effort = effort;
            }
        }
    }
    else if (["deepseek", "enabled"].includes(compat.thinkingFormat) && model.reasoning) {
        if (options?.reasoningEffort) {
            params.thinking = { type: "enabled" };
        }
        else if (model.thinkingLevelMap?.off !== null) {
            params.thinking = { type: "disabled" };
        }
        if (options?.reasoningEffort && compat.supportsReasoningEffort) {
            params.reasoning_effort =
                model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
        }
    }
    else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
        // OpenRouter normalizes reasoning across providers via a nested reasoning object.
        const openRouterParams = params;
        if (options?.reasoningEffort) {
            openRouterParams.reasoning = {
                effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
            };
        }
        else if (model.thinkingLevelMap?.off !== null) {
            openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
        }
    }
    else if (compat.thinkingFormat === "ant-ling" && model.reasoning && options?.reasoningEffort) {
        const effort = model.thinkingLevelMap?.[options.reasoningEffort];
        if (typeof effort === "string") {
            params.reasoning = { effort };
        }
    }
    else if (compat.thinkingFormat === "together" && model.reasoning) {
        const togetherParams = params;
        if (options?.reasoningEffort || model.thinkingLevelMap?.off !== null)
            togetherParams.reasoning = { enabled: !!options?.reasoningEffort };
        if (options?.reasoningEffort && compat.supportsReasoningEffort) {
            togetherParams.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
        }
    }
    else if (compat.thinkingFormat === "string-thinking" && model.reasoning) {
        const stringThinkingParams = params;
        if (options?.reasoningEffort) {
            stringThinkingParams.thinking = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
        }
        else if (model.thinkingLevelMap?.off !== null) {
            stringThinkingParams.thinking = model.thinkingLevelMap?.off ?? "none";
        }
    }
    else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
        // OpenAI-style reasoning_effort
        params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
    }
    else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
        const offValue = model.thinkingLevelMap?.off;
        if (typeof offValue === "string" && compat.thinkingTokenBudgetOff === undefined) {
            params.reasoning_effort = offValue;
        }
    }
    // Cap reasoning with a top-level budget field. Independent of thinkingFormat: the
    // same server can serve zai, qwen or chat-template models. Reasoning and the answer
    // share max_tokens here, so an uncapped reasoning phase can consume the whole
    // response and leave no answer and no tool call.
    if (thinkingTokenBudgetField && thinkingBudget !== undefined) {
        Object.assign(params, { [thinkingTokenBudgetField]: thinkingBudget });
    }
    // OpenRouter provider routing preferences
    if (model.compat?.openRouterRouting) {
        params.provider = model.compat.openRouterRouting;
    }
    // Vercel AI Gateway provider routing preferences
    if (model.compat?.vercelGatewayRouting) {
        const routing = model.compat.vercelGatewayRouting;
        if (routing.only || routing.order) {
            const gatewayOptions = {};
            if (routing.only)
                gatewayOptions.only = routing.only;
            if (routing.order)
                gatewayOptions.order = routing.order;
            params.providerOptions = { gateway: gatewayOptions };
        }
    }
    // Last so custom keys override the named request fields.
    if (options?.samplingParams) {
        Object.assign(params, options.samplingParams);
    }
    return params;
}
function resolveThinkingTokenBudgetField(compat) {
    if (compat.thinkingTokenBudgetField)
        return compat.thinkingTokenBudgetField;
    if (compat.supportsThinkingTokenBudget)
        return "thinking_token_budget";
    return undefined;
}
function resolveClampedThinkingBudget(model, options, params) {
    if (!options?.reasoningEffort || !model.reasoning)
        return undefined;
    const ceiling = params.max_tokens ?? params.max_completion_tokens ?? model.maxTokens;
    const budget = clampThinkingBudgetToAnswerRoom(thinkingBudgetForLevel(options.reasoningEffort, options.thinkingBudgets), ceiling);
    return budget > 0 ? budget : undefined;
}
function buildChatTemplateValues(model, options, values, thinkingBudget) {
    const resolvedValues = {};
    for (const [key, value] of Object.entries(values)) {
        const resolved = resolveChatTemplateKwargValue(model, options, value, thinkingBudget);
        if (resolved !== undefined) {
            resolvedValues[key] = resolved;
        }
    }
    return Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined;
}
function resolveChatTemplateKwargValue(model, options, value, thinkingBudget) {
    if (typeof value !== "object" || value === null) {
        return value;
    }
    const reasoningEffort = options?.reasoningEffort;
    if (!reasoningEffort && value.omitWhenOff) {
        return undefined;
    }
    if (value.$var === "thinking.enabled") {
        return !!reasoningEffort;
    }
    if (value.$var === "thinking.budget") {
        return thinkingBudget;
    }
    const mappedValue = reasoningEffort ? model.thinkingLevelMap?.[reasoningEffort] : model.thinkingLevelMap?.off;
    return mappedValue === undefined ? reasoningEffort : typeof mappedValue === "string" ? mappedValue : undefined;
}
function getCompatCacheControl(compat, cacheRetention) {
    if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
        return undefined;
    }
    const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
    return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}
function applyAnthropicCacheControl(messages, tools, cacheControl) {
    addCacheControlToSystemPrompt(messages, cacheControl);
    addCacheControlToLastTool(tools, cacheControl);
    addCacheControlToLastConversationMessage(messages, cacheControl);
}
function addCacheControlToSystemPrompt(messages, cacheControl) {
    for (const message of messages) {
        if (message.role === "system" || message.role === "developer") {
            addCacheControlToInstructionMessage(message, cacheControl);
            return;
        }
    }
}
function addCacheControlToLastConversationMessage(messages, cacheControl) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
            if (addCacheControlToMessage(message, cacheControl)) {
                return;
            }
        }
    }
}
function addCacheControlToLastTool(tools, cacheControl) {
    if (!tools || tools.length === 0) {
        return;
    }
    const lastTool = tools[tools.length - 1];
    lastTool.cache_control = cacheControl;
}
function addCacheControlToInstructionMessage(message, cacheControl) {
    return addCacheControlToTextContent(message, cacheControl);
}
function addCacheControlToMessage(message, cacheControl) {
    if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
        return addCacheControlToTextContent(message, cacheControl);
    }
    return false;
}
function addCacheControlToTextContent(message, cacheControl) {
    const content = message.content;
    if (typeof content === "string") {
        if (content.length === 0) {
            return false;
        }
        message.content = [
            {
                type: "text",
                text: content,
                cache_control: cacheControl,
            },
        ];
        return true;
    }
    if (!Array.isArray(content)) {
        return false;
    }
    for (let i = content.length - 1; i >= 0; i--) {
        const part = content[i];
        if (part?.type === "text") {
            const textPart = part;
            textPart.cache_control = cacheControl;
            return true;
        }
    }
    return false;
}
export function convertMessages(model, context, compat, options) {
    const params = [];
    const normalizeToolCallId = (id) => {
        // Handle pipe-separated IDs from OpenAI Responses API
        // Format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
        // These come from providers like github-copilot, openai-codex, opencode
        // Extract just the call_id part and normalize it
        // Multiple tool calls in the same turn can share call_id but differ by item_id.
        // Preserve item-level uniqueness when replaying into Chat Completions, which
        // requires distinct tool call ids.
        if (id.includes("|")) {
            // Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
            const separatorIndex = id.indexOf("|");
            const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
            const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
            const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
            if (combinedId.length <= 40) {
                return combinedId;
            }
            const hash = shortHash(id).slice(0, 8);
            const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
            return `${prefix}_${hash}`;
        }
        if (model.provider === "openai")
            return id.length > 40 ? id.slice(0, 40) : id;
        return id;
    };
    const transformedMessages = transformMessages(context.messages, model, (id) => normalizeToolCallId(id));
    if (context.systemPrompt) {
        const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
        const role = useDeveloperRole ? "developer" : "system";
        params.push({ role: role, content: sanitizeSurrogates(context.systemPrompt) });
    }
    let lastRole = null;
    for (let i = 0; i < transformedMessages.length; i++) {
        const msg = transformedMessages[i];
        // Some providers don't allow user messages directly after tool results
        // Insert a synthetic assistant message to bridge the gap
        if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
            params.push({
                role: "assistant",
                content: "I have processed the tool results.",
            });
        }
        if (msg.role === "user") {
            if (typeof msg.content === "string") {
                params.push({
                    role: "user",
                    content: sanitizeSurrogates(msg.content),
                });
            }
            else {
                const content = msg.content.map((item) => {
                    if (item.type === "text") {
                        return {
                            type: "text",
                            text: sanitizeSurrogates(item.text),
                        };
                    }
                    else {
                        return {
                            type: "image_url",
                            image_url: {
                                url: `data:${item.mimeType};base64,${item.data}`,
                            },
                        };
                    }
                });
                if (content.length === 0)
                    continue;
                params.push({
                    role: "user",
                    content,
                });
            }
        }
        else if (msg.role === "assistant") {
            // Some providers don't accept null content, use empty string instead
            const assistantMsg = {
                role: "assistant",
                content: compat.requiresAssistantAfterToolResult ? "" : null,
            };
            const assistantTextParts = msg.content
                .filter(isTextContentBlock)
                .filter((block) => block.text.trim().length > 0)
                .map((block) => ({
                type: "text",
                text: sanitizeSurrogates(block.text),
            }));
            const assistantText = assistantTextParts.map((part) => part.text).join("");
            const thinkingBlocks = msg.content.filter(isThinkingContentBlock);
            const toolCalls = msg.content.filter(isToolCallBlock);
            const signedReasoningDetails = thinkingBlocks
                .map((block) => parseOpenAIReasoningDetails(block.thinkingSignature))
                .find((details) => details !== undefined);
            const legacyReasoningDetails = toolCalls
                .map((toolCall) => parseLegacyEncryptedReasoningDetail(toolCall.thoughtSignature))
                .filter((detail) => detail !== undefined);
            const preservedReasoningDetails = signedReasoningDetails ?? (legacyReasoningDetails.length > 0 ? legacyReasoningDetails : undefined);
            const nonEmptyThinkingBlocks = thinkingBlocks.filter((block) => block.thinking.trim().length > 0);
            if (nonEmptyThinkingBlocks.length > 0) {
                if (compat.requiresThinkingAsText) {
                    // Convert thinking blocks to plain text (no tags to avoid model mimicking them)
                    const thinkingText = nonEmptyThinkingBlocks
                        .map((block) => sanitizeSurrogates(block.thinking))
                        .join("\n\n");
                    assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
                }
                else {
                    // Always send assistant content as a plain string (OpenAI Chat Completions
                    // API standard format). Sending as an array of {type:"text", text:"..."}
                    // objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
                    // NVIDIA NIM) to mirror the content-block structure literally in their
                    // output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
                    if (assistantText.length > 0) {
                        assistantMsg.content = assistantText;
                    }
                    // reasoning_details is the structured alternative to a raw reasoning field.
                    if (!preservedReasoningDetails) {
                        // Use the signature from the first thinking block if available (for llama.cpp server + gpt-oss)
                        let signature = nonEmptyThinkingBlocks[0].thinkingSignature;
                        if (model.provider === "opencode-go" && signature === "reasoning") {
                            signature = "reasoning_content";
                        }
                        if (signature && isOpenAICompletionsReasoningField(signature)) {
                            assistantMsg[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
                        }
                    }
                }
            }
            else if (assistantText.length > 0) {
                // Always send assistant content as a plain string (OpenAI Chat Completions
                // API standard format). Sending as an array of {type:"text", text:"..."}
                // objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
                // NVIDIA NIM) to mirror the content-block structure literally in their
                // output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
                assistantMsg.content = assistantText;
            }
            if (toolCalls.length > 0) {
                assistantMsg.tool_calls = toolCalls.map((tc) => {
                    const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);
                    if (customInputProperty !== undefined) {
                        return {
                            id: tc.id,
                            type: "custom",
                            custom: {
                                name: tc.name,
                                input: sanitizeSurrogates(getGrammarToolInput(tc.name, tc.arguments, customInputProperty)),
                            },
                        };
                    }
                    return {
                        id: tc.id,
                        type: "function",
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.arguments),
                        },
                    };
                });
            }
            if (preservedReasoningDetails) {
                assistantMsg.reasoning_details = preservedReasoningDetails;
            }
            if (compat.requiresReasoningContentOnAssistantMessages &&
                model.reasoning &&
                assistantMsg.reasoning_content === undefined) {
                assistantMsg.reasoning_content = "";
            }
            // Skip assistant messages that have no content and no tool calls.
            // Some providers require "either content or tool_calls, but not none".
            // Other providers also don't accept empty assistant messages.
            // This handles aborted assistant responses that got no content.
            const content = assistantMsg.content;
            const hasContent = content !== null &&
                content !== undefined &&
                (typeof content === "string" ? content.length > 0 : content.length > 0);
            if (!hasContent && !assistantMsg.tool_calls) {
                continue;
            }
            params.push(assistantMsg);
        }
        else if (msg.role === "toolResult") {
            const imageBlocks = [];
            const deferredToolNames = new Set();
            let j = i;
            for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
                const toolMsg = transformedMessages[j];
                // Extract text and image content
                const textResult = toolMsg.content
                    .filter(isTextContentBlock)
                    .map((block) => block.text)
                    .join("\n");
                const hasImages = toolMsg.content.some((c) => c.type === "image");
                // Always send tool result with text (or placeholder if only images)
                const hasText = textResult.length > 0;
                const toolResultText = hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)";
                // Some providers require the 'name' field in tool results
                const toolResultMsg = {
                    role: "tool",
                    content: sanitizeSurrogates(toolResultText),
                    tool_call_id: toolMsg.toolCallId,
                };
                if (compat.requiresToolResultName && toolMsg.toolName) {
                    toolResultMsg.name = toolMsg.toolName;
                }
                params.push(toolResultMsg);
                if (compat.deferredToolsMode === "kimi") {
                    for (const name of toolMsg.addedToolNames ?? []) {
                        deferredToolNames.add(name);
                    }
                }
                if (hasImages && model.input.includes("image")) {
                    for (const block of toolMsg.content) {
                        if (isImageContentBlock(block)) {
                            imageBlocks.push({
                                type: "image_url",
                                image_url: {
                                    url: `data:${block.mimeType};base64,${block.data}`,
                                },
                            });
                        }
                    }
                }
            }
            i = j - 1;
            if (imageBlocks.length > 0) {
                if (compat.requiresAssistantAfterToolResult) {
                    params.push({
                        role: "assistant",
                        content: "I have processed the tool results.",
                    });
                }
                params.push({
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Attached image(s) from tool result:",
                        },
                        ...imageBlocks,
                    ],
                });
                lastRole = "user";
            }
            else {
                lastRole = "toolResult";
            }
            if (deferredToolNames.size > 0) {
                const deferredTools = getToolsByName(context.tools, deferredToolNames);
                if (deferredTools.length > 0) {
                    const kimiToolMessage = {
                        role: "system",
                        tools: convertTools(deferredTools, compat),
                    };
                    // Kimi accepts a system message with tools but omits the standard content field.
                    params.push(kimiToolMessage);
                }
            }
            continue;
        }
        lastRole = msg.role;
    }
    return params;
}
function convertTools(tools, compat) {
    return tools.map((tool) => {
        const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
        if (grammar) {
            return {
                type: "custom",
                custom: {
                    name: tool.name,
                    description: tool.description,
                    format: {
                        type: "grammar",
                        grammar: {
                            syntax: grammar.format,
                            definition: grammar.definition,
                        },
                    },
                },
            };
        }
        const strict = resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode !== false);
        return {
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: getJsonSchemaToolParameters(tool, strict),
                // Only include strict if provider supports it. Some reject unknown fields.
                ...(compat.supportsStrictMode !== false && { strict: strict ?? false }),
            },
        };
    });
}
function parseChunkUsage(rawUsage, model, serviceTier) {
    const promptTokens = rawUsage.prompt_tokens || 0;
    const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? 0;
    const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
    // Follow documented OpenAI/OpenRouter semantics: cached_tokens is cache-read
    // tokens (hits). Providers disagree on placement: OpenAI/OpenRouter use
    // prompt_tokens_details.cached_tokens, DeepSeek uses prompt_cache_hit_tokens,
    // and Kimi documents top-level usage.cached_tokens on the final usage chunk.
    // OpenAI does not document or emit cache_write_tokens, but
    // OpenRouter-compatible providers can include it as a separate write count.
    // OpenRouter's own provider/tests affirm the separate mapping:
    // https://github.com/OpenRouterTeam/ai-sdk-provider/pull/409
    // Do not subtract writes from cached_tokens, otherwise spec-compliant
    // providers are under-reported. DS4 mirrors this contract too:
    // https://github.com/antirez/ds4/pull/29
    const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
    // OpenAI completion_tokens already includes reasoning_tokens.
    const outputTokens = rawUsage.completion_tokens || 0;
    const usage = {
        input,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
        totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
usage.cacheReadReported = [rawUsage.prompt_tokens_details?.cached_tokens, rawUsage.prompt_cache_hit_tokens, rawUsage.cached_tokens].some(v => Number.isFinite(v) && v >= 0); /* PI_CACHE_USAGE_ACCURACY_V1 */
    // Some Together-compatible responses report reasoning at the top level.
    // Completion tokens already include it: expose the breakdown, never add it.
    const reasoningCount = rawUsage.completion_tokens_details?.reasoning_tokens ?? rawUsage.reasoning_tokens;
    usage.reasoning = Number.isSafeInteger(reasoningCount) && reasoningCount >= 0 ? Math.min(reasoningCount, usage.output) : 0;
calculateCost(model,usage);
usage.cost.source = 'estimate';
    if (model.provider === 'openrouter' && Number.isFinite(rawUsage.cost) && rawUsage.cost >= 0) {
      let official = false;
      try { official = new URL(model.baseUrl).hostname === 'openrouter.ai'; } catch {}
      if (official) {
        usage.cost.estimatedTotal = usage.cost.total;
        usage.cost.total = rawUsage.cost;
        usage.cost.source = 'provider-reported'; usage.cost.complete = true;
      }
    }
    /* PI_PROVIDER_PRICE_ACCURACY_V4 */
    let billingHost = '';
    try { const u = new URL(model.baseUrl); if (u.protocol === 'https:') billingHost = u.hostname; } catch {}
    if (model.provider === 'deepinfra' && billingHost === 'api.deepinfra.com' && Number.isFinite(rawUsage.estimated_cost) && rawUsage.estimated_cost >= 0) {
      usage.cost.estimatedTotal = usage.cost.total;
      usage.cost.total = rawUsage.estimated_cost;
      usage.cost.source = 'provider-estimate'; usage.cost.complete = true;
    }
    // Published direct-API peak rates, verified 2026-09-10. Exact IDs only.
    // Recognize the catalog snapshot so explicit custom rates still take precedence.
    const peak = model.id === 'deepseek-v4-pro' ? (Date.now() >= Date.parse('2026-09-14T04:00:00Z') ? [0.3, 1.2, 0.006] : [1.32, 3.96, 0.044]) :
      ['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp'].includes(model.id) ? [0.3, 1.2, 0.006] : undefined;
    if (model.provider === 'deepseek' && billingHost === 'api.deepseek.com' && peak &&
        model.cost.input === peak[0] && model.cost.output === peak[1] && model.cost.cacheRead === peak[2] && model.cost.cacheWrite === 0 && !model.cost.tiers?.length) {
      const now = new Date(), day = now.getUTCDay(), hour = now.getUTCHours();
      const atPeak = day >= 1 && day <= 5 && (hour >= 1 && hour < 4 || hour >= 6 && hour < 10);
      if (!atPeak) for (const key of ['input','output','cacheRead','cacheWrite','total']) usage.cost[key] *= 0.5;
      usage.cost.priceBasis = atPeak ? 'deepseek-peak-2026-09-10' : 'deepseek-off-peak-2026-09-10';
    }
    if (!['provider-reported','provider-estimate'].includes(usage.cost.source) &&
        [rawUsage.prompt_tokens_details?.audio_tokens, rawUsage.completion_tokens_details?.audio_tokens].some(n => Number.isFinite(n) && n > 0)) usage.cost.complete = false;
    if (usage.cost.source === 'provider-reported' && Number.isFinite(rawUsage.cost_details?.upstream_inference_cost))
      usage.cost.upstreamInferenceCost = rawUsage.cost_details.upstream_inference_cost;
    if (usage.cost.source === 'provider-reported' && rawUsage.is_byok === true) usage.cost.byok = true;

    /* PI_CHAT_SERVICE_PRICING_V1 */
    if (model.provider === 'openai') {
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
      applyServiceTierPricing(usage, serviceTier, model);
    }

return usage;
}
function mapStopReason(reason) {
    if (reason === null)
        return { stopReason: "stop" };
    switch (reason) {
        case "stop":
        case "end":
            return { stopReason: "stop" };
        case "length":
            return { stopReason: "length" };
        case "function_call":
        case "tool_calls":
            return { stopReason: "toolUse" };
        case "content_filter":
            return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
        case "network_error":
            return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
        default:
            return {
                stopReason: "error",
                errorMessage: `Provider finish_reason: ${reason}`,
            };
    }
}
/**
 * Auto-detect compatibility settings from provider name and baseUrl.
 * Used as the base when model.compat is not set; explicit model.compat
 * entries override these detected values.
 */
function detectCompat(model) {
    const provider = model.provider;
    const baseUrl = model.baseUrl;
    let host = "";
    try { host = new URL(baseUrl).hostname; } catch {}
    const isZai = provider === "zai" ||
        provider === "zai-coding-cn" ||
        host === "api.z.ai" ||
        host === "open.bigmodel.cn";
    const isTogether = provider === "together" || host === "api.together.ai" || host === "api.together.xyz";
    const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || ["api.moonshot.ai", "api.moonshot.cn"].includes(host);
    const isOpenRouter = provider === "openrouter" || host === "openrouter.ai";
    const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || host === "api.cloudflare.com";
    const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || host === "gateway.ai.cloudflare.com";
    const isNvidia = provider === "nvidia" || host === "integrate.api.nvidia.com";
    const isAntLing = provider === "ant-ling" || host === "api.ant-ling.com";
    const isDeepSeek = provider === "deepseek" || host === "api.deepseek.com";
    const isNonStandard = isNvidia ||
        provider === "cerebras" ||
        host === "api.cerebras.ai" ||
        provider === "xai" ||
        host === "api.x.ai" ||
        isTogether ||
        (host === "chutes.ai" || host.endsWith(".chutes.ai")) ||
        isDeepSeek ||
        isZai ||
        isMoonshot ||
        provider === "opencode" ||
        host === "opencode.ai" ||
        isCloudflareWorkersAI ||
        isCloudflareAiGateway ||
        isAntLing;
    const useMaxTokens = (host === "chutes.ai" || host.endsWith(".chutes.ai")) ||
        isDeepSeek ||
        isMoonshot ||
        isCloudflareAiGateway ||
        isTogether ||
        isNvidia ||
        isAntLing ||
        isZai;
    const isGrok = provider === "xai" || host === "api.x.ai";
    const isOpenRouterDeveloperRoleModel = isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
    const cacheControlFormat = provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined;
    return {
        supportsStore: !isNonStandard,
        supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
        supportsReasoningEffort: !isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
        supportsUsageInStreaming: true,
        supportsFinishReason: true,
        maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
        requiresToolResultName: false,
        requiresAssistantAfterToolResult: false,
        requiresThinkingAsText: false,
        requiresReasoningContentOnAssistantMessages: isDeepSeek,
        thinkingFormat: isDeepSeek
            ? "deepseek"
            : isZai
                ? "zai"
                : isTogether
                    ? "together"
                    : isAntLing
                        ? "ant-ling"
                        : isOpenRouter
                            ? "openrouter"
                            : "openai",
        openRouterRouting: {},
        vercelGatewayRouting: {},
        chatTemplateKwargs: {},
        chatTemplateArgs: {},
        zaiToolStream: false,
        supportsThinkingTokenBudget: false,
        thinkingTokenBudgetField: undefined,
        thinkingTokenBudgetOff: undefined,
        supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia,
        supportsOpenAIGrammarTools: false,
        cacheControlFormat,
        sendSessionAffinityHeaders: false,
        deferredToolsMode: undefined,
        sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
        supportsLongCacheRetention: isOpenAIEndpoint(baseUrl),
    };
}
/**
 * Get resolved compatibility settings for a model.
 * Auto-detects from provider/URL then overrides with explicit model.compat.
 */
function getCompat(model) {
    const detected = detectCompat(model);
    if (!model.compat)
        return detected;
    return {
        supportsStore: model.compat.supportsStore ?? detected.supportsStore,
        supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
        supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
        supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
        supportsFinishReason: model.compat.supportsFinishReason ?? detected.supportsFinishReason,
        maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
        requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
        requiresAssistantAfterToolResult: model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
        requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
        requiresReasoningContentOnAssistantMessages: model.compat.requiresReasoningContentOnAssistantMessages ??
            detected.requiresReasoningContentOnAssistantMessages,
        thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
        openRouterRouting: model.compat.openRouterRouting ?? {},
        vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
        chatTemplateKwargs: model.compat.chatTemplateKwargs ?? detected.chatTemplateKwargs,
        chatTemplateArgs: model.compat.chatTemplateArgs ?? detected.chatTemplateArgs,
        zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
        supportsThinkingTokenBudget: model.compat.supportsThinkingTokenBudget ?? detected.supportsThinkingTokenBudget,
        thinkingTokenBudgetField: model.compat.thinkingTokenBudgetField ?? detected.thinkingTokenBudgetField,
        thinkingTokenBudgetOff: model.compat.thinkingTokenBudgetOff ?? detected.thinkingTokenBudgetOff,
        supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
        supportsOpenAIGrammarTools: model.compat.supportsOpenAIGrammarTools ?? detected.supportsOpenAIGrammarTools,
        cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
        sendSessionAffinityHeaders: model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
        deferredToolsMode: model.compat.deferredToolsMode ?? detected.deferredToolsMode,
        sessionAffinityFormat: model.compat.sessionAffinityFormat ?? detected.sessionAffinityFormat,
        supportsLongCacheRetention: model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
        vllmPriority: model.compat.vllmPriority,
    };
}

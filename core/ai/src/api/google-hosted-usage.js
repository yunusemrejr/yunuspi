import { calculateCost } from "../models.js";

const countFields = ["promptTokenCount", "cachedContentTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount", "toolUsePromptTokenCount"];
const validCount = value => Number.isSafeInteger(value) && value >= 0;

function billingRoute(model, params, client) {
    const requestHttp = params.config?.httpOptions;
    if (params.model !== model.id || requestHttp?.extraBody !== undefined) return undefined;
    try {
        // Use the SDK's resolved base, including environment or global defaults.
        // If that resolver changes or disappears, leave provider pricing unknown.
        const base = new URL(requestHttp?.baseUrl ?? client.apiClient?.getBaseUrl?.());
        if (base.protocol !== "https:" || base.port || base.username || base.password || base.search || base.hash) return undefined;
        if (client.vertexai && model.provider === "google-vertex" && /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(base.hostname) &&
            /^\/(?:v1(?:beta\d*)?\/?)?$/.test(base.pathname)) return "vertex";
        if (!client.vertexai && model.provider === "google" && base.hostname === "generativelanguage.googleapis.com" &&
            /^\/(?:v1(?:beta\d*)?\/?)?$/.test(base.pathname)) return "developer";
    } catch { /* The configured gateway has no trusted price here. */ }
    return undefined;
}

function onlyTool(tools, key) {
    return Array.isArray(tools) && tools.length > 0 && tools.every(tool => tool && typeof tool === "object" &&
        Object.keys(tool).length === 1 && tool[key] != null);
}

function webUrl(value) {
    if (typeof value !== "string") return false;
    try {
        return ["https:", "http:"].includes(new URL(value).protocol);
    } catch { return false; }
}

export function createGoogleHostedUsage(model, params, client) {
    const route = billingRoute(model, params, client);
    const urlOnly = onlyTool(params.config?.tools, "urlContext");
    const searchOnly = onlyTool(params.config?.tools, "googleSearch") || onlyTool(params.config?.tools, "googleSearchRetrieval");
    const counts = {};
    const queries = new Set();
    let currentResponseId;
    let searchObserved = false;
    let searchListObserved = false;
    let webSource = false;
    let supportedWebSource = false;
    let terminalSourceList = false;
    let multipleCandidates = (params.config?.candidateCount ?? 1) > 1;
    let ambiguousSources = false;
    let urlRetrieved = false;
    let toolModality;
    let inconsistent = false;
    let finished = false;

    function recordCandidate(candidate) {
        const urls = candidate?.urlContextMetadata?.urlMetadata;
        if (Array.isArray(urls)) urlRetrieved ||= urls.some(url => url?.urlRetrievalStatus === "URL_RETRIEVAL_STATUS_SUCCESS");
        multipleCandidates ||= candidate?.index > 0;
        const grounding = candidate?.groundingMetadata;
        if (!grounding) return;
        const list = grounding.webSearchQueries;
        if (Array.isArray(list)) {
            searchListObserved = true;
            for (const query of list) {
                if (typeof query === "string" && query.trim()) queries.add(query);
                else if (typeof query !== "string") inconsistent = true;
            }
        }
        searchObserved ||= grounding.searchEntryPoint != null;
        const sources = grounding.groundingChunks;
        if (Array.isArray(sources)) {
            terminalSourceList ||= typeof candidate.finishReason === "string" && candidate.finishReason.length > 0;
            for (const source of sources) {
                if (source?.web) {
                    const valid = webUrl(source.web.uri);
                    webSource ||= valid;
                    ambiguousSources ||= !valid;
                }
            }
            const supports = grounding.groundingSupports;
            if (Array.isArray(supports)) supportedWebSource ||= supports.some(support => {
                const indices = support?.groundingChunkIndices;
                return Array.isArray(indices) && indices.some(index => validCount(index) && webUrl(sources[index]?.web?.uri));
            });
        }
    }

    function recordUsage(raw) {
        let changed = false;
        for (const key of countFields) {
            const value = raw[key];
            if (value === undefined || value === null) continue;
            if (!validCount(value)) {
                inconsistent = true;
                continue;
            }
            if (counts[key] !== undefined && value < counts[key]) inconsistent = true;
            if (counts[key] === undefined || value > counts[key]) {
                counts[key] = value;
                changed = true;
            }
        }
        if (Array.isArray(raw.toolUsePromptTokensDetails) && raw.toolUsePromptTokensDetails.length > 0) {
            const details = raw.toolUsePromptTokensDetails;
            if (!details.every(detail => validCount(detail?.tokenCount))) inconsistent = true;
            else {
                const total = details.reduce((sum, detail) => sum + detail.tokenCount, 0);
                const textOnly = details.every(detail => detail.modality === "TEXT" || detail.tokenCount === 0);
                if (!toolModality || total > toolModality.total) toolModality = {total, textOnly};
                else if (total === toolModality.total) toolModality.textOnly &&= textOnly;
            }
        }
        return changed;
    }

    function setTokenUsage(output, urlInput = 0) {
        const prompt = counts.promptTokenCount ?? 0;
        const cache = counts.cachedContentTokenCount ?? 0;
        const validCache = counts.promptTokenCount === undefined || cache <= prompt;
        if (!validCache) inconsistent = true;
        const reasoning = counts.thoughtsTokenCount ?? 0;
        Object.assign(output.usage, {
            input: prompt - (validCache ? Math.min(prompt, cache) : 0) + urlInput,
            output: (counts.candidatesTokenCount ?? 0) + reasoning,
            cacheRead: validCache ? cache : 0,
            ...(validCache && counts.cachedContentTokenCount !== undefined ? {cacheReadReported:true} : {}),
            reasoning,
            totalTokens: counts.totalTokenCount ?? 0,
        });
        if (!validCache) delete output.usage.cacheReadReported;
        calculateCost(model, output.usage);
    }

    return {
        observe(chunk, output) {
            if (typeof chunk.responseId === "string" && chunk.responseId.trim()) {
                currentResponseId = chunk.responseId;
                output.responseId ??= currentResponseId;
            }
            if (currentResponseId && currentResponseId !== output.responseId) return false;
            if (Array.isArray(chunk.candidates)) {
                multipleCandidates ||= chunk.candidates.length > 1;
                for (const candidate of chunk.candidates) recordCandidate(candidate);
            }
            if (chunk.usageMetadata && recordUsage(chunk.usageMetadata)) setTokenUsage(output);
            return true;
        },
        finish(output, complete) {
            if (finished) return;
            finished = true;
            const searchActivity = searchObserved || queries.size > 0 || webSource || ambiguousSources;
            const toolInput = counts.toolUsePromptTokenCount;
            const urlInput = route && urlOnly && urlRetrieved && !searchActivity && toolInput > 0 &&
                toolModality?.textOnly && toolModality.total === toolInput && validCount(output.usage.input + toolInput) ? toolInput : 0;
            // URL-retrieved content is ordinary model input. Search-retrieved
            // context is excluded, so a mixed total cannot be added wholesale.
            // https://ai.google.dev/gemini-api/docs/pricing#pricing-for-tools
            if (urlInput > 0) setTokenUsage(output, urlInput);
            const cost = output.usage.cost;
            const meters = {};
            if (toolInput !== undefined) meters.google_tool_prompt_tokens = toolInput;
            if (urlInput > 0) meters.google_url_context_input_tokens = urlInput;
            if (searchListObserved) meters.google_search_queries = queries.size;
            if (supportedWebSource) meters.google_web_grounded_prompts = 1;
            else if (route === "vertex" && terminalSourceList && !webSource && !ambiguousSources && !multipleCandidates && complete && searchActivity) {
                meters.google_web_grounded_prompts = 0;
            }
            if (Object.keys(meters).length > 0) cost.serverToolUse = meters;

            const modelMajor = /^gemini-(\d+)(?:\.|-)/.exec(model.id)?.[1];
            if (route && searchActivity && modelMajor) cost.googleGroundingUnit = Number(modelMajor) >= 3 ? "query" : "grounded-prompt";
            // Vertex meters only responses with at least one web grounding URL.
            // Even when the request qualifies, the account's free allowance is unknown.
            // https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
            const searchMayCost = searchActivity && meters.google_web_grounded_prompts !== 0;
            const missingUrlMeter = urlRetrieved && toolInput === undefined;
            const unpricedInput = toolInput > 0 && urlInput === 0 && !(route && searchOnly && searchActivity && !urlRetrieved);
            const hostedActivity = searchActivity || urlRetrieved || toolInput > 0;
            const knownTokens = (counts.promptTokenCount ?? 0) + (counts.candidatesTokenCount ?? 0) + (counts.thoughtsTokenCount ?? 0) + (toolInput ?? 0);
            const missingTokens = hostedActivity && (counts.promptTokenCount === undefined || counts.totalTokenCount > knownTokens);
            if (inconsistent || searchMayCost || missingUrlMeter || unpricedInput || missingTokens || (!complete && hostedActivity)) cost.complete = false;
        },
    };
}

const directOrigin = "https://api.anthropic.com";
const meterKeys = ["web_search_requests", "web_fetch_requests", "code_execution_requests"];
const codeTools = new Set(["code_execution", "bash_code_execution", "text_editor_code_execution"]);
const tokenBuckets = ["input", "output", "cacheRead", "cacheWrite"];

export function isDirectAnthropicBilling(model, response) {
    if (model.provider !== "anthropic" || response.redirected) return false;
    try {
        const base = new URL(model.baseUrl);
        if (base.href !== `${directOrigin}/`) return false;
        if (!response.url) return true;
        const effective = new URL(response.url);
        return effective.origin === directOrigin && effective.pathname === "/v1/messages" && !effective.username && !effective.password;
    } catch {
        return false;
    }
}

export function createAnthropicHostedUsage({ direct, subscription, requestedGeo, tools }) {
    const counts = {};
    const searchResults = new Map();
    let responseId;
    let stopped = false;
    let seenFetch = false;
    let seenCode = false;
    let missingSearchIdentity = false;
    let conflictingCounters = false;
    let deltaSearchRequests;
    let reportedGeo;
    let sawMessage = false;
    let finished = false;

    function recordCounters(raw, delta = false) {
        if (!raw || typeof raw !== "object") return;
        for (const key of meterKeys) {
            const value = raw[key];
            if (value === undefined || value === null) continue;
            if (!Number.isSafeInteger(value) || value < 0) {
                conflictingCounters = true;
                continue;
            }
            if (value < (counts[key] ?? 0)) conflictingCounters = true;
            counts[key] = Math.max(counts[key] ?? 0, value);
            if (delta && key === "web_search_requests") deltaSearchRequests = value;
        }
    }

    function recordSearch(id, outcome) {
        if (typeof id !== "string" || !id.trim()) {
            missingSearchIdentity = true;
            return;
        }
        const prior = searchResults.get(id);
        if (!prior || prior === "pending") searchResults.set(id, outcome);
        else if (outcome !== "pending" && prior !== outcome) searchResults.set(id, "conflict");
    }

    function recordBlock(block) {
        if (block?.type === "server_tool_use") {
            if (block.name === "web_search") recordSearch(block.id, "pending");
            else if (block.name === "web_fetch") seenFetch = true;
            else if (codeTools.has(block.name)) seenCode = true;
        } else if (block?.type === "web_search_tool_result") {
            const content = block.content;
            const success = Array.isArray(content) && content.every(result => result?.type === "web_search_result");
            // Search result blocks arrive whole. An error result carries no separate search fee.
            // https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
            recordSearch(block.tool_use_id, success ? "success" : content?.type === "web_search_tool_result_error" ? "failure" : "pending");
        } else if (block?.type === "web_fetch_tool_result") {
            seenFetch = true;
        } else if (["code_execution_tool_result", "bash_code_execution_tool_result", "text_editor_code_execution_tool_result"].includes(block?.type)) {
            seenCode = true;
        }
    }

    return {
        observe(event) {
            if (event.type === "message_start") {
                const message = event.message;
                if (responseId && message?.id && responseId !== message.id) {
                    searchResults.clear();
                    for (const key of meterKeys) delete counts[key];
                    stopped = seenFetch = seenCode = missingSearchIdentity = conflictingCounters = false;
                    deltaSearchRequests = undefined;
                    reportedGeo = undefined;
                }
                responseId = message?.id ?? responseId;
                sawMessage = true;
                reportedGeo = message?.usage?.inference_geo ?? reportedGeo;
                recordCounters(message?.usage?.server_tool_use);
                if (Array.isArray(message?.content)) {
                    for (const block of message.content) recordBlock(block);
                }
            } else if (event.type === "message_delta") {
                recordCounters(event.usage?.server_tool_use, true);
            } else if (event.type === "content_block_start") {
                recordBlock(event.content_block);
            } else if (event.type === "message_stop") {
                stopped = true;
            }
        },
        finish(usage) {
            if (finished) return;
            finished = true;
            const cost = usage.cost;
            if (direct && sawMessage && requestedGeo === "us") {
                if (reportedGeo === "us") applyUsTokenRates(cost);
                else cost.complete = false;
            }
            if (direct && requestedGeo === "global" && reportedGeo === "us") cost.complete = false;

            let successes = 0;
            let unresolved = missingSearchIdentity;
            for (const outcome of searchResults.values()) {
                if (outcome === "success") successes++;
                else if (outcome !== "failure") unresolved = true;
            }
            const searchActivity = searchResults.size > 0 || missingSearchIdentity || counts.web_search_requests > 0;
            const fetchActivity = seenFetch || counts.web_fetch_requests > 0;
            const codeActivity = seenCode || counts.code_execution_requests > 0;
            const activity = searchActivity || fetchActivity || codeActivity;
            if (searchResults.size > 0) counts.web_search_successes = successes;
            if (Object.keys(counts).length > 0) cost.serverToolUse = counts;
            if (!activity && !conflictingCounters) return;

            const incompleteSearch = unresolved || counts.web_search_requests > successes || deltaSearchRequests < successes;
            const unpricedCode = codeActivity && !hasBundledCodeExecution(tools);
            // https://platform.claude.com/docs/en/about-claude/pricing#tool-use-pricing
            const completeTools = stopped && !incompleteSearch && !unpricedCode && !conflictingCounters;
            if (direct && (successes > 0 || activity && completeTools)) {
                cost.serverToolCost = successes * 0.01;
                cost.serverToolPriceBasis = successes > 0 ? "anthropic-api-published-web-search-rate" : "anthropic-api-published-no-tool-fee";
                cost.total += cost.serverToolCost;
            }
            if (!direct || !completeTools) {
                cost.complete = false;
                if (subscription) usage.costDetails = { reported: 0, estimated: 0, subscription: true, seen: false, unknown: true };
            }
        },
    };
}

function hasBundledCodeExecution(tools) {
    // Anthropic includes code execution when web search or fetch version 20260209 or later is in the request.
    return Array.isArray(tools) && tools.some(tool => {
        const version = typeof tool?.type === "string" && /^web_(?:search|fetch)_(\d{8})$/.exec(tool.type);
        return version && version[1] >= "20260209";
    });
}

function applyUsTokenRates(cost) {
    // https://platform.claude.com/docs/en/about-claude/pricing#data-residency-pricing
    const multiplier = 1.1;
    for (const key of tokenBuckets) cost[key] *= multiplier;
    if (cost.rates) {
        for (const [key, rate] of Object.entries(cost.rates)) cost.rates[key] = rate * multiplier;
    }
    cost.total = tokenBuckets.reduce((total, key) => total + cost[key], 0);
    cost.tokenPriceMultiplier = multiplier;
    cost.tokenPriceMultiplierBasis = "anthropic-us-inference";
}

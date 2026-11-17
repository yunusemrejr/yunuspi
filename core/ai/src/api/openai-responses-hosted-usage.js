import { isFlatPlanProvider } from "../utils/flat-plan.js";
import { isOpenAIEndpoint } from "./openai-prompt-cache.js";

const hostedToolTypes = new Set(["web_search_call", "file_search_call", "image_generation_call", "code_interpreter_call"]);
const hostedProgress = /^response\.(web_search_call|file_search_call|image_generation_call|code_interpreter_call)\.(in_progress|searching|generating|interpreting|partial_image|completed)$/;
const terminalTypes = new Set(["response.completed", "response.incomplete", "response.failed"]);

export function responsesHostedToolRates(model, tools) {
    if (model.provider !== "openai" || !isOpenAIEndpoint(model.baseUrl) || !Array.isArray(tools)) return undefined;
    const url = new URL(model.baseUrl);
    if (!/^\/v1\/?$/.test(url.pathname) || url.port || url.username || url.password || url.search || url.hash) return undefined;
    const types = new Set(tools.map(tool => tool?.type));
    // The output item type alone cannot distinguish standard and preview tool pricing.
    const standardWeb = types.has("web_search") && !types.has("web_search_preview") && !types.has("web_search_preview_2025_03_11");
    // https://developers.openai.com/api/docs/pricing#tools
    return { webSearch: standardWeb ? 0.01 : undefined, fileSearch: types.has("file_search") ? 0.0025 : undefined };
}

export function createResponsesHostedUsageMeter(provider, rates) {
    const responses = new Map();
    let responseId;

    function getResponse(id) {
        let response = responses.get(id);
        if (!response) {
            response = { calls: new Map(), unidentified: false, tokenUsageReported: false };
            responses.set(id, response);
        }
        return response;
    }

    function recordTool(response, id, tool) {
        if (typeof id !== "string" || !id.trim()) {
            response.unidentified = true;
            return;
        }
        const saved = response.calls.get(id);
        if (!saved) {
            response.calls.set(id, tool);
            return;
        }
        saved.conflict ||= tool.conflict || saved.type !== tool.type ||
            (saved.action !== undefined && tool.action !== undefined && saved.action !== tool.action);
        saved.completed ||= tool.completed;
        saved.action ??= tool.action;
    }

    function recordItem(id, item) {
        const type = item?.type;
        const hostedShell = type === "shell_call" && item.environment?.type === "container_reference";
        if (!hostedToolTypes.has(type) && !hostedShell) return;
        const action = type === "web_search_call" && typeof item.action?.type === "string" ? item.action.type : undefined;
        recordTool(getResponse(id), item.id, { type, completed: item.status === "completed", action });
    }

    return {
        observe(event) {
            const terminal = terminalTypes.has(event.type);
            if (event.type === "response.created" || event.type === "response.in_progress" || terminal) {
                const id = event.response?.id;
                if (typeof id === "string" && id) {
                    // Ordinary tool frames omit response ID. The first response
                    // envelope can identify those provisional frames, even at EOF.
                    const provisional = !responseId && responses.get(undefined);
                    if (provisional) {
                        const identified = getResponse(id);
                        identified.unidentified ||= provisional.unidentified;
                        for (const [itemId, tool] of provisional.calls) recordTool(identified, itemId, tool);
                        responses.delete(undefined);
                    }
                    responseId = id;
                }
                if (terminal) {
                    const usage = event.response?.usage;
                    getResponse(responseId).tokenUsageReported ||= [usage?.input_tokens, usage?.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0);
                }
                if (Array.isArray(event.response?.output)) {
                    for (const item of event.response.output) recordItem(responseId, item);
                }
                return;
            }
            const id = typeof event.response_id === "string" && event.response_id ? event.response_id : responseId;
            if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
                recordItem(id, event.item);
            } else {
                const progress = typeof event.type === "string" ? hostedProgress.exec(event.type) : undefined;
                if (progress) recordTool(getResponse(id), event.item_id, { type: progress[1], completed: progress[2] === "completed" });
            }
        },
        finish(output) {
            const response = responses.get(output.responseId ?? responseId);
            if (response?.calls.size || response?.unidentified) {
                applyHostedUsage(output.usage, provider, rates, response.calls, response.unidentified || !response.tokenUsageReported);
            }
        },
    };
}

function applyHostedUsage(usage, provider, rates, calls, incomplete) {
    const counts = {};
    let fees = 0;
    for (const { type, completed, action, conflict } of calls.values()) {
        if (!completed || conflict) {
            incomplete = true;
            continue;
        }
        if (type === "web_search_call" && action !== "search") {
            // The guide identifies the search action as chargeable, not each web item.
            // https://developers.openai.com/api/docs/guides/tools-web-search#output-and-citations
            if (rates?.webSearch === undefined || !["open_page", "find_in_page"].includes(action)) incomplete = true;
            continue;
        }
        counts[type] = (counts[type] ?? 0) + 1;
        const rate = type === "web_search_call" ? rates?.webSearch : type === "file_search_call" ? rates?.fileSearch : undefined;
        fees += rate ?? 0;
        // Search content may have its own input-token charge. The stream does not
        // identify that token bucket separately, so adding it could charge it twice.
        if (rate === undefined || type === "web_search_call") incomplete = true;
    }

    const cost = usage.cost;
    if (Object.keys(counts).length) cost.serverToolUse = counts;
    // A trusted provider-reported total already covers the request.
    if (cost.source === "provider-reported") return;
    if (fees > 0) {
        cost.serverToolCost = fees;
        cost.serverToolPriceBasis = "openai-api-published-tool-rates";
        cost.total += fees;
    }
    if (incomplete) {
        cost.complete = false;
        if (provider === "openai-codex" || isFlatPlanProvider(provider)) {
            usage.costDetails = { reported: 0, estimated: 0, subscription: true, seen: false, unknown: true };
        }
    }
}

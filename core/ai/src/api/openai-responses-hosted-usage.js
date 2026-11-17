import { isFlatPlanProvider } from "../utils/flat-plan.js";
import { isOpenAIEndpoint } from "./openai-prompt-cache.js";

const hostedToolTypes = new Set(["web_search_call", "file_search_call", "image_generation_call", "code_interpreter_call"]);
const hostedProgress = /^response\.(web_search_call|file_search_call|image_generation_call|code_interpreter_call)\.(in_progress|searching|generating|interpreting|partial_image|completed)$/;
const terminalTypes = new Set(["response.completed", "response.incomplete", "response.failed"]);
const standardImageModels = new Set(["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2.6-sunburst", "gpt-image-2.6-flare"]);
const meterCount = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const standardImageTier = value => value == null || ["auto", "default", "standard"].includes(value);

export function responsesHostedToolRates(model, tools, response, serviceTier) {
    if (model.provider !== "openai" || !isOpenAIEndpoint(model.baseUrl) || !Array.isArray(tools)) return undefined;
    const url = new URL(model.baseUrl);
    if (!/^\/v1\/?$/.test(url.pathname) || url.port || url.username || url.password || url.search || url.hash) return undefined;
    if (response?.redirected || response?.url && response.url !== `${url.origin}/v1/responses`) return undefined;
    const types = new Set(tools.map(tool => tool?.type));
    // The output item type alone cannot distinguish standard and preview tool pricing.
    const standardWeb = types.has("web_search") && !types.has("web_search_preview") && !types.has("web_search_preview_2025_03_11");
    // https://developers.openai.com/api/docs/pricing#tools
    const images = tools.filter(tool => tool?.type === "image_generation");
    const imageModel = images[0]?.model;
    const standardImage = url.hostname === "api.openai.com" && standardImageTier(serviceTier) &&
        standardImageModels.has(imageModel) && images.every(tool => tool.model === imageModel);
    return { webSearch: standardWeb ? 0.01 : undefined, fileSearch: types.has("file_search") ? 0.0025 : undefined,
        imageModel: standardImage ? imageModel : undefined };
}

function imageUsage(raw) {
    const input = meterCount(raw?.input_tokens);
    const output = meterCount(raw?.output_tokens);
    const cached = meterCount(raw?.cached_tokens);
    const text = meterCount(raw?.input_tokens_details?.text_tokens);
    const image = meterCount(raw?.input_tokens_details?.image_tokens);
    const outputImage = meterCount(raw?.output_tokens_details?.image_tokens);
    const inputCounts = {}, outputCounts = {};
    if (input !== undefined) inputCounts.image_generation_input_tokens = input;
    if (output !== undefined) outputCounts.image_generation_output_tokens = output;
    if (cached !== undefined) inputCounts.image_generation_cached_tokens = cached;
    if (text !== undefined) inputCounts.image_generation_text_input_tokens = text;
    if (image !== undefined) inputCounts.image_generation_image_input_tokens = image;
    const validImageOutput = output !== undefined && outputImage !== undefined && outputImage <= output;
    if (validImageOutput) outputCounts.image_generation_image_output_tokens = outputImage;
    const outputCost = validImageOutput ? outputImage * 30 / 1e6 : undefined;
    let inputCost;
    if (input !== undefined && cached !== undefined && text !== undefined && image !== undefined &&
        cached <= input && text + image === input) {
        const cache = raw.cached_tokens_details;
        let cachedText = meterCount(cache?.cached_text_tokens);
        if (cache == null && image === 0) cachedText = cached;
        if (cache == null && (text === 0 || cached === 0)) cachedText = 0;
        const cachedImage = cache == null && cachedText !== undefined ? cached - cachedText : meterCount(cache?.cached_image_tokens);
        if (cachedText !== undefined && cachedImage !== undefined && cachedText <= text && cachedImage <= image && cachedText + cachedImage === cached) {
            inputCounts.image_generation_cached_text_tokens = cachedText;
            inputCounts.image_generation_cached_image_tokens = cachedImage;
            // Standard GPT-Image 2.5/2.6 text, image, and cached input rates.
            // https://developers.openai.com/api/docs/pricing#multimodal-models
            inputCost = ((text - cachedText) * 5 + (image - cachedImage) * 8 + cachedText * 1.25 + cachedImage * 2) / 1e6;
        }
    }
    const bucket = (units, counts, cost) => ({ units, counts, cost, active: Object.values(counts).some(value => value > 0) });
    return { input: bucket(input, inputCounts, inputCost), output: bucket(output, outputCounts, outputCost), reportedTotal: meterCount(raw?.total_tokens) };
}

function retainImageBucket(previous, next, terminal) {
    if (previous && (previous.active && !next.active || previous.cost !== undefined && next.cost === undefined ||
        previous.units !== undefined && next.units === undefined || !terminal && previous.units > next.units)) return previous;
    return next;
}

function recordHostedMeters(scope, response, terminal, rates) {
    // This is a response-level cumulative snapshot, separate from base `usage`.
    // https://developers.openai.com/api/reference/resources/responses/methods/retrieve
    const tools = response?.tool_usage;
    if (rates?.imageModel) {
        scope.imagePricingUncertain ||= !standardImageTier(response?.service_tier) || (Array.isArray(response?.tools) &&
            response.tools.some(tool => tool?.type === "image_generation" && tool.model != null && tool.model !== rates.imageModel));
    }
    const web = meterCount(tools?.web_search?.num_requests);
    if (web !== undefined && (terminal || !scope.finalWebMeter)) {
        // Interim zero is a placeholder until completion; a terminal zero can
        // supersede an estimate or previously reported provisional count.
        scope.webRequests = terminal ? web : Math.max(scope.webRequests ?? 0, web);
        scope.finalWebMeter ||= terminal;
    }
    if (tools?.image_gen == null || scope.finalImageMeter && !terminal) return;
    const reported = imageUsage(tools.image_gen);
    // A missing/incomplete image record may be skipped in this aggregate.
    // Preserve previously attested buckets when a later packet omits them.
    const previous = scope.imageMeter;
    const input = retainImageBucket(previous?.input, reported.input, terminal);
    const output = retainImageBucket(previous?.output, reported.output, terminal);
    scope.imageMeter = {
        input, output,
        active: input.active || output.active || reported.reportedTotal > 0 || previous?.active,
    };
    scope.finalImageMeter ||= terminal;
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
                        const { calls, unidentified, ...billing } = provisional;
                        Object.assign(identified, billing);
                        identified.unidentified ||= unidentified;
                        for (const [itemId, tool] of calls) recordTool(identified, itemId, tool);
                        responses.delete(undefined);
                    }
                    responseId = id;
                }
                if (terminal) {
                    const usage = event.response?.usage;
                    getResponse(responseId).tokenUsageReported ||= [usage?.input_tokens, usage?.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0);
                }
                recordHostedMeters(getResponse(responseId), event.response, terminal, rates);
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
            if (response?.calls.size || response?.unidentified || response?.webRequests > 0 || response?.imageMeter?.active) {
                applyHostedUsage(output.usage, provider, rates, response);
            }
        },
    };
}

function applyHostedUsage(usage, provider, rates, response) {
    const counts = {};
    let fees = 0;
    let incomplete = response.unidentified || !response.tokenUsageReported;
    let webObserved = false;
    for (const { type, completed, action, conflict } of response.calls.values()) {
        webObserved ||= type === "web_search_call";
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
        // Search content may have its own input-token charge. The stream does not
        // identify that token bucket separately, so adding it could charge it twice.
        if (type !== "file_search_call" || rates?.fileSearch === undefined) incomplete = true;
        else fees += rates.fileSearch;
    }
    const webMeter = response.webRequests;
    if (webMeter !== undefined && (webObserved || webMeter > 0)) counts.web_search_billable_requests = webMeter;
    const reportedWeb = response.finalWebMeter || webMeter > 0;
    const webUnits = reportedWeb ? webMeter : counts.web_search_call ?? 0;
    fees += webUnits * (rates?.webSearch ?? 0);
    incomplete ||= webMeter > 0;

    const image = response.imageMeter;
    let pricedImage = false;
    if (image?.active) {
        Object.assign(counts, image.input.counts, image.output.counts);
        incomplete = true;
        if (rates?.imageModel && !response.imagePricingUncertain) {
            const imageFee = (image.input.cost ?? 0) + (image.output.cost ?? 0);
            fees += imageFee;
            pricedImage = imageFee > 0;
        }
    }

    const cost = usage.cost;
    if (Object.keys(counts).length) cost.serverToolUse = counts;
    // A trusted provider-reported total already covers the request.
    if (cost.source === "provider-reported") return;
    const knownZeroWeb = webObserved && response.finalWebMeter && webMeter === 0 && rates?.webSearch !== undefined;
    if (fees > 0 || knownZeroWeb) {
        cost.serverToolCost = fees;
        cost.serverToolPriceBasis = pricedImage ? "openai-api-published-tool-and-image-token-rates" : "openai-api-published-tool-rates";
        cost.total += fees;
    }
    if (incomplete) {
        cost.complete = false;
        if (provider === "openai-codex" || isFlatPlanProvider(provider)) {
            usage.costDetails = { reported: 0, estimated: 0, subscription: true, seen: false, unknown: true };
        }
    }
}

import { estimateContextTokens } from "../utils/estimate.js";
// PI_TOKEN_BUDGET (local patch; re-applied by verify-harness.mjs): policy constants.
// PI_TOKEN_BUDGET_CEILING caps the per-response output; PI_TOKEN_BUDGET_SCALE
// floors the context reserve (which also scales with the estimated input).
export const PI_TOKEN_BUDGET_CEILING = 32768;
export const PI_TOKEN_BUDGET_SCALE = 8192;
const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;
export function clampMaxTokensToContext(model, context, maxTokens) {
    /* PI_TOKEN_BUDGET: finite output ceiling; small windows retain useful headroom. */
    const declared = Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? Math.floor(model.maxTokens) : PI_TOKEN_BUDGET_CEILING;
    const requested = Number.isFinite(maxTokens) ? Math.floor(maxTokens) : declared;
    const ceiling = Math.max(MIN_MAX_TOKENS, Math.min(requested, declared, PI_TOKEN_BUDGET_CEILING));
    if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return ceiling;
    const window = Math.floor(model.contextWindow);
    const estimated = estimateContextTokens(context).tokens;
    if (!Number.isFinite(estimated) || estimated < 0) throw new Error("Cannot estimate request context; refusing an unsafe output budget.");
    const floor = Math.min(Math.max(CONTEXT_SAFETY_TOKENS, PI_TOKEN_BUDGET_SCALE), Math.max(128, Math.floor(window / 8)));
    const reserve = Math.max(floor, Math.ceil(estimated * 0.05));
    const available = window - estimated - reserve;
    // Signal Pi's existing bounded compact-and-retry before any provider request.
    // Explicit small output requests remain valid when they actually fit.
    const minimum = Math.min(ceiling, 1024, Math.max(128, Math.floor(window / 16)));
    if (available < minimum) throw new Error("Context length exceeded: insufficient reply headroom (" + available + " tokens available; " + minimum + " needed). Compact context before retrying.");
    return Math.min(ceiling, available);
}
export function buildBaseOptions(model, context, options, apiKey) {
    const samplingParams = model.samplingParams || options?.samplingParams
        ? { ...model.samplingParams, ...options?.samplingParams }
        : undefined;
    return {
        temperature: options?.temperature,
        samplingParams,
        maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
        signal: options?.signal,
        telemetryContext: options?.telemetryContext,
        apiKey: apiKey || options?.apiKey,
        fetch: options?.fetch,
        transport: options?.transport,
        cacheRetention: options?.cacheRetention,
        sessionId: options?.sessionId,
        headers: options?.headers,
        onPayload: options?.onPayload,
        onResponse: options?.onResponse,
        timeoutMs: options?.timeoutMs,
        websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
        maxRetries: options?.maxRetries,
        maxRetryDelayMs: options?.maxRetryDelayMs,
        metadata: options?.metadata,
        env: options?.env,
    };
}
/** Tokens always left for the answer when a thinking budget shares the response ceiling. */
export const MIN_ANSWER_TOKENS = 1024;
export const DEFAULT_THINKING_BUDGETS = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
};
export function clampReasoning(effort) {
    return effort === "xhigh" || effort === "max" ? "high" : effort;
}
export function thinkingBudgetForLevel(reasoningLevel, customBudgets) {
    const budgets = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets };
    const level = clampReasoning(reasoningLevel);
    return budgets[level];
}
/** Cap a thinking budget so at least MIN_ANSWER_TOKENS remain under a shared response ceiling. */
export function clampThinkingBudgetToAnswerRoom(thinkingBudget, ceiling) {
    return Math.min(thinkingBudget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}
export function adjustMaxTokensForThinking(
// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
baseMaxTokens, modelMaxTokens, reasoningLevel, customBudgets) {
    let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);
    const maxTokens = baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
    if (maxTokens <= thinkingBudget) {
        thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
    }
    return { maxTokens, thinkingBudget };
}

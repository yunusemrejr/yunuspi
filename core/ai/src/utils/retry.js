function buildProviderErrorPattern(patterns) {
    return new RegExp(patterns.join("|"), "i");
}
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
    // OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
    // Zen API. These are subscription/account limits, not transient throttles.
    "GoUsageLimitError",
    "FreeUsageLimitError",
    // OpenCode Go subscription-limit text asks users to enable available-balance
    // usage after rolling/weekly/monthly limits are reached.
    "Monthly usage limit reached",
    "available balance",
    // Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
    // quota/billing error code; the other strings cover common gateway wording.
    "insufficient_quota",
    "out of budget",
    "quota exceeded",
    "billing",
]);
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
    // Generic provider load, HTTP status, and server-side transient failures.
    "overloaded",
    "rate.?limit",
    "too many requests",
    "429",
    "500",
    "502",
    "503",
    "504",
    "524",
    "service.?unavailable",
    "server.?error",
    "internal.?error",
    // Wrapper/provider text for transient upstream failures, including OpenRouter
    // "Provider returned error" responses (#2264).
    "provider.?returned.?error",
    "exceeded request buffer limit while retrying upstream",
    // Network, proxy, and fetch transport failures. This includes OpenAI Codex
    // raw-fetch failures such as "upstream connect", "connection refused", and
    // "reset before headers" (#733), plus OpenRouter connection drops (#3317).
    "network.?error",
    "connection.?error",
    "connection.?refused",
    "connection.?lost",
    "other side closed",
    "fetch failed",
    "getaddrinfo",
    "ENOTFOUND",
    "EAI_AGAIN",
    "upstream.?connect",
    "reset before headers",
    "socket hang up",
    "socket connection was closed",
    "timed? out",
    "timeout",
    "terminated",
    // WebSocket transports can report close/error text instead of HTTP/fetch text.
    "websocket.?closed",
    "websocket.?error",
    // Premature stream endings from SDKs and transports. Anthropic can throw
    // "stream ended without ..." and "Anthropic stream ended before message_stop"
    // (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
    "ended without",
    "stream ended before message_stop",
    "stream ended before a terminal response event",
    "http2 request did not get a response",
    // Provider-requested retry delay cap failures should flow through the outer
    // retry policy so callers can surface/abort the backoff (#1123).
    "retry delay",
    // Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
    // stream exceptions (#6019).
    "you can retry your request",
    "try your request again",
    "please retry your request",
    // gRPC based providers (e.g. NVIDIA NIM)
    "ResourceExhausted",
    // pi-harness local patch (re-applied by verify-harness.mjs): gateway
    // mid-stream SSE error injection — OpenRouter-style 502 prose with no
    // HTTP status in the text, so it previously fell through every pattern
    // above and turned a transient upstream blip into a fatal turn error.
    "json error injected into sse stream",
    "stream_read_error",
    // pi-harness local patch (2026-09-02): OpenRouter terminates a stream
    // with finish_reason "error" when the routed-upstream provider fails
    // mid-generation (pi's message: "Provider finish_reason: error") —
    // transient, upstream-side (the next request re-routes); cooldown
    // class since 2026-09-04 (see RATE_LIMIT_RE).
    "finish_reason: error",
    // pi-harness local patch (2026-09-03): the empty-response annotation note
    // phrase (see Target 6+7) — the annotated message is stopReason "error" +
    // this errorMessage, and the second classification (post-run retry) must
    // still match this pattern for the retry to engage.
    "no actionable content",
    // pi-harness local patch (2026-09-06): codex WebSocket transport death —
    // a dropped stream/connection surfaces as stopReason "error" with this
    // message and zero billed output (observed 2026-09-06, openai-codex);
    // transient, retried under the stock budget (not the cooldown class).
    "WebSocket error",
    // pi-harness local patch (2026-09-07): Node HTTP/2 transport reset —
    // "h2 protocol error: error reading a body from connection" surfaces
    // when the provider's HTTP/2 connection is reset mid-body (observed
    // 2026-09-07, together/deepseek); transient, retried under the stock
    // budget (not the cooldown class).
    "h2 protocol error",
]);
// pi-harness local patch v2 (re-applied by verify-harness.mjs): deterministic
// content-moderation rejections must NOT be blind-retried with an identical
// payload (3 identical retries of a deterministic rejection is pure waste).
// They fail fast so the agent can modify the request or route elsewhere;
// transient provider errors keep the normal retry budget.
const DETERMINISTIC_REJECTION_PATTERN = /data_inspection_failed|inappropriate content|content inspection|content filter|content moderation|invalid[ _-](?:request|parameters?|arguments?)|unsupported[ _-]parameter|unrecognized request argument/i;
class RetrySleepAbortError extends Error {
    constructor() {
        super("Aborted");
    }
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new RetrySleepAbortError());
            return;
        }
        const timeout = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(new RetrySleepAbortError());
        }, { once: true });
    });
}
/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(produce, policy, signal, callbacks) {
    const maxAttempts = policy?.enabled ? policy.maxRetries : 0;
    let attempt = 0;
    let lastRetry;
    let rateLimitLoopStart = 0;
    for (;;) {
        const response = await produce();
        /* PI_AUX_EMPTY_RESPONSE */
        if (policy?.enabled === true && response.stopReason === "stop") isRetryableAssistantError(response);
        // Abort: terminal but not successful. Never retry an aborted message.
        if (response.stopReason === "aborted") {
            if (lastRetry)
                await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
            return response;
        }
        // Success: non-error, non-abort responses return as-is.
        if (response.stopReason !== "error") {
            if (lastRetry)
                await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
            return response;
        }
        // A disabled retry policy is authoritative for every error class.
        if (policy?.enabled !== true) {
            return response;
        }
        // Non-retryable errors return immediately.
        if (!isRetryableAssistantError(response)) {
            if (lastRetry)
                await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
            return response;
        }
        // PI_RATE_LIMIT_POLICY (local patch): cooldown-class errors (rate limits +
        // provider-unavailable 503s + gateway/upstream stream failures) get a
        // FIXED 25s cooldown and no maxRetries cap while this call has spent
        // <2min in the consecutive loop; beyond that, give up with the final
        // error so callers stop hammering the same shared pool.
        const rateLimited = /\b429\b|\b503\b|rate.?limit|too many requests|service.?unavailable|temporar(?:ily)? unavailable|upstream_unavailable|json error injected into sse stream|stream_read_error|finish_reason: error/i.test(response.errorMessage || "");
        // The ordinary retry cap must be evaluated AFTER classification;
        // otherwise the documented two-minute cooldown budget is unreachable.
        if (attempt >= maxAttempts && !rateLimited) {
            if (lastRetry)
                await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
            return response;
        }
        if (rateLimited) {
            if (!rateLimitLoopStart) rateLimitLoopStart = Date.now();
            if (Date.now() - rateLimitLoopStart > 120000) {
                if (lastRetry)
                    await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
                return response;
            }
        } else {
            rateLimitLoopStart = 0;
        }
        attempt++;
        lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
        const delayMs = rateLimited
            ? 25000
            : policy.baseDelayMs * 2 ** (attempt - 1);
        await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);
        // Normalize aborts during retry backoff to the same AssistantMessage shape as
        // provider stream aborts, so callers do not need to care when cancellation happened.
        try {
            await sleep(delayMs, signal);
        }
        catch (error) {
            await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
            if (error instanceof RetrySleepAbortError) {
                const { errorMessage: _errorMessage, ...rest } = response;
                return { ...rest, stopReason: "aborted" };
            }
            throw error;
        }
        await callbacks?.onRetryAttemptStart?.();
    }
}
/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message) {
    // PI_EMPTY_RESPONSE_POLICY (local patch; re-applied by verify-harness.mjs): a
    // stop response with no tool calls and no non-empty text is a provider
    // anomaly (reasoning-only/empty stream that billed tokens and halted the run
    // silently — friendli GLM-5.3-flash 2026-09-03). Annotate it as a first-class
    // retryable error so the existing retry loops (outer _prepareRetry ->
    // agent.continue(), inner retryAssistantCall) auto-continue under the normal
    // maxRetries budget; on exhaustion the run ends with a visible error instead
    // of a silent halt. Aborted, length, text-only, and tool-call turns keep
    // their existing semantics.
    if (
        message.stopReason === "stop" &&
        !(Array.isArray(message.content) &&
            message.content.some((block) =>
                block &&
                (block.type === "toolCall" ||
                    (block.type === "text" &&
                        typeof block.text === "string" &&
                        block.text.trim().length > 0)),
            ))
    ) {
        message.stopReason = "error";
        message.errorMessage ??= "Provider returned no actionable content (empty/thinking-only response)";
        return true;
    }
    if (message.stopReason !== "error" || !message.errorMessage)
        return false;
    const errorMessage = message.errorMessage;
    if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage))
        return false;
    if (DETERMINISTIC_REJECTION_PATTERN.test(errorMessage))
        return false; /* pi-harness local patch v2 */
    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

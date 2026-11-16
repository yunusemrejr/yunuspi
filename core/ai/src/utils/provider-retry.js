const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
export const MAX_RETRY_TIMER_MS = 2_147_483_647;
// A gate deadline is local policy evidence. A symbol survives shallow result
// copies while keeping the deadline out of serialized messages and receipts.
const sharedProviderCooldown = Symbol.for("yunuspi.shared-provider-cooldown.v1");
export function setSharedProviderCooldown(target, until) {
    if (Number.isSafeInteger(until) && until > 0) target[sharedProviderCooldown] = until;
}
export function getSharedProviderCooldown(target) {
    const until = target?.[sharedProviderCooldown];
    return Number.isSafeInteger(until) && until > 0 ? until : undefined;
}
function isProviderError(error) {
    if (!(error instanceof Error) || !("status" in error) || !("headers" in error))
        return false;
    return ((error.status === undefined || typeof error.status === "number") &&
        (error.headers === undefined || error.headers instanceof Headers));
}
/** Mirrors the pinned OpenAI/Anthropic SDK retry policy; review when either SDK is upgraded. */
function isRetryableProviderError(error) {
    const shouldRetry = error.headers?.get("x-should-retry");
    if (shouldRetry === "true")
        return true;
    if (shouldRetry === "false")
        return false;
    if (error.status === undefined)
        return true;
    return (error.status === 408 ||
        error.status === 409 ||
        error.status === 429 ||
        (typeof error.status === "number" && error.status >= 500));
}
function validateServerRetryDelayMs(delayMs, maxRetryDelayMs, providerErrorMessage) {
    const configured = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    const maxDelayMs = configured > 0 ? Math.min(configured, MAX_RETRY_TIMER_MS) : MAX_RETRY_TIMER_MS;
    if (delayMs > maxDelayMs) {
        throw new Error(`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`);
    }
    return delayMs;
}
function retryHeader(headers, name) {
    if (typeof headers?.get === "function") return headers.get(name);
    if (!headers || typeof headers !== "object") return undefined;
    const key = Object.keys(headers).find(key => key.toLowerCase() === name);
    return key === undefined ? undefined : headers[key];
}
function numericRetryDelay(value, scale) {
    if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
    return Math.min(Math.ceil(Number(value) * scale), Number.MAX_SAFE_INTEGER);
}
export function readRetryAfterMs(headers, now = Date.now()) {
    const exact = numericRetryDelay(retryHeader(headers, "retry-after-ms"), 1);
    if (exact !== undefined) return exact;
    const hint = retryHeader(headers, "retry-after");
    const seconds = numericRetryDelay(hint, 1000);
    if (seconds !== undefined) return seconds;
    if (typeof hint !== "string" || !/^[a-z]{3},\s/i.test(hint)) return undefined;
    const date = Date.parse(hint);
    return Number.isFinite(date) && date >= now ? date - now : undefined;
}
/** Keep only typed transport retry advice. SDK response bodies can contain
 * arbitrary prose and cannot override these headers. */
export function captureProviderRetryAdvice(message, error) {
    const response = error?.$response;
    const headers = error?.headers ?? response?.headers;
    const status = [error?.status, error?.statusCode, error?.$metadata?.httpStatusCode, response?.statusCode]
        .find(value => Number.isInteger(value) && value >= 100 && value <= 599);
    const retryAfterMs = readRetryAfterMs(headers);
    const allowed = retryHeader(headers, "x-should-retry");
    if (status !== undefined || retryAfterMs !== undefined || allowed === "true" || allowed === "false") {
        message.providerRetry = {
            ...message.providerRetry,
            ...(status === undefined ? {} : { status }),
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            ...(allowed === "true" || allowed === "false" ? { retryAllowed: allowed === "true" } : {}),
        };
    }
}
function getRetryDelayMs(error, retryIndex, maxRetryDelayMs) {
    const hint = readRetryAfterMs(error.headers);
    if (hint !== undefined) return validateServerRetryDelayMs(hint, maxRetryDelayMs, error.message);
    const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
    return exponentialDelay * (1 - Math.random() * 0.25);
}
function createAbortError() {
    const error = new Error("Request aborted");
    error.name = "AbortError";
    return error;
}
function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timeout);
            reject(createAbortError());
        };
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, Math.max(0, ms));
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 */
export async function retryProviderRequest(request, options = {}) {
    const maxRetries = options.retryOwner === "session" ? 0 : options.maxRetries ?? 0;
    let retriesRemaining = maxRetries;
    for (;;) {
        if (options.signal?.aborted)
            throw createAbortError();
        try {
            // Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
            return await request();
        }
        catch (error) {
            if (options.signal?.aborted)
                throw createAbortError();
            if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error))
                throw error;
            const retryIndex = maxRetries - retriesRemaining;
            retriesRemaining--;
            await abortableSleep(getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs), options.signal);
        }
    }
}

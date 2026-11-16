import type { AssistantMessage, ProviderRequestOptions } from "../types.ts";
export declare const MAX_RETRY_TIMER_MS = 2147483647;
export declare function setSharedProviderCooldown(target: AssistantMessage | Error, until: number | undefined): void;
export declare function getSharedProviderCooldown(target: AssistantMessage | Error | undefined): number | undefined;
interface ProviderRetryOptions extends Pick<ProviderRequestOptions, "retryOwner"> {
    maxRetries?: number;
    maxRetryDelayMs?: number;
    signal?: AbortSignal;
}
export declare function readRetryAfterMs(headers?: Headers | Record<string, unknown>, now?: number): number | undefined;
export declare function captureProviderRetryAdvice(message: Pick<AssistantMessage, "providerRetry">, error: unknown): void;
/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 */
export declare function retryProviderRequest<T>(request: () => Promise<T>, options?: ProviderRetryOptions): Promise<T>;
export {};

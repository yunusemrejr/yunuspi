/** A rejection from the response body's reader, before any SSE decoding. */
export declare class SseBodyReadError extends Error {
    readonly pendingEvent: boolean;
    constructor(cause: unknown, pendingEvent: boolean);
}
export declare function iterateSseMessages(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string | null; data: string; raw: string[] }>;

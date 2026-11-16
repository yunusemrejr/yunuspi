export declare function iterateSseMessages(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string | null; data: string; raw: string[] }>;

import { AssistantMessageEventStream } from "../utils/event-stream.js";
function createSetupErrorMessage(model, error) {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
    };
}
function hasResult(source) {
    return typeof source.result === "function";
}
async function forwardStream(target, source, mapMessage) {
    for await (let event of source) {
        if (mapMessage) {
            const field = event.type === "done" ? "message" : event.type === "error" ? "error" : "partial";
            const message = event[field];
            const mapped = message && mapMessage(message);
            if (mapped !== message) event = { ...event, [field]: mapped };
        }
        target.push(event);
    }
    const result = hasResult(source) ? await source.result() : undefined;
    target.end(result && mapMessage ? mapMessage(result) : result);
}
/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 */
export function lazyStream(model, setup, mapMessage) {
    const outer = new AssistantMessageEventStream();
    setup()
        .then((inner) => forwardStream(outer, inner, mapMessage))
        .catch((error) => {
        const message = createSetupErrorMessage(model, error);
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
    });
    return outer;
}
export function lazyApi(load, capabilities) {
    const api = {
        stream: (model, context, options) => lazyStream(model, async () => (await load()).stream(model, context, options)),
        streamSimple: (model, context, options) => lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
    };
    if (capabilities?.fetchDeferred) {
        api.fetchDeferred = (model, handle, options) => lazyStream(model, async () => {
            const implementation = await load();
            if (!implementation.fetchDeferred)
                throw new Error("API does not support deferred responses");
            return implementation.fetchDeferred(model, handle, options);
        });
    }
    if (capabilities?.cancelDeferred) {
        api.cancelDeferred = async (model, handle, options) => {
            const implementation = await load();
            if (!implementation.cancelDeferred)
                throw new Error("API cannot cancel deferred responses");
            await implementation.cancelDeferred(model, handle, options);
        };
    }
    return api;
}

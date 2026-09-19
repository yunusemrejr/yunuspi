// Generic event stream class for async iteration
export class EventStream {
    queue = [];
    waiting = [];
    done = false;
    finalResultPromise;
    resolveFinalResult;
    isComplete;
    extractResult;
    constructor(isComplete, extractResult) {
        this.isComplete = isComplete;
        this.extractResult = extractResult;
        this.finalResultPromise = new Promise((resolve) => {
            this.resolveFinalResult = resolve;
        });
    }
    push(event) {
        if (this.done)
            return;
        if (this.isComplete(event)) {
            this.done = true;
            this.resolveFinalResult(this.extractResult(event));
        }
        // Deliver to waiting consumer or queue it
        const waiter = this.waiting.shift();
        if (waiter) {
            waiter({ value: event, done: false });
        }
        else {
            this.queue.push(event);
        }
    }
    end(result) {
        this.done = true;
        if (result !== undefined) {
            this.resolveFinalResult(result);
        }
        // Notify all waiting consumers that we're done
        while (this.waiting.length > 0) {
            const waiter = this.waiting.shift();
            waiter({ value: undefined, done: true });
        }
    }
    async *[Symbol.asyncIterator]() {
        while (true) {
            if (this.queue.length > 0) {
                yield this.queue.shift();
            }
            else if (this.done) {
                return;
            }
            else {
                const result = await new Promise((resolve) => this.waiting.push(resolve));
                if (result.done)
                    return;
                yield result.value;
            }
        }
    }
    result() {
        return this.finalResultPromise;
    }
}
export class AssistantMessageEventStream extends EventStream {
    constructor() {
        super((event) => event.type === "done" || event.type === "error", (event) => {
            if (event.type === "done") {
                return event.message;
            }
            else if (event.type === "error") {
                return event.error;
            }
            throw new Error("Unexpected event type for final result");
        });
    }
}
/** Factory function for AssistantMessageEventStream (for use in extensions) */

/* PI_STREAM_IDLE_V1: event progress, including thinking/tool fragments. */
// Symbol.for also deduplicates a runtime bundle calling an SDK custom stream.
// This marker is written ONLY to our own child signal, never the caller's.
const piStreamIdleSignalOwner = Symbol.for("pi-harness.stream-idle.v1");
export function piWithStreamIdle(model, options, start) {
    if (options?.signal?.[piStreamIdleSignalOwner] === true) return start(options);
    const outer = new AssistantMessageEventStream();
    const controller = new AbortController();
    const callerSignal = options?.signal;
    let timer, pendingStop, iterator, finished = false, lastMessage;
    const errorMessage = (error, reason) => {
        let message;
        try { if (lastMessage) message = structuredClone(lastMessage); } catch {}
        message ??= {
            role: "assistant", content: [], api: model.api, provider: model.provider,
            model: model.id, timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
        };
        for (const block of message.content) {
            delete block.partialJson;
            delete block.customInput;
        }
        message.stopReason = reason;
        message.errorMessage = error instanceof Error ? error.message : String(error);
        return message;
    };
    const cleanup = () => {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onAbort);
        delete controller.signal[piStreamIdleSignalOwner];
        pendingStop?.();
    };
    const fail = (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        const reason = callerSignal?.aborted ? "aborted" : "error";
        const message = errorMessage(error, reason);
        outer.push({ type: "error", reason, error: message });
        outer.end(message);
        // Settlement precedes transport cancellation; never wait for driver cleanup.
        controller.abort(error);
    };
    const onAbort = () => fail(new Error("Request was aborted"));
    const dispose = (it) => {
        try { Promise.resolve(it?.return?.()).catch(() => {}); } catch {}
    };
    // At most one cancellation waiter, rather than one permanently retained
    // Promise.race handler per token on a long-running stream.
    const wait = async (work) => {
        try {
            return await new Promise((resolve, reject) => {
                pendingStop = () => resolve(undefined);
                Promise.resolve(work).then(resolve, reject);
                if (finished) pendingStop();
            });
        } finally { pendingStop = undefined; }
    };
    let idleMs;
    try {
        const configured = options?.timeoutMs ?? options?.env?.PI_STREAM_IDLE_MS ??
            (typeof process !== "undefined" ? process.env?.PI_STREAM_IDLE_MS : undefined) ?? 300000;
        idleMs = Number(configured);
        if (String(configured).trim() === "" || !Number.isFinite(idleMs) || idleMs < 0 || idleMs > 2147483647)
            throw new Error("Invalid PI_STREAM_IDLE_MS/timeoutMs inactivity budget: " + String(configured));
        idleMs = Math.floor(idleMs);
    } catch (error) { fail(error); return outer; }
    const reset = () => {
        clearTimeout(timer);
        if (idleMs > 0) timer = setTimeout(() => fail(new Error(
            "Provider stream idle timeout after " + idleMs + "ms without assistant events"
        )), idleMs);
    };
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    if (callerSignal?.aborted) { onAbort(); return outer; }
    Object.defineProperty(controller.signal, piStreamIdleSignalOwner, { value: true, configurable: true });
    reset();
    void (async () => {
        try {
            const source = await wait(Promise.resolve().then(() => {
                if (!finished) return start({ ...options, signal: controller.signal });
            }).then((source) => {
                if (finished && source) dispose(source[Symbol.asyncIterator]());
                return source;
            }));
            if (finished) return;
            iterator = source[Symbol.asyncIterator]();
            while (!finished) {
                const next = await wait(iterator.next());
                if (finished) return;
                if (next.done) {
                    // A result() that never settles is covered by the same budget.
                    const result = await wait(typeof source.result === "function" ? source.result() : undefined);
                    if (finished) return;
                    if (!result || result.stopReason === "pending") throw new Error("Provider stream ended without a final result");
                    const type = result.stopReason === "error" || result.stopReason === "aborted" ? "error" : "done";
                    finished = true;
                    cleanup();
                    outer.push(type === "error" ? { type, reason: result.stopReason, error: result } : { type, reason: result.stopReason, message: result });
                    outer.end(result);
                    return;
                }
                const event = next.value;
                lastMessage = event.partial ?? event.message ?? event.error ?? lastMessage;
                if (event.type === "done" || event.type === "error") {
                    finished = true;
                    cleanup();
                    outer.push(event);
                    outer.end(event.type === "done" ? event.message : event.error);
                    return;
                }
                reset();
                outer.push(event);
            }
        } catch (error) { fail(error); }
        finally { dispose(iterator); }
    })();
    return outer;
}

export function createAssistantMessageEventStream() {
    return new AssistantMessageEventStream();
}

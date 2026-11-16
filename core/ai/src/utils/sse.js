function flushSseEvent(state) {
    if (!state.event && state.data.length === 0) {
        state.raw = [];
        return null;
    }
    const event = {
        event: state.event,
        data: state.data.join("\n"),
        raw: [...state.raw],
    };
    state.event = null;
    state.data = [];
    state.raw = [];
    return event;
}
function decodeSseLine(line, state) {
    if (line === "") {
        return flushSseEvent(state);
    }
    state.raw.push(line);
    if (line.startsWith(":")) {
        return null;
    }
    const delimiterIndex = line.indexOf(":");
    const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
    let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
    if (value.startsWith(" ")) {
        value = value.slice(1);
    }
    if (fieldName === "event") {
        state.event = value;
    }
    else if (fieldName === "data") {
        state.data.push(value);
    }
    return null;
}
function consumeLine(text) {
    const lineBreakIndex = text.search(/[\r\n]/);
    if (lineBreakIndex === -1) {
        return null;
    }
    const carriageReturn = text[lineBreakIndex] === "\r";
    const afterBreak = lineBreakIndex + 1;
    const nextIndex = carriageReturn && text[afterBreak] === "\n" ? afterBreak + 1 : afterBreak;
    return {
        line: text.slice(0, lineBreakIndex),
        rest: text.slice(nextIndex),
        trailingCarriageReturn: carriageReturn && afterBreak === text.length,
    };
}
/** A rejection from the response body's reader, before any SSE decoding. */
export class SseBodyReadError extends Error {
    constructor(cause, pendingEvent) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.pendingEvent = pendingEvent;
    }
}
export async function* iterateSseMessages(body, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const state = { event: null, data: [], raw: [] };
    const onAbort = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener("abort", onAbort, { once: true });
    let buffer = "";
    let skipLeadingLf = false;
    try {
        while (true) {
            if (signal?.aborted) {
                throw new Error("Request was aborted");
            }
            let read;
            try {
                read = await reader.read();
            } catch (error) {
                if (signal?.aborted || error?.name === "AbortError") throw error;
                // Include incomplete UTF-8 and the unparsed last line. Blank
                // separators and comment-only keepalives carry no event data.
                const trailing = buffer + decoder.decode();
                const pendingEvent = state.event !== null || state.data.length > 0 ||
                    (trailing.trim() !== "" && !trailing.startsWith(":"));
                throw new SseBodyReadError(error, pendingEvent);
            }
            if (signal?.aborted) {
                throw new Error("Request was aborted");
            }
            const { value, done } = read;
            if (done) {
                break;
            }
            const chunk = decoder.decode(value, { stream: true });
            if (chunk.length === 0) continue;
            // CR is itself a line break. Consume it immediately, then ignore
            // the optional LF even when it arrives in the next chunk.
            buffer += skipLeadingLf && chunk.startsWith("\n") ? chunk.slice(1) : chunk;
            skipLeadingLf = false;
            let consumed = consumeLine(buffer);
            while (consumed) {
                buffer = consumed.rest;
                skipLeadingLf = consumed.trailingCarriageReturn;
                const event = decodeSseLine(consumed.line, state);
                if (event) {
                    yield event;
                }
                consumed = consumeLine(buffer);
            }
        }
        buffer += decoder.decode();
        let consumed = consumeLine(buffer);
        while (consumed) {
            buffer = consumed.rest;
            const event = decodeSseLine(consumed.line, state);
            if (event) {
                yield event;
            }
            consumed = consumeLine(buffer);
        }
        if (buffer.length > 0) {
            const event = decodeSseLine(buffer, state);
            if (event) {
                yield event;
            }
        }
        const trailingEvent = flushSseEvent(state);
        if (trailingEvent) {
            yield trailingEvent;
        }
    }
    finally {
        signal?.removeEventListener("abort", onAbort);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

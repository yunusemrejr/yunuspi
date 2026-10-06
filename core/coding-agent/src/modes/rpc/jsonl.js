import { StringDecoder } from "node:string_decoder";
/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value) {
    return `${JSON.stringify(value)}\n`;
}
/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 */
export function attachJsonlLineReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let fragments = [];
    let active = true;
    const append = (part) => {
        if (!part.length) return;
        const last = fragments.length - 1;
        // Avoid retaining one array entry per byte when a peer fragments a
        // record unusually finely, without repeatedly flattening the record.
        if (last >= 0 && fragments[last].length < 8192) fragments[last] += part;
        else fragments.push(part);
    };
    const emitLine = (line) => {
        onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    };
    const consume = (text) => {
        let start = 0, newlineIndex;
        // Keep incomplete records as chunks: repeatedly concatenating and
        // scanning a long JSON/image record made one-byte feeds quadratic.
        while (active && (newlineIndex = text.indexOf("\n", start)) !== -1) {
            const part = text.slice(start, newlineIndex);
            append(part);
            const line = fragments.join("");
            fragments = [];
            start = newlineIndex + 1;
            emitLine(line);
        }
        if (active && start < text.length) append(text.slice(start));
    };
    const onData = (chunk) => {
        if (active) consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
    };
    const onEnd = () => {
        if (!active) return;
        consume(decoder.end());
        if (active && fragments.length) {
            const line = fragments.join("");
            fragments = [];
            emitLine(line);
        }
        detach();
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    function detach() {
        active = false;
        fragments = [];
        stream.off("data", onData);
        stream.off("end", onEnd);
    }
    return detach;
}

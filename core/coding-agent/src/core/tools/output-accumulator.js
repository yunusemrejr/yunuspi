import { randomBytes } from "node:crypto";
import { createWriteStream, unlink } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "./truncate.js";
function defaultTempFilePath(prefix) {
    const id = randomBytes(8).toString("hex");
    return join(tmpdir(), `${prefix}-${id}.log`);
}
function byteLength(text) {
    return Buffer.byteLength(text, "utf-8");
}
/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
    maxLines;
    maxBytes;
    maxRollingBytes;
    tempFilePrefix;
    decoder = new TextDecoder();
    rawChunks = [];
    tailText = "";
    tailBytes = 0;
    tailStartsAtLineBoundary = true;
    totalRawBytes = 0;
    totalDecodedBytes = 0;
    completedLines = 0;
    totalLines = 0;
    currentLineBytes = 0;
    hasOpenLine = false;
    finished = false;
    tempFilePath;
    tempFileStream;
    tempFileOpened = false;
    captureError;
    headText = "";
    outputMode;
    pendingDrain;
    constructor(options = {}) {
        this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
        this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
        this.outputMode = options.outputMode ?? "tail";
    }
    append(data) {
        if (this.finished) {
            throw new Error("Cannot append to a finished output accumulator");
        }
        this.totalRawBytes += data.length;
        this.appendDecodedText(this.decoder.decode(data, { stream: true }));
        if (this.tempFileStream || this.shouldUseTempFile()) {
            this.ensureTempFile();
            const stream = this.tempFileStream;
            if (!stream) return;
            // Owned producers await this promise and pause both pipes. A legacy
            // adapter ignoring backpressure must not create an unbounded queue.
            if (stream.writableLength + data.length > 2 * 1024 * 1024) {
                this.failCapture("producer ignored output backpressure", stream);
                return;
            }
            if (!stream.write(data)) return this.waitForDrain(stream);
        }
        else if (data.length > 0) {
            this.rawChunks.push(data);
        }
    }
    finish() {
        if (this.finished) {
            return;
        }
        this.finished = true;
        this.appendDecodedText(this.decoder.decode());
        if (this.shouldUseTempFile()) {
            this.ensureTempFile();
        }
    }
    snapshot(options = {}) {
        const tailTruncation = truncateTail(this.getSnapshotText(), {
            maxLines: this.maxLines,
            maxBytes: this.maxBytes,
        });
        const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
        const truncatedBy = truncated
            ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
            : null;
        const truncation = {
            ...tailTruncation,
            truncated,
            truncatedBy,
            totalLines: this.totalLines,
            totalBytes: this.totalDecodedBytes,
            maxLines: this.maxLines,
            maxBytes: this.maxBytes,
        };
        let content = truncation.content;
        if (truncated && this.outputMode === "head-tail") {
            const marker = "\n[... middle output omitted ...]\n";
            const budget = Math.max(0, this.maxBytes - byteLength(marker));
            const head = this.bytePrefix(this.headText, Math.floor(budget / 2));
            const tail = truncateTail(this.getSnapshotText(), {
                maxLines: Math.max(1, Math.floor(this.maxLines / 2)),
                maxBytes: budget - byteLength(head),
            }).content;
            content = head + marker + tail;
            truncation.content = content;
            truncation.outputBytes = byteLength(content);
            truncation.outputLines = content.split("\n").length;
        }
        if (options.persistIfTruncated && truncation.truncated) {
            this.ensureTempFile();
        }
        return {
            content,
            truncation,
            outputMode: this.outputMode,
            fullOutputPath: this.captureError ? undefined : this.tempFilePath,
            captureError: this.captureError,
        };
    }
    async closeTempFile() {
        if (!this.tempFileStream) {
            return;
        }
        const stream = this.tempFileStream;
        await new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                stream.off("error", done); stream.off("finish", done); stream.off("close", done);
                resolve();
            };
            const timer = setTimeout(() => { this.failCapture("capture flush timed out", stream); done(); }, 30000);
            stream.once("error", done); stream.once("finish", done); stream.once("close", done);
            if (stream.destroyed || stream.writableFinished) done();
            else stream.end();
        });
        if (this.tempFileStream === stream) this.tempFileStream = undefined;
    }
    getLastLineBytes() {
        return this.currentLineBytes;
    }
    appendDecodedText(text) {
        if (text.length === 0) {
            return;
        }
        const bytes = byteLength(text);
        if (byteLength(this.headText) < this.maxBytes)
            this.headText = this.bytePrefix(this.headText + text, this.maxBytes);
        this.totalDecodedBytes += bytes;
        this.tailText += text;
        this.tailBytes += bytes;
        if (this.tailBytes > this.maxRollingBytes * 2) {
            this.trimTail();
        }
        let newlines = 0;
        let lastNewline = -1;
        for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
            newlines++;
            lastNewline = i;
        }
        if (newlines === 0) {
            this.currentLineBytes += bytes;
            this.hasOpenLine = true;
        }
        else {
            this.completedLines += newlines;
            const tail = text.slice(lastNewline + 1);
            this.currentLineBytes = byteLength(tail);
            this.hasOpenLine = tail.length > 0;
        }
        this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
    }
    trimTail() {
        const buffer = Buffer.from(this.tailText, "utf-8");
        if (buffer.length <= this.maxRollingBytes) {
            this.tailBytes = buffer.length;
            return;
        }
        let start = buffer.length - this.maxRollingBytes;
        while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
            start++;
        }
        this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
        this.tailText = buffer.subarray(start).toString("utf-8");
        this.tailBytes = byteLength(this.tailText);
    }
    getSnapshotText() {
        if (this.tailStartsAtLineBoundary) {
            return this.tailText;
        }
        const firstNewline = this.tailText.indexOf("\n");
        return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
    }
    shouldUseTempFile() {
        return (this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines);
    }
    ensureTempFile() {
        if (this.tempFilePath || this.captureError) {
            return;
        }
        this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
        const stream = createWriteStream(this.tempFilePath, { flags: "wx", mode: 0o600 });
        stream.once("open", () => { this.tempFileOpened = true; });
        stream.on("error", (error) => this.failCapture(error.code ?? "write failed", stream));
        this.tempFileStream = stream;
        for (const chunk of this.rawChunks) {
            stream.write(chunk);
        }
        this.rawChunks = [];
    }
    failCapture(reason, stream) {
        this.captureError ??= `Full output unavailable: ${reason}`;
        if (this.tempFileStream === stream) this.tempFileStream = undefined;
        stream.destroy();
        // Never advertise a partial file as complete evidence.
        if (this.tempFilePath) {
            // EEXIST/EACCES can fail before opening. Such a path is not ours.
            // Check at close, since destroy can race the asynchronous open.
            const remove = () => { if (this.tempFileOpened) unlink(this.tempFilePath, () => {}); };
            if (stream.closed) remove(); else stream.once("close", remove);
        }
    }
    waitForDrain(stream) {
        if (this.pendingDrain) return this.pendingDrain;
        const pending = new Promise(resolve => {
            const done = () => {
                clearTimeout(timer);
                for (const event of ["drain", "error", "close"]) stream.off(event, done);
                resolve();
            };
            const timer = setTimeout(() => { this.failCapture("capture drain timed out", stream); done(); }, 30000);
            for (const event of ["drain", "error", "close"]) stream.once(event, done);
            if (stream.destroyed || !stream.writableNeedDrain) done();
        });
        this.pendingDrain = pending;
        pending.finally(() => { if (this.pendingDrain === pending) this.pendingDrain = undefined; });
        return pending;
    }
    bytePrefix(text, maxBytes) {
        const bytes = Buffer.from(text);
        let end = Math.min(maxBytes, bytes.length);
        while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        return bytes.subarray(0, end).toString("utf8");
    }
}

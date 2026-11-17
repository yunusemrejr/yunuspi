import { isUtf8 } from "node:buffer";
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from "../../utils/mime.js";

const MIN_INDEX_BYTES = 256 * 1024;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const CHECKPOINT_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 512 * 1024;
const MAX_INDEX_FILES = 64;
const indexes = new Map();

function sameRevision(before, after) {
    return before.dev === after.dev && before.ino === after.ino && before.size === after.size
        && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function remember(key, index) {
    indexes.delete(key);
    indexes.set(key, index);
    if (indexes.size > MAX_INDEX_FILES) indexes.delete(indexes.keys().next().value);
}

function buildIndex(bytes, stats) {
    const checkpointCount = Math.ceil(bytes.length / CHECKPOINT_BYTES);
    const lines = new Uint32Array(checkpointCount);
    const starts = new Uint32Array(checkpointCount);
    let line = 0;
    let lastStart = 0;
    for (let checkpoint = 0; checkpoint < checkpointCount; checkpoint++) {
        lines[checkpoint] = line;
        starts[checkpoint] = lastStart;
        const end = Math.min(bytes.length, (checkpoint + 1) * CHECKPOINT_BYTES);
        for (let cursor = checkpoint * CHECKPOINT_BYTES; cursor < end; cursor++) {
            if (bytes[cursor] === 10) {
                line++;
                lastStart = cursor + 1;
            }
        }
    }
    // split("\n") includes the final empty line when the file ends in LF.
    return { stats, bytes: bytes.length, lines, starts, totalLines: line + 1 };
}

async function readExactly(file, start, length, signal) {
    const bytes = Buffer.allocUnsafe(length);
    for (let offset = 0; offset < length;) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(bytes, offset, Math.min(length - offset, READ_CHUNK_BYTES), start + offset);
        if (bytesRead === 0) return undefined;
        offset += bytesRead;
    }
    return bytes;
}

async function lineStart(index, line, takeBytes) {
    let low = 0;
    let high = index.lines.length;
    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (index.lines[middle] <= line) low = middle;
        else high = middle;
    }
    let remaining = line - index.lines[low];
    if (remaining === 0) return index.starts[low];
    // Start at the last byte checkpoint before this line. Even a single huge
    // earlier line cannot make this lookup scan more than one checkpoint span.
    const start = low * CHECKPOINT_BYTES;
    const block = await takeBytes(start, Math.min(CHECKPOINT_BYTES, index.bytes - start));
    if (!block) return undefined;
    for (let cursor = 0; cursor < block.length; cursor++) {
        if (block[cursor] === 10 && --remaining === 0) return start + cursor + 1;
    }
}

async function selectRange(index, offset, limit, takeBytes) {
    const startLine = offset - 1;
    if (startLine >= index.totalLines) return { text: "", totalLines: index.totalLines, selectedLines: 0 };
    const endLine = Math.min(startLine + limit, index.totalLines);
    const start = await lineStart(index, startLine, takeBytes);
    // join("\n") excludes the separator after an explicit range. At EOF the
    // final empty logical line remains part of the range, including its LF.
    const nextStart = endLine === index.totalLines ? index.bytes + 1 : await lineStart(index, endLine, takeBytes);
    if (start === undefined || nextStart === undefined || nextStart <= start) return undefined;
    const selected = await takeBytes(start, nextStart - 1 - start);
    if (!selected) return undefined;
    return { text: selected.toString("utf8"), totalLines: index.totalLines, selectedLines: endLine - startLine };
}

export async function readNativeFile(file, stats, offset, limit, signal) {
    const startLine = offset ?? 1;
    const indexable = Number.isSafeInteger(startLine) && startLine > 0 && Number.isSafeInteger(limit) && limit > 0
        && stats.size >= MIN_INDEX_BYTES && stats.size <= MAX_INDEX_BYTES;
    const key = indexable ? `${stats.dev}:${stats.ino}` : undefined;
    const cached = indexes.get(key);
    const useCached = cached && sameRevision(cached.stats, stats);
    if (useCached) {
        const range = await selectRange(cached, startLine, limit, (start, length) => readExactly(file, start, length, signal));
        const stable = sameRevision(stats, await file.stat({ bigint: true }));
        signal?.throwIfAborted();
        if (range && stable) {
            remember(key, cached);
            return { range };
        }
        if (indexes.get(key) === cached) indexes.delete(key);
        // Positional reads leave the file cursor at zero, so a changed file
        // falls back to the legacy read on this same descriptor.
    }
    const buffer = await file.readFile({ signal });
    const mimeType = detectSupportedImageMimeType(buffer.subarray(0, IMAGE_TYPE_SNIFF_BYTES));
    if (!indexable || useCached || mimeType || BigInt(buffer.length) !== stats.size || !isUtf8(buffer)) return { buffer, mimeType };
    const index = buildIndex(buffer, stats);
    const range = await selectRange(index, startLine, limit, (start, length) => buffer.subarray(start, start + length));
    const stable = sameRevision(stats, await file.stat({ bigint: true }));
    signal?.throwIfAborted();
    if (!range || !stable) return { buffer, mimeType };
    remember(key, index);
    return { range };
}

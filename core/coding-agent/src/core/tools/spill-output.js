import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const MAX_SPILLED_BYTES = 128 * 1024 * 1024;
const spilledFiles = new Map();
let spilledTotalBytes = 0;
/**
 * Keep oversized tool output retrievable instead of losing it at the byte cap.
 * The temp directory is a RAM-backed tmpfs on most Linux hosts, so the live
 * spill set is bounded: an unbounded set pins hundreds of megabytes of memory
 * for the lifetime of a long session. The oldest spill is dropped first, and a
 * single oversized spill is always kept.
 */
/* PI_SEARCH_OUTPUT_SPILL */
export function spillToolOutput(prefix, text) {
    const file = join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`);
    writeFileSync(file, text);
    const bytes = Buffer.byteLength(text);
    spilledFiles.set(file, bytes);
    spilledTotalBytes += bytes;
    // Map iteration is insertion-ordered, so the first key is the oldest spill.
    while (spilledTotalBytes > MAX_SPILLED_BYTES && spilledFiles.size > 1) {
        const [oldest, oldestBytes] = spilledFiles.entries().next().value;
        spilledFiles.delete(oldest);
        spilledTotalBytes -= oldestBytes;
        try {
            rmSync(oldest, { force: true });
        }
        catch { }
    }
    return file;
}

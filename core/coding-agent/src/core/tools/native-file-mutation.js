import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";

function sameInode(before, after) {
    return !!after && before.dev === after.dev && before.ino === after.ino;
}

async function currentTarget(path) {
    try { return await stat(path, { bigint: true }); }
    catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "ELOOP") return undefined;
        throw error;
    }
}

/** Keep native reads and writes on one verified regular file description. */
export async function withNativeFileMutation(path, flags, run, throwIfAborted) {
    // In particular, a write-only open on a FIFO must never wait for a reader.
    const existingFlags = (flags & ~constants.O_CREAT) | (constants.O_NONBLOCK ?? 0);
    let file;
    let creating = false;
    try { file = await open(path, existingFlags); }
    catch (error) {
        if (!(flags & constants.O_CREAT) || error?.code !== "ENOENT") throw error;
        throwIfAborted();
        // This open can create the file, so a subsequent Stop cannot cancel the write.
        creating = true;
        file = await open(path, existingFlags | constants.O_CREAT);
    }
    try {
        const initial = await file.stat({ bigint: true });
        if (!initial.isFile()) {
            throw Object.assign(new Error(`File mutation requires a regular file: ${path}`), {
                code: initial.isDirectory() ? "EISDIR" : "EINVAL", path,
            });
        }
        return await run(file, async text => {
            const bytes = Buffer.from(text, "utf8");
            const current = await currentTarget(path);
            if (!sameInode(initial, current) || initial.size !== current.size ||
                initial.mtimeNs !== current.mtimeNs || initial.ctimeNs !== current.ctimeNs) {
                throw Object.assign(new Error(`File changed before writing: ${path} (optimistic-concurrency conflict). No bytes were written. Re-read the target before retrying.`), { code: "ESTALE", path });
            }
            if (!creating) throwIfAborted();
            for (let position = 0; position < bytes.length;) {
                // A prior read may have moved the descriptor's cursor. Explicit
                // positions also let us handle a short write without a reopen.
                const { bytesWritten } = await file.write(bytes, position, bytes.length - position, position);
                if (bytesWritten === 0) throw new Error(`Write made no progress: ${path}`);
                position += bytesWritten;
            }
            if (BigInt(bytes.length) < initial.size) await file.truncate(bytes.length);
            const written = await currentTarget(path);
            if (!sameInode(initial, written)) {
                throw Object.assign(new Error(`Path changed during writing: ${path}. The opened file received the write. Inspect the current path before retrying.`), { code: "ESTALE", path });
            }
            if (written.size !== BigInt(bytes.length)) {
                throw Object.assign(new Error(`File size changed during writing: ${path}. Inspect the file before retrying.`), { code: "ESTALE", path });
            }
        });
    }
    finally { await file.close(); }
}

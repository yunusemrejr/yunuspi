import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Bind validation and content reads to the same local file descriptor. */
export async function withRegularReadFile(path, signal, read) {
    signal?.throwIfAborted();
    // Opening a FIFO in the default blocking mode can pin a libuv worker
    // indefinitely. O_NONBLOCK lets us reject it before starting any read.
    const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
        signal?.throwIfAborted();
        const stats = await file.stat();
        signal?.throwIfAborted();
        if (!stats.isFile()) {
            const directory = stats.isDirectory();
            throw Object.assign(new Error(directory ? `Path is a directory: ${path}` : `Read requires a regular file: ${path}`), {
                code: directory ? "EISDIR" : "EINVAL",
                path,
            });
        }
        const result = await read(file);
        signal?.throwIfAborted();
        return result;
    }
    finally {
        await file.close();
    }
}

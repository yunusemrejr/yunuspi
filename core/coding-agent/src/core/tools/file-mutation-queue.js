import { createFileMutationQueue } from "@yunuspi/agent-core/node";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
const queue = createFileMutationQueue();
function isMissingPathError(error) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR"));
}
async function getMutationQueueKey(filePath) {
    const resolvedPath = resolve(filePath);
    try {
        return await realpath(resolvedPath);
    }
    catch (error) {
        if (isMissingPathError(error)) {
            return resolvedPath;
        }
        throw error;
    }
}
/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export function withFileMutationQueue(filePath, fn, signal) {
    return queue(() => getMutationQueueKey(filePath), fn, signal);
}

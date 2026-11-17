import { raceWithAbortSignal } from "@yunuspi/ai/utils/abort";
import { getOrThrow } from "../types.js";
const queuesByEnvironment = new WeakMap();

function cancellationError(signal) {
    const reason = signal.reason;
    if (reason instanceof Error && reason.name !== "AbortError") return reason;
    return new Error("Operation aborted", { cause: reason });
}

/** Deduplicate aliases before admitting FIFO turns on each canonical path. */
export function createFileMutationQueue() {
    // An entry marks an active turn. Its set contains only cancellable waiters.
    const paths = new Map();
    let registrations = Promise.resolve();
    return (resolveKey, operation, signal) => new Promise((resolve, reject) => {
        let key, pending;
        const removeAbort = () => signal?.removeEventListener("abort", abort);
        const abort = () => {
            pending?.delete(run);
            reject(cancellationError(signal));
        };
        const checkAborted = () => {
            if (signal?.aborted) throw cancellationError(signal);
        };
        async function run() {
            removeAbort();
            try {
                checkAborted();
                // The admitted operation retains its turn until it physically
                // settles, even if its caller cancels during a write.
                resolve(await operation());
            }
            catch (error) {
                reject(error);
            }
            finally {
                const next = pending.values().next().value;
                if (next) {
                    pending.delete(next);
                    queueMicrotask(next);
                }
                else paths.delete(key);
            }
        }
        if (signal?.aborted) {
            abort();
            return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        const registration = registrations.then(async () => {
            checkAborted();
            const resolution = resolveKey();
            key = await (signal ? raceWithAbortSignal(resolution, signal) : resolution);
            checkAborted();
            pending = paths.get(key);
            if (pending) pending.add(run);
            else {
                pending = new Set();
                paths.set(key, pending);
                void run();
            }
        });
        registrations = registration.catch(error => {
            removeAbort();
            reject(signal?.aborted ? cancellationError(signal) : error);
        });
    });
}

async function getMutationQueueKey(env, path, context) {
    const absolutePath = getOrThrow(await env.absolutePath(path, context));
    const canonicalPath = await env.canonicalPath(absolutePath, context);
    if (canonicalPath.ok)
        return canonicalPath.value;
    if (canonicalPath.error.code === "not_found" || canonicalPath.error.code === "not_supported")
        return absolutePath;
    throw canonicalPath.error;
}
/** Serialize file mutations targeting the same environment and canonical path. */
export function withFileMutationQueue(env, path, fn, context) {
    let queue = queuesByEnvironment.get(env);
    if (!queue) {
        queue = createFileMutationQueue();
        queuesByEnvironment.set(env, queue);
    }
    return queue(() => getMutationQueueKey(env, path, context), fn, context.abortSignal);
}

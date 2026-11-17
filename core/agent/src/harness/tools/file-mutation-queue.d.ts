import type { Context } from "../context.ts";
import type { ExecutionEnv } from "../types.ts";
export declare function createFileMutationQueue(): <T>(resolveKey: () => Promise<string>, operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
/** Serialize file mutations targeting the same environment and canonical path. */
export declare function withFileMutationQueue<T>(env: ExecutionEnv, path: string, fn: () => Promise<T>, context: Context): Promise<T>;

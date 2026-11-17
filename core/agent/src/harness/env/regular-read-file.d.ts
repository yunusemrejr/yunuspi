import type { FileHandle } from "node:fs/promises";
/** Bind validation and content reads to the same local file descriptor. */
export declare function withRegularReadFile<T>(path: string, signal: AbortSignal | undefined, read: (file: FileHandle) => T | Promise<T>): Promise<T>;

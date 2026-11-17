import type { FileHandle } from "node:fs/promises";

/** Keep native reads and writes on one verified regular file description. */
export declare function withNativeFileMutation<T>(
    path: string,
    flags: number,
    run: (file: FileHandle, commit: (text: string) => Promise<void>) => T | Promise<T>,
    throwIfAborted: () => void,
): Promise<T>;

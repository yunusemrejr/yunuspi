/** Synchronously serialize a bounded session file transaction across owners. */
export declare function withSessionWriteLock<T>(file: string, transaction: () => T): T;

/** 0..1 likeness of a requested name to an existing entry; 0 means unrelated. */
export declare function nameSimilarity(wanted: string, existing: string): number;
/** Hint lines for a path that does not exist: nearest directory, look-alikes, re-rooted and same-name candidates. */
export declare function missingPathHint(requested: string, resolved: string, cwd: string): string;
/** Hint for read on a directory (EISDIR). */
export declare function directoryReadHint(resolved: string): string;
/** Hint for a file given where a directory was expected. */
export declare function fileWhereDirectoryExpectedHint(resolved: string): string;
/** Append hint lines under an error's own text. */
export declare function withHint(message: string, hint: string): string;
/** Attach the right hint to a filesystem error in place. */
export declare function annotatePathError<T>(error: T, requested: string, resolved: string, cwd: string): T;

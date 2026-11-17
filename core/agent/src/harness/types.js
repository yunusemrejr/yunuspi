/** Create a successful {@link Result}. */
export function ok(value) {
    return { ok: true, value };
}
/** Create a failed {@link Result}. */
export function err(error) {
    return { ok: false, error };
}
/** Return the success value or throw the failure error. Intended for tests and explicit adapter boundaries. */
export function getOrThrow(result) {
    if (!result.ok)
        throw result.error;
    return result.value;
}
/** Return the success value or `undefined`. Only object values are allowed to avoid truthiness bugs with primitives. */
export function getOrUndefined(result) {
    return result.ok ? result.value : undefined;
}
/** Normalize unknown thrown values into Error instances before using them as typed error causes. */
export function toError(error) {
    if (error instanceof Error)
        return error;
    if (typeof error === "string")
        return new Error(error);
    try {
        return new Error(JSON.stringify(error));
    }
    catch {
        return new Error(String(error));
    }
}
/** Error returned by {@link FileSystem} file operations. */
export class FileError extends Error {
    /** Backend-independent error code. */
    code;
    /** Absolute addressed path associated with the failure, when available. */
    path;
    constructor(code, message, path, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "FileError";
        this.code = code;
        this.path = path;
    }
}
/** Error returned by {@link ExecutionEnv.exec}. */
export class ExecutionError extends Error {
    /** Backend-independent error code. */
    code;
    constructor(code, message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "ExecutionError";
        this.code = code;
    }
}
const toolErrorDetails = Symbol.for("yunuspi.agent-tool-error.details");
/** A tool rejection carrying public result details, such as a retained output reference. */
export class AgentToolError extends Error {
    constructor(message, details, options) {
        super(message, options);
        this.name = "AgentToolError";
        this[toolErrorDetails] = details;
    }
    static detailsOf(error) {
        // The same error can cross source, bundled, or extension-loaded module copies.
        return error instanceof Error && Object.hasOwn(error, toolErrorDetails) ? error[toolErrorDetails] : undefined;
    }
}
/** Error returned by compaction helpers. */
export class CompactionError extends Error {
    /** Backend-independent error code. */
    code;
    constructor(code, message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "CompactionError";
        this.code = code;
    }
}
/** Error returned by branch summarization helpers. */
export class BranchSummaryError extends Error {
    /** Backend-independent error code. */
    code;
    constructor(code, message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "BranchSummaryError";
        this.code = code;
    }
}

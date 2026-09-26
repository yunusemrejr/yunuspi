/**
 * Shared command execution utilities for extensions and custom tools.
 */
/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
    /** AbortSignal to cancel the command */
    signal?: AbortSignal;
    /** Timeout in milliseconds, 0 disables it; maximum 2147483647. */
    timeout?: number;
    /** Working directory */
    cwd?: string;
}
/**
 * Result of executing a shell command.
 */
export interface ExecResult {
    stdout: string;
    stderr: string;
    /** Nonzero for signal termination, cancellation, timeout, or spawn failure. */
    code: number;
    killed: boolean;
}
/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export declare function execCommand(command: string, args: string[], cwd: string, options?: ExecOptions): Promise<ExecResult>;

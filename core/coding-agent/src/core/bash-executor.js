/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */
import { createShellOutputDecoder } from "@yunuspi/agent-core";
import { stripAnsi } from "../utils/ansi.js";
import { sanitizeBinaryOutput } from "../utils/shell.js";
import { OutputAccumulator } from "./tools/output-accumulator.js";

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(command, cwd, operations, options) {
    const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
    const decoder = createShellOutputDecoder();
    let acceptingOutput = true;
    const append = decoded => {
        const text = sanitizeBinaryOutput(stripAnsi(decoded)).replace(/\r/g, "");
        const pending = output.append(text);
        options?.onChunk?.(text);
        return pending;
    };

    let exitCode;
    try {
        ({ exitCode } = await operations.exec(command, cwd, {
            onData: (data, source) => acceptingOutput ? append(decoder.append(data, source)) : undefined,
            signal: options?.signal,
        }));
    }
    catch (error) {
        if (!options?.signal?.aborted) {
            acceptingOutput = false;
            await output.closeTempFile();
            throw error;
        }
    }
    finally {
        acceptingOutput = false;
    }

    try {
        const remaining = decoder.finish();
        if (remaining) await append(remaining);
        output.finish();
    }
    finally {
        await output.closeTempFile();
    }
    const snapshot = output.snapshot();
    const cancelled = options?.signal?.aborted ?? false;
    return {
        output: snapshot.captureError ? `${snapshot.content}\n\n[${snapshot.captureError}]` : snapshot.content,
        exitCode: cancelled ? undefined : (exitCode ?? undefined),
        cancelled,
        truncated: snapshot.truncation.truncated,
        fullOutputPath: snapshot.fullOutputPath,
    };
}

/**
 * Write oversized tool output to a temp file and return its path. The live
 * spill set is bounded; the oldest files are removed once the budget is
 * exceeded.
 */
export declare function spillToolOutput(prefix: string, text: string): string;

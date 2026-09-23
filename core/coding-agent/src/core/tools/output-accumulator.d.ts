import { type TruncationResult } from "./truncate.ts";
export interface OutputAccumulatorOptions {
    maxLines?: number;
    maxBytes?: number;
    tempFilePrefix?: string;
    outputMode?: "tail" | "head-tail";
}
export interface OutputSnapshot {
    content: string;
    truncation: TruncationResult;
    fullOutputPath?: string;
    outputMode: "tail" | "head-tail";
    captureError?: string;
}
/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export declare class OutputAccumulator {
    private readonly maxLines;
    private readonly maxBytes;
    private readonly maxRollingBytes;
    private readonly tempFilePrefix;
    private readonly decoder;
    private rawChunks;
    private tailText;
    private tailBytes;
    private tailStartsAtLineBoundary;
    private totalRawBytes;
    private totalDecodedBytes;
    private completedLines;
    private totalLines;
    private currentLineBytes;
    private hasOpenLine;
    private finished;
    private tempFilePath;
    private tempFileStream;
    private tempFileOpened;
    constructor(options?: OutputAccumulatorOptions);
    /** Producers should await a returned promise before delivering more data. */
    append(data: Buffer): void | Promise<void>;
    finish(): void;
    snapshot(options?: {
        persistIfTruncated?: boolean;
    }): OutputSnapshot;
    closeTempFile(): Promise<void>;
    getLastLineBytes(): number;
    private appendDecodedText;
    private trimTail;
    private getSnapshotText;
    private shouldUseTempFile;
    private ensureTempFile;
    private failCapture;
    private waitForDrain;
    private bytePrefix;
    private captureError;
    private headText;
    private outputMode;
    private pendingDrain;
}

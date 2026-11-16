import { type TruncationResult } from "./truncate.ts";
export interface OutputAccumulatorOptions {
    maxLines?: number;
    maxBytes?: number;
    tempFilePrefix?: string;
    /** Stop full-output capture past this many raw bytes (default 64 MiB). */
    maxCaptureBytes?: number;
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
    private capturedBytes;
    private maxCaptureBytes;
    constructor(options?: OutputAccumulatorOptions);
    /** Strings are already decoded. Producers should await any returned promise before delivering more data. */
    append(data: Buffer | string): void | Promise<void>;
    finish(): void;
    snapshot(options?: {
        persistIfTruncated?: boolean;
    }): OutputSnapshot;
    private headTailPreview;
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
    private headBytesRemaining;
    private outputMode;
    private pendingDrain;
}

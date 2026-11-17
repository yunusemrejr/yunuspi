import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

interface ReadTextRange {
    text: string;
    totalLines: number;
    selectedLines: number;
}
export declare function readNativeFile(file: FileHandle, stats: BigIntStats, offset: number | undefined, limit: number | undefined, signal?: AbortSignal): Promise<{ range: ReadTextRange } | { buffer: Buffer; mimeType: string | null }>;

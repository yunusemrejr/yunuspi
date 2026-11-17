import type { BigIntStats } from "node:fs";

export declare function withRegularResourceFile<T>(filePath: string, read: (fd: number, info: BigIntStats) => T): T;
export declare function addResourceIgnoreRules(ig: { add(patterns: string[]): unknown }, dir: string, rootDir: string): void;

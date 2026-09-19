import type { RetryPolicy } from "@yunuspi/ai";
import type { CompactionSettings } from "./compaction/compaction.ts";
export declare const DEFAULT_RETRY_POLICY: RetryPolicy;
export declare function validateToolNames(tools: readonly {
    name: string;
}[]): void;
export declare function validateRetryPolicy(policy: RetryPolicy): void;
export declare function validateCompactionSettings(settings: CompactionSettings): void;

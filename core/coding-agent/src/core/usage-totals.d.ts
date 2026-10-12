import type { Usage } from "@yunuspi/ai/compat";
export interface UsageTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}
export declare function createUsageTotals(): UsageTotals;
export declare function addUsageToTotals(totals: UsageTotals, usage: Usage): void;

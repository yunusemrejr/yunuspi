/** Pure transcript collectors; missing provider evidence remains explicitly unknown. */
export declare function readCostEvidence(usage: any, provider?: string): any;
export declare function mergeCostEvidence(left: any, right: any): any;
export declare function hasRecordedTokenUsage(usage: any, noExecution?: boolean): boolean;
export declare function collectAuxiliaryModelUsage(entries: any[]): any;
export declare function collectSessionCost(entries: any[], subscription?: boolean): any;
export declare function recoverRetainedChildCosts(entries: any[], options: { sessionFile: string | null | undefined; statusRoot?: string; privateWorkflowRunId?: string }): {
    entries: { type: 'custom'; customType: 'subagent-cost-v1'; data: {
        runId: string; recoveredForSessionId: string; results: any[];
        childLedgerCoverage?: {
            direct?: { route: string; tokens: Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number> };
            requests?: [string, string, 'pending' | 'unpriced' | 'known'][];
        };
    } }[];
    candidates: boolean;
};
export declare function collectSessionStats(entries: any[], subscription?: boolean): Omit<import("./agent-session.js").SessionStats, "sessionId" | "sessionFile" | "contextUsage">;
export declare function collectSessionMetrics(entries: any[], live?: any): any;

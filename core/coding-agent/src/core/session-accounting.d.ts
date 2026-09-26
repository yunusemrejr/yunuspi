/** Pure transcript collectors; missing provider evidence remains explicitly unknown. */
export declare function readCostEvidence(usage: any, provider?: string): any;
export declare function mergeCostEvidence(left: any, right: any): any;
export declare function hasRecordedTokenUsage(usage: any, noExecution?: boolean): boolean;
export declare function collectAuxiliaryModelUsage(entries: any[]): any;
export declare function collectSessionCost(entries: any[], subscription?: boolean): any;
export declare function collectSessionMetrics(entries: any[], live?: any): any;

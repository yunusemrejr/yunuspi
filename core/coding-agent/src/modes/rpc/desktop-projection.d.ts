export declare function desktopMessage(message: any, budget?: { remaining: number }): any;
export declare function desktopBranchMessages(entries: any[]): any[];
export declare function desktopArguments(args: any): Record<string, any>;
export declare function desktopHistory(messages: any[], options?: { limit?: number; before?: number }): { messages: any[]; before: number; hasMore: boolean; total: number };
export declare function desktopEvent(event: any): any | undefined;

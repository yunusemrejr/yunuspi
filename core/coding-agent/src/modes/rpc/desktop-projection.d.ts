import type { SessionEntry, SessionManager } from '../../core/session-manager.js';

type HistoryPageOptions = { limit?: number; before?: number };
type HistoryPage = { messages: any[]; before: number; hasMore: boolean; total: number };
type DesktopGoal = { id: string; status: 'active' | 'paused' | 'blocked'; settled: number; total: number };
type LiveHistoryManager = Pick<SessionManager, 'getHeader' | 'getLeafEntry' | 'getEntriesRevision' | 'getBranch'>;

export declare function desktopMessage(message: any, budget?: { remaining: number }): any;
export declare function desktopBranchMessages(entries: any[]): any[];
export declare function desktopGoal(entries: SessionEntry[]): DesktopGoal | null;
export declare function desktopArguments(args: any): Record<string, any>;
export declare function desktopHistory(messages: any[], options?: HistoryPageOptions): HistoryPage;
export declare function desktopSessionHistory(manager: LiveHistoryManager, options?: HistoryPageOptions & { anchor?: string }): (HistoryPage & { anchor?: string; goal?: DesktopGoal | null }) | { reset: true };
export declare function desktopEvent(event: any): any | undefined;
export declare function createDesktopStreamingPreview(): { readonly userMessage: any | null; observe(event: any): void; snapshot(): any | null; reset(): void };

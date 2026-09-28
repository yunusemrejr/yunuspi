export interface DiskLimits {
    budgetBytes: number;
    reserveBytes: number;
    maxFileBytes: number;
}
export declare function getDiskLimits(): DiskLimits;
export declare function diskAvailable(path: string): number | undefined;
export declare function watchDisk(path: string, limits: DiskLimits, onTrip: (reason: string) => void, intervalMs?: number): () => void;
export declare function fileSizeLimitPrefix(limits: DiskLimits): string;

export interface DocumentReadEvidence { path: string; hash: string; complete: true; bytes: number; plain: boolean }
export interface DocumentMutationEvidence { path: string; hash: string; changedBytes: number; proseOnly: boolean; rewrite: boolean }
export declare function directProseRequest(text: string): boolean;
export declare function proseToolAllowed(name: string, args: unknown): boolean;
export declare function readOnlyDiscoveryShell(command: unknown): boolean;
export declare function prosePath(cwd: string, file: string): boolean;
export declare function documentReadEvidence(file: string, text: string, complete: boolean): DocumentReadEvidence | undefined;
export declare function documentMutationEvidence(file: string, before: string | undefined, after: string): DocumentMutationEvidence | undefined;

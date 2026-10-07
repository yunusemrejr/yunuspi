export type MediaKind = "image" | "video" | "speech" | "music" | "sfx";
export type MediaModelSelections = Partial<Record<MediaKind, string>>;
export interface MediaModelOption { kind: MediaKind; id: string; name: string; description: string; source: string; configured?: boolean; capabilities?: Record<string, any>; }
export declare const MEDIA_KINDS: MediaKind[];
export declare const MEDIA_CATALOG_API: string;
export declare function normalizeMediaModels(value: unknown): MediaModelSelections;
export declare function builtinMediaModels(): MediaModelOption[];
export declare function mediaCatalogJson(endpoint: string, options?: { signal?: AbortSignal; fetchImpl?: typeof fetch; refresh?: boolean }): Promise<any>;
export declare function fetchMediaModels(kind: MediaKind, options?: { signal?: AbortSignal; fetchImpl?: typeof fetch; refresh?: boolean }): Promise<MediaModelOption[]>;

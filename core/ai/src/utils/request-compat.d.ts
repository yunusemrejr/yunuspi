export type UnionPolicy = "allow" | "flatten" | "reject";
export type ProfileProvenance = "curated" | "override" | "unknown-fallback";

export interface BackendProfile {
	id: string;
	unions: UnionPolicy;
	unsupportedKeywords: string[];
	strictUnsupportedKeywords: string[];
	requiresAdditionalPropertiesFalseInStrict: boolean;
	maxDepth: number;
	provenance: ProfileProvenance;
}

export interface ProjectWireSchemaOptions {
	strict?: boolean;
}

export type ProjectWireSchemaResult =
	| { ok: true; schema: unknown; dropped: string[] }
	| { ok: false; dropped: string[]; reason: string; field?: string };

export interface ToolWireInput {
	name?: string;
	schema?: unknown;
}

export interface ToolWireResult {
	tool: string;
	ok: boolean;
	dropped: string[];
	schema?: unknown;
	reason?: string;
	field?: string;
	note?: string;
}

export interface ToolWireReport {
	ok: boolean;
	backend: string;
	results: ToolWireResult[];
	incompatible: Array<{ tool: string; reason: string; field?: string }>;
}

export function getBackendProfile(backendId?: string): BackendProfile;
export function listBackendProfiles(): Array<{ id: string; provenance: ProfileProvenance }>;
export function registerBackendProfile(profile: {
	id: string;
	unions?: UnionPolicy;
	unsupportedKeywords?: string[];
	strictUnsupportedKeywords?: string[];
	requiresAdditionalPropertiesFalseInStrict?: boolean;
	maxDepth?: number;
}): void;
export function unregisterBackendProfile(backendId?: string): void;
export function projectWireSchema(canonical: unknown, backendId?: string, options?: ProjectWireSchemaOptions): ProjectWireSchemaResult;
export function checkToolWire(tools: ToolWireInput[], backendId?: string, options?: ProjectWireSchemaOptions): ToolWireReport;

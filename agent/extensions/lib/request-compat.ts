/**
 * Extension adapter for the canonical core/ai request-compatibility service.
 *
 * Extensions consume provider wire-schema projection ONLY through this module,
 * which delegates to `core/ai` (`@yunuspi/ai/utils/request-compat`). The
 * canonical implementation lives in core; this file carries no projection
 * logic of its own — only environment-aware loading (installed CLI resolves
 * the package specifier; repo checkouts and tests resolve the relative core
 * source) plus TypeScript types.
 *
 * Local argument validation ALWAYS uses the canonical full schema. Wire
 * projection only derives what is safe to serialize to a specific backend.
 */
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

interface CompatApi {
	getBackendProfile(backendId?: string): BackendProfile;
	listBackendProfiles(): Array<{ id: string; provenance: ProfileProvenance }>;
	registerBackendProfile(profile: Record<string, unknown>): void;
	unregisterBackendProfile(backendId?: string): void;
	projectWireSchema(canonical: unknown, backendId?: string, options?: { strict?: boolean }): ProjectWireSchemaResult;
	checkToolWire(tools: ToolWireInput[], backendId?: string, options?: { strict?: boolean }): ToolWireReport;
}

let cached: { api: CompatApi; source: string } | undefined;

function loadCompatApi(): { api: CompatApi; source: string } {
	if (cached) return cached;
	const require = createRequire(import.meta.url);
	const attempts: string[] = [];
	// Installed CLI (live harness): the owned package resolves normally. The
	// exports map (`./utils/*` -> `./dist/utils/*.js`) takes extensionless
	// specifiers and exposes the `import` condition only, so resolution goes
	// through import.meta.resolve (ESM conditions) and the resolved FILE is
	// then required directly — specifier require() would fail exports gating.
	const resolve = (import.meta as unknown as { resolve?: (specifier: string) => string }).resolve;
	for (const specifier of ["@yunuspi/ai/utils/request-compat", "@yunuspi/ai/utils/request-compat.js"]) {
		try {
			if (typeof resolve !== "function") throw new Error("import.meta.resolve unavailable");
			const file = fileURLToPath(resolve.call(import.meta, specifier));
			const api = require(file) as CompatApi;
			if (api && typeof api.projectWireSchema === "function") {
				cached = { api, source: `package:${specifier}` };
				return cached;
			}
			attempts.push(`${specifier} (missing projectWireSchema)`);
		} catch (error) {
			attempts.push(`${specifier} (${error instanceof Error ? error.code ?? error.message : String(error)})`);
		}
	}
	// Repo checkout / tests: resolve the core source relative to this file.
	// agent/extensions/lib/request-compat.ts -> <root>/core/ai/src/utils/...
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const candidates = [
			path.join(here, "..", "..", "..", "core", "ai", "src", "utils", "request-compat.js"),
			path.join(here, "..", "..", "..", "core", "ai", "dist", "utils", "request-compat.js"),
		];
		for (const file of candidates) {
			try {
				const api = require(file) as CompatApi;
				if (api && typeof api.projectWireSchema === "function") {
					cached = { api, source: `file:${file}` };
					return cached;
				}
			} catch {
				// Try the next candidate.
			}
		}
		attempts.push("repo-relative core/ai src+dist");
	} catch (error) {
		attempts.push(`relative (${error instanceof Error ? error.message : String(error)})`);
	}
	throw new Error(`request-compat: canonical core/ai service unavailable [${attempts.join("; ")}]`);
}

/** Which core/ai copy backs this adapter (diagnostic provenance). */
export function requestCompatSource(): string {
	return loadCompatApi().source;
}

export function getBackendProfile(backendId?: string): BackendProfile {
	return loadCompatApi().api.getBackendProfile(backendId);
}

export function listBackendProfiles(): Array<{ id: string; provenance: ProfileProvenance }> {
	return loadCompatApi().api.listBackendProfiles();
}

export function registerBackendProfile(profile: {
	id: string;
	unions?: UnionPolicy;
	unsupportedKeywords?: string[];
	strictUnsupportedKeywords?: string[];
	requiresAdditionalPropertiesFalseInStrict?: boolean;
	maxDepth?: number;
}): void {
	loadCompatApi().api.registerBackendProfile(profile as unknown as Record<string, unknown>);
}

export function unregisterBackendProfile(backendId?: string): void {
	loadCompatApi().api.unregisterBackendProfile(backendId);
}

export function projectWireSchema(canonical: unknown, backendId?: string, options?: { strict?: boolean }): ProjectWireSchemaResult {
	return loadCompatApi().api.projectWireSchema(canonical, backendId, options);
}

export function checkToolWire(tools: ToolWireInput[], backendId?: string, options?: { strict?: boolean }): ToolWireReport {
	return loadCompatApi().api.checkToolWire(tools, backendId, options);
}

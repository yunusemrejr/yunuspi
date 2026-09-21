/**
 * Canonical provider request compatibility service.
 *
 * Owned by core/ai. Every extension that sends provider requests consumes this
 * API instead of reinventing wire quirks.
 *
 * Contract:
 * - The canonical full JSON Schema stays internal and is ALWAYS used for
 *   local argument validation. Wire projection never weakens local checks.
 * - Before a request is sent, the exact backend that will receive it gets a
 *   backend-safe wire schema derived from the canonical schema: unsupported
 *   keywords are dropped (and reported), strict-schema features are
 *   normalized, union forms are flattened or rejected per backend.
 * - If no safe projection exists, the caller must pick another
 *   already-authorized backend or reject BEFORE spending an inference request.
 *
 * Backend profiles are curated conservative defaults with explicit provenance
 * ("curated" vs "override"). Overrides win; tests pin curated behavior.
 *
 * Dependency-free ESM. No network, no timers, no filesystem.
 */

const STRICT_UNSUPPORTED_KEYWORDS = Object.freeze([
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"patternProperties",
	"unevaluatedProperties",
	"propertyNames",
	"minProperties",
	"maxProperties",
	"uniqueItems",
	"minItems",
	"maxItems",
	"minContains",
	"maxContains",
	"unevaluatedItems",
	"contains",
	"if",
	"then",
	"else",
	"not",
	"dependentRequired",
	"dependentSchemas",
	"dependencies",
	"$comment",
	"$vocabulary",
	"contentMediaType",
	"contentEncoding",
	"contentSchema",
]);

const LENIENT_UNSUPPORTED_KEYWORDS = Object.freeze([]);

/**
 * Curated backend profiles. `unions` controls anyOf/oneOf/allOf handling:
 * - "allow":   keep union forms verbatim
 * - "flatten": keep the first non-null branch, drop the rest (reported)
 * - "reject":  no safe projection; caller must switch backend or narrow tools
 */
const CURATED_PROFILES = new Map([
	["openai", { id: "openai", unions: "allow", unsupportedKeywords: [...LENIENT_UNSUPPORTED_KEYWORDS], strictUnsupportedKeywords: [...STRICT_UNSUPPORTED_KEYWORDS], requiresAdditionalPropertiesFalseInStrict: true, maxDepth: 10 }],
	["openrouter", { id: "openrouter", unions: "allow", unsupportedKeywords: [...LENIENT_UNSUPPORTED_KEYWORDS], strictUnsupportedKeywords: [...STRICT_UNSUPPORTED_KEYWORDS], requiresAdditionalPropertiesFalseInStrict: true, maxDepth: 10 }],
	["orcarouter", { id: "orcarouter", unions: "allow", unsupportedKeywords: [...LENIENT_UNSUPPORTED_KEYWORDS], strictUnsupportedKeywords: [...STRICT_UNSUPPORTED_KEYWORDS], requiresAdditionalPropertiesFalseInStrict: false, maxDepth: 8 }],
	["friendli", { id: "friendli", unions: "flatten", unsupportedKeywords: ["patternProperties", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "dependentRequired", "dependentSchemas", "dependencies", "if", "then", "else", "not"], strictUnsupportedKeywords: [...STRICT_UNSUPPORTED_KEYWORDS], requiresAdditionalPropertiesFalseInStrict: true, maxDepth: 8 }],
	["deepseek", { id: "deepseek", unions: "flatten", unsupportedKeywords: ["patternProperties", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "dependentRequired", "dependentSchemas", "dependencies", "if", "then", "else", "not"], strictUnsupportedKeywords: [...STRICT_UNSUPPORTED_KEYWORDS], requiresAdditionalPropertiesFalseInStrict: true, maxDepth: 8 }],
	["together", { id: "together", unions: "allow", unsupportedKeywords: [...LENIENT_UNSUPPORTED_KEYWORDS], strictUnsupportedKeywords: [...STRICT_UNSUPPORTED_KEYWORDS], requiresAdditionalPropertiesFalseInStrict: false, maxDepth: 10 }],
	["openai-compatible", { id: "openai-compatible", unions: "allow", unsupportedKeywords: [...LENIENT_UNSUPPORTED_KEYWORDS], strictUnsupportedKeywords: [...STRICT_UNSUPPORTED_KEYWORDS], requiresAdditionalPropertiesFalseInStrict: false, maxDepth: 10 }],
]);

const overrides = new Map();

function profileProvenance(id) {
	return overrides.has(id) ? "override" : "curated";
}

/** Canonical backend profile with provenance. Unknown backends fail closed to strict-flatten. */
export function getBackendProfile(backendId) {
	const id = typeof backendId === "string" && backendId ? backendId.toLowerCase() : "openai-compatible";
	if (overrides.has(id)) return { ...overrides.get(id), provenance: "override" };
	if (CURATED_PROFILES.has(id)) return { ...CURATED_PROFILES.get(id), provenance: "curated" };
	return { id, unions: "flatten", unsupportedKeywords: [...STRICT_UNSUPPORTED_KEYWORDS], strictUnsupportedKeywords: [...STRICT_UNSUPPORTED_KEYWORDS], requiresAdditionalPropertiesFalseInStrict: true, maxDepth: 6, provenance: "unknown-fallback" };
}

export function listBackendProfiles() {
	const ids = new Set([...CURATED_PROFILES.keys(), ...overrides.keys()]);
	return [...ids].map((id) => ({ id, provenance: profileProvenance(id) }));
}

/** Register a local backend-profile override. Overrides always win. */
export function registerBackendProfile(profile) {
	if (!profile || typeof profile.id !== "string" || !profile.id) throw new Error("request-compat: profile needs an id");
	if (profile.unions !== undefined && !["allow", "flatten", "reject"].includes(profile.unions)) {
		throw new Error("request-compat: unions must be allow|flatten|reject");
	}
	overrides.set(profile.id.toLowerCase(), {
		id: profile.id.toLowerCase(),
		unions: profile.unions ?? "allow",
		unsupportedKeywords: Array.isArray(profile.unsupportedKeywords) ? [...profile.unsupportedKeywords] : [],
		strictUnsupportedKeywords: Array.isArray(profile.strictUnsupportedKeywords) ? [...profile.strictUnsupportedKeywords] : [...STRICT_UNSUPPORTED_KEYWORDS],
		requiresAdditionalPropertiesFalseInStrict: profile.requiresAdditionalPropertiesFalseInStrict === true,
		maxDepth: Number.isSafeInteger(profile.maxDepth) && profile.maxDepth > 0 ? profile.maxDepth : 10,
	});
}

/** Remove a previously registered override (tests and config reload). */
export function unregisterBackendProfile(backendId) {
	overrides.delete(String(backendId ?? "").toLowerCase());
}

const UNION_KEYS = ["anyOf", "oneOf", "allOf"];
const MAX_SCHEMA_NODES = 20000;

function isObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function joinPath(path, key) {
	return path ? `${path}.${key}` : String(key);
}

/**
 * Derive a backend-safe wire schema from the canonical schema. The input is
 * never mutated. `dropped` records every `path.keyword` removed so callers
 * can explain the projection; `ok:false` means no safe projection exists.
 */
export function projectWireSchema(canonical, backendId, options = {}) {
	const profile = getBackendProfile(backendId);
	const strict = options.strict === true;
	const unsupported = new Set(strict ? [...profile.unsupportedKeywords, ...profile.strictUnsupportedKeywords] : profile.unsupportedKeywords);
	const dropped = [];
	let nodes = 0;

	const fail = (reason, field) => ({ ok: false, dropped, reason, ...(field ? { field } : {}) });

	function flattenUnion(branches, path) {
		if (!Array.isArray(branches) || !branches.length) return undefined;
		// Prefer keeping an enum/const branch (most information preserved),
		// else the first non-null object branch, else the first branch.
		const nonNull = branches.filter((branch) => !(isObject(branch) && branch.type === "null") && branch !== null);
		const pool = nonNull.length ? nonNull : branches;
		const pick = pool.find((branch) => isObject(branch) && (branch.enum !== undefined || branch.const !== undefined))
			?? pool.find((branch) => isObject(branch) && branch.type === "object")
			?? pool[0];
		dropped.push(`${path || "$"}:union-flattened(${branches.length}->1)`);
		return pick;
	}

	function project(node, path, depth) {
		nodes += 1;
		if (nodes > MAX_SCHEMA_NODES) return { error: "schema-too-large" };
		if (depth > profile.maxDepth) return { error: `exceeds-max-depth(${profile.maxDepth})`, field: path || "$" };
		if (Array.isArray(node)) {
			const out = [];
			for (let i = 0; i < node.length; i += 1) {
				const projected = project(node[i], `${path || "$"}[${i}]`, depth + 1);
				if (projected && projected.error) return projected;
				out.push(projected);
			}
			return out;
		}
		if (!isObject(node)) return node;
		const out = {};
		for (const [key, value] of Object.entries(node)) {
			if (unsupported.has(key)) {
				dropped.push(joinPath(path, key));
				continue;
			}
			if (UNION_KEYS.includes(key)) {
				if (profile.unions === "reject") return { error: `union-${key}-rejected`, field: joinPath(path, key) };
				if (profile.unions === "flatten") {
					const flat = flattenUnion(value, joinPath(path, key));
					// A flattened union merges into the parent: object branches
					// spread their keywords, scalar branches replace type/enum.
					if (isObject(flat)) {
						const projected = project(flat, joinPath(path, key), depth + 1);
						if (projected && projected.error) return projected;
						for (const [spreadKey, spreadValue] of Object.entries(projected)) {
							if (spreadKey in out) {
								dropped.push(`${joinPath(path, key)}:union-key-conflict(${spreadKey})`);
								continue;
							}
							out[spreadKey] = spreadValue;
						}
						continue;
					}
					const projected = project(flat, joinPath(path, key), depth + 1);
					if (projected && projected.error) return projected;
					if (isObject(projected)) Object.assign(out, projected);
					continue;
				}
				const projected = project(value, joinPath(path, key), depth + 1);
				if (projected && projected.error) return projected;
				out[key] = projected;
				continue;
			}
			const projected = project(value, joinPath(path, key), depth + 1);
			if (projected && projected.error) return projected;
			out[key] = projected;
		}
		if (strict && profile.requiresAdditionalPropertiesFalseInStrict && out.type === "object" && out.additionalProperties === undefined) {
			out.additionalProperties = false;
			dropped.push(`${path || "$"}:additionalProperties=false(imposed)`);
		}
		if (out.type === "object" && out.additionalProperties === true && strict && profile.requiresAdditionalPropertiesFalseInStrict) {
			out.additionalProperties = false;
			dropped.push(`${path || "$"}:additionalProperties=true->false`);
		}
		return out;
	}

	const projected = project(canonical ?? {}, "", 0);
	if (projected && projected.error) return fail(projected.error, projected.field);
	return { ok: true, schema: projected, dropped };
}

/**
 * Preflight a tool set against the exact backend that will receive the
 * request. Returns per-tool projections; `ok:false` names the incompatible
 * tools so the caller can narrow the subset or switch backend BEFORE sending.
 */
export function checkToolWire(tools, backendId, options = {}) {
	const list = Array.isArray(tools) ? tools : [];
	const results = [];
	const incompatible = [];
	for (const tool of list.slice(0, 256)) {
		const name = typeof tool?.name === "string" && tool.name ? tool.name.slice(0, 128) : "unnamed-tool";
		if (!isObject(tool?.schema)) {
			results.push({ tool: name, ok: true, dropped: [], note: "no-schema" });
			continue;
		}
		const projected = projectWireSchema(tool.schema, backendId, options);
		if (projected.ok) {
			results.push({ tool: name, ok: true, dropped: projected.dropped, ...(projected.schema ? { schema: projected.schema } : {}) });
		} else {
			results.push({ tool: name, ok: false, dropped: projected.dropped, reason: projected.reason, ...(projected.field ? { field: projected.field } : {}) });
			incompatible.push({ tool: name, reason: projected.reason ?? "incompatible", ...(projected.field ? { field: projected.field } : {}) });
		}
	}
	return { ok: incompatible.length === 0, backend: getBackendProfile(backendId).id, results, incompatible };
}

export const __testing = { STRICT_UNSUPPORTED_KEYWORDS, CURATED_PROFILE_IDS: [...CURATED_PROFILES.keys()] };

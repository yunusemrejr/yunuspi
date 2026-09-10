/** Deterministic, source-preserving fusion. Worker labels are untrusted:
 * only byte-identical bodies are deduplicated, every distinct conflict remains,
 * and source owner/time order determines presentation, never factual truth. */

/** A single fragment emitted by a fusion-mode worker. */
export type FusionFragment = {
	owner: string;
	kind: "duplicate" | "complementary" | "conflict";
	body: string;
	updatedAt: number;
};

/** Global merge strategy chosen from the fragment kinds present. */
export type FusionStrategy = "deduped" | "union" | "disjoint-split";

/** Provenance entry: which worker owns which fused section. */
export type FusionProvenance = {
	section: string;
	owner: string;
};

/** Result of planning a fusion. */
export type FusionResult = {
	/** Conflicting source owners remain unresolved; preview order is not truth. */
	unresolvedConflicts?: string[];
	requiresReview?: boolean;
	truncated?: boolean;
	originalChars?: number;
	strategy: FusionStrategy;
	fusedBody: string;
	provenance: FusionProvenance[];
};

/** Optional planning config. */
export type FusionConfig = {
	maxBodyChars: number;
};

const DEFAULT_MAX_BODY_CHARS = 32768;
/** Hard ceiling for one fused body, regardless of caller configuration. */
export const MAX_FUSION_BODY_CHARS = 131072;
const TRUNCATION_MARKER = "...[truncated]";
const KINDS: readonly string[] = ["duplicate", "complementary", "conflict"];

function fieldError(index: number | null, field: string, msg: string): never {
	const where = index === null ? "fragments" : `fragments[${index}]`;
	const name = field ? `.${field}` : "";
	throw new TypeError(`${where}${name}: ${msg}`);
}

/** Validates one fragment object; throws TypeError naming the bad field. */
function validateFragmentShape(fragment: unknown, index: number): asserts fragment is FusionFragment {
	const f = fragment as Record<string, unknown>;
	if (f === null || typeof f !== "object" || Array.isArray(f)) {
		throw fieldError(index, "", "must be an object");
	}
	if (typeof f.owner !== "string" || f.owner.length === 0) {
		throw fieldError(index, "owner", "must be a non-empty string");
	}
	if (typeof f.kind !== "string" || !KINDS.includes(f.kind)) {
		throw fieldError(index, "kind", "must be one of " + KINDS.join("|"));
	}
	if (typeof f.body !== "string") {
		throw fieldError(index, "body", "must be a string");
	}
	if (typeof f.updatedAt !== "number" || !Number.isFinite(f.updatedAt)) {
		throw fieldError(index, "updatedAt", "must be a finite number");
	}
}

/** Validates the fragment array; throws TypeError naming the bad field. */
export function validateFragments(fragments: unknown): asserts fragments is FusionFragment[] {
	if (!Array.isArray(fragments)) {
		throw fieldError(null, "", "must be an array");
	}
	for (let i = 0; i < fragments.length; i++) {
		validateFragmentShape(fragments[i], i);
	}
}

function validateConfig(config: FusionConfig | undefined): number {
	if (config === undefined) return DEFAULT_MAX_BODY_CHARS;
	const c = config as Record<string, unknown>;
	if (c === null || typeof c !== "object" || Array.isArray(c)) {
		throw new TypeError("config must be an object");
	}
	if (typeof c.maxBodyChars !== "number" || !Number.isInteger(c.maxBodyChars) || c.maxBodyChars <= 0) {
		throw new TypeError("config.maxBodyChars must be a positive integer");
	}
	if (c.maxBodyChars > MAX_FUSION_BODY_CHARS) {
		throw new TypeError(`config.maxBodyChars must be <= ${MAX_FUSION_BODY_CHARS}`);
	}
	return c.maxBodyChars;
}

/** Global strategy implied by the fragment kinds. */
export function classifyFusionStrategy(fragments: FusionFragment[]): FusionStrategy {
	validateFragments(fragments);
	if (fragments.length === 0) return "deduped";
	if (fragments.some((f) => f.kind === "conflict")) return "disjoint-split";
	if (fragments.every((f) => f.kind === "duplicate") && fragments.every(f=>f.body===fragments[0].body)) return "deduped";
	return "union";
}

const FRAGMENT_FENCE_OPEN: RegExp = /```[ \t]*fragment[ \t]*\n/g;

/**
 * Extracts fenced fragment blocks from a fusion-mode worker's output (the
 * ```fragment format documented in extensions/pi-subagents/prompts/fusion.md).
 *
 * Text outside fragment blocks is ignored (workers are told not to emit it,
 * but stray prose must not kill a merge). Each fenced block must parse as a
 * valid fragment — malformed blocks throw a TypeError naming the block index,
 * and an unterminated fragment fence is loud for the same reason: the worker
 * announced a fragment it never delivered.
 *
 * Returns [] when the text contains no fragment fence at all — callers decide
 * the fallback (runs.fuse treats such output as one complementary section).
 */
export function parseFragmentBlocks(text: string): FusionFragment[] {
	if (typeof text !== "string") {
		throw new TypeError("parseFragmentBlocks: text must be a string");
	}
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const blockRe = /```[ \t]*fragment[ \t]*\n([\s\S]*?)```/g;
	const fragments: FusionFragment[] = [];
	let match: RegExpExecArray | null;
	while ((match = blockRe.exec(normalized)) !== null) {
		const index = fragments.length;
		let parsed: unknown;
		try {
			parsed = JSON.parse(match[1]);
		} catch (error) {
			throw new TypeError(
				`fragments[${index}]: fenced fragment block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		validateFragmentShape(parsed, index);
		fragments.push(parsed);
	}
	const openers = normalized.match(FRAGMENT_FENCE_OPEN)?.length ?? 0;
	if (openers > fragments.length) {
		throw new TypeError("fragments[" + fragments.length + "]: unterminated fragment fence (opening ```fragment without a closing ```)");
	}
	return fragments;
}

function byOwnerThenTime(a: FusionFragment, b: FusionFragment): number {
	if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1;
	return a.updatedAt - b.updatedAt;
}

function applyBound(body: string, maxBodyChars: number): string {
	if (body.length <= maxBodyChars) return body;
	if (maxBodyChars <= TRUNCATION_MARKER.length) {
		return body.slice(0, maxBodyChars);
	}
	return body.slice(0, maxBodyChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Plans the fusion of fragments into a single bounded body with provenance.
 * Deterministic: identical input always yields identical output.
 */
export function planFusion(fragments: FusionFragment[], config?: FusionConfig): FusionResult {
 validateFragments(fragments);
 const maxBodyChars=validateConfig(config);
 const strategy=classifyFusionStrategy(fragments);
 const ordered=fragments.slice().sort((a,b)=>Number(b.kind==="conflict")-Number(a.kind==="conflict")||byOwnerThenTime(a,b));
 const sections=new Map<string,string>();
 const parts:string[]=[];
 const provenance:FusionProvenance[]=[];
 for(const fragment of ordered) {
  let section=sections.get(fragment.body);
  if(!section){section=`s${sections.size+1}`;sections.set(fragment.body,section);parts.push(fragment.body);}
  if(!provenance.some(item=>item.section===section&&item.owner===fragment.owner))provenance.push({section,owner:fragment.owner});
 }
 const body=parts.join("\n\n");
 const truncated=body.length>maxBodyChars;
 return {strategy,fusedBody:applyBound(body,maxBodyChars),provenance,
  ...(truncated?{truncated:true,originalChars:body.length,requiresReview:true}:{}),
  ...(strategy==="disjoint-split"?{requiresReview:true,unresolvedConflicts:[...new Set(fragments.filter(f=>f.kind==="conflict").map(f=>f.owner))]}:{})};
}

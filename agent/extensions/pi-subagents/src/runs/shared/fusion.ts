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
	/** UTF-16 character range of this source's retained body, excluding the truncation marker. */
	start: number;
	end: number;
	omitted?: boolean;
	truncated?: boolean;
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
	maxBodyChars?: number;
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
	if (typeof f.owner !== "string" || f.owner.trim().length === 0) {
		throw fieldError(index, "owner", "must be a non-empty string");
	}
	if (typeof f.kind !== "string" || !KINDS.includes(f.kind)) {
		throw fieldError(index, "kind", "must be one of " + KINDS.join("|"));
	}
	if (typeof f.body !== "string" || !f.body.trim()) {
		throw fieldError(index, "body", "must be a non-empty string");
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
	if (c.maxBodyChars === undefined) return DEFAULT_MAX_BODY_CHARS;
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
	const openRe = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*fragment[ \t]*(?:\n|$)/gm;
	const fragments: FusionFragment[] = [];
	let match: RegExpExecArray | null;
	while ((match = openRe.exec(normalized)) !== null) {
		const index = fragments.length, fence = match[1];
		// Markdown fences end on their own line. Backticks inside a JSON body
		// (for example an escaped code block) are ordinary source content.
		const closeRe = new RegExp(`^[ \\t]{0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n|$)`, "gm");
		closeRe.lastIndex = openRe.lastIndex;
		const closing = closeRe.exec(normalized);
		if (!closing) throw new TypeError(`fragments[${index}]: unterminated fragment fence`);
		let parsed: unknown;
		try { parsed = JSON.parse(normalized.slice(openRe.lastIndex, closing.index)); }
		catch (error) {
			throw new TypeError(`fragments[${index}]: fenced fragment block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		validateFragmentShape(parsed, index);
		fragments.push(parsed);
		openRe.lastIndex = closeRe.lastIndex;
	}
	return fragments;
}

function byOwnerThenTime(a: FusionFragment, b: FusionFragment): number {
	if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1;
	return a.updatedAt - b.updatedAt;
}

function retainedChars(body: string, maxBodyChars: number): number {
	if (body.length <= maxBodyChars) return body.length;
	let end = maxBodyChars <= TRUNCATION_MARKER.length ? maxBodyChars : maxBodyChars - TRUNCATION_MARKER.length;
	// Never leave a lone UTF-16 high surrogate at the truncation boundary.
	if (end > 0 && /[\uD800-\uDBFF]/.test(body[end - 1]) && /[\uDC00-\uDFFF]/.test(body[end])) end--;
	return end;
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
 const sections=new Map<string,{section:string;start:number;end:number}>();
 let originalChars=0;
 const provenanceOwners=new Map<string,Set<string>>();
 const parts:string[]=[];
 const provenance:FusionProvenance[]=[];
 for(const fragment of ordered) {
  let range=sections.get(fragment.body);
  if(!range){
   const start=originalChars+(parts.length?2:0);
   range={section:`s${sections.size+1}`,start,end:start+fragment.body.length};
   originalChars=range.end;sections.set(fragment.body,range);parts.push(fragment.body);
  }
  const {section}=range;
  let owners=provenanceOwners.get(section);
  if(!owners){owners=new Set<string>();provenanceOwners.set(section,owners);}
  if(!owners.has(fragment.owner)){owners.add(fragment.owner);provenance.push({...range,owner:fragment.owner});}
 }
 const body=parts.join("\n\n");
 const truncated=body.length>maxBodyChars;
 const retained=retainedChars(body,maxBodyChars);
 const fusedBody=body.slice(0,retained)+(truncated&&maxBodyChars>TRUNCATION_MARKER.length?TRUNCATION_MARKER:"");
 return {strategy,fusedBody,provenance:provenance.map(entry=>entry.end<=retained?entry:{...entry,start:Math.min(entry.start,retained),end:retained,...(entry.start>=retained?{omitted:true}:{truncated:true})}),
  ...(truncated?{truncated:true,originalChars:body.length,requiresReview:true}:{}),
  ...(strategy==="disjoint-split"?{requiresReview:true,unresolvedConflicts:[...new Set(fragments.filter(f=>f.kind==="conflict").map(f=>f.owner))]}:{})};
}

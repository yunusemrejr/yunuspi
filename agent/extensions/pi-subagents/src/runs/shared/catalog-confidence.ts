/**
 * Catalog-confidence metadata for capability facts.
 *
 * Every capability fact — context size, max output, reasoning support, image
 * support, tool calling, structured outputs, price, cache pricing — carries
 * provenance and confidence instead of a bare value. Selection can require
 * high-confidence evidence selectively rather than treating all metadata
 * equally.
 *
 * Provenance ladder (strongest first):
 *   live-provider       observed from the provider in this session
 *   official-pricing    provider's official pricing/catalog endpoint
 *   user-override       explicit local configuration
 *   stored-cache        previously fetched evidence, within bounds
 *   inferred-fallback   guessed default (e.g. 8192 output fallback)
 *   unknown             no evidence at all
 *
 * Free status, model quality, route reliability, child capacity, backend
 * compatibility, and budget remain independent gates; this module only labels
 * the evidence each gate consumed. Dependency-free and pure.
 */

export type CapabilityProvenance =
	| "live-provider"
	| "official-pricing"
	| "user-override"
	| "stored-cache"
	| "inferred-fallback"
	| "unknown";

export interface ConfidentValue<T> {
	value: T;
	provenance: CapabilityProvenance;
	/** Unix ms when the evidence was captured; 0 for unknown. */
	observedAt: number;
	/** Revision/etag of the source catalog when known. */
	sourceRevision?: string;
	unknown: boolean;
}

const PROVENANCE_RANK: Record<CapabilityProvenance, number> = {
	"live-provider": 5,
	"official-pricing": 4,
	"user-override": 3,
	"stored-cache": 2,
	"inferred-fallback": 1,
	unknown: 0,
};

export function confidentValue<T>(
	value: T,
	provenance: CapabilityProvenance,
	observedAt = Date.now(),
	sourceRevision?: string,
): ConfidentValue<T> {
	return {
		value,
		provenance,
		observedAt: provenance === "unknown" ? 0 : observedAt,
		...(sourceRevision ? { sourceRevision } : {}),
		unknown: provenance === "unknown",
	};
}

export function unknownValue<T>(value: T): ConfidentValue<T> {
	return { value, provenance: "unknown", observedAt: 0, unknown: true };
}

/** True when the evidence meets or exceeds the required provenance floor. */
export function meetsProvenance<T>(fact: ConfidentValue<T> | undefined, floor: CapabilityProvenance): boolean {
	if (!fact || fact.unknown) return false;
	return PROVENANCE_RANK[fact.provenance] >= PROVENANCE_RANK[floor];
}

export interface CapabilityFacts {
	contextWindow?: ConfidentValue<number>;
	maxOutput?: ConfidentValue<number>;
	reasoning?: ConfidentValue<boolean>;
	imageInput?: ConfidentValue<boolean>;
	toolCalling?: ConfidentValue<boolean>;
	structuredOutput?: ConfidentValue<boolean>;
	inputPricePerMillion?: ConfidentValue<number>;
	outputPricePerMillion?: ConfidentValue<number>;
	cacheReadPricePerMillion?: ConfidentValue<number>;
	cacheWritePricePerMillion?: ConfidentValue<number>;
	free?: ConfidentValue<boolean>;
}

export interface ProvenanceRequirement {
	/** Minimum provenance per fact; unset facts accept anything known. */
	floors?: Partial<Record<keyof CapabilityFacts, CapabilityProvenance>>;
	/** When true, unknown facts reject instead of merely degrading. */
	requireKnown?: Array<keyof CapabilityFacts>;
}

export interface ProvenanceVerdict {
	ok: boolean;
	/** Machine-readable misses: fact -> have (want floor). */
	misses: string[];
}

/**
 * Check capability facts against a provenance policy. Unknown evidence is
 * reported as unknown — never silently treated as zero, false, or failed.
 */
export function checkCapabilityProvenance(facts: CapabilityFacts, policy: ProvenanceRequirement = {}): ProvenanceVerdict {
	const misses: string[] = [];
	for (const [fact, floor] of Object.entries(policy.floors ?? {}) as Array<[keyof CapabilityFacts, CapabilityProvenance]>) {
		const value = facts[fact] as ConfidentValue<unknown> | undefined;
		if (!meetsProvenance(value, floor)) {
			misses.push(`${fact}: have ${value?.provenance ?? "unknown"}, want >= ${floor}`);
		}
	}
	for (const fact of policy.requireKnown ?? []) {
		const value = facts[fact] as ConfidentValue<unknown> | undefined;
		if (!value || value.unknown) misses.push(`${fact}: unknown`);
	}
	return { ok: misses.length === 0, misses };
}

/** Compact one-line provenance summary for decision records and diagnostics. */
export function summarizeProvenance(facts: CapabilityFacts): string {
	const parts: string[] = [];
	const show = (name: string, fact: ConfidentValue<unknown> | undefined) => {
		if (!fact) return;
		parts.push(`${name}=${fact.unknown ? "unknown" : fact.provenance}`);
	};
	show("ctx", facts.contextWindow);
	show("out", facts.maxOutput);
	show("rsn", facts.reasoning);
	show("img", facts.imageInput);
	show("tools", facts.toolCalling);
	show("so", facts.structuredOutput);
	show("price", facts.inputPricePerMillion);
	show("free", facts.free);
	return parts.join(" ");
}

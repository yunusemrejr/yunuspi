/**
 * Explicit context-injection provenance.
 *
 * Every injected context block carries owner, semantic hash, source revision,
 * TTL/freshness, estimated tokens, protected status, and whether it
 * materially differs from the last injection. The harness can finally tell
 * genuinely new project intelligence apart from repeated churn.
 *
 * Cache discipline: stable prompt prefixes are preserved aggressively.
 * Dynamic session/status scalars live in narrow late-bound blocks instead of
 * modifying earlier stable context — the optimization target is the
 * invalidation tail, not shrinking capabilities.
 *
 * Dependency-free except node:crypto for stable hashing.
 */
import { createHash } from "node:crypto";

export interface InjectionEnvelope {
	/** Owning subsystem (project-intelligence, reminders, lens, ...). */
	owner: string;
	/** Semantic hash of the normalized block bytes. */
	hash: string;
	/** Source revision (graph digest, file mtime bucket, config fingerprint). */
	sourceRevision: string;
	/** Milliseconds the block stays fresh; 0 means single-use. */
	ttlMs: number;
	injectedAt: number;
	/** Estimated tokens (chars/4 magnitude check, not a tokenizer). */
	estimatedTokens: number;
	/** Protected blocks survive compaction pressure. */
	protected: boolean;
	/** True when bytes differ materially from this owner's last injection. */
	materiallyNew: boolean;
	/** Placement: stable prefix blocks vs late-bound dynamic blocks. */
	placement: "stable-prefix" | "late-bound";
}

export interface InjectionInput {
	owner: string;
	bytes: string;
	sourceRevision?: string;
	ttlMs?: number;
	protected?: boolean;
	placement?: "stable-prefix" | "late-bound";
	at?: number;
}

const CHARS_PER_TOKEN = 4;
const lastByOwner = new Map<string, string>();

function semanticHash(bytes: string): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/** Wrap an injection with full provenance. Pure except the per-owner last-hash ledger. */
export function envelopInjection(input: InjectionInput): { envelope: InjectionEnvelope; bytes: string } {
	const bytes = input.bytes ?? "";
	const hash = semanticHash(bytes);
	const owner = input.owner.slice(0, 80);
	const prior = lastByOwner.get(owner);
	const materiallyNew = prior !== hash;
	lastByOwner.set(owner, hash);
	return {
		envelope: {
			owner,
			hash,
			sourceRevision: (input.sourceRevision ?? "unknown").slice(0, 128),
			ttlMs: Math.max(0, input.ttlMs ?? 0),
			injectedAt: input.at ?? Date.now(),
			estimatedTokens: Math.ceil(bytes.length / CHARS_PER_TOKEN),
			protected: input.protected === true,
			materiallyNew,
			placement: input.placement ?? "stable-prefix",
		},
		bytes,
	};
}

/** Whether a prior envelope is still fresh at `now`. */
export function injectionFresh(envelope: InjectionEnvelope, now = Date.now()): boolean {
	if (envelope.ttlMs <= 0) return false;
	return now - envelope.injectedAt < envelope.ttlMs;
}

/**
 * Split dynamic scalars out of a stable block. Returns the stable bytes
 * (byte-identical when dynamic values change) plus a late-bound block. Volatile
 * scalars must never live inside stable-prefix bytes (append-only history).
 */
export function splitLateBound(stableTemplate: string, dynamic: Record<string, string>): { stable: string; lateBound: string } {
	const lateBound = Object.entries(dynamic)
		.slice(0, 32)
		.map(([key, value]) => `${key}: ${String(value).slice(0, 280)}`)
		.join("\n");
	return { stable: stableTemplate, lateBound };
}

/** Reset the per-owner ledger (tests and session turnover). */
export function clearInjectionLedger(): void {
	lastByOwner.clear();
}

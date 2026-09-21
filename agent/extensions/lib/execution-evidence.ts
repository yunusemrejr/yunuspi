/**
 * Unified ExecutionEvidence contract.
 *
 * Tools, subagents, background jobs, reviews, tests, and provider calls expose
 * one common minimal envelope: identity, owner, start/end, state, cause,
 * artifacts, usage, mutation evidence, verification evidence, provenance, and
 * recoverability. Specialized fields stay nested under `detail` — this removes
 * the cross-module translation bugs where each consumer re-inferred what
 * another module already knew.
 *
 * Dependency-free and pure.
 */

export type EvidenceState =
	| "queued"
	| "running"
	| "paused"
	| "stopped"
	| "completed"
	| "failed"
	| "unknown";

export type EvidenceOwner =
	| "parent"
	| "subagent"
	| "background"
	| "review"
	| "test"
	| "provider"
	| "hook"
	| "system";

export interface EvidenceIdentity {
	/** Stable logical id (task id, job id, review id, call id). */
	id: string;
	/** Attempt number for retried work; 1 when unattempted. */
	attempt?: number;
	/** Owning todo id when this evidence belongs to tracked work. */
	todoId?: string;
	/** Human-readable label. */
	label?: string;
}

export interface EvidenceUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	turns?: number;
	/** Cost state: unknown is first-class, never zero-filled. */
	costUsd?: number;
	costState?: "unknown" | "estimated" | "provider-reported" | "subscription" | "free-evidence" | "pending" | "verified-zero";
}

export interface MutationEvidence {
	/** Whether the unit of work changed durable state. Unknown stays unknown. */
	mutated?: boolean;
	filesChanged?: number;
	/** Redacted paths/identifiers only; never contents. */
	targets?: string[];
}

export interface VerificationEvidence {
	/** How the outcome was checked: tests, review, inspection, none, unknown. */
	method?: string;
	passed?: boolean;
	/** Evidence ids backing the verdict (test receipt, review id). */
	evidenceIds?: string[];
	coverage?: "complete" | "partial" | "stale" | "incomplete" | "unknown";
}

export interface Recoverability {
	/** Whether the work can be resumed/retried from retained state. */
	resumable: boolean;
	/** What to do next, in the caller's vocabulary. */
	nextAction?: "resume" | "retry-changed" | "retry-same" | "split" | "inspect" | "abandon" | "none";
	detail?: string;
}

export interface ExecutionEvidence {
	version: 1;
	identity: EvidenceIdentity;
	owner: EvidenceOwner;
	startedAt?: number;
	endedAt?: number;
	state: EvidenceState;
	/** Compact machine-readable cause id (failure category or ok/*). */
	cause?: string;
	/** Retained artifact references (paths/ids, never contents). */
	artifacts: string[];
	usage?: EvidenceUsage;
	mutation?: MutationEvidence;
	verification?: VerificationEvidence;
	/** Provenance: which subsystem produced this record, which schema version. */
	provenance: { producer: string; schema: string };
	recoverability?: Recoverability;
	/** Specialized nested fields stay here; the envelope above is canonical. */
	detail?: Record<string, unknown>;
}

export interface EvidenceInput {
	identity: EvidenceIdentity;
	owner?: EvidenceOwner;
	startedAt?: number;
	endedAt?: number;
	state?: EvidenceState;
	cause?: string;
	artifacts?: string[];
	usage?: EvidenceUsage;
	mutation?: MutationEvidence;
	verification?: VerificationEvidence;
	producer: string;
	recoverability?: Recoverability;
	detail?: Record<string, unknown>;
}

const MAX_ARTIFACTS = 32;

function cleanString(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value.slice(0, max) : undefined;
}

function cleanNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Build a bounded, JSON-safe ExecutionEvidence envelope. */
export function buildExecutionEvidence(input: EvidenceInput): ExecutionEvidence {
	const artifacts = (input.artifacts ?? [])
		.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
		.map((entry) => entry.slice(0, 512))
		.slice(0, MAX_ARTIFACTS);
	const usage = input.usage
		? {
			...(cleanNumber(input.usage.input) === undefined ? {} : { input: cleanNumber(input.usage.input) }),
			...(cleanNumber(input.usage.output) === undefined ? {} : { output: cleanNumber(input.usage.output) }),
			...(cleanNumber(input.usage.cacheRead) === undefined ? {} : { cacheRead: cleanNumber(input.usage.cacheRead) }),
			...(cleanNumber(input.usage.cacheWrite) === undefined ? {} : { cacheWrite: cleanNumber(input.usage.cacheWrite) }),
			...(cleanNumber(input.usage.reasoning) === undefined ? {} : { reasoning: cleanNumber(input.usage.reasoning) }),
			...(cleanNumber(input.usage.turns) === undefined ? {} : { turns: cleanNumber(input.usage.turns) }),
			...(cleanNumber(input.usage.costUsd) === undefined ? {} : { costUsd: cleanNumber(input.usage.costUsd) }),
			...(input.usage.costState ? { costState: input.usage.costState } : {}),
		}
		: undefined;
	return {
		version: 1,
		identity: {
			id: cleanString(input.identity.id, 200) ?? "unknown",
			...(input.identity.attempt === undefined ? {} : { attempt: input.identity.attempt }),
			...(cleanString(input.identity.todoId, 160) ? { todoId: cleanString(input.identity.todoId, 160) } : {}),
			...(cleanString(input.identity.label, 160) ? { label: cleanString(input.identity.label, 160) } : {}),
		},
		owner: input.owner ?? "system",
		...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
		...(input.endedAt === undefined ? {} : { endedAt: input.endedAt }),
		state: input.state ?? "unknown",
		...(cleanString(input.cause, 160) ? { cause: cleanString(input.cause, 160) } : {}),
		artifacts,
		...(usage && Object.keys(usage).length ? { usage: usage as EvidenceUsage } : {}),
		...(input.mutation ? { mutation: input.mutation } : {}),
		...(input.verification ? { verification: input.verification } : {}),
		provenance: { producer: cleanString(input.producer, 80) ?? "unknown", schema: "execution-evidence/v1" },
		...(input.recoverability ? { recoverability: input.recoverability } : {}),
		...(input.detail ? { detail: input.detail } : {}),
	};
}

/** Merge specialized records into one envelope list without re-inference. */
export function mergeEvidenceLists(...lists: ExecutionEvidence[][]): ExecutionEvidence[] {
	const merged = new Map<string, ExecutionEvidence>();
	for (const list of lists) {
		for (const evidence of list.slice(0, 512)) {
			const key = `${evidence.owner}:${evidence.identity.id}:${evidence.identity.attempt ?? 1}`;
			const prior = merged.get(key);
			if (!prior) {
				merged.set(key, evidence);
				continue;
			}
			merged.set(key, {
				...prior,
				...evidence,
				artifacts: [...new Set([...prior.artifacts, ...evidence.artifacts])].slice(0, MAX_ARTIFACTS),
				detail: { ...(prior.detail ?? {}), ...(evidence.detail ?? {}) },
			});
		}
	}
	return [...merged.values()];
}

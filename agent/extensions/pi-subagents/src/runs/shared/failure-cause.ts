/**
 * Structured failure causes, preserved end-to-end.
 *
 * Replaces lossy markers (`child-error`, bare exit codes, "verification") with
 * a compact machine-readable failure object: stage, category, provider code,
 * backend, tool name, schema field, retryability, attempt, output presence,
 * truncation state, acceptance state, and a retained diagnostic reference. Raw
 * sensitive error text stays redacted or stored separately — privacy never
 * requires throwing away the cause.
 *
 * Classification parses the ACTUAL failure, not incidental text: structured
 * evidence first (validator codes, exit metadata, provider codes, parser error
 * types, budget/timeout state, acceptance results), regex over free-form text
 * only as a last-resort fallback. Words inside command output, SQL columns,
 * echoed prompts, or quoted data must not flip the category.
 *
 * Output truncation (`length` stops, max_tokens, answer-budget exhaustion,
 * structured-output cut-off) is its own category — not a provider-health
 * failure and not an acceptance failure. A length stop alone must not poison
 * provider health.
 *
 * Dependency-free and pure.
 */
import { createHash } from "node:crypto";

export type FailureStage =
	| "classify"
	| "select"
	| "preflight"
	| "launch"
	| "execute"
	| "tool"
	| "provider"
	| "parse"
	| "validate"
	| "accept"
	| "budget"
	| "recover";

export type FailureCategory =
	| "invalid-request"
	| "schema-incompatible"
	| "unsupported-field"
	| "auth"
	| "quota"
	| "rate-limit"
	| "overload"
	| "transport"
	| "timeout"
	| "context-overflow"
	| "output-truncated"
	| "budget-exhausted"
	| "permission"
	| "dependency"
	| "internal"
	| "process-signal"
	| "acceptance"
	| "interrupted"
	| "stopped"
	| "unknown"
	| "none";

export type TruncationState = "none" | "length-stop" | "answer-budget" | "structural-cutoff";
export type AcceptanceState = "none" | "pending" | "passed" | "failed";

/** Granular health key: model, provider, backend, and request shape stay separate. */
export interface HealthScope {
	model?: string;
	provider?: string;
	backend?: string;
	shapeHash?: string;
}

export interface FailureCause {
	stage: FailureStage;
	category: FailureCategory;
	/** Provider's own code (HTTP status, error type) when known. */
	providerCode?: string;
	backend?: string;
	tool?: string;
	schemaField?: string;
	/** Safe to retry without changing the payload. */
	retryable: boolean;
	/** Deterministic for the exact payload: retry requires a changed payload, backend, tool subset, or budget. */
	deterministicShape: boolean;
	attempt?: number;
	outputPresent: boolean;
	truncation: TruncationState;
	acceptance: AcceptanceState;
	/** Reference to retained diagnostics (event id, ledger key). No raw text. */
	diagnosticRef?: string;
	/** Normalized request-shape hash for payload-sensitive retry. */
	shapeHash?: string;
	/** Which health scopes this failure may cool (empty = no health impact). */
	healthScopes?: HealthScope;
}

/** Read compact persisted causes after raw provider text has been redacted.
 * Do not copy unknown fields or arbitrary strings into the UI projection. */
export function readFailureCause(value: unknown): FailureCause | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	const stages = ["classify", "select", "preflight", "launch", "execute", "tool", "provider", "parse", "validate", "accept", "budget", "recover"];
	const categories = ["invalid-request", "schema-incompatible", "unsupported-field", "auth", "quota", "rate-limit", "overload", "transport", "timeout", "context-overflow", "output-truncated", "budget-exhausted", "permission", "dependency", "internal", "process-signal", "acceptance", "interrupted", "stopped", "unknown", "none"];
	if (!stages.includes(String(row.stage)) || !categories.includes(String(row.category))) return undefined;
	if (typeof row.retryable !== "boolean" || typeof row.deterministicShape !== "boolean" || typeof row.outputPresent !== "boolean") return undefined;
	if (!["none", "length-stop", "answer-budget", "structural-cutoff"].includes(String(row.truncation)) || !["none", "pending", "passed", "failed"].includes(String(row.acceptance))) return undefined;
	return {
		stage: row.stage as FailureStage, category: row.category as FailureCategory,
		retryable: row.retryable, deterministicShape: row.deterministicShape, outputPresent: row.outputPresent,
		truncation: row.truncation as TruncationState, acceptance: row.acceptance as AcceptanceState,
		...(Number.isSafeInteger(row.attempt) && Number(row.attempt) > 0 ? { attempt: Number(row.attempt) } : {}),
		...Object.fromEntries(["providerCode", "backend", "tool", "schemaField", "diagnosticRef", "shapeHash"].flatMap(key =>
			typeof row[key] === "string" && /^[a-z0-9_.:/@+-]{1,256}$/i.test(row[key] as string) ? [[key, row[key]]] : [])),
	};
}

export interface StructuredFailureEvidence {
	stage?: FailureStage;
	/** Tool validator machine code (e.g. invalid-params, schema-mismatch). */
	validatorCode?: string;
	toolName?: string;
	schemaField?: string;
	/** Process exit metadata. */
	exitCode?: number;
	signal?: string;
	/** Provider response code: HTTP status or typed error code. */
	providerCode?: string | number;
	backend?: string;
	/** SQLite/parser typed error name. */
	parserError?: string;
	/** Typed JavaScript exception from the native helper launch boundary. */
	runtimeError?: string;
	/** Native child-process spawn code, not a provider response code. */
	processCode?: string;
	budgetExhausted?: boolean;
	timedOut?: boolean;
	timedOutPhase?: string;
	contextOverflow?: boolean;
	/** Stop/finish reason from the provider (length, stop, tool_calls, ...). */
	stopReason?: string;
	maxTokens?: number;
	outputTokens?: number;
	structuredOutputFailed?: boolean;
	acceptanceStatus?: "passed" | "failed" | "pending" | "none";
	stopped?: boolean;
	interrupted?: boolean;
	status?: string;
	error?: boolean;
	/** Normalized request shape for hashing (volatile fields stripped by caller or here). */
	requestShape?: unknown;
	attempt?: number;
	outputPresent?: boolean;
	diagnosticRef?: string;
	/** Free-form text: LAST resort only, bounded. */
	message?: string;
}

const VOLATILE_SHAPE_KEYS = new Set([
	"requestId", "request_id", "timestamp", "created", "nonce", "traceId", "trace_id",
	"spanId", "span_id", "sessionId", "session_id", "runId", "run_id", "attempt",
	"seed", "requestStartMs", "deadlineMs", "timeout",
]);

function normalizeShape(value: unknown, depth = 0): unknown {
	if (depth > 12) return "?";
	if (Array.isArray(value)) return value.slice(0, 64).map((entry) => normalizeShape(entry, depth + 1));
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !VOLATILE_SHAPE_KEYS.has(key))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.slice(0, 128);
		return Object.fromEntries(entries.map(([key, entry]) => [key, normalizeShape(entry, depth + 1)]));
	}
	if (typeof value === "string") return value.length > 512 ? value.slice(0, 512) : value;
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	return typeof value;
}

/** Hash a normalized provider request shape minus volatile fields. */
export function hashRequestShape(shape: unknown): string {
	return createHash("sha256").update(JSON.stringify(normalizeShape(shape) ?? null)).digest("hex").slice(0, 32);
}

function stopReasonTruncated(stopReason: string | undefined): TruncationState {
	const reason = (stopReason ?? "").toLowerCase();
	if (!reason) return "none";
	if (reason === "length" || reason === "max_tokens" || reason === "max-tokens" || reason.includes("length")) return "length-stop";
	if (reason.includes("budget")) return "answer-budget";
	return "none";
}

/**
 * Classify a failure from structured evidence. Order is deliberate:
 * explicit lifecycle flags, validator codes, provider codes, parser types,
 * budget/timeout/overflow state, truncation state, acceptance state, and only
 * then — bounded, last-resort — free-form text cues.
 */
export function classifyFailure(evidence: StructuredFailureEvidence = {}): FailureCause {
	const stage: FailureStage = evidence.stage ?? "execute";
	const attempt = Number.isSafeInteger(evidence.attempt) ? evidence.attempt : undefined;
	const outputPresent = evidence.outputPresent === true;
	const acceptance: AcceptanceState = evidence.acceptanceStatus ?? "none";
	const shapeHash = evidence.requestShape === undefined ? undefined : hashRequestShape(evidence.requestShape);
	const diagnosticRef = typeof evidence.diagnosticRef === "string" && evidence.diagnosticRef.length <= 256 ? evidence.diagnosticRef : undefined;
	const backend = typeof evidence.backend === "string" && evidence.backend.length <= 128 ? evidence.backend : undefined;
	const tool = typeof evidence.toolName === "string" && evidence.toolName.length <= 128 ? evidence.toolName : undefined;
	const schemaField = typeof evidence.schemaField === "string" && evidence.schemaField.length <= 256 ? evidence.schemaField : undefined;

	const finish = (
		category: FailureCategory,
		overrides: Partial<FailureCause> = {},
	): FailureCause => ({
		stage,
		category,
		...(evidence.providerCode !== undefined ? { providerCode: String(evidence.providerCode).slice(0, 64) } : {}),
		...(backend ? { backend } : {}),
		...(tool ? { tool } : {}),
		...(schemaField ? { schemaField } : {}),
		retryable: false,
		deterministicShape: false,
		...(attempt === undefined ? {} : { attempt }),
		outputPresent,
		truncation: stopReasonTruncated(evidence.stopReason),
		acceptance,
		...(diagnosticRef ? { diagnosticRef } : {}),
		...(shapeHash ? { shapeHash } : {}),
		...overrides,
	});

	// 1. Explicit lifecycle flags win over everything else.
	if (evidence.stopped || evidence.status === "stopped") return finish("stopped", { healthScopes: {} });
	if (evidence.interrupted || evidence.status === "paused") return finish("interrupted", { retryable: true, healthScopes: {} });

	if (["ReferenceError", "TypeError", "SyntaxError"].includes(evidence.runtimeError ?? "")) return finish("internal", { healthScopes: {} });

	if (evidence.stage === "launch" && ["EACCES", "EPERM"].includes(evidence.processCode ?? "")) return finish("permission", { healthScopes: {} });
	if (evidence.stage === "launch" && evidence.processCode === "ENOENT") return finish("dependency", { healthScopes: {} });

	// 2. Tool validator codes (structured, exact).
	if (evidence.validatorCode) {
		const code = evidence.validatorCode.toLowerCase();
		if (/schema|params|arguments|validation|invalid-json|malformed/.test(code)) {
			return finish("schema-incompatible", {
				deterministicShape: true,
				healthScopes: backend ? { backend } : {},
			});
		}
		if (/unsupported|unknown-(field|tool|parameter)/.test(code)) {
			return finish("unsupported-field", { deterministicShape: true, healthScopes: backend ? { backend } : {} });
		}
	}

	// 3. Provider response codes (structured, exact).
	if (evidence.providerCode !== undefined) {
		const code = String(evidence.providerCode);
		if (code === "401" || code === "403" || /invalid[_ -]?key|unauthorized|forbidden|invalid_api_key/i.test(code)) {
			return finish("auth", { healthScopes: {} });
		}
		if (code === "429" || /rate[_ -]?limit/i.test(code)) {
			return finish("rate-limit", { retryable: true, healthScopes: { provider: undefined, backend } });
		}
		if (/quota|insufficient[_ -]?(credits|quota)|billing|purchase[_ -]?credits/i.test(code)) {
			return finish("quota", { healthScopes: {} });
		}
		if (["500", "502", "503", "504", "524", "529"].includes(code) || /overloaded|overload|capacity/i.test(code)) {
			return finish("overload", { retryable: true, healthScopes: backend ? { backend } : {} });
		}
		if (code === "400" || code === "422" || /invalid[_ -]?request|bad[_ -]?request|validation[_ -]?error/i.test(code)) {
			return finish("invalid-request", { deterministicShape: true, healthScopes: backend ? { backend } : {} });
		}
		if (code === "413" || /context[_ -]?(length|limit|overflow)|too[_ -]?many[_ -]?tokens|maximum[_ -]?context/i.test(code)) {
			return finish("context-overflow", { healthScopes: {} });
		}
		if (/fetch[_ -]?failed|socket|econn|etimedout|stream[_ -]?(closed|error|ended)|connection/i.test(code)) {
			return finish("transport", { retryable: true, healthScopes: backend ? { backend } : {} });
		}
	}

	// 4. Parser / storage typed errors.
	if (evidence.parserError) {
		return finish("dependency", { healthScopes: {} });
	}

	// 5. Budget / timeout / overflow state.
	if (evidence.budgetExhausted) return finish("budget-exhausted", { healthScopes: {} });
	if (evidence.timedOut) return finish("timeout", { retryable: true, healthScopes: {} });
	if (evidence.contextOverflow) return finish("context-overflow", { healthScopes: {} });

	// 6. Truncation state: a length stop is its own category and must NOT
	// poison provider health, whatever else the record contains.
	const truncation = stopReasonTruncated(evidence.stopReason);
	if (truncation !== "none") {
		return finish("output-truncated", { truncation, retryable: true, healthScopes: {} });
	}
	if (evidence.structuredOutputFailed) {
		return finish("output-truncated", { truncation: "structural-cutoff", retryable: true, healthScopes: {} });
	}

	// 7. Process signals are structured and specific. A bare nonzero exit code
	// is NOT specific: it only proves "the process failed", so it must not
	// outrank a specific failure report in the message ("HTTP 503"). Bare
	// exits fall through to message cues, then to unknown (missing evidence
	// stays unknown — never invented as a dependency failure).
	if (evidence.signal) return finish("process-signal", { healthScopes: {} });

	// 8. Acceptance state: execution outcome and acceptance outcome are
	// recorded independently. Acceptance failure here means execution produced
	// output that did not pass — transport/truncation/budget causes above win.
	if (acceptance === "failed") return finish("acceptance", { healthScopes: {} });

	// 9. No failure signal at all.
	if (!evidence.error && evidence.status !== "failed") return finish("none", { healthScopes: {} });

	// 10. Last resort: bounded cues over free-form text. These patterns match
	// failure REPORTS, not incidental echoes: bare nouns that also appear in
	// SQL columns, quoted data, or echoed prompts ("schema", "budget", "error")
	// never match alone — they need failure verbs, provider status codes, or
	// harness gate prefixes.
	const message = (evidence.message ?? "").slice(0, 4000);
	if (message) {
		if (/\b(?:502|503|504|524|529)\b/.test(message)) return finish("transport", { retryable: true, healthScopes: backend ? { backend } : {} });
		if (/\b429\b/.test(message)) return finish("rate-limit", { retryable: true, healthScopes: {} });
		if (/\b413\b/.test(message)) return finish("context-overflow", { healthScopes: {} });
		if (/\b(?:401|403)\b|\bEPERM\b/.test(message)) return finish("permission", { healthScopes: {} });
		if (/^blocked:/im.test(message)) return finish("permission", { healthScopes: {} });
		if (/timed?\s+out|deadline exceeded|exceeded (?:the )?timeout/i.test(message)) return finish("timeout", { retryable: true, healthScopes: {} });
		if (/rate limited|rate-limit exceeded|quota exceeded|insufficient (?:credits|quota|balance)/i.test(message)) {
			return finish(/quota|credits|balance/i.test(message) ? "quota" : "rate-limit", {
				retryable: !/quota|credits|balance/i.test(message),
				healthScopes: {},
			});
		}
		if (/(?:budget|economy|price cap|cost limit).{0,48}(?:exceeded|exhausted|blocked|denied)|exceeded.{0,48}(?:budget|cost limit)/i.test(message)) {
			return finish("budget-exhausted", { healthScopes: {} });
		}
		if (/context (?:length|limit) exceeded|maximum context|too many tokens|input too (?:long|large)/i.test(message)) {
			return finish("context-overflow", { healthScopes: {} });
		}
		if (/^spawn(?:Sync)? .+ (?:EACCES|EPERM)$/.test(message) || /permission denied|not authorized|unauthorized|operation not permitted/i.test(message)) {
			return finish("permission", { healthScopes: {} });
		}
		if (/cannot find (?:module|package)|module not found|command not found|enoent/i.test(message)) {
			return finish("dependency", { healthScopes: {} });
		}
		if (/structured.?output.{0,48}(?:failed|invalid|error)|invalid.?json|json parse (?:error|failed)|schema validation failed|no (?:final|useful) output/i.test(message)) {
			return finish("schema-incompatible", { deterministicShape: true, healthScopes: backend ? { backend } : {} });
		}
		if (/invalid (?:request|parameters|arguments)|malformed request|unexpected token/i.test(message)) {
			return finish("invalid-request", { deterministicShape: true, healthScopes: backend ? { backend } : {} });
		}
		if (/acceptance (?:failed|rejected)|completed without making edits|missing required output/i.test(message)) {
			return finish("acceptance", { healthScopes: {} });
		}
		if (/service unavailable|bad gateway|gateway timeout|fetch failed|socket hang up|connection (?:reset|refused|closed)/i.test(message)) {
			return finish("transport", { retryable: true, healthScopes: backend ? { backend } : {} });
		}
		if (/\b(?:killed|terminated)\b|signal (?:term|kill|segv|abrt)/i.test(message)) return finish("process-signal", { healthScopes: {} });
	}

	// 11. A child that traps a signal exits with the conventional 128+N code
	// and no signal field (143 SIGTERM, 129 SIGHUP, 130 SIGINT, 137 SIGKILL).
	// Only after every message cue, so a specific report still wins.
	if (evidence.exitCode !== undefined && [129, 130, 137, 143].includes(evidence.exitCode)) return finish("process-signal", { healthScopes: {} });

	return finish("unknown", { healthScopes: {} });
}

/**
 * Whether this failure may cool provider health, and at which granularity. An
 * invalid tool schema on one backend cools that backend only — never the base
 * model globally. Overload on one serving provider never excludes the same
 * model elsewhere. Length stops, quota, auth, budget, and acceptance outcomes
 * never cool anything.
 */
export function healthImpactForCause(cause: FailureCause): { cool: boolean; scope: "backend" | "provider" | "none" } {
	switch (cause.category) {
		case "overload":
		case "transport":
		case "rate-limit":
			return { cool: true, scope: cause.backend ? "backend" : "provider" };
		case "invalid-request":
		case "schema-incompatible":
		case "unsupported-field":
			// Request-shape failures are deterministic for the payload, not the
			// provider. Cooldown (if any) applies to the backend shape only.
			return { cool: false, scope: "none" };
		default:
			return { cool: false, scope: "none" };
	}
}

/**
 * Payload-sensitive retry gate: a deterministic invalid-request failure
 * suppresses retry of the SAME shape, while a changed tool set, backend,
 * schema projection, or output budget counts as a genuinely different attempt.
 */
export function mayRetryShape(
	cause: FailureCause,
	previousShapeHash: string | undefined,
	currentShapeHash: string | undefined,
): { allowed: boolean; reason: string } {
	if (!cause.retryable && !cause.deterministicShape) return { allowed: false, reason: `${cause.category} is not retryable` };
	if (cause.deterministicShape && previousShapeHash && currentShapeHash && previousShapeHash === currentShapeHash) {
		return { allowed: false, reason: `deterministic ${cause.category}: identical payload shape ${currentShapeHash}; change payload, backend, tool subset, or budget first` };
	}
	if (cause.deterministicShape) return { allowed: true, reason: "request shape changed since the deterministic failure" };
	return { allowed: cause.retryable, reason: cause.retryable ? "transient failure class" : `${cause.category} is not retryable` };
}

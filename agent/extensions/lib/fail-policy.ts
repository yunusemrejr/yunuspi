/**
 * Explicit fail-open vs fail-closed policy per subsystem.
 *
 * Safety/authorization fails closed. Optional guidance, skill ranking, local
 * ML helpers, telemetry, analytics, and cosmetic diagnostics fail open.
 * Routing/cost gates preserve user constraints and return explicit blocked
 * states instead of throwing. This table is the policy — not scattered
 * catch blocks across extensions.
 *
 * Dependency-free and pure.
 */

export type FailMode = "fail-closed" | "fail-open" | "blocked-state";

export type Subsystem =
	| "safety"
	| "authorization"
	| "mutation-guard"
	| "secret-redaction"
	| "routing"
	| "cost-gate"
	| "provider-health"
	| "skill-ranking"
	| "guidance"
	| "micro-intelligence"
	| "telemetry"
	| "diagnostics"
	| "context-injection"
	| "review"
	| "memory";

const POLICY: Record<Subsystem, { mode: FailMode; note: string }> = {
	safety: { mode: "fail-closed", note: "unsafe on error: deny the action" },
	authorization: { mode: "fail-closed", note: "unauthorized on error: deny the action" },
	"mutation-guard": { mode: "fail-closed", note: "unproven mutation authority blocks completion" },
	"secret-redaction": { mode: "fail-closed", note: "redaction failure withholds the text" },
	routing: { mode: "blocked-state", note: "preserve user caps; return explicit blocked, never silent reroute" },
	"cost-gate": { mode: "blocked-state", note: "unknown cost blocks metered spend; free/subscription paths stay explicit" },
	"provider-health": { mode: "blocked-state", note: "unknown health cools the route explicitly, never globally" },
	"skill-ranking": { mode: "fail-open", note: "ranking failure yields no suggestions, never a wrong skill" },
	guidance: { mode: "fail-open", note: "guidance failure skips the hint" },
	"micro-intelligence": { mode: "fail-open", note: "helper failure falls back to the main model path" },
	telemetry: { mode: "fail-open", note: "telemetry failure drops the sample" },
	diagnostics: { mode: "fail-open", note: "diagnostic failure marks unknown, never invents data" },
	"context-injection": { mode: "fail-open", note: "injection failure skips the block" },
	review: { mode: "fail-open", note: "review failure skips the round and records the gap" },
	memory: { mode: "fail-open", note: "memory failure proceeds without recall and records the gap" },
};

/** Fail mode for a subsystem. Unknown subsystems fail closed (safe default). */
export function failModeFor(subsystem: string): FailMode {
	const entry = (POLICY as Record<string, { mode: FailMode }>)[subsystem];
	return entry?.mode ?? "fail-closed";
}

/** Human-readable policy note for diagnostics. */
export function failPolicyNote(subsystem: string): string {
	const entry = (POLICY as Record<string, { note: string }>)[subsystem];
	return entry?.note ?? "unknown subsystem: fail closed by default";
}

export interface GuardedResult<T> {
	ok: boolean;
	value?: T;
	/** Machine-readable fallback applied under the subsystem policy. */
	fallback?: "denied" | "skipped" | "blocked" | "degraded" | "none";
	error?: string;
}

/**
 * Run a subsystem function under its policy. Fail-closed subsystems return a
 * denial on throw; fail-open subsystems return the supplied fallback value
 * with a skipped marker; blocked-state subsystems return an explicit blocked
 * marker. The error is always retained in `error` — never swallowed.
 */
export function guardSubsystem<T>(subsystem: Subsystem, fn: () => T, fallback: T): GuardedResult<T> {
	try {
		return { ok: true, value: fn() };
	} catch (error) {
		const message = error instanceof Error ? error.message.slice(0, 280) : String(error).slice(0, 280);
		const mode = failModeFor(subsystem);
		if (mode === "fail-closed") return { ok: false, fallback: "denied", error: message };
		if (mode === "blocked-state") return { ok: false, fallback: "blocked", error: message };
		return { ok: false, value: fallback, fallback: "skipped", error: message };
	}
}

/**
 * Pre-spawn preflight: decide whether a child may be launched, and record why.
 *
 * Before this module the checks existed but were scattered and invisible: route
 * resolution ran in the fallback planner, economy ran at selection time,
 * provider health ran at the request gate, and budgets ran at admission — none
 * of them were recorded together, and a group could be launched into a route
 * that had no credentials or was in cooldown, with the failure only visible
 * after the child had burned a slot.
 *
 * This module assembles the five checks into one record that is stored on the
 * run status and surfaced with the result. It is conservative by design: a
 * check it cannot perform reports "unknown" and warns, it does not block.
 * Only definite failures block, and a blocked launch reports the blocker.
 *
 * Pure: probes are injected, so benches run this offline.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildTelemetry } from "./group-reliability.ts";

export type PreflightCheckState = "pass" | "warn" | "fail" | "unknown";

export interface PreflightCheck {
	state: PreflightCheckState;
	detail?: string;
}

export type PreflightCheckName = "route" | "credentials" | "provider_health" | "economy" | "budget";

export const PREFLIGHT_CHECK_NAMES: readonly PreflightCheckName[] = ["route", "credentials", "provider_health", "economy", "budget"];

export interface ChildSpawnPreflight {
	version: 1;
	at: number;
	/** Model as requested by the caller/agent config (before resolution). */
	requestedModel?: string;
	/** Resolved route the child will actually use. */
	selectedRoute?: { provider?: string; model: string };
	/** Fallback routes available if the selected route fails. */
	fallbackRoutes?: string[];
	checks: Record<PreflightCheckName, PreflightCheck>;
	/** Hard blockers: the child must not be launched. */
	blockers: string[];
	/** Non-fatal observations worth surfacing. */
	warnings: string[];
	ok: boolean;
}

export interface SpawnPreflightProbes {
	route?: (input: { requestedModel?: string }) => PreflightCheck & { provider?: string; model?: string };
	credentials?: (input: { provider?: string; model?: string }) => PreflightCheck;
	providerHealth?: (input: { provider?: string; model?: string }) => PreflightCheck;
	economy?: (input: { provider?: string; model?: string }) => PreflightCheck;
	budget?: (input: { requestedModel?: string }) => PreflightCheck;
}

export interface SpawnPreflightInput {
	requestedModel?: string;
	fallbackRoutes?: string[];
	now?: number;
	probes?: SpawnPreflightProbes;
}

function unknownCheck(detail?: string): PreflightCheck {
	return detail ? { state: "unknown", detail } : { state: "unknown" };
}

const UNKNOWN_DETAIL = "not checked in this context";

export function runChildSpawnPreflight(input: SpawnPreflightInput = {}): ChildSpawnPreflight {
	const now = input.now ?? Date.now();
	const probes = input.probes ?? {};
	const routeResult = probes.route?.({ requestedModel: input.requestedModel });
	const routeCheck: PreflightCheck = routeResult
		? { state: routeResult.state, ...(routeResult.detail ? { detail: routeResult.detail } : {}) }
		: unknownCheck(UNKNOWN_DETAIL);
	const provider = routeResult?.provider;
	const model = routeResult?.model ?? input.requestedModel;
	const checkOrUnknown = (probe: SpawnPreflightProbes[keyof SpawnPreflightProbes] | undefined, detail: string): PreflightCheck => {
		if (!probe) return unknownCheck(detail);
		const result = (probe as (input: { provider?: string; model?: string }) => PreflightCheck)({ provider, model });
		return { state: result.state, ...(result.detail ? { detail: result.detail } : {}) };
	};
	const checks: Record<PreflightCheckName, PreflightCheck> = {
		route: routeCheck,
		credentials: checkOrUnknown(probes.credentials, UNKNOWN_DETAIL),
		provider_health: checkOrUnknown(probes.providerHealth, UNKNOWN_DETAIL),
		economy: checkOrUnknown(probes.economy, UNKNOWN_DETAIL),
		budget: probes.budget
			? (() => {
				const result = probes.budget!({ requestedModel: input.requestedModel });
				return { state: result.state, ...(result.detail ? { detail: result.detail } : {}) };
			})()
			: unknownCheck(UNKNOWN_DETAIL),
	};
	const blockers: string[] = [];
	const warnings: string[] = [];
	for (const name of PREFLIGHT_CHECK_NAMES) {
		const check = checks[name];
		if (check.state === "fail") blockers.push(`${name}: ${check.detail ?? "failed"}`);
		else if (check.state === "warn" && check.detail) warnings.push(`${name}: ${check.detail}`);
		else if (check.state === "unknown") warnings.push(`${name}: ${check.detail ?? UNKNOWN_DETAIL}`);
	}
	return {
		version: 1,
		at: now,
		...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
		...(model ? { selectedRoute: { ...(provider ? { provider } : {}), model } } : {}),
		...(input.fallbackRoutes?.length ? { fallbackRoutes: [...input.fallbackRoutes] } : {}),
		checks,
		blockers,
		warnings,
		ok: blockers.length === 0,
	};
}

/** Beyond this cooldown the request-time gate stops deferring and denies; spawning into it only burns the slot. */
export const PREFLIGHT_HEALTH_FAIL_AFTER_MS = 90_000;

/** Default automatic-budget caps ($/1M tokens) used when the selection-time policy is unavailable at the spawn seam. */
export const PREFLIGHT_DEFAULT_MAX_INPUT_PER_MILLION = 1;
export const PREFLIGHT_DEFAULT_MAX_OUTPUT_PER_MILLION = 1;

export interface RunnerSpawnPreflightInput {
	requestedModel?: string;
	/** Caller-declared origin of the request; defaults to explicit when a concrete model was named. */
	origin?: "explicit" | "inherited" | "configured" | "automatic";
	/** Route the child will use (first resolved candidate). */
	selected?: string;
	/** Remaining candidates to fall back to. */
	fallbacks?: string[];
	/** USD/1M rates for the selected route, when the model catalog knows them. */
	rates?: { input?: number; output?: number };
	/** Provider-health verdict evaluated by the caller (read-only, no gate taken here). */
	health?: { allowed: boolean; waitMs: number; kind?: string; boundBy?: string };
	hasUsageBudgetConfig?: boolean;
	usageBudgetAlreadyExhausted?: boolean;
	timeoutMs?: number;
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
	now?: number;
}

function readModelsJsonApiKey(agentDir: string | undefined, provider: string): { raw?: string; path?: string } {
	if (!agentDir) return {};
	try {
		const modelsPath = path.join(agentDir, "models.json");
		const json = JSON.parse(fs.readFileSync(modelsPath, "utf-8")) as {
			providers?: Record<string, { apiKey?: string }>;
		};
		const entry = json.providers?.[provider];
		if (!entry || typeof entry.apiKey !== "string") return { path: modelsPath };
		return { raw: entry.apiKey, path: modelsPath };
	} catch {
		return {};
	}
}

/**
 * Assemble the runner-side preflight record. Decisive where the runner has
 * first-hand facts (resolved route, provider cooldown, configured budgets);
 * honest "unknown" where the fact lives upstream (selection-time economy when
 * rates are missing, runtime-owned credentials). Never throws.
 */
export function assembleRunnerSpawnPreflight(input: RunnerSpawnPreflightInput): ChildSpawnPreflight {
	const now = input.now ?? Date.now();
	const env = input.env ?? process.env;
	const selected = input.selected ?? input.requestedModel;
	const fallbacks = (input.fallbacks ?? []).filter((route): route is string => typeof route === "string" && route.length > 0);
	const origin = input.origin ?? (input.requestedModel ? "explicit" : "automatic");
	const slash = selected?.indexOf("/") ?? -1;
	const provider = slash > 0 ? selected!.slice(0, slash) : undefined;
	const model = slash > 0 ? selected!.slice(slash + 1) : selected;

	const route: PreflightCheck = selected
		? { state: "pass", detail: `resolved route ${selected}${fallbacks.length ? ` (+${fallbacks.length} fallback${fallbacks.length === 1 ? "" : "s"})` : " (no fallback)"}` }
		: { state: "warn", detail: "no resolved route at spawn; the child inherits the ambient default" };

	let credentials: PreflightCheck;
	if (!provider) {
		credentials = { state: "unknown", detail: "no provider on the route; runtime-owned credentials (auth.json/login) assumed" };
	} else {
		const { raw } = readModelsJsonApiKey(input.agentDir, provider);
		const varName = typeof raw === "string" && raw.startsWith("$") ? raw.slice(1) : undefined;
		const envValue = varName
			? env[varName]
			: typeof raw === "string" && raw.length > 0
				? raw
				: env[`${provider.toUpperCase()}_API_KEY`] ?? env[`${provider.toUpperCase()}_KEY`];
		credentials = typeof raw === "string" && raw.length > 0 && !raw.startsWith("$")
			? { state: "pass", detail: `${provider} credential is configured in models.json` }
			: envValue && envValue.length > 0
				? { state: "pass", detail: `${provider} credential present (${varName ?? `${provider.toUpperCase()}_API_KEY`})` }
				: { state: "unknown", detail: `${provider} credential not visible to the runner; runtime auth (auth.json/login) assumed present` };
	}

	let providerHealth: PreflightCheck;
	if (!input.health) {
		providerHealth = { state: "unknown", detail: "provider health not evaluated at spawn; the request-time gate still applies" };
	} else if (input.health.allowed) {
		providerHealth = { state: "pass", detail: provider ? `${provider} route is not in cooldown` : "route is not in cooldown" };
	} else if (fallbacks.length > 0 || input.health.waitMs <= PREFLIGHT_HEALTH_FAIL_AFTER_MS) {
		providerHealth = { state: "warn", detail: `${provider ?? "route"} is cooling for ~${Math.ceil(input.health.waitMs / 1000)}s${input.health.kind ? ` (${input.health.kind})` : ""}${fallbacks.length ? `; ${fallbacks.length} fallback route${fallbacks.length === 1 ? "" : "s"} available` : "; the request gate may defer within its bound"}` };
	} else {
		providerHealth = { state: "fail", detail: `${provider ?? "route"} is cooling for ~${Math.ceil(input.health.waitMs / 1000)}s${input.health.kind ? ` (${input.health.kind})` : ""} with no fallback; launching would burn the slot` };
	}

	let economy: PreflightCheck;
	const rates = input.rates;
	const freeRoute = typeof model === "string" && model.endsWith(":free");
	if (origin === "explicit" || origin === "configured") {
		economy = { state: "pass", detail: `${origin} route ${selected ?? "(default)"}; cost authorized by the caller, automatic budget does not apply` };
	} else if (freeRoute) {
		economy = { state: "pass", detail: `${selected} is a zero-price route` };
	} else if (rates && Number.isFinite(rates.input) && Number.isFinite(rates.output)) {
		const maxInput = Number(env.PI_SUBAGENT_AUTO_MAX_INPUT_PER_M) > 0 ? Number(env.PI_SUBAGENT_AUTO_MAX_INPUT_PER_M) : PREFLIGHT_DEFAULT_MAX_INPUT_PER_MILLION;
		const maxOutput = Number(env.PI_SUBAGENT_AUTO_MAX_OUTPUT_PER_M) > 0 ? Number(env.PI_SUBAGENT_AUTO_MAX_OUTPUT_PER_M) : PREFLIGHT_DEFAULT_MAX_OUTPUT_PER_MILLION;
		economy = rates.input! <= maxInput && rates.output! <= maxOutput
			? { state: "pass", detail: `${selected} rates $${rates.input}/$${rates.output} per 1M within the automatic budget ($${maxInput}/$${maxOutput})` }
			: { state: "fail", detail: `${selected} rates $${rates.input}/$${rates.output} per 1M exceed the automatic budget ($${maxInput}/$${maxOutput}); authorize the route or pick an affordable one` };
	} else {
		economy = { state: "unknown", detail: "no catalog rates for the selected route; selection-time admission is authoritative" };
	}

	const budget: PreflightCheck = !input.hasUsageBudgetConfig
		? { state: "warn", detail: "no per-run usage budget configured; run-wide deadline is the only bound" }
		: input.usageBudgetAlreadyExhausted
			? { state: "fail", detail: "per-run usage budget is already exhausted before any child ran" }
			: { state: "pass", detail: `per-run usage budget configured${input.timeoutMs !== undefined ? `; deadline ${input.timeoutMs}ms` : ""}` };

	return runChildSpawnPreflight({
		...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
		...(fallbacks.length ? { fallbackRoutes: fallbacks } : {}),
		now,
		probes: {
			route: () => ({ ...route, ...(provider ? { provider } : {}), ...(model ? { model } : {}) }),
			credentials: () => credentials,
			providerHealth: () => providerHealth,
			economy: () => economy,
			budget: () => budget,
		},
	});
}

export function formatSpawnPreflightBlocked(preflight: ChildSpawnPreflight): string {
	const route = preflight.selectedRoute?.model ?? preflight.requestedModel ?? "unknown route";
	return `Child launch blocked by preflight for ${route}: ${preflight.blockers.join("; ")}. Surface this failure instead of retrying the slot.`;
}

/**
 * Route provenance: what the caller asked for, what was selected, what was
 * actually attempted, whether a fallback was used, and why it ended. Stored per
 * child so the parent and the metrics report what ran, not what was requested.
 */
export interface ChildRouteProvenance {
	version: 1;
	requestedModel?: string;
	/** How the route was chosen: explicit, inherited or automatic. */
	origin?: "explicit" | "inherited" | "configured" | "automatic" | "unknown";
	selectedRoute?: { provider?: string; model: string };
	attempts: Array<{
		attempt: number;
		provider?: string;
		model?: string;
		/** Outcome of this attempt. */
		outcome: "succeeded" | "failed";
		error?: string;
		/** True when this attempt was produced by a fallback after a failure. */
		fallback?: boolean;
		retry?: boolean;
	}>;
	fallbackUsed: boolean;
	retryUsed: boolean;
	/** As-run provider/model (last attempt that produced traffic). */
	actual?: { provider?: string; model?: string };
	terminalCause?: string;
}

function splitRoute(route: string | undefined): { provider?: string; model?: string } {
	if (!route || typeof route !== "string") return {};
	const slash = route.indexOf("/");
	if (slash <= 0) return { model: route };
	return { provider: route.slice(0, slash), model: route.slice(slash + 1) };
}

function shortError(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

export interface ProvenanceSource {
	requestedModel?: string;
	origin?: string;
	model?: string;
	provider?: string;
	attemptedModels?: readonly string[];
	modelAttempts?: ReadonlyArray<{ model?: string; success?: boolean; error?: string }>;
	/** True when the as-run model differs from the requested/selected route. */
	usedFallback?: boolean;
	terminalCause?: string;
	error?: string;
}

/** Build the provenance chain from whatever the runner/executor recorded. */
export function buildChildRouteProvenance(source: ProvenanceSource): ChildRouteProvenance {
	const attempts = (source.modelAttempts ?? []).map((attempt, index) => {
		const route = splitRoute(attempt.model);
		return {
			attempt: index + 1,
			...(route.provider ? { provider: route.provider } : {}),
			...(route.model ? { model: route.model } : {}),
			outcome: attempt.success === true ? ("succeeded" as const) : ("failed" as const),
			...(shortError(attempt.error) ? { error: shortError(attempt.error) } : {}),
			...(index > 0 ? { fallback: true } : {}),
		};
	});
	const attempted = (source.attemptedModels ?? []).filter((value): value is string => typeof value === "string" && value.length > 0);
	const selectedRoute = source.model ?? attempted[0] ?? source.requestedModel;
	const asRun = source.model ?? attempted.at(-1);
	const fallbackUsed = source.usedFallback === true
		|| attempts.length > 1
		|| (Boolean(source.requestedModel) && Boolean(asRun) && asRun !== source.requestedModel);
	const origin = source.origin === "explicit" || source.origin === "inherited" || source.origin === "configured" || source.origin === "automatic"
		? source.origin
		: source.requestedModel ? "explicit" : "unknown";
	return {
		version: 1,
		...(source.requestedModel ? { requestedModel: source.requestedModel } : {}),
		...(origin !== "unknown" || !source.requestedModel ? { origin } : { origin: "unknown" }),
		...(selectedRoute ? { selectedRoute: { ...splitRoute(selectedRoute), model: splitRoute(selectedRoute).model ?? selectedRoute } } : {}),
		attempts,
		fallbackUsed,
		retryUsed: attempts.length > 1,
		...(asRun ? { actual: splitRoute(asRun) } : {}),
		...(source.terminalCause ? { terminalCause: source.terminalCause } : {}),
		...(shortError(source.error) ? { error: shortError(source.error) } : {}),
	} as ChildRouteProvenance & { error?: string };
}

/** One-line provenance for UI/metrics: "req X → ran Y (fallback, timeout)". */
export function formatChildRouteProvenance(provenance: ChildRouteProvenance): string {
	const requested = provenance.requestedModel ?? "default";
	const actual = provenance.actual?.model ?? provenance.selectedRoute?.model ?? requested;
	const parts = [actual === requested ? actual : `${requested} → ${actual}`];
	if (provenance.fallbackUsed) parts.push("fallback");
	if (provenance.retryUsed) parts.push("retried");
	if (provenance.terminalCause && provenance.terminalCause !== "completed") parts.push(provenance.terminalCause);
	return parts.join(", ");
}

/** Attach as-run provider/model to a telemetry row from provenance. */
export function provenanceForTelemetry(provenance: ChildRouteProvenance, telemetry: ChildTelemetry): ChildTelemetry {
	return {
		...telemetry,
		...(provenance.actual?.provider ? { provider: provenance.actual.provider } : {}),
		...(provenance.actual?.model ? { model: provenance.actual.model } : {}),
		...(provenance.requestedModel ? { requestedModel: provenance.requestedModel } : {}),
	};
}

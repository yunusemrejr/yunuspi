/**
 * provider-gate.ts — executable cooldown enforcement at the request-control
 * layer (fix_provider_cooldown_enforcement).
 *
 * INVARIANT: a provider/model marked cooling-down must NEVER be called merely
 * because Pi's normal tool-continuation loop wants another turn. This
 * extension sits at the ONE seam every inference request passes through —
 * the `before_provider_request` hook inside the provider send path (see
 * sdk.js onPayload: the hook runs after payload assembly, before the HTTP
 * call, for the main agent loop, tool-result continuations, retries, subagent
 * children and auxiliary calls alike) — and enforces the shared state from
 * pi-subagents/src/runs/shared/provider-health.ts:
 *
 *   1. resolve the transport's provider/model, consult shared provider health/rate state,
 *   2. estimate request token pressure (chars/4 over the payload messages),
 *   3. record the outgoing request in the shared pressure window,
 *   4. while the route/provider is cooling: DEFER the request in place
 *      (bounded in-gate wait; the SAME payload goes out once eligible — the
 *      pending tool-result continuation resumes automatically, no "go on"
 *      required, no provider call to announce the cooldown),
 *   5. beyond the in-gate budget: DENY by throwing
 *      `PI_AUTONOMOUS_REQUEST_DENIED` (the patched request seam re-throws
 *      exactly this code, so the request never reaches the provider) with a
 *      rate-limit-class message, so the existing cooldown-class retry
 *      machinery owns the longer wait within its retry budget — and every
 *      re-request passes through this gate again.
 *
 * The admitted request owns its terminal observer. It classifies each failure
 * and records the cooldown before the next request can fire. A corresponding
 * success can clear that cooldown. This works in main
 * sessions AND subagent children (extensions load in every pi process), so
 * the shared file coordinates the whole fleet. Auxiliary requests use a
 * separate admission hook and a callback bound to the admitted request.
 *
 * Status messages describe policy and point at the inspectable state file
 * (provider-health.json); they never masquerade as enforcement — the
 * enforcement is the gate above.
 *
 * Kill switches (tests / debugging): PI_PROVIDER_GATE=off disables the gate;
 * PI_PROVIDER_GATE_MAX_WAIT_MS overrides the in-gate wait budget. The gate
 * falls back to the registry when a host supplies no route metadata. For an
 * ambiguous legacy request it blocks when a known candidate is cooling.
 * It skips loopback/mock endpoints.
 */

import { setSharedProviderCooldown, type AssistantMessage } from "@yunuspi/ai";
import { cacheProfileFor } from "./lib/lean-policy.ts";
import type {
	BeforeAuxiliaryProviderRequestEvent,
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@yunuspi/coding-agent";
import {
	GateDeniedError,
	REQUEST_RATE_PROVIDERS,
	estimateTokens,
	gateRequest,
	evaluateRoute,
	recordFailure,
	recordSuccess,
	economyRateIdentity,
	invalidateEconomyUsage,
	readHealth,
	snapshot,
} from "./pi-subagents/src/runs/shared/provider-health.ts";

type AnyCtx = ExtensionContext | undefined;
type RequestModel = NonNullable<BeforeProviderRequestEvent["model"]>;

interface RouteRef {
	provider: string;
	model: string;
	baseUrl?: string;
}

interface PendingAttempt {
	provider: string;
	model: string;
	/** Monotonic creation time used to discard completions that never arrive. */
	createdAt: number;
	session?: string;
	endpoint?: string;
	started?: number;
	/** Completion metadata is unsafe when requests for this route overlap. */
	ambiguous?: boolean;
	/** Explicit OpenRouter routing can be retained before provider attribution. */
	candidateProvider?: string;
	/** Wall-clock admission time; a completion only supersedes failures recorded before it. */
	admittedAt?: number;
	/** Pressure estimate of this request, so a failure is paced by its own size. */
	estTokens?: number;
}

// Legacy dispatchers without exact outcome callbacks may still emit `message_end`.
const MAX_PENDING_ATTEMPTS = 128;
const PENDING_ATTEMPT_TTL_MS = 10 * 60_000;

function gateDisabled(): boolean {
	return process.env.PI_PROVIDER_GATE === "off";
}

function sessionLabel(ctx: AnyCtx): string | undefined {
	try {
		const file = ctx?.sessionManager?.getSessionFile?.();
		return file ? file.split("/").pop() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the provider for a legacy event without transport metadata. The payload carries only the
 * model id; the provider comes from an unambiguous model-registry row. A
 * session model is used only when the host has no registry row (auxiliary calls
 * may use a different model). Returns undefined when the attribution is
 * uncertain — the gate's caller applies the cooling ambiguity guard before
 * allowing an unverified provider.
 */
function payloadModel(payload: any): string | undefined {
	const values = [payload?.model, payload?.modelId, payload?.modelID]
		.filter((value): value is string => typeof value === "string" && value.length > 0);
	const unique = [...new Set(values)];
	return unique.length === 1 ? unique[0] : undefined;
}

function routeFromModel(model: any, modelId: string): RouteRef | undefined {
	if (!model || typeof model.provider !== "string") return undefined;
	return {
		provider: model.provider,
		model: modelId,
		...(typeof model.baseUrl === "string" ? { baseUrl: model.baseUrl } : {}),
	};
}

function registryRoutes(modelId: string, ctx: AnyCtx): RouteRef[] {
	try {
		const matches = (ctx?.modelRegistry?.getAvailable?.() ?? [])
			.filter((model: any) => model?.id === modelId && typeof model?.provider === "string")
			.map((model: any) => routeFromModel(model, modelId))
			.filter((route: RouteRef | undefined): route is RouteRef => !!route);
		const unique = new Map<string, RouteRef>();
		for (const route of matches) {
			const key = JSON.stringify([route.provider, route.baseUrl ?? ""]);
			if (!unique.has(key)) unique.set(key, route);
		}
		return [...unique.values()];
	} catch {
		return [];
	}
}

function resolveRoute(payload: any, ctx: AnyCtx): RouteRef | undefined {
	const model = payloadModel(payload);
	if (!model) return undefined;
	const matches = registryRoutes(model, ctx);
	if (matches.length === 1) return matches[0];
	// A context model is a useful fallback when a host has no registry snapshot,
	// but it cannot disambiguate duplicate provider rows with the same id.
	if (matches.length === 0 && ctx?.model?.id === model && typeof ctx.model.provider === "string") {
		return routeFromModel(ctx.model, model);
	}
	return undefined;
}

/**
 * An auxiliary request carries only a model identifier through Pi's hook API.
 * If that identifier names multiple provider routes, the hook cannot know which
 * route will be called. Preserve the normal fail-open behavior while every
 * candidate is healthy, but fail closed when a candidate is cooling: allowing
 * in that state would make the cooldown unenforceable exactly at the point
	 * where attribution is uncertain.
 */
function coolingAmbiguousRoute(payload: any, ctx: AnyCtx): { route: RouteRef; decision: ReturnType<typeof evaluateRoute> } | undefined {
	const model = payloadModel(payload);
	if (!model) return undefined;
	const routes = registryRoutes(model, ctx);
	if (routes.length < 2) return undefined;
	const state = readHealth();
	const candidates = routes
		.filter((route) => !isLoopback(route))
		.map((route) => {
			const endpointInfo = requestEndpoint(payload, route, ctx?.model);
			return {
				route,
				decision: evaluateRoute({
					provider: route.provider,
					model: route.model,
					endpoints: endpointInfo
						? [endpointInfo.endpoint, ...(endpointInfo.name ? [endpointInfo.name] : [])]
						: undefined,
				}, state),
			};
		})
		.filter((candidate) => !candidate.decision.allowed)
		.sort((a, b) => b.decision.waitMs - a.decision.waitMs);
	return candidates[0];
}

function isLoopback(route: RouteRef): boolean {
	if (typeof route.baseUrl !== "string") return false;
	try {
		const url = new URL(route.baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		// URL normalizes IPv4 shorthand and IPv4-mapped IPv6. Match the whole
		// hostname: localhost.example and 127.example are real remote hosts.
		const host = url.hostname.toLowerCase();
		return host === "localhost" || host === "localhost." ||
			host === "0.0.0.0" || host === "[::1]" ||
			/^127\.\d+\.\d+\.\d+$/.test(host) ||
			/^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
	} catch {
		return false;
	}
}

function setStatus(ctx: AnyCtx, text: string): void {
	try {
		ctx?.ui?.setStatus?.("provider-gate", text);
	} catch {
		/* headless contexts have no status line */
	}
}

function requestEndpoint(payload: any, route: RouteRef, model?: RequestModel): { endpoint: string; name?: string } | undefined {
	const only = payload?.provider?.only;
	if (
		route.provider !== "openrouter" ||
		payload?.provider?.allow_fallbacks !== false ||
		!Array.isArray(only) ||
		only.length !== 1 ||
		typeof only[0] !== "string" ||
		!only[0]
	) return undefined;
	const endpoint = only[0];
	const name = model?.provider === route.provider && model.id === route.model
		&& model.compat?.openRouterRouting?.only?.[0] === endpoint
		? model.compat.recoveryEndpointName
		: undefined;
	return { endpoint, ...(typeof name === "string" && name ? { name } : {}) };
}

function pendingRouteKey(provider: string, model: string): string {
	return `${provider}\u0000${model}`;
}

function prunePendingAttempts(pending: Map<string, PendingAttempt[]>, now = performance.now()): void {
	const cutoff = now - PENDING_ATTEMPT_TTL_MS;
	const entries: Array<{ key: string; attempt: PendingAttempt }> = [];
	for (const [key, attempts] of pending) {
		const fresh = attempts.filter((attempt) => attempt.createdAt >= cutoff);
		if (fresh.length === 0) pending.delete(key);
		else {
			pending.set(key, fresh);
			for (const attempt of fresh) entries.push({ key, attempt });
		}
	}
	if (entries.length <= MAX_PENDING_ATTEMPTS) return;
	entries
		.sort((a, b) => a.attempt.createdAt - b.attempt.createdAt)
		.slice(0, entries.length - MAX_PENDING_ATTEMPTS)
		.forEach(({ key, attempt }) => removePendingAttempt(pending, attempt));
}

function markPendingAttempt(pending: Map<string, PendingAttempt[]>, attempt: PendingAttempt): void {
	prunePendingAttempts(pending);
	const key = pendingRouteKey(attempt.provider, attempt.model);
	const current = pending.get(key) ?? [];
	if (current.length > 0) {
		for (const prior of current) prior.ambiguous = true;
		attempt.ambiguous = true;
	}
	current.push(attempt);
	pending.set(key, current);
	prunePendingAttempts(pending);
}

function removePendingAttempt(pending: Map<string, PendingAttempt[]>, attempt: PendingAttempt): void {
	const key = pendingRouteKey(attempt.provider, attempt.model);
	const current = pending.get(key);
	if (!current) return;
	const index = current.indexOf(attempt);
	if (index < 0) return;
	current.splice(index, 1);
	if (current.length === 0) pending.delete(key);
}

function takePendingAttempt(
	pending: Map<string, PendingAttempt[]>,
	provider: string,
	model: string | undefined,
	session: string | undefined,
): PendingAttempt | undefined {
	prunePendingAttempts(pending);
	if (!model) return undefined;
	const keys = [pendingRouteKey(provider, model), pendingRouteKey("", model)];
	const candidates: Array<{ key: string; attempt: PendingAttempt }> = [];
	for (const key of keys) {
		const current = pending.get(key);
		if (!current?.length) continue;
		for (const attempt of current) {
			if (session === undefined || attempt.session === session) candidates.push({ key, attempt });
		}
	}
	if (candidates.length === 0) return undefined;
	if (candidates.length > 1) for (const candidate of candidates) candidate.attempt.ambiguous = true;
	// The concrete provider key wins only as the record to consume. When a
	// neutral candidate also exists, both records were plausible for this
	// request and the ambiguity flag suppresses endpoint/timing metadata.
	const selected = candidates.find((candidate) => candidate.key === pendingRouteKey(provider, model)) ?? candidates[0];
	const current = pending.get(selected.key);
	if (!current) return undefined;
	const index = current.indexOf(selected.attempt);
	if (index < 0) return undefined;
	// A completion from another known session cannot safely consume this
	// request's timing or endpoint. Leave the attempt available for its own
	// session's completion and drop metadata for the mismatched event.
	const [attempt] = current.splice(index, 1);
	if (current.length === 0) pending.delete(selected.key);
	return attempt;
}

function resetPendingAttempts(pending: Map<string, PendingAttempt[]>): void {
	pending.clear();
}

async function admitRoute(
	payload: unknown,
	route: RouteRef,
	model: RequestModel | undefined,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<Pick<PendingAttempt, "started" | "admittedAt" | "endpoint" | "estTokens">> {
	const endpoint = requestEndpoint(payload, route, model);
	const estTokens = estimateTokens(payload);
	try {
		const outcome = await gateRequest({
			provider: route.provider,
			model: route.model,
			endpoints: endpoint ? [endpoint.endpoint, ...(endpoint.name ? [endpoint.name] : [])] : undefined,
			estTokens,
			session: sessionLabel(ctx),
			signal,
		});
		setStatus(ctx, outcome.deferredMs > 0
			? `provider-gate: deferred ${route.provider}/${route.model} ${Math.round(outcome.deferredMs / 1000)}s (cooldown elapsed; same continuation resumed)`
			: "");
		return { started: performance.now(), admittedAt: outcome.admittedAt,
			endpoint: endpoint?.name ?? endpoint?.endpoint, estTokens };
	} catch (error) {
		if (error instanceof GateDeniedError) {
			const d = error.details;
			if (d.kind === "quota-rate" && REQUEST_RATE_PROVIDERS.has(route.provider)) {
				setSharedProviderCooldown(error, d.cooldownUntil);
			}
			setStatus(ctx, `provider-gate: ${route.provider}/${route.model} cooling ${Math.ceil(d.waitMs / 1000)}s` +
				` (${d.kind ?? "unknown"} via ${d.source ?? "unknown"}); state: provider-health.json`);
		}
		throw error;
	}
}

function recordCompletion(
	message: AssistantMessage,
	attempt: Pick<PendingAttempt, "started" | "admittedAt" | "endpoint" | "estTokens" | "ambiguous" | "candidateProvider"> | undefined,
	selected: RequestModel | undefined,
	source: "message_end" | "auxiliary",
	model = message.model,
): void {
	if (message.usage?.dispatchOutcome === "not-dispatched") return;
	const { provider, errorMessage, usage, timestamp } = message;
	const current = selected?.provider === provider && selected.id === model ? selected : undefined;
	const cost = current?.cost;
	const rates = cost && current ? economyRateIdentity(cost, current.baseUrl, current.api) : undefined;
	const attributed = attempt && !attempt.ambiguous && (!attempt.candidateProvider || attempt.candidateProvider === provider)
		? attempt : undefined;
	const endpoint = attributed?.endpoint;
	if (message.stopReason === "error") {
		if (attempt && !attempt.ambiguous && attempt.started === undefined) return;
		const recorded = recordFailure({ provider, model, errorMessage, providerRetry: message.providerRetry, source, endpoint, estTokens: attributed?.estTokens, rates });
		if (attributed && recorded?.kind === "quota-rate" && REQUEST_RATE_PROVIDERS.has(provider)) {
			setSharedProviderCooldown(message, recorded.retryCooldownUntil);
		}
		if (!recorded) invalidateEconomyUsage(provider, model);
		return;
	}
	if (message.stopReason !== "stop" && message.stopReason !== "toolUse" || typeof usage?.input !== "number") return;

	const startedAt = attributed?.admittedAt ?? (Number.isSafeInteger(timestamp) ? timestamp : undefined);
	if (source === "auxiliary") {
		recordSuccess({ provider, model, endpoint, inputTokens: usage.input, startedAt, healthOnly: true });
		return;
	}
	const elapsedMs = typeof attributed?.started === "number" ? performance.now() - attributed.started : undefined;
	const now = Date.now();
	const validContent = Array.isArray(message.content) && message.content.some(part =>
		(part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)
		|| (part?.type === "toolCall" && typeof part.name === "string" && part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments)));
	const economyUsage = validContent && Number.isSafeInteger(timestamp) && timestamp <= now && now - timestamp <= 300_000
		&& cost && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
		&& [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(n => Number.isSafeInteger(n) && n >= 0)
		&& typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total >= 0
		? { ...(typeof elapsedMs === "number" && elapsedMs >= 0 && elapsedMs <= 600_000 ? { elapsedMs } : {}),
			messageAt: timestamp, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
			costUsd: usage.cost.total, rates: rates! }
		: undefined;
	recordSuccess({ provider, model, endpoint, inputTokens: usage.input, economyUsage, startedAt });
}

export default function providerGateExtension(pi: ExtensionAPI): void {
	if (process.env.PI_PROVIDER_GATE === "off") return;

	const pending = new Map<string, PendingAttempt[]>();
	for (const event of ["session_start", "session_switch", "session_tree", "session_shutdown", "agent_end"] as const) {
		pi.on(event, () => resetPendingAttempts(pending));
	}

	// THE GATE — runs for every inference request in this process.
	pi.on("before_provider_request", async (event: BeforeProviderRequestEvent, ctx) => {
		if (gateDisabled()) return undefined;
		const { payload, model, signal, onOutcome } = event;
		const route = (model?.id ? routeFromModel(model, model.id) : undefined) ?? resolveRoute(payload, ctx);
		if (!route) {
			const ambiguous = coolingAmbiguousRoute(payload, ctx as AnyCtx);
			if (ambiguous) {
				const { route: coolingRoute, decision } = ambiguous;
				setStatus(ctx as AnyCtx, `provider-gate: ambiguous model ${coolingRoute.model} blocked while ${coolingRoute.provider} is cooling`);
				throw new GateDeniedError(
					`429 rate limit: provider-gate cannot safely attribute model ${coolingRoute.model}; candidate ${coolingRoute.provider}/${coolingRoute.model} is cooling` +
						` (${Math.ceil(decision.waitMs / 1000)}s; state: provider-health.json)`,
					decision,
				);
			}
			// The registry may contain the same model id for OpenRouter and a
			// direct provider. Admission remains ambiguity-safe above, but an
			// explicit OpenRouter pin is still useful completion evidence. Keep it
			// provider-neutral until message_end supplies the actual provider.
			const model = payloadModel(payload);
			const endpointInfo = model
				? requestEndpoint(payload, { provider: "openrouter", model }, ctx.model)
				: undefined;
			if (model && endpointInfo) {
				const attempt: PendingAttempt = {
					provider: "",
					model,
					createdAt: performance.now(),
					...(sessionLabel(ctx as AnyCtx) ? { session: sessionLabel(ctx as AnyCtx) } : {}),
					endpoint: endpointInfo.name ?? endpointInfo.endpoint,
					candidateProvider: "openrouter",
				};
				markPendingAttempt(pending, attempt);
				attempt.started = performance.now();
			}
			return undefined;
		} // fail-open: unattributable requests are never blocked unless a known candidate is cooling
		if (isLoopback(route)) return undefined; // mocks/loopback are not fleet traffic
		// Lean cache policy: detect the per-architecture prompt-cache strategy for
		// this route and expose it for /metrics. Requests already carry a stable,
		// append-only prefix (system + tools first), which every strategy rewards.
		try {
			const profile = cacheProfileFor(route.provider, route.model);
			const bridge = ((globalThis as any)[Symbol.for("yunus-pi.cache-profile.v1")] ??= {}) as Record<string, unknown>;
			bridge[`${route.provider}/${route.model}`] = { strategy: profile.strategy, ttlSeconds: profile.ttlSeconds, at: Date.now() };
		} catch { /* cache telemetry must never block a request */ }
		const requestSignal = signal ?? ctx.signal;
		if (onOutcome) {
			const attempt = await admitRoute(payload, route, model, ctx, requestSignal);
			onOutcome(message => {
				if (message.provider === route.provider) {
					recordCompletion(message, attempt, model, "message_end", route.model);
				}
			});
			return undefined;
		}
		const attempt: PendingAttempt = {
			provider: route.provider,
			model: route.model,
			createdAt: performance.now(),
			session: sessionLabel(ctx),
		};
		markPendingAttempt(pending, attempt);
		try {
			Object.assign(attempt, await admitRoute(payload, route, ctx.model, ctx, requestSignal));
		} catch (error) {
			// A stream deadline can close the turn before the gate settles.
			// Keep this marker through message_end to distinguish local waits.
			if (!requestSignal?.aborted) removePendingAttempt(pending, attempt);
			throw error;
		}
	});

	pi.on("before_auxiliary_provider_request", async (event: BeforeAuxiliaryProviderRequestEvent, ctx) => {
		if (gateDisabled()) return;
		const { payload, model, signal } = event;
		const route = routeFromModel(model, model.id);
		if (!route || isLoopback(route)) return;
		const attempt = await admitRoute(payload, route, model, ctx, signal);
		return (message: AssistantMessage) => {
			// Anthropic can report the concrete serving model or a fallback.
			// Health applies to the admitted route. Keep the returned model
			// intact for display and billing.
			if (message.provider === route.provider) {
				recordCompletion(message, attempt, model, "auxiliary", route.model);
			}
		};
	});

	pi.on("message_end", (event, ctx) => {
		const message = event?.message;
		if (event?.requestedModel || message?.role !== "assistant" || !message.provider) return;
		const session = sessionLabel(ctx);
		const selected = ctx.model;
		const attempt = takePendingAttempt(pending, message.provider, message.model, session);
		const alias = !attempt && selected?.provider === message.provider && selected.id !== message.model
			? takePendingAttempt(pending, message.provider, selected.id, session) : undefined;
		recordCompletion(message, attempt ?? alias, selected, "message_end", alias && !alias.ambiguous ? alias.model : undefined);
	});

	// Observability surface: /provider-health prints the shared state —
	// per-provider cooldown-until, source, failure classification, request
	// pressure, deferred continuations, last result.
	pi.registerCommand?.("provider-health", {
		description:
			"Show shared provider cooldown/rate state (provider-health.json)",
		handler: (_args: string, ctx: any) => {
			const snap = snapshot();
			const lines: string[] = [
				`state: ${snap.file}`,
				`updated: ${snap.updatedAt ? new Date(snap.updatedAt).toISOString() : "never"}`,
			];
			for (const p of snap.providers) {
				const cooling = p.cooldownUntil > Date.now();
				lines.push(
					`${p.provider}: ${cooling ? `COOLING until ${new Date(p.cooldownUntil).toISOString()}` : "ok"}` +
						` (source: ${p.cooldownSource ?? "-"}, last: ${p.failure ? `${p.failure.kind} x${p.failure.consecutive} @${p.failure.source}` : p.lastResult?.ok ? "ok" : "-"}),` +
						` requests/60s: ${p.requestsLast60s} (~${p.estTokensLast60s} tok)` +
						(p.models.length
							? `; routes: ${p.models.map((m) => `${m.model}${m.cooldownUntil > Date.now() ? " (cooling)" : ""}`).join(", ")}`
							: ""),
				);
			}
			for (const p of snap.pending) {
				lines.push(
					`pending: ${p.route} — ${p.reason} since ${new Date(p.since).toISOString()}`,
				);
			}
			if (!snap.providers.length && !snap.pending.length)
				lines.push("no recorded provider state");
			// Command handlers' return values are discarded; the report must be shown.
			ctx.ui?.notify?.(lines.join("\n"), "info");
		},
	});
}

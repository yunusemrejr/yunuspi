/**
 * Free OpenRouter models, blended into a session.
 *
 * The parent session keeps the free-model state fresh in the background: the
 * list of free models, the account's free requests left today, and a short
 * probe of each model it has not measured yet (lib/free-models.ts holds the
 * rules). A child that starts on a free model carries the routes it may fall
 * back to; when its free model is rate limited or fails, this extension, running
 * inside the child, rests that model and moves the child to the next route.
 * Nothing here runs without an OpenRouter key, with `team.free` off, or offline.
 */
import type { ExtensionAPI, ExtensionContext } from "@yunuspi/coding-agent";
import {
	QUOTA_TTL_MS,
	catalogStale,
	isCoolingDown,
	isEndpointFailure,
	isFreeRoute,
	noteFreeFailure,
	noteRefreshError,
	quotaStale,
	readState,
	refreshCatalog,
	refreshQuota,
	runProbes,
} from "./lib/free-models.ts";
import { loadTeamConfig } from "./lib/team.ts";

interface RecoveryEvent {
	message: { provider?: string; model?: string; errorMessage?: string };
	requestedModel?: { provider: string; id: string };
	decision?: "retry";
}

/** The event `_prepareRetry` emits before it retries a failed turn; the typed overloads do not list it. */
interface RecoveryHost {
	on(event: "pi_provider_recovery", handler: (event: RecoveryEvent, ctx: ExtensionContext) => Promise<void>): void;
}

function recoveryRoutes(): string[] {
	try {
		const routes = JSON.parse(process.env.PI_SUBAGENT_RECOVERY_ROUTES ?? "[]");
		return Array.isArray(routes) ? routes.filter((route): route is string => typeof route === "string") : [];
	} catch {
		return [];
	}
}

function teamFreeOn(cwd: string): boolean {
	try {
		return loadTeamConfig(cwd).team.free === "on";
	} catch {
		return false;
	}
}

export default function freeModels(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		(pi as unknown as RecoveryHost).on("pi_provider_recovery", async (event, ctx) => {
			const provider = event.requestedModel?.provider ?? event.message.provider;
			const model = event.requestedModel?.id ?? event.message.model;
			const { errorMessage } = event.message;
			const failed = provider && model ? (model.startsWith(`${provider}/`) ? model : `${provider}/${model}`) : undefined;
			const routes = recoveryRoutes();
			const at = failed ? routes.indexOf(failed) : -1;
			if (!failed || at < 0 || !isFreeRoute(failed) || !isEndpointFailure(errorMessage)) return;
			noteFreeFailure(failed);
			const state = readState();
			const now = Date.now();
			for (const route of routes.slice(at + 1)) {
				if (isCoolingDown(route, now, state)) continue;
				const split = route.indexOf("/");
				const next = ctx.modelRegistry.find(route.slice(0, split), route.slice(split + 1));
				if (next && (await pi.setModel(next))) {
					event.decision = "retry";
					return;
				}
			}
		});
		return;
	}

	let running = false;
	let lastRun = 0;

	/** One pass at a time; a failure is kept for /team to show and never reaches the session. */
	async function maintain(ctx: ExtensionContext): Promise<void> {
		if (running || process.env.PI_OFFLINE === "1" || !teamFreeOn(ctx.cwd)) return;
		running = true;
		try {
			const key = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
			if (!key) return;
			const registered = new Set(ctx.modelRegistry.getAvailable().filter((model) => model.provider === "openrouter").map((model) => model.id));
			const now = Date.now();
			const state = readState();
			if (catalogStale(state, now)) await refreshCatalog({ registered });
			if (quotaStale(state, now)) await refreshQuota({ key });
			await runProbes({ key });
		} catch (error) {
			try {
				noteRefreshError(error instanceof Error ? error.message : String(error));
			} catch {
				/* An unwritable state file leaves the failure unrecorded. */
			}
		} finally {
			running = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		lastRun = Date.now();
		void maintain(ctx);
	});
	// Before each turn, so the day's remainder is read again before a child is launched and models found since are measured.
	pi.on("turn_start", (_event, ctx) => {
		if (Date.now() - lastRun < QUOTA_TTL_MS) return;
		lastRun = Date.now();
		void maintain(ctx);
	});
}

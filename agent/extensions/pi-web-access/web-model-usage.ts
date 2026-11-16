import { isFlatPlanProvider } from "@yunuspi/ai";
import type { Api, AssistantMessage, Model } from "@yunuspi/ai/compat";
import type { ExtensionContext } from "@yunuspi/coding-agent";
import { startWebUsage, type WebUsageOptions } from "./web-usage.ts";

interface ModelUsageOptions extends WebUsageOptions {
	modelRegistry: Pick<ExtensionContext["modelRegistry"], "getProvider" | "isUsingOAuth">;
}

/** Measure an SDK completion before output validation or deterministic fallback
 * can hide the call. Local preflight stays with the caller. */
export async function trackWebCompletion(
	options: ModelUsageOptions,
	model: Model<Api>,
	signal: AbortSignal | undefined,
	complete: () => Promise<AssistantMessage>,
): Promise<AssistantMessage> {
	signal?.throwIfAborted();
	if (!options.onUsage) return complete();
	const finish = startWebUsage(options, model.provider, model.id);
	let plan = model.provider === "openai-codex" || isFlatPlanProvider(model.provider);
	if (!plan) {
		try {
			plan = options.modelRegistry.isUsingOAuth?.(model) === true
				&& options.modelRegistry.getProvider?.(model.provider)?.auth?.oauth?.isSubscription === true;
		}
		catch { /* Capture usage even if plan metadata is unavailable. */ }
	}
	try {
		const response = await complete();
		const usage = plan
			? { ...response.usage, costDetails: { reported: 0, estimated: 0, unknown: true, subscription: true, seen: false } }
			: response.usage;
		const status = response.stopReason === "aborted"
			? signal?.reason?.name === "TimeoutError" ? "timeout" : "cancelled"
			: response.stopReason === "error" ? "failed" : "completed";
		finish(status, usage);
		return response;
	} catch (error) {
		const reason = signal?.aborted ? signal.reason : error;
		const name = reason instanceof Error ? reason.name : undefined;
		finish(name === "TimeoutError" ? "timeout" : signal?.aborted || name === "AbortError" ? "cancelled" : "failed");
		throw error;
	}
}

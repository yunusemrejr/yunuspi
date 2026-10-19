import { complete, type Api, type Model, type ProviderHeaders } from "@yunuspi/ai/compat";
import type { SummaryGenerationContext } from "./summary-review.ts";

async function resolveSessionModel(
	ctx: SummaryGenerationContext,
): Promise<{ model: Model<Api>; apiKey: string; headers?: ProviderHeaders }> {
	const model = ctx.model;
	if (!model) throw new Error("No active session model for query rewrite");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok && auth.apiKey) return { model, apiKey: auth.apiKey, headers: auth.headers };
	throw new Error(`No API key available for query rewrite model ${model.provider}/${model.id}`);
}

export async function rewriteSearchQuery(
	query: string,
	ctx: SummaryGenerationContext,
	signal: AbortSignal,
): Promise<string> {
	const trimmedQuery = typeof query === "string" ? query.trim() : "";
	// Blank input needs no rewrite: return it as-is instead of burning a model
	// call (and, when no session model is available, throwing a misleading
	// error for something that had nothing to say).
	if (!trimmedQuery) return query;
	const { model, apiKey, headers } = await resolveSessionModel(ctx);
	const registry = ctx.modelRegistry as typeof ctx.modelRegistry & { complete?: typeof complete };
	const usesRegistryComplete = typeof registry.complete === "function";
	const completeFn = usesRegistryComplete ? registry.complete!.bind(registry) : complete;
	const response = await completeFn(
		model,
		{
			messages: [{
				role: "user",
				content: [{ type: "text", text: `Rewrite this web search query to get better, more specific results. Add relevant year qualifiers, precise technical terms, and specificity. Return ONLY the improved query text, nothing else.\n\nQuery: ${query}` }],
				timestamp: Date.now(),
			}],
		},
		usesRegistryComplete ? { signal } : { apiKey, headers, signal },
	);
	if (response.stopReason === "aborted") throw new Error("Aborted");
	const contentParts = Array.isArray(response.content) ? response.content : [];
	const text = contentParts
		.map((part: unknown) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")
		.join("")
		.trim();
	if (!text) throw new Error("Rewrite returned empty response");
	return text;
}

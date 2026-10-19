import type { ThinkingLevel } from "@yunuspi/agent-core";
import type { ExtensionContext } from "@yunuspi/coding-agent";
import type { Model, ProviderHeaders } from "@yunuspi/ai";
import { THINKING_LEVELS } from "../shared/model-info.ts";

type RegistryModel = Model<any>;

interface WatchdogReviewAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
}

export interface WatchdogReviewModelSelection {
	model: RegistryModel;
	thinkingLevel: ThinkingLevel;
	auth: WatchdogReviewAuth;
}

function fullModelId(model: Pick<RegistryModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function sessionThinkingLevel(ctx: ExtensionContext): ThinkingLevel {
	const value = ctx.thinkingLevel;
	return value && (THINKING_LEVELS as readonly string[]).includes(value) ? value : "off";
}

async function resolveReviewAuth(ctx: ExtensionContext, model: RegistryModel): Promise<WatchdogReviewAuth> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) throw new Error(`Watchdog model auth failed for ${fullModelId(model)}: ${auth.error}`);
	return {
		...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
		...(auth.headers ? { headers: auth.headers } : {}),
		...(auth.env ? { env: auth.env } : {}),
	};
}

/** Watchdog reviews run on the session's own model at its current thinking level. */
export async function resolveWatchdogReviewModel(ctx: ExtensionContext): Promise<WatchdogReviewModelSelection> {
	const model = ctx.model;
	if (!model) throw new Error("Watchdog review cannot run because the current Pi session model is unavailable.");
	return {
		model,
		thinkingLevel: sessionThinkingLevel(ctx),
		auth: await resolveReviewAuth(ctx, model),
	};
}

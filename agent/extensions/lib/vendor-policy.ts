/**
 * Which model routes the harness may never run on: Claude, OpenAI GPT and
 * o-series, and Google Gemini are reached only through a subscription login
 * (openai-codex, google-gemini-cli, google-antigravity, a Claude or Copilot
 * subscription), never through a pay-per-token API key or an aggregator.
 * Open-weight models (gpt-oss, gemma) are not affected.
 */

/** Providers whose login is a subscription: every model they list is allowed. */
export const SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set(["openai-codex", "google-gemini-cli", "google-antigravity"]);

/** A reseller that is also a subscription: allowed only when the caller says the login is one. */
export const SUBSCRIPTION_AGGREGATOR_PROVIDERS: ReadonlySet<string> = new Set(["github-copilot"]);

/** The vendors' own APIs: a key there is a paid API unless the caller says the login is a subscription. */
export const FIRST_PARTY_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai", "google", "google-vertex"]);

// A model name starts a segment at the id's start or after / . : (anthropic.claude-3, us.anthropic.claude-3, models/gemini-3, vertex/claude-x).
const OPEN_WEIGHT_MODEL = /(?:^|[/.:])(?:gpt-oss|gemma)/;
const CLAUDE_MODEL = /(?:^|[/.:])claude/;
const GEMINI_MODEL = /(?:^|[/.:])gemini/;
const GPT_MODEL = /(?:^|[/.:])(?:gpt-(?!oss)|chatgpt)/;
const O_SERIES_MODEL = /^o\d/;

/** The proprietary family a model id belongs to, from the id alone; undefined for any other model, open-weight ones included. */
function proprietaryFamily(modelId: string): "Claude" | "GPT" | "Gemini" | undefined {
	const id = modelId.toLowerCase();
	// OpenRouter writes "~vendor/…" for the vendor's latest model of a kind.
	const slash = id.indexOf("/");
	const maker = slash > 0 ? id.slice(0, slash).replace(/^~/, "") : undefined;
	if (maker === "anthropic" || CLAUDE_MODEL.test(id)) return "Claude";
	if (GEMINI_MODEL.test(id)) return "Gemini";
	if (GPT_MODEL.test(id)) return "GPT";
	// The o-series (o3, o4-mini) is told apart from other o-names only by its maker.
	if ((maker === undefined || maker === "openai") && O_SERIES_MODEL.test(id.slice(slash + 1))) return "GPT";
	return undefined;
}

/**
 * A one-line reason when `route` ("provider/model-id") reaches Claude, GPT or
 * Gemini by anything but a subscription; undefined when the route is allowed.
 * Only the subscription providers, and with `subscription: true` the vendors'
 * own providers and github-copilot, may carry those models: any other provider,
 * known or not, is refused when the model is one of them. Open-weight models
 * (gpt-oss, gemma) are never refused.
 */
export function forbiddenPaidRoute(route: string, opts: { subscription?: boolean } = {}): string | undefined {
	const slash = route.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = route.slice(0, slash).toLowerCase();
	const modelId = route.slice(slash + 1).toLowerCase();
	if (SUBSCRIPTION_PROVIDERS.has(provider)) return undefined;
	if (opts.subscription === true && (FIRST_PARTY_PROVIDERS.has(provider) || SUBSCRIPTION_AGGREGATOR_PROVIDERS.has(provider))) return undefined;
	// A router alias picks the model itself and can land on Claude, GPT or Gemini.
	if (provider === "openrouter" && /^~?openrouter\//.test(modelId)) return `reaches whichever model ${provider} picks, Claude, GPT and Gemini included, through a paid API; those run only on a subscription`;
	const family = proprietaryFamily(modelId);
	if (family) return `reaches ${family} through ${provider}, which is not a subscription login; ${family} runs only on a subscription`;
	if (FIRST_PARTY_PROVIDERS.has(provider) && !OPEN_WEIGHT_MODEL.test(modelId)) return `reaches ${provider} through a paid API key; Claude, GPT and Gemini run only on a subscription`;
	return undefined;
}

/** A model as a request or the registry names it. */
export interface PolicyModel {
	provider: string;
	id: string;
	baseUrl?: string;
}

/** A model served from this machine (a mock or a local server) reaches no paid vendor. */
function isLoopbackBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
		return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
	} catch {
		return false;
	}
}

/**
 * Why a request to `model` must not be sent, or undefined. The credential counts as a
 * subscription when the registry reports OAuth for the provider (a Claude or Gemini
 * login); a key never does.
 */
export function paidRouteRefusal(model: PolicyModel, registry?: { isUsingOAuth?(model: PolicyModel): boolean }): string | undefined {
	if (isLoopbackBaseUrl(model.baseUrl)) return undefined;
	const route = `${model.provider}/${model.id}`;
	if (!forbiddenPaidRoute(route)) return undefined;
	let oauth = false;
	try {
		oauth = registry?.isUsingOAuth?.(model) === true;
	} catch {
		// An unreadable credential is not a subscription.
	}
	return forbiddenPaidRoute(route, { subscription: oauth });
}

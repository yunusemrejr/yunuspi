/**
 * Model tiers: the last word of a model id names a tier ("gpt-6.1-terra" is in
 * tier "terra"), and `provider/latest-<tier>` stands for the newest model of it.
 * No imports, so the desktop's main process can load this file as it is.
 */

export interface ModelRef {
	provider: string;
	id: string;
}

export const routeOf = (model: ModelRef): string => `${model.provider}/${model.id}`;

const EXCLUDED_TIER_SEGMENTS = ["pro", "ultra"];

/** The numbers of a model id's version ("gpt-5.10-terra" is [5, 10]); none when it has no version. */
function versionOf(id: string): number[] {
	return (/\d+(?:\.\d+)*/.exec(id)?.[0] ?? "").split(".").filter(Boolean).map(Number);
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const difference = (a[i] ?? 0) - (b[i] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** The newest model of `tier` the provider lists: its id ends in `-<tier>` and has no pro or ultra segment. */
export function latestOfTier(provider: string, tier: string, available: readonly ModelRef[]): string | undefined {
	const wanted = tier.toLowerCase();
	const candidates = available.filter((model) => {
		if (model.provider !== provider) return false;
		const segments = model.id.toLowerCase().split("-");
		return segments[segments.length - 1] === wanted && !segments.some((segment) => EXCLUDED_TIER_SEGMENTS.includes(segment));
	});
	const newest = candidates.reduce<ModelRef | undefined>((best, model) => (!best || compareVersions(versionOf(model.id), versionOf(best.id)) > 0 ? model : best), undefined);
	return newest && routeOf(newest);
}

/** A `latest-<tier>` selector as a picker offers it, with the model it stands for now. */
export interface TierOption {
	setting: string;
	label: string;
}

/**
 * One `provider/latest-<tier>` option per tier the provider lists, labelled
 * "latest terra → gpt-6.1-terra". Ids ending in a version or a pro/ultra variant make no tier.
 */
export function tierOptions(available: readonly ModelRef[], provider = "openai-codex"): TierOption[] {
	const tiers = new Set<string>();
	for (const model of available) {
		const tier = model.provider === provider ? /-([a-z]+)$/i.exec(model.id)?.[1]?.toLowerCase() : undefined;
		if (tier && !EXCLUDED_TIER_SEGMENTS.includes(tier)) tiers.add(tier);
	}
	return [...tiers].sort().flatMap((tier) => {
		const route = latestOfTier(provider, tier, available);
		return route ? [{ setting: `${provider}/latest-${tier}`, label: `latest ${tier} → ${route.slice(route.indexOf("/") + 1)}` }] : [];
	});
}

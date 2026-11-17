// https://docs.x.ai/developers/advanced-api-usage/regions
const directOrigins = new Set(["https://api.x.ai", "https://us.api.x.ai"]);

export function isXaiBillingEndpoint(model, response, endpoint) {
    if (model.provider !== "xai" || !response?.url || response.redirected) return false;
    let base;
    try { base = new URL(model.baseUrl); } catch { return false; }
    if (!directOrigins.has(base.origin) || !/^\/v1\/?$/.test(base.pathname) ||
        base.username || base.password || base.search || base.hash) return false;
    return response.url === `${base.origin}/v1/${endpoint}`;
}

export function applyXaiUsage(usage, raw, previous) {
    const value = raw.cost_in_usd_ticks;
    const ticks = Number.isSafeInteger(value) && value >= 0 ? value : previous;
    if (ticks !== undefined) {
        // The request total already accounts for discounts and hosted tools.
        // https://docs.x.ai/developers/cost-tracking
        const cost = usage.cost;
        cost.estimatedTotal = cost.total;
        cost.total = ticks / 10_000_000_000;
        cost.source = "provider-reported";
        cost.priceBasis = "xai-reported-usd-ticks";
        cost.complete = true;
    }
    return ticks;
}

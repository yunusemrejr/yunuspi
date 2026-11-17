// https://openrouter.ai/blog/announcements/us-in-region-routing/
const billingOrigins = new Set(["https://openrouter.ai", "https://us.openrouter.ai", "https://eu.openrouter.ai"]);

export function isOpenRouterBillingEndpoint(model, response, endpoint) {
    if (model.provider !== "openrouter" || !response || response.redirected) return false;
    let base;
    try { base = new URL(model.baseUrl); } catch { return false; }
    if (!billingOrigins.has(base.origin) || !/^\/api\/v1\/?$/.test(base.pathname) ||
        base.username || base.password || base.search || base.hash) return false;
    return !response.url || response.url === `${base.origin}/api/v1/${endpoint}`;
}

const usdAmount = value => Number.isFinite(value) && value >= 0 ? value : undefined;

export function applyOpenRouterUsage(usage, raw, previous) {
    // The router and upstream BYOK provider can each bill for the same request.
    // https://openrouter.ai/docs/cookbook/administration/usage-accounting
    const routerCost = usdAmount(raw.cost) ?? previous?.routerCost;
    const byok = typeof raw.is_byok === "boolean" ? raw.is_byok : previous?.byok;
    const upstreamCost = byok !== false
        ? usdAmount(raw.cost_details?.upstream_inference_cost) ?? previous?.upstreamCost
        : undefined;
    if (routerCost !== undefined || byok === true) {
        const cost = usage.cost;
        cost.estimatedTotal = cost.total;
        cost.total = routerCost ?? 0;
        cost.source = "provider-reported";
        cost.complete = routerCost !== undefined && (byok !== true || upstreamCost !== undefined);
        if (byok === true) {
            cost.byok = true;
            if (upstreamCost !== undefined) cost.upstreamInferenceCost = upstreamCost;
        }
        if (routerCost === undefined) {
            // There is no measured router total. Retain only the attested upstream
            // amount and leave the missing side of this two-party charge explicit.
            usage.costDetails = {
                reported: upstreamCost ?? 0,
                estimated: 0,
                unknown: true,
                subscription: false,
                seen: upstreamCost !== undefined,
            };
        }
    }
    return { routerCost, byok, upstreamCost };
}

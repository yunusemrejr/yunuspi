function calculateCost(model, usage) {
    // USD per million, captured on the response so model switches and catalog
    // refreshes never retroactively reprice a session. Reasoning is in output.
    const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    const buckets = ['input', 'output', 'cacheRead', 'cacheWrite'];
    const base = model.cost ?? {};
    let complete = buckets.every(k => valid(usage[k]));
    const inputTokens = buckets.filter(k => k !== 'output').reduce((sum, k) => sum + (valid(usage[k]) ? usage[k] : 0), 0);
    let rates = { ...base }, threshold = -1;
    for (const tier of base.tiers ?? []) {
        if (!valid(tier?.inputTokensAbove)) { complete = false; continue; }
        if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
            rates = { ...base, ...tier };
            threshold = tier.inputTokensAbove;
        }
    }
    const writes = valid(usage.cacheWrite) ? usage.cacheWrite : 0;
    const longWrite = valid(usage.cacheWrite1h) ? Math.min(writes, usage.cacheWrite1h) : 0;
    if (usage.cacheWrite1h !== undefined && (!valid(usage.cacheWrite1h) || usage.cacheWrite1h > writes)) complete = false;
    const cost = usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    for (const key of buckets) {
        const tokens = valid(usage[key]) ? usage[key] : 0;
        if (tokens > 0 && base.missing?.includes(key)) complete = false;
        if (!valid(rates[key])) { if (tokens > 0) complete = false; continue; }
        cost[key] = tokens * rates[key] / 1e6;
    }
    if (longWrite > 0) {
        // Existing native contract: 1h writes cost 2x input. An explicit 1h
        // rate supports gateways whose write schedule differs from Anthropic.
        const longRate = rates.cacheWrite1h ?? (valid(rates.input) ? rates.input * 2 : undefined);
        if (valid(longRate) && valid(rates.cacheWrite)) cost.cacheWrite = ((writes - longWrite) * rates.cacheWrite + longWrite * longRate) / 1e6;
        else complete = false;
    }
    cost.total = buckets.reduce((sum, k) => sum + cost[k], 0);
    // Zero-filled catalog placeholders cannot establish a free route.
    if (buckets.every(k => !rates[k]) && base.knownFree !== true) complete = false;
    if (!Number.isFinite(cost.total)) { cost.total = 0; complete = false; }
    cost.source = 'estimate';
    cost.complete = complete;
    cost.provider = model.provider;
    cost.model = model.id;
    cost.rates = Object.fromEntries(buckets.filter(k => valid(rates[k])).map(k => [k, rates[k]]));
    if (longWrite > 0) cost.rates.cacheWrite1h = rates.cacheWrite1h ?? rates.input * 2;
    if (threshold >= 0) cost.inputTokensAbove = threshold;
    return cost;
}

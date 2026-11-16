export function createUsageTotals() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
    };
}
export function addUsageToTotals(totals, usage) {
    for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
        const count = usage?.[field];
        if (Number.isFinite(count) && count >= 0) totals[field] += count;
    }
    const cost = usage?.cost?.total;
    if (Number.isFinite(cost) && cost >= 0) totals.cost += cost;
}

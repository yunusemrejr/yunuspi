function getServiceTierCostMultiplier(model, serviceTier) {
    if (!serviceTier || ['auto','default','standard'].includes(serviceTier)) return 1;
    // Official per-model ratios, verified 2026-09-12. A single 2x multiplier
    // overprices GPT-5 mini, GPT-4.1, GPT-4o and o-series fast requests.
    const fast = {'gpt-6-astra':2,'gpt-5.6-sol':2,'gpt-5.6-terra':2,'gpt-5.6-luna':2,
      'gpt-5.5':2.5,'gpt-5.4':2,'gpt-5.4-mini':2,'gpt-5.3-codex':2,
      'gpt-5.2':2,'gpt-5.1':2,'gpt-5':2,'gpt-5-mini':1.8,
      'gpt-4.1':1.75,'gpt-4.1-mini':1.75,'gpt-4.1-nano':2,
      'gpt-4o':1.7,'gpt-4o-2024-05-13':1.75,'gpt-4o-mini':5/3,'o3':1.75,'o4-mini':20/11};
    const id = Object.hasOwn(fast,model.id) ? model.id : model.id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    if (serviceTier === 'fast' || serviceTier === 'priority') return fast[id];
    if (serviceTier === 'flex' && ['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna',
      'gpt-5.5','gpt-5.5-pro','gpt-5.4','gpt-5.4-pro','gpt-5.4-mini','gpt-5.4-nano',
      'gpt-5.2','gpt-5.1','gpt-5','gpt-5-mini','gpt-5-nano','o3','o4-mini'].includes(id)) return 0.5;
    return undefined;
}
function applyServiceTierPricing(usage, serviceTier, model) {
    let host = '';
    try { const url = new URL(model.baseUrl); if (url.protocol === 'https:') host = url.hostname; } catch {}
    usage.cost.serviceTier = serviceTier ?? 'default';
    // An OpenAI-compatible wire format does not imply OpenAI's price schedule.
    if (model.provider !== 'openai' || !['api.openai.com', 'us.api.openai.com', 'eu.api.openai.com'].includes(host)) {
        if (serviceTier && !['auto', 'default', 'standard'].includes(serviceTier)) usage.cost.complete = false;
        return;
    }
    if (serviceTier && !['auto', 'default', 'standard', 'flex', 'batch', 'priority', 'fast'].includes(serviceTier)) usage.cost.complete = false;
    let multiplier = getServiceTierCostMultiplier(model, serviceTier);
    const input = usage.input + usage.cacheRead + usage.cacheWrite;
    const unavailableFast = ['fast','priority'].includes(serviceTier) &&
      (/^gpt-5\.[45](?:-\d{4}-\d{2}-\d{2})?$/.test(model.id) && input > 272000 || host === 'eu.api.openai.com' && model.id === 'gpt-6-astra');
    if (multiplier === undefined || unavailableFast) { usage.cost.complete = false; multiplier = 1; }
    // Official schedule, 2026-09-12. Unknown regional models stay partial.
    // https://developers.openai.com/api/docs/pricing
    if (host !== 'api.openai.com') {
        if (/^(gpt-6-astra|gpt-5\.6-(sol|terra|luna)|gpt-5\.[45](?:-mini|-nano|-pro)?)(?:-\d{4}-\d{2}-\d{2})?$/.test(model.id)) multiplier *= 1.1;
        else usage.cost.complete = false;
    }
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) usage.cost[key] *= multiplier;
    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
    usage.cost.multiplier = multiplier;
}

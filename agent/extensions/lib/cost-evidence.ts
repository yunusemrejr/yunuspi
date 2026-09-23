// @ts-nocheck -- Also embedded verbatim in the installed SDK/CLI footer.
/** Compact accounting facts; no prompt, endpoint, credential or response text. */
export function readCostEvidence(usage, provider) {
  const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const details = usage?.costDetails;
  if (details && valid(details.reported) && valid(details.estimated) &&
      ['unknown', 'subscription', 'seen'].every(k => typeof details[k] === 'boolean')) {
    return {reported:details.reported, estimated:details.estimated, unknown:details.unknown, subscription:details.subscription, seen:details.seen, estimatedUsage:details.estimatedUsage === true || details.estimated > 0};
  }
  const cost = usage?.cost;
  if (provider === 'openai-codex' || cost?.billing === 'subscription')
    return {reported:0, estimated:0, unknown:false, subscription:true, seen:false, estimatedUsage:false};
  const n = typeof cost === 'number' ? cost : cost?.total;
  const reported = cost?.source === 'provider-reported';
  const provided = reported || cost?.source === 'provider-estimate';
  // Initial child counters are zero before a response arrives. Only a price
  // receipt or explicitly complete pricing can establish a zero charge.
  const seen = valid(n) && (n > 0 || provided || cost?.complete === true);
  return {
    reported:seen && reported ? n : 0,
    estimated:seen && !reported ? n : 0,
    unknown:!seen || !reported && cost?.complete === false || Boolean(details),
    subscription:false,
    seen,
    estimatedUsage:seen && !reported,
  };
}

export function mergeCostEvidence(left, right) {
  return {reported:left.reported + right.reported, estimated:left.estimated + right.estimated,
    unknown:left.unknown || right.unknown, subscription:left.subscription || right.subscription, seen:left.seen || right.seen, estimatedUsage:Boolean(left.estimatedUsage || right.estimatedUsage || left.estimated > 0 || right.estimated > 0)};
}

/** Zero-initialized counters alone are not a measurement of a launched child. */
export function hasRecordedTokenUsage(usage, noExecution = false) {
  const counts = ['input','output','cacheRead','cacheWrite','reasoning','turns']
    .map(k => usage?.[k]).filter(n => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  return counts.length > 0 && (counts.some(n => n > 0) || noExecution || readCostEvidence(usage).seen);
}

/** Direct SDK calls are auxiliary requests, not assistant turns or child agents.
 * Receipts contain only identity and provider accounting. A pending receipt is
 * not a zero charge; a late final receipt replaces the same request once. */
export function collectAuxiliaryModelUsage(entries) {
  const rows = new Map();
  const fields = ['input','output','cacheRead','cacheWrite','reasoning'];
  const statuses = new Set(['pending','completed','failed','cancelled','timeout']);
  const identity = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && /^[a-zA-Z0-9_.:-]+$/.test(value);
  const routePart = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\s\x00-\x1f\x7f]/.test(value);
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const costQuality = evidence => evidence.unknown ? 0 : evidence.subscription ? 3 : evidence.estimatedUsage ? 1 : evidence.seen ? 2 : 0;
  let truncated = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.type !== 'custom' || entry.customType !== 'auxiliary-model-usage-v1') continue;
    const data = entry.data;
    if (!data || !identity(data.id,160) || !identity(data.owner,64) || !routePart(data.provider,128) || !routePart(data.model,256) || !statuses.has(data.status)) { truncated = true; continue; }
    const key = JSON.stringify([data.owner,data.id]), route = `${data.provider}/${data.model}`;
    const old = rows.get(key);
    // Never guess a changed route or evict an earlier bill to fit a bound.
    // The map is bounded by the retained transcript's distinct request IDs.
    if (old && old.route !== route) { truncated = true; continue; }
    const usage = Object.fromEntries(fields.filter(k => valid(data.usage?.[k])).map(k => [k,data.usage[k]]));
    const evidence = readCostEvidence(data.usage, data.usage ? data.provider : undefined);
    if (data.status === 'pending') evidence.unknown = true;
    usage.costDetails = evidence;
    const usageRecorded = hasRecordedTokenUsage(usage);
    const tokens = fields.filter(k => k !== 'reasoning').reduce((sum,k) => sum + (usage[k] ?? 0),0);
    const next = {id:data.id, owner:data.owner, route, status:data.status, usage, usageRecorded, tokens, evidence};
    if (old) {
      // Provider billing may correct an earlier estimate down to zero. Missing
      // or replayed estimate receipts cannot erase already measured usage.
      if (costQuality(evidence) < costQuality(old.evidence) || !evidence.seen && old.evidence.seen) next.evidence = old.evidence;
      if (!usageRecorded || old.usageRecorded && tokens < old.tokens) {
        next.usage = old.usage; next.usageRecorded = old.usageRecorded; next.tokens = old.tokens;
      }
      next.usage = {...next.usage, costDetails:next.evidence};
      if (data.status === 'pending' || old.status === 'completed') next.status = old.status;
    }
    rows.set(key,next);
  }
  return {rows:[...rows.values()], truncated};
}

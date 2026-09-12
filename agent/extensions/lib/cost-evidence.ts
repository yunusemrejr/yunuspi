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
  const tokens = ['input','output','cacheRead','cacheWrite'].some(k => valid(usage?.[k]) && usage[k] > 0);
  const noActivity = usage && ['input','output','cacheRead','cacheWrite','turns'].every(k => usage[k] === 0);
  const seen = valid(n) && (n > 0 || provided || noActivity || tokens && cost?.complete === true);
  return {
    reported:seen && reported ? n : 0,
    estimated:seen && !reported ? n : 0,
    unknown:!seen || !reported && cost?.complete === false || Boolean(details),
    subscription:false,
    seen,
    estimatedUsage:seen && !reported && !noActivity,
  };
}

export function mergeCostEvidence(left, right) {
  return {reported:left.reported + right.reported, estimated:left.estimated + right.estimated,
    unknown:left.unknown || right.unknown, subscription:left.subscription || right.subscription, seen:left.seen || right.seen, estimatedUsage:Boolean(left.estimatedUsage || right.estimatedUsage || left.estimated > 0 || right.estimated > 0)};
}

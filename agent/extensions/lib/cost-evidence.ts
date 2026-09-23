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

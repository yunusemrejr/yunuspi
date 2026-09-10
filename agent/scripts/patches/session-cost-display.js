function formatSessionCost(entries, subscription) {
  let total = 0, estimate = false, unknown = false, seen = false;
  const children = new Map(), pending = new Set(), settled = new Set();
  const add = (u) => {
    const n = u?.cost?.total;
    const reported = u?.cost?.source === 'provider-reported';
    const provided = reported || u?.cost?.source === 'provider-estimate';
    const tokens = [u?.input,u?.output,u?.cacheRead,u?.cacheWrite].some(v => Number.isFinite(v) && v > 0);
    if (!provided && !tokens || !Number.isFinite(n) || n < 0 || n === 0 && !provided) { unknown = true; return; }
    seen = true; total += n; estimate ||= !reported;
  };
  const nestedCost = (nodes, depth = 0) => {
    if (!Array.isArray(nodes)) return 0;
    if (depth > 8) { unknown = true; return 0; }
    let sum = 0;
    for (const node of nodes) {
      const n = node?.totalCost?.costUsd;
      if (Number.isFinite(n) && n >= 0) sum += n;
      else { sum += nestedCost(node?.children, depth + 1); for (const step of node?.steps ?? []) sum += nestedCost(step?.children, depth + 1); }
    }
    return sum;
  };
  const record = (d, terminal) => {
    if (!d || typeof d !== 'object') return;
    const root = d.runId || d.asyncId || d.id;
    if (typeof root !== 'string') return;
    if (terminal) { pending.delete(root); settled.add(root); }
    else if (d.asyncId && !settled.has(root)) pending.add(root);
    if (!Array.isArray(d.results)) return;
    d.results.forEach((r, index) => {
      if (!r || typeof r !== 'object') return;
      const u = r.usage;
      const key = `${r.runId || root}:${r.runId ? 0 : r.index ?? index}`;
      const own = typeof u?.cost === 'number' ? u.cost : undefined;
      const inclusive = r.totalCost?.costUsd;
      const n = Number.isFinite(own) ? Math.max(own + nestedCost(r.children), Number.isFinite(inclusive) ? inclusive : 0) : inclusive;
      const tokens = [u?.input,u?.output,u?.cacheRead,u?.cacheWrite].some(v => Number.isFinite(v) && v > 0);
      // Zero without price provenance is unknown, except attested no-activity startup failures.
      const zeroActivity = u && [u.input,u.output,u.cacheRead,u.cacheWrite,u.turns].every(v => v === 0);
      const value = Number.isFinite(n) && n >= 0 ? n : undefined;
      const old = children.get(key);
      if (!old || value !== undefined && (old.value === undefined || value >= old.value))
        children.set(key,{value,unknown:value === undefined || value === 0 && !zeroActivity,estimate:tokens || value > 0});
    });
  };
  for (const e of entries) {
    const m = e.type === 'message' ? e.message : undefined;
    if (m?.role === 'toolResult' && m.toolName === 'subagent') record(m.details, !m.details?.asyncId && Array.isArray(m.details?.results) && m.details.results.length > 0);
    if (e.type === 'custom' && e.customType === 'subagent-cost-v1') record(e.data, true);
    if (m?.role === 'assistant' && m.provider === 'openai-codex') { subscription = true; continue; }
    if (m?.role === 'assistant' || m?.role === 'toolResult' && m.toolName !== 'subagent' && m.usage || ['compaction','branch_summary'].includes(e.type)) add(m ? m.usage : e.usage);
  }
  for (const c of children.values()) {
    unknown ||= c.unknown;
    if (c.value !== undefined) {total += c.value;seen = true;estimate ||= c.estimate;}
  }
  unknown ||= pending.size > 0;
  if (!seen) return subscription ? `sub${unknown ? '+?' : ''}` : '$?';
  const value = total > 0 && total < 1 ? total.toFixed(6) : total.toFixed(3);
  return `$${estimate ? '~' : ''}${value}${unknown ? '+?' : ''}${subscription ? ' (sub)' : ''}`;
}

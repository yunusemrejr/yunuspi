import type { ExtensionAPI } from '@yunuspi/coding-agent';

/** Record each selected model's runtime configuration as session evidence.
 * Assistant messages carry provider/model, but the thinking level and the
 * OpenRouter backend routing are live session state. Without a record,
 * /metrics and /export-json cannot show which thinking or nested provider
 * each used route ran with. One small `model-config-v1` entry is appended
 * at every selection boundary; consecutive duplicates are skipped so reloads
 * and no-op selections add no noise.
 */
const ENTRY = 'model-config-v1';
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function cleanRouting(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const text = JSON.stringify(value);
    if (text.length > 2048) return undefined;
    return JSON.parse(text) as Record<string, unknown>;
  } catch { return undefined; }
}

export default function modelConfig(pi: ExtensionAPI) {
  let remembered = '';
  const keyOf = (data: { route: string; thinking?: string; openRouterRouting?: unknown; recoveryEndpointName?: string }) =>
    JSON.stringify([data.route, data.thinking ?? null, data.openRouterRouting ?? null, data.recoveryEndpointName ?? null]);
  const record = (model: any, thinking: unknown, source: string) => {
    const provider = model?.provider, id = model?.id;
    if (typeof provider !== 'string' || !provider.trim() || typeof id !== 'string' || !id.trim()) return;
    const level = typeof thinking === 'string' && THINKING.has(thinking) ? thinking : undefined;
    const routing = cleanRouting(model?.compat?.openRouterRouting);
    const endpoint = typeof model?.compat?.recoveryEndpointName === 'string' && model.compat.recoveryEndpointName.trim()
      ? model.compat.recoveryEndpointName.trim().slice(0, 160) : undefined;
    const data = {
      route: `${provider}/${id}`.slice(0, 160),
      ...(level ? { thinking: level } : {}),
      ...(routing ? { openRouterRouting: routing } : {}),
      ...(endpoint ? { recoveryEndpointName: endpoint } : {}),
      source: source.slice(0, 64),
    };
    const key = keyOf(data);
    if (key === remembered) return;
    remembered = key;
    try { pi.appendEntry(ENTRY, data); }
    catch { if (remembered === key) remembered = ''; }
  };
  pi.on('session_start', (_event: any, ctx: any) => {
    // A reload replays startup with the same selection: collapse against the
    // last recorded config instead of appending a duplicate anchor.
    remembered = '';
    try {
      const branch = ctx.sessionManager.getBranch?.() ?? [];
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry?.type === 'custom' && entry.customType === ENTRY && entry.data?.route) {
          remembered = keyOf(entry.data);
          break;
        }
      }
    } catch { /* unreadable history cannot seed the anchor */ }
    record(ctx.model, pi.getThinkingLevel?.(), 'session_start');
  });
  pi.on('model_select', (event: any, ctx: any) => record(event.model ?? ctx.model, pi.getThinkingLevel?.(), `model_select:${typeof event.source === 'string' ? event.source : 'unknown'}`));
  pi.on('thinking_level_select', (event: any, ctx: any) => record(ctx.model, event.level, 'thinking_level_select'));
}

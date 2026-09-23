import { loadLlmPreferences, preferenceEntriesFor, type LlmPreferencesConfig } from '../pi-subagents/src/runs/shared/llm-preferences.ts';
import { resolveModelCandidate } from '../pi-subagents/src/runs/shared/model-fallback.ts';
import { toModelInfo } from '../pi-subagents/src/shared/model-info.ts';
import { isProvenFreeRoute, readFreeEvidence } from '../pi-subagents/src/runs/shared/free-route-evidence.ts';
import { projectTranscriptChildren, reduceChildEvents } from '../pi-subagents/src/runs/shared/child-ledger.ts';
import { collectSessionCost } from './session-cost.ts';

const routeText = (value: unknown) => typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9_./:~+@-]+$/.test(value) ? value : undefined;
const modelRoute = (provider: unknown, id: unknown) => routeText(provider) && routeText(id) ? routeText(`${provider}/${id}`) : undefined;
/** Read-only projection of existing preference, billing and child-ledger owners.
 * No routing decisions, credential fields, endpoints, prompts or output text. */
export function observerModelEvidence(input: { models: any[]; entries: any[]; preferredRoles?: string[]; preferences?: LlmPreferencesConfig; restrictions?: { fixedRoute?: boolean; sameModel?: boolean; freeOnly?: boolean }; currentModel?: any }) {
  const registry = input.models.filter(model => modelRoute(model?.provider, model?.id)).map(toModelInfo);
  const loaded = input.preferences ? { ok: true, config: input.preferences } : loadLlmPreferences();
  const retained = input.entries.slice(-2000);
  const usage = new Map<string, { responses: number; failedResponses: number; attempts: number; executionFailures: number; acceptanceFailures: number; completed: number }>();
  const row = (route: string) => {
    if (!usage.has(route) && usage.size < 256) usage.set(route, { responses: 0, failedResponses: 0, attempts: 0, executionFailures: 0, acceptanceFailures: 0, completed: 0 });
    return usage.get(route);
  };
  for (const entry of retained) {
    const message = entry?.type === 'message' ? entry.message : undefined;
    if (message?.role !== 'assistant') continue;
    const route = modelRoute(message.provider, message.model);
    if (!route) continue;
    const value = row(route); if (!value) continue;
    value.responses++; if (message.stopReason === 'error') value.failedResponses++;
  }
  const ledger = reduceChildEvents(projectTranscriptChildren(retained));
  for (const task of ledger.tasks) for (const attempt of task.attempts) {
    const route = routeText(attempt.route); if (!route) continue;
    const value = row(route); if (!value) continue;
    value.attempts++;
    if (attempt.execution.status === 'failed') value.executionFailures++;
    if (attempt.acceptance.status === 'failed') value.acceptanceFailures++;
    if (attempt.state === 'completed') value.completed++;
  }
  const extraRoles = [...new Set(input.preferredRoles ?? [])].filter(role => ['swarm', 'fusion'].includes(role) && loaded.ok && loaded.config?.preferences[role]);
  const preferred = ['subagents', ...extraRoles, 'council', 'quality_review'].map(role => ({ role, routes: loaded.ok && loaded.config
    ? preferenceEntriesFor(role, loaded.config).slice(0, 3).flatMap(entry => {
      const requested = entry.provider ? `${entry.provider}/${entry.model ?? ''}` : entry.model;
      if (!routeText(requested)) return [];
      const candidate = resolveModelCandidate(requested!, registry, entry.provider);
      const resolved = registry.some(model => model.fullId === candidate) ? candidate : undefined;
      return [{ route: resolved ?? requested, available: Boolean(resolved), ...(entry.thinking ? { thinking: entry.thinking } : {}), seen: resolved ? usage.has(resolved) : false }];
    }) : [] }));
  const fixed = input.restrictions?.fixedRoute || input.restrictions?.sameModel;
  const current = modelRoute(input.currentModel?.provider, input.currentModel?.id);
  const freeEvidence = readFreeEvidence();
  const free = freeEvidence ? registry.filter(model => (!fixed || model.fullId === current) && isProvenFreeRoute(model, freeEvidence)).slice(0, 3).map(model => model.fullId) : [];
  const costs = collectSessionCost(retained);
  const preferredIds = new Set(preferred.flatMap(group => group.routes.map(route => route.route)));
  const routeUsage = [...usage].sort(([a], [b]) => Number(preferredIds.has(b)) - Number(preferredIds.has(a))).slice(0, 6).map(([route, value]) => ({ route, ...value }));
  const value = { scope: input.entries.length > retained.length ? 'last 2000 retained entries; earlier usage unknown' : 'current retained branch; compacted history may be absent',
    preferences: loaded.ok ? preferred : 'unavailable', preferenceScope: 'Sampled roles and routes; additional configured choices may be omitted for budget.', restrictions: input.restrictions ?? {}, provenFreeCandidates: free,
    usage: routeUsage, cost: { reportedUsd: costs.reported, estimatedUsd: costs.estimated, unknown: costs.unknown, subscription: costs.subscription },
    policy: 'Prefer suitable configured choices. Seen=false means not observed in this evidence, never a quota to spend. Consider proven-free alternatives only when task fit, observed reliability, user constraints and known cost justify them. Unknown charges are not zero; no spending threshold is implied. All candidates still require native health/capability/provider checks. Execution counts are not quality scores. Recommend a mode/model with a reason; never change settings.' };
  // Drop entire low-priority rows, never truncate JSON or an individual route.
  while (JSON.stringify(value).length > 2600 && value.usage.length) value.usage.pop();
  while (JSON.stringify(value).length > 2600 && value.provenFreeCandidates.length) value.provenFreeCandidates.pop();
  for (const group of Array.isArray(value.preferences) ? value.preferences : []) while (JSON.stringify(value).length > 2600 && group.routes.length) group.routes.pop();
  return JSON.stringify(value);
}

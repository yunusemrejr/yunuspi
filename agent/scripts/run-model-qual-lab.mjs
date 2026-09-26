#!/usr/bin/env node
/** Run the model qualification battery against one OpenRouter route and
 * record expiring role eligibility to the private store.
 *
 * node agent/scripts/run-model-qual-lab.mjs --live --route provider/model [--roles micro-worker,skill-router]
 *
 * --live is required (remote inference). Eligibility lands in the private
 * qual store (~/.pi/agent/micro-intel/qual-eligibility.json by default,
 * override with PI_QUAL_STORE) and expires after 7 days. Nothing here
 * promotes a route: admission owners read eligibility as one input.
 */
import { openRouterKey } from '../extensions/lib/jev-client.ts';
import { runQualBattery, qualifyForRole, createEligibilityStore, defaultQualStorePath, QUAL_ROLES } from '../extensions/lib/micro-intelligence/model-qual-lab.ts';

const live = process.argv.includes('--live');
if (!live) throw Error('Pass --live to run remote inference.');
const route = (process.argv.find((a) => a.startsWith('--route=')) ?? '').slice('--route='.length);
if (!route || !route.includes('/')) throw Error('Pass --route=provider/model.');
const rolesArg = (process.argv.find((a) => a.startsWith('--roles=')) ?? '').slice('--roles='.length);
const roles = (rolesArg ? rolesArg.split(',') : [...QUAL_ROLES]).map((r) => r.trim()).filter(Boolean);
for (const role of roles) {
  if (!QUAL_ROLES.includes(role)) throw Error(`Unknown role ${role}; one of ${QUAL_ROLES.join(',')}.`);
}
const key = openRouterKey();
if (!key) throw Error('No OpenRouter key (models.json provider entry or OPENROUTER_API_KEY).');

const complete = async ({ route: slug, prompt, maxTokens, timeoutMs, signal }) => {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const model = slug.includes('/') && !slug.startsWith('openrouter/') ? slug : slug.replace(/^openrouter\//, '');
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/yunusemrejr/yunuspi',
        'X-Title': 'yunuspi-qual-lab',
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: maxTokens }),
      signal: controller.signal,
    });
    if (!response.ok) throw Error(`chat ${response.status}`);
    const body = await response.json();
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw Error('malformed answers');
    return {
      text,
      latencyMs: Date.now() - started,
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      costUsd: typeof body.usage?.cost === 'number' ? body.usage.cost : 0,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

const summary = await runQualBattery(route, complete, {});
const store = createEligibilityStore({ file: process.env.PI_QUAL_STORE || defaultQualStorePath() });
const eligibility = roles.map((role) => {
  const entry = store.record(summary, role);
  return { role, eligible: entry.eligible, reason: entry.reason, expiresAt: new Date(entry.expiresAt).toISOString() };
});
console.log(JSON.stringify({
  route: summary.route, at: new Date(summary.at).toISOString(),
  meanScore: summary.meanScore, passRate: summary.passRate, p95LatencyMs: summary.p95LatencyMs,
  totalCostUsd: summary.totalCostUsd, reliability: summary.reliability,
  privacyTier: summary.privacyTier, privacyReason: summary.privacyReason,
  tasks: summary.tasks.map((t) => ({ id: t.id, score: t.score, latencyMs: t.latencyMs, error: t.error ?? null })),
  eligibility,
}, null, 1));

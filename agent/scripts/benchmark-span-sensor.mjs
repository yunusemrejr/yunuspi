#!/usr/bin/env node
/** Span behavior-sensor benchmark over synthetic YunusPi traces.
 *
 * Offline default: validates the scoring pipeline (fingerprint stability,
 * caching, threshold gating) with a mock scorer and reports a keyword
 * baseline against the fixture labels. No network, no keys.
 *
 * node agent/scripts/benchmark-span-sensor.mjs [--live] [--trace id]
 * --live scores the fixtures through the real OpenRouter Span route
 * (needs OPENROUTER_API_KEY; a missing Span route reports
 * route-unavailable instead of failing).
 */
import fs from 'node:fs';
import {
  SPAN_CATALOG, createSpanTrace, spanTraceFingerprint, scoreSpanTrace,
  spanAdvisory, openRouterSpanScorer, clearSpanCache,
} from '../extensions/lib/micro-intelligence/span-sensor.ts';

const live = process.argv.includes('--live');
const only = (process.argv.find((a) => a.startsWith('--trace=')) ?? '').slice('--trace='.length);
const fixture = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/micro-intel/traces.json', import.meta.url), 'utf8'));

const toTrace = (events) => {
  const collector = createSpanTrace();
  for (const [kind, text] of events) collector.record(kind, text, 1000);
  return collector.trace;
};

// Offline baseline: transparent keyword heuristics, not a model claim.
const keywordScorer = async (prompt) => {
  const errors = (prompt.match(/\[error\]/g) ?? []).length;
  const reviews = (prompt.match(/quality_review/g) ?? []).length;
  const tests = (prompt.match(/project_tests/g) ?? []).length;
  const subs = (prompt.match(/subagent/g) ?? []).length;
  const scores = {};
  for (const signal of SPAN_CATALOG) scores[signal.id] = { present: 0.05, absent: 0.9, notObservable: 0.05 };
  if (errors >= 3) {
    scores['repeated-failure-loop'] = { present: 0.9, absent: 0.05, notObservable: 0.05 };
    scores['unproductive-progress'] = { present: 0.85, absent: 0.1, notObservable: 0.05 };
  }
  if (reviews >= 3) scores['review-churn'] = { present: 0.85, absent: 0.1, notObservable: 0.05 };
  if (tests >= 3) scores['redundant-verification'] = { present: 0.85, absent: 0.1, notObservable: 0.05 };
  if (subs >= 3) scores['unnecessary-delegation'] = { present: 0.8, absent: 0.15, notObservable: 0.05 };
  return { text: JSON.stringify(scores), model: 'keyword-baseline', ms: 0 };
};

const report = { at: new Date().toISOString(), mode: live ? 'live-span-route' : 'offline-pipeline', traces: [] };
const scorer = live ? openRouterSpanScorer() : keywordScorer;
const env = live ? { ...process.env, PI_SPAN_SHADOW: '1' } : { PI_SPAN_SHADOW: '0' };

for (const trace of fixture.traces) {
  if (only && trace.id !== only) continue;
  const events = toTrace(trace.events);
  clearSpanCache();
  const first = await scoreSpanTrace(events, scorer, { env });
  const refingerprint = spanTraceFingerprint(toTrace(trace.events)) === first.fingerprint;
  const second = await scoreSpanTrace(events, scorer, { env });
  const full = new Set([...(trace.expected ?? [])]);
  // Corroborate with the fixture labels: advisory must reproduce exactly
  // the expected set when the scorer flags them (pipeline check, not
  // proof the live route agrees with the labels).
  const advisory = spanAdvisory(first, full);
  const flagged = first.scores ? Object.entries(first.scores).filter(([, s]) => s.present >= 0.8).map(([id]) => id) : [];
  report.traces.push({
    id: trace.id,
    events: trace.events.length,
    ok: first.ok,
    skipped: first.skipped ?? null,
    fingerprintStable: refingerprint,
    cacheHitOnRescore: second.cached === true,
    expected: [...full],
    flagged,
    advised: advisory.signals,
    heldForCorroboration: advisory.uncorroborated,
    model: first.model ?? null,
    shadow: first.shadow,
  });
}

report.summary = {
  traces: report.traces.length,
  scored: report.traces.filter((t) => t.ok).length,
  cacheStable: report.traces.every((t) => t.fingerprintStable && (t.cacheHitOnRescore || !t.ok)),
};
console.log(JSON.stringify(report, null, 1));

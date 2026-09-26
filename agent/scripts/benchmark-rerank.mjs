#!/usr/bin/env node
/** Rerank benchmark: lexical vs local Needle vs remote rerank variants.
 *
 * Offline default: lexical order plus order-stability checks over the
 * synthetic fixture (no keys, no assets required).
 * --live adds the Needle head-rerank when assets are installed, and the
 * remote Voyage-shaped reranker when PI_RERANK_MODEL is set (needs the
 * backend key, e.g. VOYAGE_API_KEY). Models are compared, never assumed:
 * pass PI_RERANK_MODEL=voyage-rerank-3 (or any compatible model) per run.
 *
 * node agent/scripts/benchmark-rerank.mjs [--live]
 */
import fs from 'node:fs';
import { remoteRanker } from '../extensions/lib/micro-intelligence/rerank.ts';
import { needleRanker } from '../extensions/lib/project-memory-retrieve.ts';

const live = process.argv.includes('--live');
const fixture = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/micro-intel/code-retrieval.json', import.meta.url), 'utf8'));

const terms = (text) => new Set(String(text).toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.sqrt(a.size * b.size));
};
const candidates = fixture.files.map((f) => ({ id: f.path, text: `${f.path}\n${f.text}` }));

const report = { at: new Date().toISOString(), corpus: 'tests/fixtures/micro-intel/code-retrieval.json', modes: [] };
const evaluate = (name, extra, orderOf) => {
  const rows = [];
  for (const q of fixture.queries) {
    const order = orderOf(q.text);
    const rankPos = order.findIndex((p) => q.relevant.includes(p));
    rows.push({ id: q.id, rank: rankPos < 0 ? null : rankPos + 1, order: order.slice(0, 3) });
  }
  report.modes.push({
    name, ...extra,
    accuracyAt1: rows.filter((r) => r.rank === 1).length / rows.length,
    mrr: rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rows.length,
    rows,
  });
};

evaluate('lexical', {}, (query) => [...candidates]
  .map((c) => ({ id: c.id, score: overlap(terms(query), terms(c.text)) }))
  .sort((a, b) => b.score - a.score).map((r) => r.id));

if (live) {
  try {
    const ranker = needleRanker();
    const rows = [];
    for (const q of fixture.queries) {
      const order = (await ranker.rank(q.text, candidates)) ?? candidates.map((c) => c.id);
      const rankPos = order.findIndex((p) => q.relevant.includes(p));
      rows.push({ id: q.id, rank: rankPos < 0 ? null : rankPos + 1, order: order.slice(0, 3) });
    }
    report.modes.push({
      name: 'needle-local', accuracyAt1: rows.filter((r) => r.rank === 1).length / rows.length,
      mrr: rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rows.length, rows,
    });
  } catch (error) {
    report.modes.push({ name: 'needle-local', error: String(error?.message ?? error).slice(0, 160) });
  }
  if (process.env.PI_RERANK_MODEL) {
    try {
      const ranker = remoteRanker({ env: { ...process.env, PI_RERANK: 'on' } });
      const rows = [];
      let unavailable = 0;
      for (const q of fixture.queries) {
        const order = (await ranker.rank(q.text, candidates)) ?? candidates.map((c) => c.id);
        if (order.length < 2) unavailable++;
        const rankPos = order.findIndex((p) => q.relevant.includes(p));
        rows.push({ id: q.id, rank: rankPos < 0 ? null : rankPos + 1, order: order.slice(0, 3) });
      }
      report.modes.push({
        name: 'remote-rerank', model: process.env.PI_RERANK_MODEL, unavailable,
        accuracyAt1: rows.filter((r) => r.rank === 1).length / rows.length,
        mrr: rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rows.length, rows,
      });
    } catch (error) {
      report.modes.push({ name: 'remote-rerank', error: String(error?.message ?? error).slice(0, 160) });
    }
  } else {
    report.note = 'Set PI_RERANK_MODEL to compare a remote rerank variant against lexical (and Needle with --live).';
  }
} else {
  report.note = 'Offline: lexical order only. Pass --live for Needle and remote-rerank comparisons.';
}

console.log(JSON.stringify(report, null, 1));

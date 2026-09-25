#!/usr/bin/env node
/** Opt-in real-provider retrieval evaluation over a public, synthetic corpus.
 * node scripts/benchmark-project-memory.mjs --live > report.json
 * No production DB is opened. Remote text is limited to the checked-in fixture. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { openProjectStore } from '../agent/extensions/lib/project-vector-store.ts';
import { indexEvent, reindexEmbeddings } from '../agent/extensions/lib/project-memory-index.ts';
import { needleMemoryEmbedder, openRouterMemoryEmbedder } from '../agent/extensions/lib/project-memory-embedder.ts';
import { retrieveProjectMemory } from '../agent/extensions/lib/project-memory-retrieve.ts';
import { needleWarmup, needleHealth, needleHandle } from '../agent/extensions/lib/needle-runtime.ts';
if (!process.argv.includes('--live')) throw Error('Pass --live to allow embedding the public fixture through OpenRouter.');
const fixture = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/project-memory/recall.json', import.meta.url), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-recall-eval-'));
const report = { at: new Date().toISOString(), corpus: 'tests/fixtures/project-memory/recall.json', memories: fixture.memories.length, queries: fixture.queries.length, rerank: false, modes: [] };
const percentile = (values, fraction) => [...values].sort((a,b) => a-b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
try {
  needleWarmup();
  for (let i = 0; i < 300 && needleHealth().state === 'warming'; i++) await new Promise(r => setTimeout(r, 100));
  const n = needleMemoryEmbedder(), r = openRouterMemoryEmbedder();
  for (const [name, embedder] of [['A lexical', undefined], ['B lexical + Needle3', n], ['C lexical + OpenRouter Qwen3', r]]) {
    const store = openProjectStore(path.join(root, `${name[0]}.sqlite`), { projectId: 'benchmark' });
    const ids = new Map();
    try {
      for (const memory of fixture.memories) {
        const indexed = await indexEvent(store, 'benchmark', { kind: 'decision', sourceType: memory.type, text: memory.text, timestamp: '2026-09-25T00:00:00.000Z' });
        ids.set(indexed.ids[0], memory.id);
      }
      const start = performance.now();
      const index = embedder ? await reindexEmbeddings(store, embedder, { limit: 64 }) : { embedded: 0, failed: 0 };
      const indexingMs = performance.now() - start;
      const rows = [];
      for (const q of fixture.queries) {
        const result = await retrieveProjectMemory(store, q.text, { embedder, role: q.role ?? 'main', limit: 5, rerank: false, now: () => Date.parse('2026-09-25T12:00:00Z') });
        const hits = result.hits.map(h => ({ id: ids.get(h.chunk.id), lexicalRank: h.signals.lexicalRank, vectorRank: h.signals.vectorRank, vectorScore: h.signals.vectorScore, score: h.score }));
        const rank = hits.findIndex(h => q.relevant.includes(h.id));
        rows.push({ ...q, hits, rank: rank < 0 ? null : rank + 1, latencyMs: result.stats.ms, degraded: result.stats.degraded, semanticSkipped: result.stats.semanticSkipped });
      }
      const summarize = group => { const rowsWithAnswer = group.filter(q => q.relevant.length); return { queries: group.length, recallAt1: rowsWithAnswer.filter(q => q.rank === 1).length / rowsWithAnswer.length, recallAt3: rowsWithAnswer.filter(q => q.rank && q.rank <= 3).length / rowsWithAnswer.length, mrrAt5: rowsWithAnswer.reduce((sum,q) => sum + (q.rank ? 1 / q.rank : 0), 0) / rowsWithAnswer.length, falsePositiveAt3: group.reduce((sum,q) => sum + q.hits.slice(0,3).filter(h => !q.relevant.includes(h.id)).length,0) / (group.length * 3), latencyP50Ms: percentile(group.map(q => q.latencyMs), .5), latencyP95Ms: percentile(group.map(q => q.latencyMs), .95) }; };
      report.modes.push({ name, indexingMs, index, spaces: store.embeddingSpaces(), health: embedder?.status?.(), overall: summarize(rows), splits: Object.fromEntries(['development','held-out'].map(split => [split, summarize(rows.filter(q => q.split === split))])), categories: Object.fromEntries(['exact','paraphrase','turkish','negative'].map(kind => [kind, summarize(rows.filter(q => q.kind === kind))])), rows });
    } finally { store.close(); }
  }
  // Read public current pricing instead of assuming a hardcoded cost.
  try {
    const response = await fetch('https://openrouter.ai/api/v1/embeddings/models', { signal: AbortSignal.timeout(10_000) });
    const model = (await response.json()).data?.find(row => row.id === r.model);
    const perToken = Number(model?.pricing?.prompt);
    if (Number.isFinite(perToken)) report.cost = { source: 'https://openrouter.ai/api/v1/embeddings/models', model: r.model, usdPerInputToken: perToken, actualTokens: r.status().tokens, estimatedUsd: perToken * r.status().tokens, reportedUsd: r.status().costUsd };
  } catch { report.cost = { unavailable: true }; }
  console.log(JSON.stringify(report, null, 2));
} finally { await needleHandle().shutdown(); fs.rmSync(root, { recursive: true, force: true }); }

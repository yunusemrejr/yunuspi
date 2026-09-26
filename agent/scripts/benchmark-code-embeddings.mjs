#!/usr/bin/env node
/** Code-embedding benchmark: does a code-specific embedding space beat
 * Qwen3 embeddings (+ lexical) for issue->file retrieval?
 *
 * Offline default: lexical baseline only over the synthetic fixture.
 * --live also embeds through OpenRouter Qwen3 (the current default) and,
 * when PI_CODE_EMBED_MODEL names a code model, through that model.
 * A separate code space is justified only if measured gains beat the
 * added index/complexity cost. No production DB is opened.
 *
 * node agent/scripts/benchmark-code-embeddings.mjs [--live]
 */
import { openRouterMemoryEmbedder } from '../extensions/lib/project-memory-embedder.ts';
import fs from 'node:fs';

const live = process.argv.includes('--live');
const fixture = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/micro-intel/code-retrieval.json', import.meta.url), 'utf8'));

const terms = (text) => new Set(String(text).toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, Math.sqrt(a.size * b.size));
};
const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

const rankLexical = (query) => fixture.files
  .map((f) => ({ path: f.path, score: overlap(terms(query), terms(`${f.path}\n${f.text}`)) }))
  .sort((a, b) => b.score - a.score);

const report = { at: new Date().toISOString(), corpus: 'tests/fixtures/micro-intel/code-retrieval.json', modes: [] };

const evaluate = (name, rank) => {
  const rows = fixture.queries.map((q) => {
    const order = rank(q.text).map((r) => r.path);
    const rankPos = order.findIndex((p) => q.relevant.includes(p));
    return { id: q.id, rank: rankPos < 0 ? null : rankPos + 1, order: order.slice(0, 3) };
  });
  const answered = rows.filter((r) => r.rank);
  report.modes.push({
    name,
    accuracyAt1: rows.filter((r) => r.rank === 1).length / rows.length,
    mrr: rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rows.length,
    answered: `${answered.length}/${rows.length}`,
    rows,
  });
};

evaluate('lexical-baseline', rankLexical);

if (live) {
  const spaces = [['qwen3-current', undefined]];
  if (process.env.PI_CODE_EMBED_MODEL) spaces.push(['code-candidate', process.env.PI_CODE_EMBED_MODEL]);
  for (const [name, model] of spaces) {
    try {
      const embedder = openRouterMemoryEmbedder(model ? { model } : {});
      const fileVecs = [];
      for (const f of fixture.files) {
        const vectors = await embedder.embed([`${f.path}\n${f.text}`], {});
        if (!vectors?.[0]) throw Error(`no vector for ${f.path} (${embedder.status?.().lastError ?? 'unknown'})`);
        fileVecs.push({ path: f.path, vec: vectors[0] });
      }
      const rows = [];
      for (const q of fixture.queries) {
        const vectors = await embedder.embed([q.text], {});
        const qv = vectors?.[0] ?? [];
        const order = fileVecs.map((f) => ({ path: f.path, score: cosine(qv, f.vec) })).sort((a, b) => b.score - a.score);
        const rankPos = order.findIndex((r) => q.relevant.includes(r.path));
        rows.push({ id: q.id, rank: rankPos < 0 ? null : rankPos + 1, order: order.slice(0, 3).map((r) => r.path) });
      }
      report.modes.push({
        name, model: embedder.model ?? model ?? 'default',
        accuracyAt1: rows.filter((r) => r.rank === 1).length / rows.length,
        mrr: rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rows.length,
        rows,
      });
    } catch (error) {
      report.modes.push({ name, error: String(error?.message ?? error).slice(0, 200) });
    }
  }
  report.note = process.env.PI_CODE_EMBED_MODEL
    ? 'Compare code-candidate vs qwen3-current accuracy/MRR: a separate code space is justified only by measured gains.'
    : 'Set PI_CODE_EMBED_MODEL to compare a code-specific embedding model against the Qwen3 default.';
} else {
  report.note = 'Offline: lexical baseline only. Pass --live to embed through OpenRouter (Qwen3 default; PI_CODE_EMBED_MODEL for the code candidate).';
}

console.log(JSON.stringify(report, null, 1));

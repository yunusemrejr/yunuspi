/** Embedding transports for the existing project index. Every batch carries
 * an immutable space identity; availability never changes what its vectors mean. */
import { createHash, randomUUID } from 'node:crypto';
import { needleEmbed, needleWarmup } from './needle-runtime.ts';
import { openRouterKey } from './jev-client.ts';
import { redactSecrets } from './memory-redaction.ts';
import { sessionObservability } from './session-observability.ts';
import type { EmbeddingSpace } from './project-vector-store.ts';

export const DEFAULT_MEMORY_EMBEDDING_MODEL = 'qwen/qwen3-embedding-8b';
export const DEFAULT_MEMORY_EMBEDDER = 'openrouter';
export const MEMORY_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
export const MEMORY_EMBED_BATCH = 16;
export const MEMORY_EMBED_CHARS = 2000;
export interface EmbeddingOptions { inputType?: 'query' | 'document'; signal?: AbortSignal; compatible?: ReadonlySet<string> }
export interface MemoryEmbedding { space: EmbeddingSpace; vectors: number[][] }
export type EmbeddingReceipt = { id: string; owner: 'project-memory'; provider: 'openrouter'; model: string; status: 'pending' | 'completed' | 'failed' | 'cancelled'; usage?: Record<string, unknown> };
export type EmbeddingAccounting = () => (receipt: EmbeddingReceipt) => void;
export interface MemoryEmbedder {
  readonly id: string;
  readonly backend?: string;
  readonly model?: string;
  readonly version?: number;
  readonly candidates?: readonly MemoryEmbedder[];
  readonly fallback?: MemoryEmbedder;
  embed(texts: string[], opts?: EmbeddingOptions): Promise<number[][] | null>;
  embedWithMetadata?(texts: string[], opts?: EmbeddingOptions): Promise<MemoryEmbedding | null>;
  status?(): Record<string, unknown>;
}

export function validMemoryVectors(vectors: unknown, count: number): vectors is number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count || !count) return false;
  const dim = vectors[0]?.length;
  if (!Number.isSafeInteger(dim) || dim < 1 || dim > 16384) return false;
  return Array.from(vectors).every(v => Array.isArray(v) && v.length === dim && Array.from(v).every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e20)
    && v.some(x => x !== 0));
}
export async function embedMemory(embedder: MemoryEmbedder, texts: string[], opts: EmbeddingOptions = {}): Promise<MemoryEmbedding | null> {
  if (opts.signal?.aborted || !texts.length || texts.length > 64) return null;
  try {
    if (embedder.embedWithMetadata) {
      const result = await embedder.embedWithMetadata(texts, opts);
      return result && !opts.signal?.aborted && validMemoryVectors(result.vectors, texts.length)
        && result.space.dim === result.vectors[0].length && (!opts.compatible || opts.compatible.has(result.space.id)) ? result : null;
    }
    if (opts.compatible && !opts.compatible.has(embedder.id)) return null;
    const vectors = await embedder.embed(texts, opts);
    if (opts.signal?.aborted || !validMemoryVectors(vectors, texts.length)) return null;
    return { vectors, space: { id: embedder.id, backend: embedder.backend ?? 'local', model: embedder.model ?? embedder.id, version: embedder.version ?? 1, dim: vectors[0].length } };
  } catch { return null; }
}

export function needleMemoryEmbedder(): MemoryEmbedder {
  let dimension = 0, lastError = '';
  return {
    id: 'needle3', backend: 'needle', model: 'needle3', version: 1,
    status: () => ({ backend: 'needle', model: 'needle3', dimension, lastError, state: lastError ? 'degraded' : dimension ? 'healthy' : 'not-run', fallback: 'lexical' }),
    async embed(texts, opts = {}) {
      try {
        needleWarmup();
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i += MEMORY_EMBED_BATCH) {
          if (opts.signal?.aborted) return null;
          const batch = texts.slice(i, i + MEMORY_EMBED_BATCH).map(t => redactSecrets(t).slice(0, MEMORY_EMBED_CHARS));
          const result = await needleEmbed(batch);
          if (!result.ok || !validMemoryVectors(result.value.vectors, batch.length)) { lastError = result.ok ? 'malformed-vectors' : result.reason; return null; }
          if (dimension && dimension !== result.value.vectors[0].length) { lastError = 'dimension-mismatch'; return null; }
          dimension = result.value.vectors[0].length;
          out.push(...result.value.vectors);
        }
        lastError = ''; return out;
      } catch { lastError = 'unavailable'; return null; }
    },
  };
}

export function openRouterMemoryEmbedder(options: { model?: string; env?: Record<string, string | undefined>; key?: () => string | undefined; fetch?: typeof fetch; now?: () => number; timeoutMs?: number; accounting?: EmbeddingAccounting } = {}): MemoryEmbedder {
  const env = options.env ?? process.env;
  const model = options.model ?? env.PI_MEMORY_EMBEDDING_MODEL ?? DEFAULT_MEMORY_EMBEDDING_MODEL;
  const id = `openrouter:${model}:v1`;
  const request = options.fetch ?? fetch, now = options.now ?? Date.now;
  const keyOf = options.key ?? openRouterKey;
  let dimension = 0, lastError = '', lastSkipped = '', retryAt = 0, active = false, calls = 0, tokens = 0, costUsd = 0, cacheHits = 0;
  const cache = new Map<string, number[]>();
  const note = (decision: string, count: number, started: number) => {
    try { sessionObservability()[Symbol.for('yunus-pi.health.v1')]?.('ml.project-memory.embedding', { decision, route: model, helper: 'openrouter', count, durationMs: now() - started, ...(lastError ? { reason: lastError } : {}) }); } catch { /* optional */ }
  };
  return {
    id, backend: 'openrouter', model, version: 1,
    status: () => ({ backend: 'openrouter', model, dimension, lastError, lastSkipped, state: active ? 'busy' : retryAt > now() ? 'cooling' : lastError ? 'degraded' : dimension ? 'healthy' : 'not-run', retryInMs: Math.max(0, retryAt - now()), calls, tokens, costUsd, cacheHits, fallback: 'compatible Needle3 / lexical' }),
    async embed(texts, opts = {}) {
      const started = now();
      const unavailable = (reason: string) => { const changed = lastError !== reason; lastError = reason; if (changed) note('unavailable', texts.length, started); return null; };
      if (opts.signal?.aborted) { lastError = 'cancelled'; return null; }
      if (['1','true','yes'].includes((env.PI_OFFLINE ?? '').toLowerCase())) return unavailable('offline');
      const key = keyOf();
      if (!key) return unavailable('no-key');
      if (!/^[A-Za-z0-9_.~-]+\/[A-Za-z0-9_.:/-]+$/.test(model)) { lastError = 'invalid-model'; return null; }
      if (!Array.isArray(texts) || !texts.length || texts.length > 64 || texts.some(t => typeof t !== 'string' || !t.trim())) { lastError = 'invalid-input'; return null; }
      const clean = texts.map(t => {
        const text = redactSecrets(t, env, [key]).slice(0, MEMORY_EMBED_CHARS);
        // Qwen's documented asymmetric retrieval format; documents stay plain.
        return opts.inputType === 'query' && model.toLowerCase() === DEFAULT_MEMORY_EMBEDDING_MODEL
          ? `Instruct: Retrieve project history relevant to this task, including decisions, corrections, regressions and implementation context.\nQuery: ${text}` : text;
      });
      const keys = clean.map(t => createHash('sha256').update(t).digest('hex'));
      const unique = [...new Set(keys)].filter(k => !cache.has(k));
      if (!unique.length) { cacheHits++; lastError = ''; return keys.map(k => [...cache.get(k)!]); }
      if (active || retryAt > now()) { lastSkipped = active ? 'busy' : 'cooling'; return null; }
      active = true;
      lastSkipped = '';
      const staged = new Map<string, number[]>();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
      let receipt: EmbeddingReceipt | undefined;
      let account: ReturnType<EmbeddingAccounting> | undefined;
      const record = () => { if (receipt) try { account?.({ ...receipt }); } catch { /* Accounting never breaks memory. */ } };
      try {
        for (let i = 0; i < unique.length; i += MEMORY_EMBED_BATCH) {
          signal.throwIfAborted();
          const batch = unique.slice(i, i + MEMORY_EMBED_BATCH);
          try { account = options.accounting?.(); } catch { account = undefined; }
          receipt = { id: randomUUID(), owner: 'project-memory', provider: 'openrouter', model, status: 'pending' };
          record();
          calls++;
          const response = await request(MEMORY_EMBEDDINGS_URL, { method: 'POST', redirect: 'error', signal,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: batch.map(k => clean[keys.indexOf(k)]), encoding_format: 'float' }) });
          if (!response.ok) {
            lastError = `http-${response.status}`;
            const retry = Number(response.headers.get('retry-after'));
            retryAt = now() + (response.status === 429 && Number.isFinite(retry) && retry > 0 ? Math.min(300_000, retry * 1000) : 60_000);
            await response.body?.cancel(); receipt.status = 'failed'; record(); return null;
          }
          if (!response.body) throw Error('empty-response');
          const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
          try {
            for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
              if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw Error('response-budget'); } chunks.push(part.value); }
          } finally { reader.releaseLock(); }
          signal.throwIfAborted();
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const used = body.usage?.prompt_tokens ?? body.usage?.total_tokens;
          if (Number.isSafeInteger(used) && used >= 0) tokens += used;
          const cost = body.usage?.cost;
          if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) costUsd += cost;
          receipt.usage = { ...(Number.isSafeInteger(used) && used >= 0 ? { input: used, output: 0 } : {}),
            ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { cost: { total: cost, source: 'provider-reported' } } : {}) };
          // OpenRouter currently echoes the upstream Hugging Face spelling
          // (Qwen/Qwen3-Embedding-8B); case does not create another model.
          if (typeof body.model === 'string' && body.model.toLowerCase() !== model.toLowerCase()) throw Error('model-mismatch');
          if (!Array.isArray(body.data) || body.data.length !== batch.length) throw Error('partial-batch');
          const ordered: number[][] = new Array(batch.length);
          for (const item of body.data) {
            if (!Number.isSafeInteger(item?.index) || item.index < 0 || item.index >= batch.length || ordered[item.index]) throw Error('invalid-index');
            ordered[item.index] = item.embedding;
          }
          if (!validMemoryVectors(ordered, batch.length)) throw Error('malformed-vectors');
          const dim = ordered[0].length;
          if (dimension && dimension !== dim) throw Error('dimension-mismatch');
          dimension = dim;
          batch.forEach((k, j) => staged.set(k, ordered[j]));
          receipt.status = 'completed'; record(); receipt = undefined;
        }
        signal.throwIfAborted();
        const out = keys.map(k => [...(staged.get(k) ?? cache.get(k))!]);
        for (const [k, vector] of staged) { if (cache.size >= 256) cache.delete(cache.keys().next().value!); cache.set(k, vector); }
        lastError = ''; retryAt = 0; note('embedded', texts.length, started); return out;
      } catch (error) {
        if (receipt) { receipt.status = opts.signal?.aborted ? 'cancelled' : 'failed'; record(); }
        const code = error instanceof Error ? error.message : '';
        lastError = opts.signal?.aborted ? 'cancelled' : controller.signal.aborted ? 'timeout'
          : ['model-mismatch','partial-batch','invalid-index','malformed-vectors','dimension-mismatch','response-budget','empty-response'].includes(code) ? code : 'network-or-json';
        if (!opts.signal?.aborted) retryAt = now() + 60_000;
        return null;
      } finally { clearTimeout(timer); active = false; if (lastError) note('unavailable', texts.length, started); }
    },
  };
}

/** Auto pins the first successful space for this owner. It does not switch
 * models between queries; a new session/configuration can explicitly choose
 * another space, whose old chunks are then eligible for bounded backfill. */
export function configuredMemoryEmbedder(env: Record<string, string | undefined> = process.env, deps: { needle?: MemoryEmbedder; openrouter?: MemoryEmbedder; accounting?: EmbeddingAccounting } = {}): MemoryEmbedder {
  const local = deps.needle ?? needleMemoryEmbedder();
  const remote = deps.openrouter ?? openRouterMemoryEmbedder({ env, accounting: deps.accounting });
  const mode = (env.PI_MEMORY_EMBEDDER ?? DEFAULT_MEMORY_EMBEDDER).toLowerCase();
  if (mode === 'needle') return local;
  if (mode === 'openrouter') return { ...remote, fallback: local };
  if (mode !== 'auto') return { id: 'disabled', embed: async () => null, status: () => ({ state: 'unavailable', lastError: 'invalid-backend', fallback: 'lexical' }) };
  let selected: MemoryEmbedder | undefined;
  let selecting: Promise<MemoryEmbedding | null> | undefined;
  return {
    get id() { return selected?.id ?? local.id; },
    candidates: [local, remote],
    fallback: local,
    status: () => ({ mode: 'auto', ...(selected?.status?.() ?? { backend: 'auto', model: remote.model ?? DEFAULT_MEMORY_EMBEDDING_MODEL, state: 'not-run' }), local: local.status?.(), remote: remote.status?.() }),
    async embed(texts, opts) { return (await this.embedWithMetadata!(texts, opts))?.vectors ?? null; },
    async embedWithMetadata(texts, opts = {}) {
      if (selecting) await selecting;
      if (selected) return embedMemory(selected, texts, opts);
      selecting = (async () => {
        for (const candidate of [local, remote]) {
          if (opts.signal?.aborted) return null;
          const result = await embedMemory(candidate, texts, opts);
          if (result) { selected = candidate; return result; }
        }
        return null;
      })();
      try { return await selecting; } finally { selecting = undefined; }
    },
  };
}

/** Project memory consolidation: canonical facts over raw history.
 *
 * Without consolidation the store fills with "Observer uses X", "Observer
 * now uses Y", "Changed from Y to Z" — historically true, retrieval poison.
 * Consolidation clusters near-duplicate same-concept chunks, picks the
 * canonical survivor (highest authority, then newest), boosts it to full
 * authority, and marks the rest superseded (valid_until + superseded_by).
 *
 * History is never deleted: superseded chunks stay in the store with full
 * provenance and remain retrievable, heavily demoted. Deterministic and
 * local — no model calls. An agent-authored canonical summary (via
 * `project_memory_remember` with `supersedes`) always outranks anything
 * produced here; this engine only ratifies, never invents, facts.
 */

import type { MemoryEmbedder } from "./project-memory-index.ts";
import { type ChunkType, type ProjectVectorStore, type StoredChunk } from "./project-vector-store.ts";

export interface MemoryCluster {
  /** Chunk ids, canonical candidate first. */
  ids: string[];
  /** Shared concept bucket that produced the cluster. */
  concept: string;
  /** Pairwise similarity that formed the cluster (0..1). */
  similarity: number;
}

export interface ConsolidateOptions {
  embedder?: MemoryEmbedder;
  /** Cosine threshold for vector clustering (default 0.92). */
  vectorThreshold?: number;
  /** Jaccard threshold for lexical clustering (default 0.5). */
  lexicalThreshold?: number;
  /** Max live chunks to scan (default 2000, newest first). */
  scanLimit?: number;
  /** Only cluster these types (default: all except code/commit/tool_result). */
  types?: ChunkType[];
  /** Report without writing (default true). */
  dryRun?: boolean;
  now?: () => string;
}

export interface ConsolidateReport {
  scanned: number;
  clusters: MemoryCluster[];
  canonicalized: string[];
  superseded: string[];
  dryRun: boolean;
}

const DEFAULT_TYPES: ChunkType[] = [
  "decision",
  "architecture",
  "concept",
  "convention",
  "observation",
  "bug",
  "todo",
  "user_request",
  "session_summary",
  "error",
];

function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? []) {
    const word = raw.replace(/[._-]+$/, "");
    if (word.length >= 3) out.add(word);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Group live chunks into near-duplicate clusters via shared concept buckets. */
export async function findClusters(store: ProjectVectorStore, opts: ConsolidateOptions = {}): Promise<{ clusters: MemoryCluster[]; scanned: number }> {
  const types = new Set(opts.types ?? DEFAULT_TYPES);
  const live = store.listRecent(Math.max(100, Math.min(5000, opts.scanLimit ?? 2000)))
    .filter((chunk) => chunk.valid_until === null && !chunk.superseded_by && types.has(chunk.source_type));
  if (live.length < 2) return { clusters: [], scanned: live.length };

  const buckets = new Map<string, StoredChunk[]>();
  for (const chunk of live) {
    const keys = chunk.concepts.length ? chunk.concepts.slice(0, 4) : [`type:${chunk.source_type}`];
    for (const key of keys) {
      const bucket = buckets.get(key) ?? [];
      bucket.push(chunk);
      buckets.set(key, bucket);
    }
  }

  const vectorThreshold = opts.vectorThreshold ?? 0.92;
  const lexicalThreshold = opts.lexicalThreshold ?? 0.5;
  const termCache = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const clusters: MemoryCluster[] = [];

  // Consolidation reuses indexed vectors. It never uploads the corpus or
  // re-embeds unchanged history, and comparisons remain within one space.
  const vectors = new Map<string, number[]>();
  if (opts.embedder) {
    const allowed = new Set([opts.embedder.id, ...(opts.embedder.candidates ?? []).map(e => e.id)]);
    for (const space of store.embeddingSpaces()) {
      if (!allowed.has(space.id)) continue;
      for (const [id, vector] of store.storedVectors(live.map(c => c.id), space.id)) vectors.set(id, vector);
    }
  }

  for (const [concept, members] of buckets) {
    if (members.length < 2 || members.length > 64) continue;
    const grouped = new Set<string>();
    for (let i = 0; i < members.length; i++) {
      if (grouped.has(members[i].id)) continue;
      const cluster: StoredChunk[] = [members[i]];
      let clusterSimilarity = 1;
      for (let j = i + 1; j < members.length; j++) {
        if (grouped.has(members[j].id)) continue;
        const a = members[i];
        const b = members[j];
        const va = vectors.get(a.id);
        const vb = vectors.get(b.id);
        const semantic = va && vb && a.embedder === b.embedder ? cosine(va, vb) : 0;
        const ta = termCache.get(a.id) ?? terms(`${a.title}\n${a.text}`);
        termCache.set(a.id, ta);
        const tb = termCache.get(b.id) ?? terms(`${b.title}\n${b.text}`);
        termCache.set(b.id, tb);
        const lexical = jaccard(ta, tb);
        // Similar topics are not necessarily duplicate facts. Require some
        // shared wording before semantic proximity can ratify a duplicate.
        if (lexical >= lexicalThreshold || (semantic >= vectorThreshold && lexical >= 0.25)) {
          clusterSimilarity = Math.min(clusterSimilarity, Math.max(semantic, lexical));
          cluster.push(b);
          grouped.add(b.id);
        }
      }
      if (cluster.length > 1) {
        // Canonical first: highest authority, then newest.
        cluster.sort((x, y) => y.authority - x.authority || (y.timestamp < x.timestamp ? -1 : 1));
        const key = cluster.map((c) => c.id).sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        for (const c of cluster) grouped.add(c.id);
        clusters.push({ ids: cluster.map((c) => c.id), concept, similarity: clusterSimilarity });
      }
    }
  }
  return { clusters, scanned: live.length };
}

/**
 * Ratify one canonical chunk per cluster. The canonical keeps its own text
 * (no invented summaries), gains full authority, and records the members it
 * supersedes; members are tombstoned with a backlink. Dry-run by default.
 */
export function consolidate(store: ProjectVectorStore, clusters: MemoryCluster[], opts: ConsolidateOptions = {}): ConsolidateReport {
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const dryRun = opts.dryRun ?? true;
  const report: ConsolidateReport = { scanned: 0, clusters, canonicalized: [], superseded: [], dryRun };
  for (const cluster of clusters) {
    const [canonicalId, ...members] = cluster.ids;
    const canonical = store.getChunk(canonicalId);
    if (!canonical || canonical.valid_until !== null) continue;
    const liveMembers = members
      .map((id) => store.getChunk(id))
      .filter((c): c is StoredChunk => !!c && c.valid_until === null);
    if (!liveMembers.length) continue;
    report.canonicalized.push(canonicalId);
    report.superseded.push(...liveMembers.map((c) => c.id));
    if (dryRun) continue;
    store.setAuthority(canonicalId, 1.0, now);
    store.addSupersedes(canonicalId, liveMembers.map((c) => c.id), now);
    for (const member of liveMembers) store.markSuperseded(member.id, canonicalId, now);
  }
  return report;
}

export function formatConsolidateReport(report: ConsolidateReport): string {
  const mode = report.dryRun ? "DRY RUN — no writes" : "APPLIED";
  const lines = [
    `[project memory consolidation: ${mode}; ${report.scanned} scanned, ${report.clusters.length} clusters, ${report.canonicalized.length} canonical, ${report.superseded.length} superseded]`,
  ];
  report.clusters.forEach((cluster, i) => {
    lines.push(`Cluster ${i + 1} (${cluster.concept}): canonical [${cluster.ids[0]}] supersedes ${cluster.ids.slice(1).map((id) => `[${id}]`).join(", ") || "none"}`);
  });
  if (report.dryRun && report.clusters.length) {
    lines.push("Re-run with dry_run=false to apply, or author a canonical summary via project_memory_remember with supersedes=[...].");
  }
  return lines.join("\n");
}

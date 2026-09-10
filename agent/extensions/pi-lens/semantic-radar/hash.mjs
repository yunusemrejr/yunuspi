// PI_LENS_RADAR_STATE_V1: preserve bounded local fingerprint quality fixes.
// semantic-radar/hash.mjs — MinHash + LSH, zero deps.
// Signature: 64 32-bit hashes via FNV-1a. Jaccard via signature intersection
// (estimate, not exact: ideal independent MinHash has standard error
// sqrt(J*(1-J)/64), up to 0.0625; actual hash correlation can change this).
const SIG_LEN = 64;
const BANDS = 16;
const ROWS = 4; // BANDS*ROWS === SIG_LEN
const MASK = 0xffffffff;
const PRIME = 0x01000193; // 104729

export function fnv1a(str, seed = 0) {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, PRIME) >>> 0;
  }
  return h >>> 0;
}

export function fnv1a16(str, seed = 0) {
  // Full 32-bit ID: the former 8-bit truncation collided within ordinary files.
  return fnv1a(str, seed).toString(16).padStart(8, "0");
}

/**
 * MinHash signature for a feature SET (duplicates irrelevant).
 * Features are strings; hashing is order-independent by construction.
 */
export function minhashSignature(features) {
  const sig = new Array(SIG_LEN).fill(0xffffffff);
  for (const f of features) {
    if (f === null || f === undefined) continue;
    // Two string hashes + avalanche mixing per permutation. (Plain linear
    // h1+i*h2 correlates permutations and degraded tier separation in tests;
    // 64 full string hashes were correct but the build's hot loop.)
    const h1 = fnv1a(f, 1);
    const h2 = fnv1a(f, 2);
    for (let i = 0; i < SIG_LEN; i++) {
      let z = (h1 + Math.imul(i + 1, 0x9e3779b1)) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      z = (z ^ (Math.imul(h2, 0x85ebca6b) >>> 0)) >>> 0;
      z = Math.imul(z ^ (z >>> 16), 0x7feb352d) >>> 0;
      const v = (z ^ (z >>> 15)) >>> 0;
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

/** Jaccard estimate from two signatures (0..1). */
export function jaccard(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let shared = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) shared++;
  return shared / a.length;
}

/** LSH buckets: band index -> {hashrow: bucketKey}. Insert returns bucket keys. */
export function lshBuckets(sig) {
  const out = [];
  for (let b = 0; b < BANDS; b++) {
    const r = b * ROWS;
    // stable bucket key = first row hash + concat of remaining (compact)
    out.push(`${sig[r]}:${sig[r + 1]}:${sig[r + 2]}:${sig[r + 3]}`);
  }
  return out;
}

/**
 * Candidate retrieval from an in-memory inverted bucket table.
 * table: Map<bucketKey, Set<entryId>>. Returns entryId -> bandHits (>=1).
 * Bounded: caller passes maxCandidates.
 */
export function lshCandidates(table, buckets, maxCandidates = 64, excludeId, eligible = () => true) {
  const hits = new Map();
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) return hits;
  // Exclusions must not consume the result cap, but dense excluded buckets
  // also must not turn candidate retrieval into an unbounded scan.
  let visits = 0;
  const maxVisits = Math.min(8192, Math.max(256, maxCandidates * 32));
  for (const bk of buckets) {
    const set = table.get(bk);
    if (!set) continue;
    for (const id of set) {
      if (++visits > maxVisits) return hits;
      if (id === excludeId || !eligible(id)) continue;
      const n = (hits.get(id) ?? 0) + 1;
      hits.set(id, n);
      // Enforce the bound inside a bucket: generated/duplicate-heavy code can
      // put thousands of entries in a single bucket. Stopping between buckets
      // lets both retrieval and clustering degenerate into all-pairs scoring.
      if (hits.size >= maxCandidates) return hits;
    }
  }
  return hits;
}

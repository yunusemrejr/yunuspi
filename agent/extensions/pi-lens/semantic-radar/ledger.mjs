// semantic-radar/ledger.mjs — entropy ledger (append-only NDJSON, concurrent-
// safe: one small line per turn, no read-modify-write race) + concept clusters
// (union-find over LSH-bounded high/lexical pairs — same scorePair doctrine as
// the radar, so one canonical representation across all layers).
import fs from "node:fs";
import path from "node:path";
import { lshBuckets, lshCandidates } from "./hash.mjs";
import { scorePair } from "./index.mjs";

const LEDGER_FILE = "entropy-ledger.ndjson";
const MAX_LINE = 4096;
const MAX_TREND_BYTES = 256 * 1024;
const MAX_TREND_RECORDS = 1000;

export function appendTurn(dataDir, record) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const line = JSON.stringify(record);
    if (Buffer.byteLength(line) + 1 > MAX_LINE) return false; // bounded UTF-8 write including newline
    fs.appendFileSync(path.join(dataDir, LEDGER_FILE), line + "\n");
    return true;
  } catch {
    return false;
  }
}

export function readTrend(dataDir, lastN = 20) {
  if (!Number.isSafeInteger(lastN) || lastN <= 0) return [];
  lastN = Math.min(lastN, MAX_TREND_RECORDS);
  let fd, raw;
  try {
    fd = fs.openSync(path.join(dataDir, LEDGER_FILE), "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_TREND_BYTES);
    // Include the byte preceding the tail, so a complete first line is kept
    // when the cap lands exactly at a line boundary. Discard a partial first
    // line before UTF-8 decoding; a cut multi-byte character cannot leak in.
    const offset = Math.max(0, start - 1);
    const bytes = Buffer.alloc(size - offset);
    let read = 0;
    while (read < bytes.length) {
      const n = fs.readSync(fd, bytes, read, bytes.length - read, offset + read);
      if (!n) break;
      read += n;
    }
    const begin = start > 0 ? bytes.subarray(0, read).indexOf(10) + 1 : 0;
    if (start > 0 && begin === 0) return [];
    const end = bytes.subarray(0, read).lastIndexOf(10);
    if (end < begin) return [];
    raw = bytes.toString("utf8", begin, end);
  } catch { return []; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ } }
  const lines = raw.split("\n");
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < lastN; i--) {
    try {
      const record = JSON.parse(lines[i]);
      if (record && typeof record === "object" && !Array.isArray(record)) out.push(record);
    } catch { /* torn/malformed line: skip */ }
  }
  return out.reverse();
}

// --- clustering -----------------------------------------------------------
class DSU {
  constructor() { this.p = new Map(); }
  find(x) {
    let r = x;
    while (this.p.get(r) !== undefined && this.p.get(r) !== r) r = this.p.get(r);
    if (!this.p.has(x)) this.p.set(x, x);
    while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; }
    return r;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

/**
 * Group index entries into concept clusters via LSH candidates + scorePair
 * (high|lexical only). Bounded: per-entry LSH lookup, never all-pairs.
 * Returns [{members:[{file,fp}], canonical:{file,fp}, usage, breadth}] sorted
 * by breadth desc. canonical = shared-placement + most-called + smallest.
 */
export function buildClusters(index, { maxCandidates = 32 } = {}) {
  index.ensureFresh?.();
  const all = [];
  for (const [file, rec] of Object.entries(index.files)) {
    for (const fp of rec.funcs ?? []) all.push({ file, fp, id: `${file}::${fp.id}` });
  }
  const byBucket = new Map();
  for (const e of all) {
    for (const bk of lshBuckets(e.fp.sig)) {
      let s = byBucket.get(bk);
      if (!s) byBucket.set(bk, (s = new Set()));
      s.add(e.id);
    }
  }
  const dsu = new DSU();
  const byId = new Map();
  for (const e of all) { dsu.find(e.id); byId.set(e.id, e); }
  const seen = new Set();
  for (const e of all) {
    const neigh = lshCandidates(byBucket, lshBuckets(e.fp.sig), maxCandidates, e.id);
    for (const id of neigh.keys()) {
      const pairKey = e.id < id ? e.id + "|" + id : id + "|" + e.id;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const other = byId.get(id);
      if (!other) continue;
      const s = scorePair(e.fp, other.fp);
      if (s.tier === "high" || s.tier === "lexical") dsu.union(e.id, id);
    }
  }
  const groups = new Map();
  for (const e of all) {
    const r = dsu.find(e.id);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(e);
  }
  // usage proxy: how often each fn NAME appears in other fns' call sets
  const callCounts = new Map();
  for (const e of all) for (const c of e.fp.calls ?? []) callCounts.set(c, (callCounts.get(c) ?? 0) + 1);
  const clusters = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    let best = null, bestScore = -1;
    for (const m of members) {
      const usage = callCounts.get(m.fp.name.toLowerCase()) ?? 0;
      const shared = /(^|\/)(lib|shared|common|core|utils?|components?|components\/ui|src\/lib)\//.test(m.file) ? 3 : 0;
      const sc = usage * 2 + shared - Math.min(1, m.fp.skelLen / 100);
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    clusters.push({
      canonical: { file: best.file, name: best.fp.name, startLine: best.fp.startLine },
      breadth: members.length,
      members: members.map((m) => ({ file: m.file, name: m.fp.name, startLine: m.fp.startLine })),
    });
  }
  clusters.sort((a, b) => b.breadth - a.breadth);
  return clusters;
}

/**
 * Turn record for the ledger: divergences introduced/resolved + concept
 * breadth deltas vs the previous snapshot. prevSnapshot: {concept:{breadth}}.
 */
export function turnRecord({ ts = Date.now(), turn = 0, files = 0, locDelta = null, clusters, prevSnapshot, extra = {} }) {
  const snapshot = {};
  for (const c of clusters) snapshot[`${c.canonical.file}::${c.canonical.name}`] = c.breadth;
  const introduced = [], resolved = [], breadthChanges = [];
  for (const [k, v] of Object.entries(snapshot)) {
    const p = prevSnapshot?.[k];
    if (p === undefined) { if (v >= 2) introduced.push({ concept: k, breadth: v }); }
    else if (v > p) breadthChanges.push({ concept: k, from: p, to: v });
  }
  for (const [k, v] of Object.entries(prevSnapshot ?? {})) {
    const n = snapshot[k];
    if (n === undefined) resolved.push({ concept: k, was: v });
    else if (n < v) breadthChanges.push({ concept: k, from: v, to: n });
  }
  return { ts, turn, files, locDelta, introduced, resolved, breadthChanges, snapshot, ...extra };
}

/** Terse one-line trend summary for /lens-drift or turn-end telemetry. */
export function formatLedgerLine(rec) {
  const bits = [];
  if (rec.introduced?.length) bits.push(`+${rec.introduced.length} competing (${rec.introduced.map((i) => i.concept
    ? `${i.concept.split("::").pop()}×${i.breadth}`
    // Incremental turn records carry the observed new function and candidate;
    // full on-demand cluster snapshots carry a concept and breadth instead.
    : `${i.fn?.split("::").pop() ?? "unknown"}→${i.canonical?.split("::").pop() ?? "unknown"}`).join(", ")})`);
  if (rec.resolved?.length) bits.push(`-${rec.resolved.length} resolved`);
  for (const b of rec.breadthChanges ?? []) bits.push(`${b.concept.split("::").pop()} ${b.from}→${b.to}`);
  return bits.join(" · ") || "no entropy change";
}

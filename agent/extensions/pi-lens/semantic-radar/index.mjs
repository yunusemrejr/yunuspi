// semantic-radar/index.mjs — persistent fingerprint index + LSH query +
// multi-signal confidence tiers. No LLM. JSON on disk, content-hash keyed.
import fs from "node:fs";
import path from "node:path";
import { lshBuckets, lshCandidates, jaccard } from "./hash.mjs";
import { rankCandidates } from "./neural-ranker.mjs";

const VERSION = 5; // Versioned rank profiles; old fingerprints rebuild before learned ranking.
const INDEX_FILE = "semantic-radar-index.json";
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_FILES = 20_000;
const MAX_FUNCS_PER_FILE = 2_048;
const MAX_TOTAL_FUNCS = 200_000;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const boundedString = (value, max, nonEmpty = true) => typeof value === "string"
  && value.length <= max && (!nonEmpty || value.length > 0) && !value.includes("\0");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validSignature = value => Array.isArray(value) && value.length === 64
  && value.every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff)
  && value.some(v => v !== 0xffffffff);
const boundedStrings = (value, maxItems, maxLength) => Array.isArray(value)
  && value.length <= maxItems && value.every(v => boundedString(v, maxLength));

// The state file is a cache, so invalid records can be discarded safely. Do
// this before rebuilding LSH buckets: malformed JSON fields must never turn a
// sibling session's cache into an exception or an unbounded memory walk.
function sanitizeRankProfile(value) {
  if (!isObject(value) || value.version !== 1) return undefined;
  const ints = (v, length, max) => Array.isArray(v) && v.length === length
    && v.every(x => Number.isInteger(x) && x >= 0 && x <= max);
  if (!ints(value.tokenSig, 32, 0xffffffff) || !value.tokenSig.some(x => x !== 0xffffffff)
      || !Array.isArray(value.literalHashes) || value.literalHashes.length > 64
      || !value.literalHashes.every(x => Number.isInteger(x) && x >= 0 && x <= 0xffffffff)
      || !Array.isArray(value.operatorHashes) || value.operatorHashes.length > 64
      || !value.operatorHashes.every(x => Number.isInteger(x) && x >= 0 && x <= 0xffffffff)
      || ![value.canonicalHash, value.literalSequenceHash, value.operatorSequenceHash].every(validHash)
      || !Number.isSafeInteger(value.tokenCount) || value.tokenCount < 8 || value.tokenCount > 2_048
      || !Number.isSafeInteger(value.identifierCount) || value.identifierCount < 0 || value.identifierCount > value.tokenCount
      || !Number.isSafeInteger(value.nested) || value.nested < 0 || value.nested > 8) return undefined;
  return {
    version: 1,
    tokenSig: [...value.tokenSig], canonicalHash: value.canonicalHash,
    literalHashes: [...value.literalHashes], operatorHashes: [...value.operatorHashes],
    literalSequenceHash: value.literalSequenceHash, operatorSequenceHash: value.operatorSequenceHash,
    tokenCount: value.tokenCount, identifierCount: value.identifierCount, nested: value.nested,
  };
}

function sanitizeFingerprint(value) {
  if (!isObject(value) || !boundedString(value.id, 256) || !boundedString(value.name, 256)
      || !validSignature(value.sig) || !boundedStrings(value.calls, 256, 512)
      || !boundedStrings(value.props, 256, 512) || !boundedString(value.retShape, 32)
      || !Number.isSafeInteger(value.skelLen) || value.skelLen < 0 || value.skelLen > 10_000_000
      || !Number.isSafeInteger(value.arity) || value.arity < 0 || value.arity > 10_000
      || (value.startLine !== undefined && (!Number.isSafeInteger(value.startLine) || value.startLine < 1))
      || (value.endLine !== undefined && (!Number.isSafeInteger(value.endLine) || value.endLine < 1))
      || (value.startLine !== undefined && value.endLine !== undefined && value.endLine < value.startLine)
      || (value.lexicalHash !== undefined && !validHash(value.lexicalHash))) return null;
  const profile = sanitizeRankProfile(value.rankProfile);
  if (value.rankProfile !== undefined && value.rankProfile !== null && !profile) return null;
  const out = {
    id: value.id, name: value.name, startLine: value.startLine, endLine: value.endLine,
    skelLen: value.skelLen, calls: [...value.calls], props: [...value.props],
    retShape: value.retShape, arity: value.arity, sig: [...value.sig],
  };
  if (value.lexicalHash !== undefined) out.lexicalHash = value.lexicalHash;
  if (profile) out.rankProfile = profile;
  return out;
}

function safeRelativePath(rel) {
  if (!boundedString(rel, 512) || path.isAbsolute(rel) || /^[a-z]:[\\/]/i.test(rel)) return false;
  const normalized = rel.replaceAll("\\", "/");
  if (normalized !== rel || normalized.split("/").some(part => !part || part === "." || part === "..")) return false;
  return !["__proto__", "constructor", "prototype"].includes(normalized);
}

function sanitizeFiles(value) {
  if (!isObject(value)) return null;
  const names = Object.keys(value);
  if (names.length > MAX_INDEX_FILES) return null;
  const out = {};
  let totalFuncs = 0;
  for (const rel of names) {
    if (!safeRelativePath(rel)) continue;
    const record = value[rel];
    if (!isObject(record) || !boundedString(record.contentHash, 128)
        || typeof record.mtimeMs !== "number" || !Number.isFinite(record.mtimeMs) || record.mtimeMs < 0
        || (record.statKey !== undefined && !boundedString(record.statKey, 256))) continue;
    if (!Array.isArray(record.funcs) || record.funcs.length > MAX_FUNCS_PER_FILE) continue;
    const funcs = record.funcs.map(sanitizeFingerprint);
    // Rebuild the whole file when any function is damaged. Keeping a partial
    // record with the same statKey would make the incremental scanner believe
    // the source was already analysed and preserve the corruption forever.
    if (funcs.some(fp => !fp)) continue;
    if (totalFuncs + funcs.length > MAX_TOTAL_FUNCS) break;
    totalFuncs += funcs.length;
    out[rel] = {
      contentHash: record.contentHash, mtimeMs: record.mtimeMs,
      funcs, ...(record.statKey === undefined ? {} : {statKey: record.statKey}),
    };
  }
  return out;
}

function setOverlap(a, b) {
  if (!a?.length || !b?.length) return { ov: 0, n: 0 };
  const bs = new Set(b);
  const as = new Set(a);
  let n = 0;
  for (const x of as) if (bs.has(x)) n++;
  return { ov: n / Math.min(as.size, bs.size), n };
}

// Collection/array plumbing that appears in almost every function — never
// counts as a domain signal on its own (task: "two functions both containing
// loops are not necessarily duplicates").
const GENERIC_PROPS = new Set(["length", "push", "pop", "map", "filter", "foreach", "reduce", "slice", "splice", "indexof", "includes", "keys", "values", "entries", "tostring", "then", "catch", "finally", "split", "join", "trim", "test", "replace", "name", "constructor", "prototype"]);
function domainProps(fp) {
  return (fp.props ?? []).filter((p) => !GENERIC_PROPS.has(p));
}

/**
 * Confidence tiers (task doctrine: multiple INDEPENDENT signals for strong
 * warnings; similar shape alone is never enough).
 *  - lexical:   identical function source text (including names and order)
 *  - high:      jacc>=0.5 + size-compatible + (calls&props | props&shape | calls&shape) agree
 *  - probable:  jacc>=0.4 + at least one domain signal (calls or props) >= 0.3
 *  - weak:      jacc>=0.3 (ledger telemetry only, never a user-facing warning)
 */
export function scorePair(a, b) {
  const valid = x => Array.isArray(x) && x.length === 64 && x.every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff) && x.some(v => v !== 0xffffffff);
  if (!valid(a?.sig) || !valid(b?.sig)) return {jaccard:0, callOverlap:0, propOverlap:0, shapeMatch:false, sizeOk:false, tier:null, evidence:[]};
  const j = jaccard(a.sig, b.sig);
  const co = setOverlap(a.calls, b.calls);
  const po = setOverlap(domainProps(a), domainProps(b));
  const callOv = co.ov, propOv = po.ov;
  const shapeMatch = a.retShape === b.retShape && a.arity === b.arity;
  const ratio = a.skelLen / Math.max(1, b.skelLen);
  const sizeOk = ratio >= 0.25 && ratio <= 4;
  const evidence = [];
  if (callOv >= 0.5 && co.n >= 2) evidence.push(`calls overlap ${(callOv * 100) | 0}%`);
  if (propOv >= 0.5 && po.n >= 2) evidence.push(`entities overlap ${(propOv * 100) | 0}%`);
  if (shapeMatch) evidence.push(`same return/arity (${a.retShape}/${a.arity})`);
  let tier = null;
  const domainAgree = (propOv >= 0.5 && po.n >= 1 && shapeMatch) || (callOv >= 0.5 && co.n >= 2) || (co.n >= 1 && shapeMatch);
  const exactSource = typeof a.lexicalHash === "string" && /^[a-f0-9]{64}$/.test(a.lexicalHash)
    && a.lexicalHash === b.lexicalHash;
  if (sizeOk && exactSource) tier = "lexical";
  else if (j >= 0.5 && sizeOk && domainAgree) tier = "high";
  else if (j >= 0.4 && sizeOk && domainAgree) tier = "probable";
  else if (j >= 0.3) tier = "weak";
  return { jaccard: j, callOverlap: callOv, propOverlap: propOv, shapeMatch, sizeOk, tier, evidence };
}

export class SemanticIndex {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.files = {}; // relPath -> {contentHash, mtimeMs, funcs:[fp]}
    this.removed = new Set(); // tombstones this session — must survive save-merge
    this.entries = new Map(); // entryId -> {file, fp}
    this.table = new Map(); // bucketKey -> Set(entryId)
    this.#dirty = true; // LSH table rebuilt lazily (query-time), never per-upsert
    this.loadedAt = 0;
    this.#lastSaveAt = 0;
    this.#saveTimer = null;
  }
  #lastSaveAt = 0;
  #saveTimer = null;

  static async load(dataDir) {
    const idx = new SemanticIndex(dataDir);
    try {
      const p = path.join(dataDir, INDEX_FILE);
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return idx;
        const serialized = fs.readFileSync(p, "utf8");
        if (Buffer.byteLength(serialized, "utf8") > MAX_INDEX_BYTES) return idx;
        const raw = JSON.parse(serialized);
        const files = raw?.version === VERSION ? sanitizeFiles(raw.files) : null;
        if (files) {
          idx.files = files;
          idx.loadedAt = Date.parse(raw.updatedAt ?? "") || 0;
          idx.#dirty = true; // rebuilt lazily on first query
        }
      }
    } catch { /* corrupt/absent -> cold start; next save reconciles */ }
    return idx;
  }

  #dirty = false;
  #rebuild() {
    this.entries.clear();
    this.table.clear();
    for (const [file, rec] of Object.entries(this.files)) {
      for (const fp of rec.funcs ?? []) {
        const id = `${file}::${fp.id}`;
        this.entries.set(id, { file, fp });
        for (const bk of lshBuckets(fp.sig)) {
          let s = this.table.get(bk);
          if (!s) this.table.set(bk, (s = new Set()));
          s.add(id);
        }
      }
    }
    this.#dirty = false;
  }
  #ensureFresh() { if (this.#dirty) this.#rebuild(); }

  upsertFile(rel, contentHash, mtimeMs, funcs, statKey) {
    // PI_LENS_RADAR_STATE_V1: a recreated file is no longer a deletion.
    this.removed.delete(rel);
    const prev = this.files[rel];
    if (prev?.contentHash === contentHash) {
      // Content is unchanged; refresh the cheap stat evidence in memory.
      if (statKey !== undefined) prev.statKey = statKey;
      prev.mtimeMs = mtimeMs;
      return false;
    }
    this.files[rel] = { contentHash, mtimeMs, funcs, statKey };
    this.#dirty = true; // O(1) — table rebuilt once at first query, not per file
    return true;
  }

  removeFile(rel) {
    if (!this.files[rel]) return false;
    delete this.files[rel];
    this.removed.add(rel);
    this.#dirty = true;
    return true;
  }

  /** Bounded candidate query: LSH recall -> multi-signal scoring. */
  query(fp, { max = 20, excludeFile = null, minTier = "weak" } = {}) {
    const order = { lexical: 3, high: 2, probable: 1, weak: 0 };
    if (!validSignature(fp?.sig) || !Number.isSafeInteger(max) || max <= 0 || !Object.hasOwn(order, minTier)) return [];
    max = Math.min(max, 256);
    this.#ensureFresh();
    const hits = lshCandidates(this.table, lshBuckets(fp.sig), max * 4, undefined,
      id => this.entries.get(id)?.file !== excludeFile);
    const out = [];
    for (const [id, bandHits] of hits) {
      const e = this.entries.get(id);
      if (!e || e.file === excludeFile) continue;
      const s = scorePair(fp, e.fp);
      if (!s.tier || order[s.tier] < order[minTier]) continue;
      out.push({ file: e.file, ...e.fp, ...s });
    }
    return rankCandidates(fp, out).slice(0, max);
  }

  stats() {
    let funcs = 0;
    for (const rec of Object.values(this.files)) funcs += rec.funcs?.length ?? 0;
    return { files: Object.keys(this.files).length, funcs };
  }

  /**
   * Concurrency-safe save: re-read disk, merge per-file by (mtimeMs, contentHash)
   * — newer disk state wins, so a sibling session's fresher analysis is never
   * clobbered by ours. Atomic tmp+rename.
   */
  /**
   * Debounced save: coalesce bursts (turn-end upsert + background full build)
   * into at most one write per minIntervalMs. The 9.4MB JSON write must NOT
   * run on every turn (oracle §6). unref'd so it never keeps the process alive.
   */
  scheduleSave(minIntervalMs = 5000) {
    const now = Date.now();
    const since = now - this.#lastSaveAt;
    if (this.#lastSaveAt && since < minIntervalMs) {
      if (!this.#saveTimer) {
        this.#saveTimer = setTimeout(() => {
          this.#saveTimer = null;
          try { this.save(); }
          catch (error) {
            // A best-effort cache flush must never become an uncaught timer
            // exception in the host. Keep live entries and allow a later retry.
            this.#lastSaveAt = 0;
            console.error("[semantic-radar] deferred save failed:", error?.code ?? "write-error");
          }
        }, minIntervalMs - since);
        this.#saveTimer.unref?.();
      }
      return;
    }
    this.save();
  }

  save() {
    this.#lastSaveAt = Date.now();
    fs.mkdirSync(this.dataDir, { recursive: true });
    const p = path.join(this.dataDir, INDEX_FILE);
    try {
      if (fs.existsSync(p)) {
        const diskStat = fs.statSync(p);
        if (diskStat.isFile() && diskStat.size <= MAX_INDEX_BYTES) {
          const serialized = fs.readFileSync(p, "utf8");
          if (Buffer.byteLength(serialized, "utf8") <= MAX_INDEX_BYTES) {
            const raw = JSON.parse(serialized);
            const diskFiles = raw.version === VERSION ? sanitizeFiles(raw.files) : null;
            if (diskFiles) {
              for (const [rel, disk] of Object.entries(diskFiles)) {
            if (this.removed.has(rel)) continue; // our deletion wins (sweep re-derives it anyway)
            const mine = this.files[rel];
            if (!mine || (disk.mtimeMs ?? 0) > (mine.mtimeMs ?? 0)) {
              this.files[rel] = disk;
              this.#dirty = true; // queries must see merged sibling entries
            }
              }
            }
          }
        }
      }
    } catch { /* keep ours on unreadable disk state */ }
    const tmp = p + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, updatedAt: new Date().toISOString(), files: this.files }));
    fs.renameSync(tmp, p);
  }
}

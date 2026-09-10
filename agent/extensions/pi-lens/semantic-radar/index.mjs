// semantic-radar/index.mjs — persistent fingerprint index + LSH query +
// multi-signal confidence tiers. No LLM. JSON on disk, content-hash keyed.
import fs from "node:fs";
import path from "node:path";
import { lshBuckets, lshCandidates, jaccard } from "./hash.mjs";
import { rankCandidates } from "./neural-ranker.mjs";

const VERSION = 5; // Versioned rank profiles; old fingerprints rebuild before learned ranking.
const INDEX_FILE = "semantic-radar-index.json";

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
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        if (raw.version === VERSION) {
          idx.files = raw.files ?? {};
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
    this.#ensureFresh();
    const order = { lexical: 3, high: 2, probable: 1, weak: 0 };
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
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        if (raw.version === VERSION && raw.files) {
          for (const [rel, disk] of Object.entries(raw.files)) {
            if (this.removed.has(rel)) continue; // our deletion wins (sweep re-derives it anyway)
            const mine = this.files[rel];
            if (!mine || (disk.mtimeMs ?? 0) > (mine.mtimeMs ?? 0)) {
              this.files[rel] = disk;
              this.#dirty = true; // queries must see merged sibling entries
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

// semantic-radar/radar.mjs — facade: repo index build, incremental update,
// divergence query. Used standalone (tests/bench) and by the pi-lens patch.
import fs from "node:fs";
import path from "node:path";
import { analyzeFile } from "./extract.mjs";
import { SemanticIndex, scorePair } from "./index.mjs";

const DEFAULT_IGNORE = /(^|[/\\])(node_modules|dist|build|vendor|\.git|\.pi-lens|backups|grammars|coverage|__snapshots__|fixtures?[/\\])/;
// Test/bench files are excluded from BOTH index and diff queries by default:
// each test file is self-contained by design and legitimately re-implements
// small helpers (check(), read()) — flagging those is the "boilerplate as
// architecture duplication" failure the task forbids. Mirrors pi-lens's
// existing skipTestFiles doctrine in the ast-grep runner.
const TEST_FILE_RE = /(^|[/\\])(bench|tests?|__tests__|snapshots?)[/\\]|[-.](test|spec|bench)\.[cm]?[jt]sx?$|[-_]test\.[cm]?[jt]s$/;
export function isTestFile(p) { return TEST_FILE_RE.test(p); }
const EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".py"]);
const fileStamp = st => `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;

// PI_LENS_RADAR_STATE_V1: incremental paths obey the same scope as full scans.
export function sourcePath(cwd, file, ignore = DEFAULT_IGNORE) {
  const abs = path.resolve(cwd, file);
  const rel = path.relative(path.resolve(cwd), abs);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
  return EXTENSIONS.has(path.extname(abs)) && !ignore.test(rel) && !isTestFile(rel) ? abs : null;
}

function* walk(dir, ignore, scan) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { scan.complete = false; return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!ignore.test(p)) yield* walk(p, ignore, scan); }
    else if (e.isFile() && EXTENSIONS.has(path.extname(e.name)) && !ignore.test(p) && !isTestFile(p)) yield p;
  }
}

export async function loadIndex(dataDir) { return SemanticIndex.load(dataDir); }

// One in-memory index per dataDir per process; reload only when the on-disk
// file is newer than our load (a sibling session's save). Turn-end diffs then
// cost parse-of-changed-files + query, not parse-of-whole-index.
const _indexCache = new Map();
export function resetIndexCache() { _indexCache.clear(); }
async function cachedIndex(dataDir) {
  const p = path.join(dataDir, "semantic-radar-index.json");
  let st = null;
  try { st = fs.statSync(p); } catch { /* cold */ }
  let hit = _indexCache.get(dataDir);
  if (hit && ((st && st.mtimeMs <= hit.diskMtimeMs) || (!st && hit.diskMtimeMs === 0))) return hit.index;
  const idx = await SemanticIndex.load(dataDir);
  _indexCache.set(dataDir, { index: idx, diskMtimeMs: st ? st.mtimeMs : 0 });
  return idx;
}

/** Full or incremental build. changedFiles (abs paths) limits scope when given. */
export async function buildIndex({ cwd, dataDir, changedFiles = null, maxFiles = 20000, ignore = DEFAULT_IGNORE, onProgress = null }) {
  const t0 = Date.now();
  const index = await cachedIndex(dataDir);
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) throw new Error("maxFiles must be a nonnegative integer");
  const scan = { complete: true };
  const candidates = changedFiles
    ? [...new Set(changedFiles.map((f) => sourcePath(cwd, f, ignore)).filter(Boolean))]
    : walk(cwd, ignore, scan);
  const files = [];
  for (const abs of candidates) {
    if (files.length >= maxFiles) { scan.complete = false; break; }
    files.push(abs);
  }
  let updated = 0, skipped = 0, removed = 0;
  const seenRel = changedFiles ? null : new Set();
  for (const abs of files) {
    const rel = path.relative(cwd, abs).replace(/\\/g, "/");
    if (seenRel) seenRel.add(rel);
    let st;
    try { st = fs.statSync(abs); } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") removed += Number(index.removeFile(rel));
      else skipped++;
      continue;
    }
    if (!st.isFile() || st.size > 2_000_000) { removed += Number(index.removeFile(rel)); skipped++; continue; }
    const statKey = fileStamp(st);
    // Full warm scans stay O(stat). Explicitly changed paths must be read:
    // generators/restores may preserve both source size and timestamps.
    if (!changedFiles && index.files[rel]?.statKey === statKey) continue;
    const res = await analyzeFile(abs);
    if (!res.supported || res.error) { removed += Number(index.removeFile(rel)); skipped++; continue; }
    if (index.upsertFile(rel, res.contentHash, st.mtimeMs, res.funcs.map((f) => ({ ...f, feats: undefined })), statKey)) updated++;
  }
  // Full-build sweep: a moved/deleted file's stale entries must not linger
  // (else a rename reads as "new competing implementation" — task: moved fn
  // without semantic change must NOT count as new entropy).
  if (seenRel && scan.complete) {
    for (const rel of Object.keys(index.files)) if (!seenRel.has(rel)) removed += Number(index.removeFile(rel));
  }
  // Only persist when this pass actually changed state; debounce the write
  // (9.4MB JSON must not hit the turn path every turn — oracle §6).
  if (updated > 0 || removed > 0) index.scheduleSave(5000);
  const hit = _indexCache.get(dataDir);
  if (hit && (updated > 0 || removed > 0)) {
    try { hit.diskMtimeMs = fs.statSync(path.join(dataDir, "semantic-radar-index.json")).mtimeMs; } catch { /* pending first save */ }
  }
  const stats = { ...index.stats(), updated, removed, skipped, truncated: !scan.complete, filesScanned: files.length, ms: Date.now() - t0 };
  onProgress?.(stats);
  return { index, stats };
}

/**
 * Diff-scoped divergence check: for each function in the given (changed) files,
 * query the index for competing implementations elsewhere. Returns candidates
 * grouped by new function, tiers filtered to user-facing (high/probable).
 */
export async function findDivergences({ cwd, dataDir, changedFiles, minTier = "probable", max = 5 }) {
  const index = await cachedIndex(dataDir);
  const order = { lexical: 3, high: 2, probable: 1, weak: 0 };
  const results = [];
  const verified = new Map();
  let removed = 0;
  for (const abs of new Set(changedFiles.map((f) => sourcePath(cwd, f)).filter(Boolean))) {
    const rel = path.relative(cwd, abs).replace(/\\/g, "/");
    const res = await analyzeFile(abs);
    if (!res.supported) continue;
    for (const fp of res.funcs) {
      const cands = index.query({ ...fp, feats: undefined }, { excludeFile: rel, max, minTier });
      for (const c of cands) {
        if (!verified.has(c.file)) {
          let fresh = false;
          const candidatePath = sourcePath(cwd, c.file);
          if (candidatePath) {
            try {
              const st = fs.statSync(candidatePath);
              fresh = index.files[c.file]?.statKey === fileStamp(st);
            } catch (error) {
              if (error.code === "ENOENT" || error.code === "ENOTDIR") removed += Number(index.removeFile(c.file));
            }
          }
          verified.set(c.file, fresh);
        }
        if (verified.get(c.file) && order[c.tier] >= order[minTier]) results.push({ newFile: rel, newFn: fp.name, newLine: fp.startLine, ...c });
      }
    }
  }
  if (removed > 0) index.scheduleSave(5000);
  return results;
}

export { scorePair };

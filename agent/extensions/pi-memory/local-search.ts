/** Built-in memory search. BM25 over memory blocks (paragraphs, list items and
 * headings with their section title) with light stemming, fuzzy expansion for
 * misspelled or inflected terms, a phrase bonus and a recency prior for daily
 * logs. When the local Needle3 worker is already healthy, semantic and deep
 * modes rerank the lexical head by reciprocal-rank fusion. No binaries,
 * downloads or provider calls: searching earlier sessions works everywhere.
 * Reads only the files it is given, within byte and file budgets. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export interface MemoryBlock { file: string; line: number; heading: string; text: string; mtimeMs: number; daily: boolean; }
export interface MemoryHit { block: MemoryBlock; score: number; matched: string[]; }

const STOP = new Set("a an and are as at be but by for from has have i in into is it its of on or that the this to was were will with we you your our not no do does did can could should would".split(" "));
const REDACT = /(?:sk-(?:ant-|proj-)?|ghp_|gho_|github_pat_|glpat-|xox[abprs]-|AKIA)[A-Za-z0-9_-]{12,}|-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----|\b[A-Za-z0-9+/_-]{48,}={0,2}/g;

/** Words, #tags and [[links]]; plural/verb endings trimmed on longer words. */
export function memoryTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.normalize("NFKC").toLowerCase().match(/#?[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? []) {
    const word = raw.replace(/[._-]+$/, "");
    if (word.length < 2 || STOP.has(word)) continue;
    out.push(stem(word));
  }
  return out;
}
function stem(word: string): string {
  if (word.length <= 4 || /\d/.test(word) || word.startsWith("#")) return word;
  if (word.endsWith("ies") && word.length > 5) return word.slice(0, -3) + "y";
  if (word.endsWith("ing") && word.length > 6) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 5) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 5 && /(?:ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return a === b;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Split Markdown into blocks at blank lines, headings and top-level list
 * items, remembering the nearest heading. */
export function splitBlocks(file: string, text: string, mtimeMs: number, daily: boolean): MemoryBlock[] {
  const blocks: MemoryBlock[] = [];
  let heading = "", lines: string[] = [], first = 1;
  const flush = () => {
    const body = lines.join("\n").trim();
    if (body.length >= 12) blocks.push({ file, line: first, heading, text: body.slice(0, 2000), mtimeMs, daily });
    lines = [];
  };
  text.split("\n").forEach((line, index) => {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); heading = h[2].replace(/<!--.*?-->/g, "").trim().slice(0, 120); return; }
    if (!line.trim() || /^\s{0,1}[-*+]\s|^\s{0,1}\d+[.)]\s/.test(line)) flush();
    if (!line.trim() || /^<!--.*-->$/.test(line.trim())) return;
    if (!lines.length) first = index + 1;
    lines.push(line);
  });
  flush();
  return blocks;
}

/** Read memory files safely: regular non-symlink files only, newest first,
 * within file and byte budgets. */
export async function readMemoryBlocks(files: Array<{ file: string; daily: boolean }>, budget = { files: 400, bytes: 12 * 1024 * 1024, fileBytes: 1024 * 1024 }): Promise<{ blocks: MemoryBlock[]; files: number; truncated: boolean }> {
  const blocks: MemoryBlock[] = [];
  let bytes = 0, read = 0, truncated = false;
  for (const { file, daily } of files) {
    if (read >= budget.files || bytes >= budget.bytes) { truncated = true; break; }
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const size = Math.min(stat.size, budget.fileBytes), buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, Math.max(0, stat.size - size));
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        if (text.includes("\0")) continue;
        bytes += bytesRead; read++;
        blocks.push(...splitBlocks(file, text, stat.mtimeMs, daily));
      } finally { await handle.close(); }
    } catch { /* unreadable memory files are skipped */ }
  }
  return { blocks, files: read, truncated };
}

/** BM25 (k1 1.2, b 0.75) with fuzzy term expansion, phrase bonus and a
 * recency prior for daily logs (half-life 14 days, at most +30%). */
export function rankBlocks(blocks: MemoryBlock[], query: string, options: { limit?: number; now?: number } = {}): MemoryHit[] {
  const limit = options.limit ?? 5, now = options.now ?? Date.now();
  const queryTerms = [...new Set(memoryTerms(query))];
  if (!queryTerms.length || !blocks.length) return [];
  const docs = blocks.map(block => { const terms = memoryTerms(`${block.heading} ${block.text}`); const tf = new Map<string, number>(); for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1); return { block, tf, length: terms.length }; });
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const n = docs.length, avg = docs.reduce((sum, doc) => sum + doc.length, 0) / n;
  // Terms absent from the corpus borrow close vocabulary: one edit away
  // (typos) or a shared prefix of five or more characters (inflections).
  const expanded: Array<{ term: string; weight: number; from: string }> = [];
  for (const term of queryTerms) {
    if (df.has(term)) { expanded.push({ term, weight: 1, from: term }); continue; }
    let found = 0;
    for (const candidate of df.keys()) {
      if (found >= 4) break;
      if (term.length >= 5 && withinOneEdit(term, candidate)) { expanded.push({ term: candidate, weight: 0.7, from: term }); found++; }
      // A stem contained in the query term ("stag" in "stagin") or sharing
      // five leading characters with it.
      else if (candidate.length >= 4 && term.length >= 5 && term.startsWith(candidate) && candidate.length / term.length >= 0.6) { expanded.push({ term: candidate, weight: 0.6, from: term }); found++; }
      else if (term.length >= 5 && candidate.length >= 5 && (candidate.startsWith(term.slice(0, 5)) && term.startsWith(candidate.slice(0, 5)))) { expanded.push({ term: candidate, weight: 0.5, from: term }); found++; }
    }
  }
  const phrase = query.toLowerCase().replace(/\s+/g, " ").trim();
  const hits: MemoryHit[] = [];
  for (const doc of docs) {
    let score = 0;
    const matched = new Set<string>();
    for (const { term, weight, from } of expanded) {
      const f = doc.tf.get(term);
      if (!f) continue;
      const d = df.get(term)!, idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += weight * idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * doc.length / avg));
      matched.add(from);
    }
    if (!score) continue;
    if (phrase.length >= 6 && phrase.includes(" ") && doc.block.text.toLowerCase().replace(/\s+/g, " ").includes(phrase)) score += 2;
    // Covering more of the query beats repeating one term.
    score *= 0.6 + 0.4 * matched.size / queryTerms.length;
    if (doc.block.daily) score *= 1 + 0.3 * 0.5 ** (Math.max(0, now - doc.block.mtimeMs) / 86_400_000 / 14);
    hits.push({ block: doc.block, score, matched: [...matched] });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export type Reranker = (query: string, candidates: Array<{ id: string; text: string }>) => Promise<string[] | undefined>;

/** Search, optionally reranking the lexical head semantically. The reranker
 * returns candidate ids best first, or undefined when unavailable. */
export async function searchMemory(files: Array<{ file: string; daily: boolean }>, query: string, options: { limit?: number; mode?: string; rerank?: Reranker; now?: number } = {}) {
  const limit = Math.max(1, Math.min(25, options.limit ?? 5));
  const { blocks, files: count, truncated } = await readMemoryBlocks(files);
  const head = rankBlocks(blocks, query, { limit: Math.max(limit, options.mode === "keyword" ? limit : 24), now: options.now });
  let results = head, reranked = false;
  if ((options.mode === "semantic" || options.mode === "deep") && options.rerank && head.length > 1) {
    const order = await options.rerank(query, head.map((hit, i) => ({ id: String(i), text: `${hit.block.heading}\n${hit.block.text}`.slice(0, 800) }))).catch(() => undefined);
    if (order?.length) {
      const semantic = new Map(order.map((id, rank) => [Number(id), rank]));
      results = head.map((hit, i) => ({ hit, fused: 1 / (60 + i) + 1 / (60 + (semantic.get(i) ?? head.length)) }))
        .sort((a, b) => b.fused - a.fused).map(row => row.hit);
      reranked = true;
    }
  }
  return { results: results.slice(0, limit), blocks: blocks.length, files: count, truncated, reranked };
}

export function formatHits(hits: MemoryHit[], home = process.env.HOME ?? ""): string {
  return hits.map((hit, i) => {
    const file = home && hit.block.file.startsWith(home) ? "~" + hit.block.file.slice(home.length) : hit.block.file;
    const text = hit.block.text.replace(REDACT, "[redacted]");
    return [`### Result ${i + 1}`, `**File:** ${file}:${hit.block.line}${hit.block.heading ? ` (${hit.block.heading})` : ""}`, `**Score:** ${Math.round(hit.score * 100) / 100} · matched ${hit.matched.join(", ")}`, "", text].join("\n");
  }).join("\n\n---\n\n");
}

/** Memory files for a search scope: global memory, scratchpad, the project's
 * memory and daily logs (newest first); "all" adds every project's logs and
 * the legacy flat daily logs. */
export async function memorySearchFiles(paths: { memory: string; scratchpad: string; project: string; projectDaily: string; dailyRoot: string }, scope: "project" | "all" = "project"): Promise<Array<{ file: string; daily: boolean }>> {
  const out: Array<{ file: string; daily: boolean }> = [{ file: paths.memory, daily: false }, { file: paths.project, daily: false }, { file: paths.scratchpad, daily: false }];
  const logs = async (dir: string) => (await fs.readdir(dir).catch(() => [] as string[])).filter(name => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(name)).sort().reverse().map(name => ({ file: path.join(dir, name), daily: true }));
  out.push(...(await logs(paths.projectDaily)).slice(0, 240));
  if (scope === "all") {
    out.push(...(await logs(paths.dailyRoot)).slice(0, 120));
    for (const entry of await fs.readdir(paths.dailyRoot, { withFileTypes: true }).catch(() => [])) {
      const dir = path.join(paths.dailyRoot, entry.name);
      if (entry.isDirectory() && dir !== paths.projectDaily) out.push(...(await logs(dir)).slice(0, 60));
    }
  }
  return out;
}

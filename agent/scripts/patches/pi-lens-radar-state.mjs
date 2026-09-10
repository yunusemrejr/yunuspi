// Preserve bounded semantic-radar scans and coherent index state across updates.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
export const marker = "PI_LENS_RADAR_STATE_V1";
export const changes = {
  "radar.mjs": [
    [
      "function* walk(dir, ignore) {",
      `// ${marker}: incremental paths obey the same scope as full scans.
export function sourcePath(cwd, file, ignore = DEFAULT_IGNORE) {
  const abs = path.resolve(cwd, file);
  const rel = path.relative(path.resolve(cwd), abs);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
  return EXTENSIONS.has(path.extname(abs)) && !ignore.test(rel) && !isTestFile(rel) ? abs : null;
}

function* walk(dir, ignore, scan) {`,
    ],
    [
      "  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }",
      "  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { scan.complete = false; return; }",
    ],
    ["yield* walk(p, ignore)", "yield* walk(p, ignore, scan)"],
    [
      "  if (hit && st && st.mtimeMs <= hit.diskMtimeMs) return hit.index;",
      "  if (hit && ((st && st.mtimeMs <= hit.diskMtimeMs) || (!st && hit.diskMtimeMs === 0))) return hit.index;",
    ],
    [
      `  const files = changedFiles
    ? changedFiles.map((f) => path.resolve(cwd, f)).filter((f) => !isTestFile(f))
    : [...walk(cwd, ignore)].slice(0, maxFiles);
  let updated = 0, skipped = 0;`,
      `  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) throw new Error("maxFiles must be a nonnegative integer");
  const scan = { complete: true };
  const candidates = changedFiles
    ? [...new Set(changedFiles.map((f) => sourcePath(cwd, f, ignore)).filter(Boolean))]
    : walk(cwd, ignore, scan);
  const files = [];
  for (const abs of candidates) {
    if (files.length >= maxFiles) { scan.complete = false; break; }
    files.push(abs);
  }
  let updated = 0, skipped = 0, removed = 0;`,
    ],
    [
      "    try { st = fs.statSync(abs); } catch { index.removeFile(rel); continue; }\n    if (st.size > 2_000_000) { skipped++; continue; }",
      '    try { st = fs.statSync(abs); } catch (error) {\n      if (error.code === "ENOENT" || error.code === "ENOTDIR") removed += Number(index.removeFile(rel));\n      else skipped++;\n      continue;\n    }\n    if (!st.isFile() || st.size > 2_000_000) { removed += Number(index.removeFile(rel)); skipped++; continue; }',
    ],
    [
      "    if (!res.supported || res.error) { skipped++; continue; }",
      "    if (!res.supported || res.error) { removed += Number(index.removeFile(rel)); skipped++; continue; }",
    ],
    [
      `  if (seenRel && seenRel.size === files.length) {
    for (const rel of Object.keys(index.files)) if (!seenRel.has(rel)) index.removeFile(rel);
  }`,
      `  if (seenRel && scan.complete) {
    for (const rel of Object.keys(index.files)) if (!seenRel.has(rel)) removed += Number(index.removeFile(rel));
  }`,
    ],
    [
      `  if (updated > 0 || (seenRel && seenRel.size !== files.length)) index.scheduleSave(5000);
  const hit = _indexCache.get(dataDir);
  if (hit && updated > 0) hit.diskMtimeMs = Date.now(); // our write is reflected in-memory; reload only on sibling saves
  const stats = { ...index.stats(), updated, skipped, filesScanned: files.length, ms: Date.now() - t0 };`,
      `  if (updated > 0 || removed > 0) index.scheduleSave(5000);
  const hit = _indexCache.get(dataDir);
  if (hit && (updated > 0 || removed > 0)) {
    try { hit.diskMtimeMs = fs.statSync(path.join(dataDir, "semantic-radar-index.json")).mtimeMs; } catch { /* pending first save */ }
  }
  const stats = { ...index.stats(), updated, removed, skipped, truncated: !scan.complete, filesScanned: files.length, ms: Date.now() - t0 };`,
    ],
    [
      "  for (const abs of changedFiles.map((f) => path.resolve(cwd, f))) {\n    if (isTestFile(abs)) continue;",
      "  for (const abs of new Set(changedFiles.map((f) => sourcePath(cwd, f)).filter(Boolean))) {",
    ],
    [
      "  for (const abs of new Set(changedFiles.map((f) => sourcePath(cwd, f)).filter(Boolean))) {",
      "  const verified = new Map();\n  let removed = 0;\n  for (const abs of new Set(changedFiles.map((f) => sourcePath(cwd, f)).filter(Boolean))) {",
    ],
    [
      "      for (const c of cands) if (order[c.tier] >= order[minTier]) results.push({ newFile: rel, newFn: fp.name, newLine: fp.startLine, ...c });",
      [
        "      for (const c of cands) {",
        "        if (!verified.has(c.file)) {",
        "          let fresh = false;",
        "          const candidatePath = sourcePath(cwd, c.file);",
        "          if (candidatePath) {",
        "            try {",
        "              const st = fs.statSync(candidatePath);",
        "              fresh = index.files[c.file]?.statKey === fileStamp(st);",
        "            } catch (error) {",
        '              if (error.code === "ENOENT" || error.code === "ENOTDIR") removed += Number(index.removeFile(c.file));',
        "            }",
        "          }",
        "          verified.set(c.file, fresh);",
        "        }",
        "        if (verified.get(c.file) && order[c.tier] >= order[minTier]) results.push({ newFile: rel, newFn: fp.name, newLine: fp.startLine, ...c });",
        "      }",
      ].join("\n"),
    ],
    [
      "  return results;\n}",
      "  if (removed > 0) index.scheduleSave(5000);\n  return results;\n}",
    ],
  ],
  "index.mjs": [
    [
      "  upsertFile(rel, contentHash, mtimeMs, funcs) {\n    const prev = this.files[rel];",
      `  upsertFile(rel, contentHash, mtimeMs, funcs, statKey) {
    // ${marker}: a recreated file is no longer a deletion.
    this.removed.delete(rel);
    const prev = this.files[rel];`,
    ],
    [
      "            if (!mine || (disk.mtimeMs ?? 0) > (mine.mtimeMs ?? 0)) this.files[rel] = disk;",
      `            if (!mine || (disk.mtimeMs ?? 0) > (mine.mtimeMs ?? 0)) {
              this.files[rel] = disk;
              this.#dirty = true; // queries must see merged sibling entries
            }`,
    ],
  ],
  "runtime.mjs": [
    [
      'import { findDivergences, buildIndex, isTestFile } from "./radar.mjs";',
      'import { findDivergences, buildIndex, sourcePath } from "./radar.mjs";',
    ],
    [
      "const SUPPORTED = /\\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|py)$/i;\nconst MAX_TURN_FILES = 25; // huge diffs: skip the check (bounded turn cost)\nconst _building = new Set(); // cwd with a background build in flight",
      `// ${marker}: cold full build once; subsequent turns update changed files only.
const MAX_TURN_FILES = 25;
const _building = new Set();
const _built = new Set();`,
    ],
    [
      "  const files = (modifiedAbsPaths ?? []).filter((f) => SUPPORTED.test(f) && !isTestFile(f));",
      "  const files = [...new Set((modifiedAbsPaths ?? []).map((f) => sourcePath(cwd, f)).filter(Boolean))];",
    ],
    [
      [
        '  if (!_building.has(cwd) && resolvedCwd !== home && !resolvedCwd.startsWith(home + path.sep + ".")) {',
        "    _building.add(cwd);",
        "    queueMicrotask(() => {",
        "      buildIndex({ cwd, dataDir }).then(",
        "        (s) => dbg(`semantic-dry: index built (${s.stats.funcs} fns, ${s.stats.ms}ms)`),",
        "        (e) => dbg(`semantic-dry: build failed: ${e}`)",
        "      ).finally(() => _building.delete(cwd));",
        "    });",
        "  }",
      ].join("\n"),
      [
        "  const key = JSON.stringify([resolvedCwd, path.resolve(dataDir)]);",
        "  if (_building.has(key)) return null;",
        '  if (!_built.has(key) && resolvedCwd !== path.parse(resolvedCwd).root && resolvedCwd !== home && !resolvedCwd.startsWith(home + path.sep + ".")) {',
        "    _building.add(key);",
        "    queueMicrotask(() => {",
        "      buildIndex({ cwd, dataDir }).then(",
        "        (s) => {",
        "          _built.add(key);",
        "          if (_built.size > 32) _built.delete(_built.values().next().value);",
        "          dbg(`semantic-dry: index built (${s.stats.funcs} fns, ${s.stats.ms}ms)`);",
        "        },",
        "        (e) => dbg(`semantic-dry: build failed: ${e}`)",
        "      ).finally(() => _building.delete(key));",
        "    });",
        "    return null; // Never query a partial cold index or race a second cache load.",
        "  }",
      ].join("\n"),
    ],
    [
      [
        "  if (_building.has(cwd) === false) {",
        "    buildIndex({ cwd, dataDir, changedFiles: rel }).catch((e) => dbg(`semantic-dry: upsert failed: ${e}`));",
        "  }",
      ].join("\n"),
      "  await buildIndex({ cwd, dataDir, changedFiles: rel }).catch((e) => dbg(`semantic-dry: upsert failed: ${e}`));",
    ],
  ],
};

// Older installed state patches already contain these blocks. Preserve their
// exact migration anchors as well as the pristine upstream form.
const freshnessEdit = changes["radar.mjs"].find(([, after]) => after.includes("fresh = index.files[c.file]?.statKey"));
freshnessEdit.push([freshnessEdit[1].replace(
  "fresh = index.files[c.file]?.statKey === fileStamp(st);",
  "fresh = index.files[c.file]?.contentHash === `${st.size}:${Math.round(st.mtimeMs)}`;",
)]);
const upsertEdit = changes["index.mjs"][0];
upsertEdit.push([upsertEdit[1].replace("funcs, statKey)", "funcs)")]);

// Quality repairs preserve Python semantics, exact source hashes, cache freshness
// and bounded cross-file recall through the same local-source patch owner.
const qualityChanges = {
  "extract.mjs": [
    [
      "// semantic-radar/extract.mjs — function extraction + feature vectors via web-tree-sitter.\n// Zero LLM, zero deps beyond the wasm grammars pi-lens already ships.\nimport { createRequire } from \"node:module\";\nimport { fileURLToPath } from \"node:url\";\nimport fs from \"node:fs\";\nimport path from \"node:path\";\nimport { fnv1a, fnv1a16, minhashSignature } from \"./hash.mjs\";\n\nconst HERE = path.dirname(fileURLToPath(import.meta.url));\n",
      "// PI_LENS_RADAR_STATE_V1: preserve bounded local fingerprint quality fixes.\n// semantic-radar/extract.mjs — function extraction + feature vectors via web-tree-sitter.\n// Zero LLM, zero deps beyond the wasm grammars pi-lens already ships.\nimport { createRequire } from \"node:module\";\nimport { fileURLToPath } from \"node:url\";\nimport fs from \"node:fs\";\nimport path from \"node:path\";\nimport { createHash } from \"node:crypto\";\nimport { fnv1a, fnv1a16, minhashSignature } from \"./hash.mjs\";\n\nconst HERE = path.dirname(fileURLToPath(import.meta.url));\n"
    ],
    [
      "    const prop = fn.childForFieldName(\"property\") ?? fn;\n    return prop.text;\n  }\n  if (fn.type === \"property_identifier\") return fn.text;\n  return null;\n}\n\nfunction litClass(node) {\n  const t = node.type;\n  if (t === \"number\") return \"num\";\n  if (t === \"true\" || t === \"false\" || t === \"null\" || t === \"none\") return \"lit\";\n  if (t === \"string\" || t === \"string_fragment\" || t === \"template_string\") {\n    const v = node.text.toLowerCase();\n",
      "    const prop = fn.childForFieldName(\"property\") ?? fn;\n    return prop.text;\n  }\n  if (fn.type === \"attribute\") return fn.childForFieldName(\"attribute\")?.text ?? null;\n  return null;\n}\n\nfunction litClass(node) {\n  const t = node.type;\n  if (t === \"number\" || t === \"integer\" || t === \"float\") return \"num\";\n  if (t === \"true\" || t === \"false\" || t === \"null\" || t === \"none\") return \"lit\";\n  if (t === \"string\" || t === \"string_fragment\" || t === \"template_string\") {\n    const v = node.text.toLowerCase();\n"
    ],
    [
      "    skel.push(n.type);\n    const operator = n.childForFieldName(\"operator\");\n    if (operator) expand(feats, \"operator\", operator.text, 2);\n    if (n.type === \"call_expression\") {\n      const c = calleeName(n);\n      if (c) { calls.add(c.toLowerCase()); expand(feats, \"call\", c.toLowerCase(), W.call); }\n    }\n",
      "    skel.push(n.type);\n    const operator = n.childForFieldName(\"operator\");\n    if (operator) expand(feats, \"operator\", operator.text, 2);\n    // Python comparisons/boolean operators have anonymous operator children,\n    // unlike JS binary expressions with a single named operator field.\n    if (!operator && [\"comparison_operator\", \"boolean_operator\", \"not_operator\"].includes(n.type)) {\n      for (const child of n.children) if (!child.isNamed && /^(?:[<>=!]+|and|or|not|in|not in|is|is not)$/.test(child.text))\n        expand(feats, \"operator\", child.text, 2);\n    }\n    if (n.type === \"call_expression\" || n.type === \"call\") {\n      const c = calleeName(n);\n      if (c) { calls.add(c.toLowerCase()); expand(feats, \"call\", c.toLowerCase(), W.call); }\n    }\n"
    ],
    [
      "      props.add(n.text.toLowerCase());\n      expand(feats, \"prop\", n.text.toLowerCase(), W.prop);\n    }\n    if (n.type === \"number\" || n.type === \"string\" || n.type === \"template_string\") {\n      const lc = litClass(n);\n      if (lc) {\n        expand(feats, \"lit\", lc, W.lit);\n",
      "      props.add(n.text.toLowerCase());\n      expand(feats, \"prop\", n.text.toLowerCase(), W.prop);\n    }\n    if (n.type === \"attribute\") {\n      const prop = n.childForFieldName(\"attribute\");\n      if (prop) { props.add(prop.text.toLowerCase()); expand(feats, \"prop\", prop.text.toLowerCase(), W.prop); }\n    }\n    if ([\"number\", \"integer\", \"float\", \"string\", \"template_string\"].includes(n.type)) {\n      const lc = litClass(n);\n      if (lc) {\n        expand(feats, \"lit\", lc, W.lit);\n"
    ],
    [
      "    const { feats, calls, props, retShape, arity, skelLen } = featureVector(n);\n    if (skelLen < 12) return; // boilerplate/trivial guard (task: don't flag normal boilerplate)\n    const id = n.startIndex + \":\" + fnv1a16(name + \":\" + n.startPosition.row + \":\" + (src?.length ?? 0));\n    out.push({\n      name, id, startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1,\n      skelLen, calls: [...calls].sort(), props: [...props].sort(), retShape, arity,\n      feats: [...feats].sort(),\n      sig: minhashSignature(feats),\n    });\n  });\n",
      "    const { feats, calls, props, retShape, arity, skelLen } = featureVector(n);\n    if (skelLen < 12) return; // boilerplate/trivial guard (task: don't flag normal boilerplate)\n    const id = n.startIndex + \":\" + fnv1a16(name + \":\" + n.startPosition.row + \":\" + (src?.length ?? 0));\n    const sortedFeatures = [...feats].sort();\n    out.push({\n      name, id, startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1,\n      skelLen, calls: [...calls].sort(), props: [...props].sort(), retShape, arity,\n      feats: sortedFeatures,\n      // Similarity features discard order and identifier binding. Only exact\n      // function text can establish the stronger lexical tier.\n      lexicalHash: createHash(\"sha256\").update(n.text).digest(\"hex\"),\n      sig: minhashSignature(feats),\n    });\n  });\n"
    ],
    [
      "  try { src = fs.readFileSync(filePath, \"utf8\"); } catch { return { supported: true, funcs: [], error: \"unreadable\" }; }\n  if (src.length > 2_000_000) return { supported: true, funcs: [], error: \"too-large\" };\n  const tree = parser.parse(src);\n  const funcs = extractFunctions(tree.rootNode, src);\n  tree.delete?.();\n  return { supported: true, funcs };\n}",
      "  try { src = fs.readFileSync(filePath, \"utf8\"); } catch { return { supported: true, funcs: [], error: \"unreadable\" }; }\n  if (src.length > 2_000_000) return { supported: true, funcs: [], error: \"too-large\" };\n  const tree = parser.parse(src);\n  try {\n    const funcs = extractFunctions(tree.rootNode, src);\n    return { supported: true, funcs, contentHash: createHash(\"sha256\").update(src).digest(\"hex\") };\n  } finally { tree.delete?.(); }\n}\n"
    ]
  ],
  "hash.mjs": [
    [
      "// semantic-radar/hash.mjs — MinHash + LSH, zero deps.\n// Signature: 64 32-bit hashes via FNV-1a. Jaccard via signature intersection\n// (estimate, not exact: ideal independent MinHash has standard error\n",
      "// PI_LENS_RADAR_STATE_V1: preserve bounded local fingerprint quality fixes.\n// semantic-radar/hash.mjs — MinHash + LSH, zero deps.\n// Signature: 64 32-bit hashes via FNV-1a. Jaccard via signature intersection\n// (estimate, not exact: ideal independent MinHash has standard error\n"
    ],
    [
      " * table: Map<bucketKey, Set<entryId>>. Returns entryId -> bandHits (>=1).\n * Bounded: caller passes maxCandidates.\n */\nexport function lshCandidates(table, buckets, maxCandidates = 64, excludeId) {\n  const hits = new Map();\n  if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) return hits;\n  for (const bk of buckets) {\n    const set = table.get(bk);\n    if (!set) continue;\n    for (const id of set) {\n      if (id === excludeId) continue;\n      const n = (hits.get(id) ?? 0) + 1;\n      hits.set(id, n);\n      // Enforce the bound inside a bucket: generated/duplicate-heavy code can\n",
      " * table: Map<bucketKey, Set<entryId>>. Returns entryId -> bandHits (>=1).\n * Bounded: caller passes maxCandidates.\n */\nexport function lshCandidates(table, buckets, maxCandidates = 64, excludeId, eligible = () => true) {\n  const hits = new Map();\n  if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) return hits;\n  // Exclusions must not consume the result cap, but dense excluded buckets\n  // also must not turn candidate retrieval into an unbounded scan.\n  let visits = 0;\n  const maxVisits = Math.min(8192, Math.max(256, maxCandidates * 32));\n  for (const bk of buckets) {\n    const set = table.get(bk);\n    if (!set) continue;\n    for (const id of set) {\n      if (++visits > maxVisits) return hits;\n      if (id === excludeId || !eligible(id)) continue;\n      const n = (hits.get(id) ?? 0) + 1;\n      hits.set(id, n);\n      // Enforce the bound inside a bucket: generated/duplicate-heavy code can\n"
    ]
  ],
  "index.mjs": [
    [
      "import path from \"node:path\";\nimport { lshBuckets, lshCandidates, jaccard } from \"./hash.mjs\";\n\nconst VERSION = 2; // Full IDs and richer literal/operator fingerprints; rebuild old caches.\nconst INDEX_FILE = \"semantic-radar-index.json\";\n\nfunction setOverlap(a, b) {\n",
      "import path from \"node:path\";\nimport { lshBuckets, lshCandidates, jaccard } from \"./hash.mjs\";\n\nconst VERSION = 4; // Exact function-source hashes; feature-set equality is only similarity.\nconst INDEX_FILE = \"semantic-radar-index.json\";\n\nfunction setOverlap(a, b) {\n"
    ],
    [
      "  const domainAgree = (propOv >= 0.5 && po.n >= 1 && shapeMatch) || (callOv >= 0.5 && co.n >= 2) || (co.n >= 1 && shapeMatch);\n  const exactFeatures = Array.isArray(a.feats) && a.feats.length > 0 && Array.isArray(b.feats)\n    && a.feats.length === b.feats.length && a.feats.every((v,i) => v === b.feats[i]);\n  if (sizeOk && exactFeatures) tier = \"lexical\";\n  else if (j >= 0.5 && sizeOk && domainAgree) tier = \"high\";\n  else if (j >= 0.4 && sizeOk && domainAgree) tier = \"probable\";\n  else if (j >= 0.3) tier = \"weak\";\n",
      "  const domainAgree = (propOv >= 0.5 && po.n >= 1 && shapeMatch) || (callOv >= 0.5 && co.n >= 2) || (co.n >= 1 && shapeMatch);\n  const exactSource = typeof a.lexicalHash === \"string\" && /^[a-f0-9]{64}$/.test(a.lexicalHash)\n    && a.lexicalHash === b.lexicalHash;\n  if (sizeOk && exactSource) tier = \"lexical\";\n  else if (j >= 0.5 && sizeOk && domainAgree) tier = \"high\";\n  else if (j >= 0.4 && sizeOk && domainAgree) tier = \"probable\";\n  else if (j >= 0.3) tier = \"weak\";\n"
    ],
    [
      "    // PI_LENS_RADAR_STATE_V1: a recreated file is no longer a deletion.\n    this.removed.delete(rel);\n    const prev = this.files[rel];\n    if (prev?.contentHash === contentHash) return false; // content-addressed: idempotent\n    this.files[rel] = { contentHash, mtimeMs, funcs };\n    this.#dirty = true; // O(1) — table rebuilt once at first query, not per file\n    return true;\n  }\n",
      "    // PI_LENS_RADAR_STATE_V1: a recreated file is no longer a deletion.\n    this.removed.delete(rel);\n    const prev = this.files[rel];\n    if (prev?.contentHash === contentHash) {\n      // Content is unchanged; refresh the cheap stat evidence in memory.\n      if (statKey !== undefined) prev.statKey = statKey;\n      prev.mtimeMs = mtimeMs;\n      return false;\n    }\n    this.files[rel] = { contentHash, mtimeMs, funcs, statKey };\n    this.#dirty = true; // O(1) — table rebuilt once at first query, not per file\n    return true;\n  }\n"
    ],
    [
      "  query(fp, { max = 20, excludeFile = null, minTier = \"weak\" } = {}) {\n    this.#ensureFresh();\n    const order = { lexical: 3, high: 2, probable: 1, weak: 0 };\n    const hits = lshCandidates(this.table, lshBuckets(fp.sig), max * 4);\n    const out = [];\n    for (const [id, bandHits] of hits) {\n      const e = this.entries.get(id);\n",
      "  query(fp, { max = 20, excludeFile = null, minTier = \"weak\" } = {}) {\n    this.#ensureFresh();\n    const order = { lexical: 3, high: 2, probable: 1, weak: 0 };\n    const hits = lshCandidates(this.table, lshBuckets(fp.sig), max * 4, undefined,\n      id => this.entries.get(id)?.file !== excludeFile);\n    const out = [];\n    for (const [id, bandHits] of hits) {\n      const e = this.entries.get(id);\n"
    ],
    [
      "      if (!this.#saveTimer) {\n        this.#saveTimer = setTimeout(() => {\n          this.#saveTimer = null;\n          this.save();\n        }, minIntervalMs - since);\n        this.#saveTimer.unref?.();\n      }\n",
      "      if (!this.#saveTimer) {\n        this.#saveTimer = setTimeout(() => {\n          this.#saveTimer = null;\n          try { this.save(); }\n          catch (error) {\n            // A best-effort cache flush must never become an uncaught timer\n            // exception in the host. Keep live entries and allow a later retry.\n            this.#lastSaveAt = 0;\n            console.error(\"[semantic-radar] deferred save failed:\", error?.code ?? \"write-error\");\n          }\n        }, minIntervalMs - since);\n        this.#saveTimer.unref?.();\n      }\n"
    ],
    [
      "    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, updatedAt: new Date().toISOString(), files: this.files }));\n    fs.renameSync(tmp, p);\n  }\n}",
      "    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, updatedAt: new Date().toISOString(), files: this.files }));\n    fs.renameSync(tmp, p);\n  }\n}\n"
    ]
  ],
  "radar.mjs": [
    [
      "const TEST_FILE_RE = /(^|[/\\\\])(bench|tests?|__tests__|snapshots?)[/\\\\]|[-.](test|spec|bench)\\.[cm]?[jt]sx?$|[-_]test\\.[cm]?[jt]s$/;\nexport function isTestFile(p) { return TEST_FILE_RE.test(p); }\nconst EXTENSIONS = new Set([\".ts\", \".mts\", \".cts\", \".tsx\", \".js\", \".mjs\", \".cjs\", \".jsx\", \".py\"]);\n\n// PI_LENS_RADAR_STATE_V1: incremental paths obey the same scope as full scans.\nexport function sourcePath(cwd, file, ignore = DEFAULT_IGNORE) {\n",
      "const TEST_FILE_RE = /(^|[/\\\\])(bench|tests?|__tests__|snapshots?)[/\\\\]|[-.](test|spec|bench)\\.[cm]?[jt]sx?$|[-_]test\\.[cm]?[jt]s$/;\nexport function isTestFile(p) { return TEST_FILE_RE.test(p); }\nconst EXTENSIONS = new Set([\".ts\", \".mts\", \".cts\", \".tsx\", \".js\", \".mjs\", \".cjs\", \".jsx\", \".py\"]);\nconst fileStamp = st => `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;\n\n// PI_LENS_RADAR_STATE_V1: incremental paths obey the same scope as full scans.\nexport function sourcePath(cwd, file, ignore = DEFAULT_IGNORE) {\n"
    ],
    [
      "      continue;\n    }\n    if (!st.isFile() || st.size > 2_000_000) { removed += Number(index.removeFile(rel)); skipped++; continue; }\n    const contentHash = `${st.size}:${Math.round(st.mtimeMs)}`;\n    // stat-first: unchanged file → no parse at all (warm builds are O(stat))\n    if (index.files[rel]?.contentHash === contentHash) continue;\n    const res = await analyzeFile(abs);\n    if (!res.supported || res.error) { removed += Number(index.removeFile(rel)); skipped++; continue; }\n    if (index.upsertFile(rel, contentHash, st.mtimeMs, res.funcs.map((f) => ({ ...f, feats: undefined })))) updated++;\n  }\n  // Full-build sweep: a moved/deleted file's stale entries must not linger\n  // (else a rename reads as \"new competing implementation\" — task: moved fn\n",
      "      continue;\n    }\n    if (!st.isFile() || st.size > 2_000_000) { removed += Number(index.removeFile(rel)); skipped++; continue; }\n    const statKey = fileStamp(st);\n    // Full warm scans stay O(stat). Explicitly changed paths must be read:\n    // generators/restores may preserve both source size and timestamps.\n    if (!changedFiles && index.files[rel]?.statKey === statKey) continue;\n    const res = await analyzeFile(abs);\n    if (!res.supported || res.error) { removed += Number(index.removeFile(rel)); skipped++; continue; }\n    if (index.upsertFile(rel, res.contentHash, st.mtimeMs, res.funcs.map((f) => ({ ...f, feats: undefined })), statKey)) updated++;\n  }\n  // Full-build sweep: a moved/deleted file's stale entries must not linger\n  // (else a rename reads as \"new competing implementation\" — task: moved fn\n"
    ],
    [
      "  return results;\n}\n\nexport { scorePair };",
      "  return results;\n}\n\nexport { scorePair };\n"
    ]
  ]
};
qualityChanges["index.mjs"].push([" *  - lexical:   identical normalized feature set (renamed-only duplicate)", " *  - lexical:   identical function source text (including names and order)"]);
for (const [name, edits] of Object.entries(qualityChanges)) {
  (changes[name] ??= []).push(...edits);
}

// Extend the existing owner: the previous applied block remains a migration
// anchor, while pristine upstream still reaches the same final postcondition.
// Export these deltas so the regression can reconstruct an installed v4 fork.
export const neuralChanges = {};
function upgradeAppliedEdit(name, anchor, transform) {
  const matching = changes[name].filter(([, after]) => after.includes(anchor));
  if (matching.length !== 1) throw new Error("Neural ranker patch ownership drift: " + anchor);
  const edit = matching[0];
  const previous = edit[1];
  edit[1] = transform(previous);
  (edit[2] ??= []).push(previous);
  (neuralChanges[name] ??= []).push([previous, edit[1]]);
}
function addNeuralEdit(name, before, after) {
  (changes[name] ??= []).push([before, after]);
  (neuralChanges[name] ??= []).push([before, after]);
}

upgradeAppliedEdit("extract.mjs", 'import { fnv1a, fnv1a16, minhashSignature }', source => source
  .replace('import { fnv1a, fnv1a16, minhashSignature } from "./hash.mjs";',
    'import { fnv1a, fnv1a16, minhashSignature } from "./hash.mjs";\nimport { extractRankProfile } from "./rank-features.mjs";'));
upgradeAppliedEdit("extract.mjs", 'lexicalHash: createHash("sha256")', source => source
  .replace('      lexicalHash: createHash("sha256").update(n.text).digest("hex"),',
    '      lexicalHash: createHash("sha256").update(n.text).digest("hex"),\n      rankProfile: extractRankProfile(n),'));
upgradeAppliedEdit("index.mjs", "const VERSION = 4;", source => source
  .replace('import { lshBuckets, lshCandidates, jaccard } from "./hash.mjs";',
    'import { lshBuckets, lshCandidates, jaccard } from "./hash.mjs";\nimport { rankCandidates } from "./neural-ranker.mjs";')
  .replace("const VERSION = 4; // Exact function-source hashes; feature-set equality is only similarity.",
    "const VERSION = 5; // Versioned rank profiles; old fingerprints rebuild before learned ranking."));
upgradeAppliedEdit("runtime.mjs", 'import { findDivergences, buildIndex, sourcePath }', source => source +
  '\nimport { compareCandidates } from "./neural-ranker.mjs";');
addNeuralEdit("index.mjs",
  "    out.sort((a, b) => (order[b.tier] - order[a.tier]) || (b.jaccard - a.jaccard));\n    return out.slice(0, max);",
  "    return rankCandidates(fp, out).slice(0, max);");
addNeuralEdit("runtime.mjs",
  'function rank(t) {\n  return t === "lexical" ? 3 : t === "high" ? 2 : t === "probable" ? 1 : 0;\n}',
  "// Share query ordering so turn-end selection preserves the ranked candidates.");
addNeuralEdit("runtime.mjs",
  "    if (!prev || rank(d.tier) > rank(prev.tier) || (d.tier === prev.tier && d.jaccard > prev.jaccard)) byFn.set(k, d);",
  "    if (!prev || compareCandidates(d, prev) < 0) byFn.set(k, d);");
addNeuralEdit("runtime.mjs",
  "  const top = [...byFn.values()].sort((a, b) => rank(b.tier) - rank(a.tier) || b.jaccard - a.jaccard).slice(0, maxAdvisories);",
  "  const top = [...byFn.values()].sort(compareCandidates).slice(0, maxAdvisories);");

export function isAppliedSource(source, edits) {
  return (
    source.includes(marker) &&
    edits.every(([, after]) => source.split(after).length === 2)
  );
}
export function applySource(source, edits) {
  if (isAppliedSource(source, edits)) return source;
  // Each edit is independently idempotent so repair can finish an interrupted
  // application. Unknown/ambiguous drift still fails before any file is written.
  for (const [before, after, legacy = []] of edits) {
    if (source.split(after).length === 2) continue;
    const anchors = [before, ...legacy].filter(anchor => source.split(anchor).length === 2);
    if (anchors.length !== 1)
      throw new Error("Radar-state anchor drift: " + before.slice(0, 100));
    source = source.replace(anchors[0], () => after);
  }
  if (!isAppliedSource(source, edits))
    throw new Error("Radar-state postcondition failed");
  return source;
}
export function targets(
  root = fileURLToPath(
    new URL("../../extensions/pi-lens/semantic-radar/", import.meta.url),
  ),
) {
  return Object.entries(changes).map(([name, edits]) => {
    const file = root + "/" + name;
    return {
      name: `pi-lens semantic-radar state: ${name}`,
      exists: () => fs.existsSync(file),
      isApplied: () => isAppliedSource(fs.readFileSync(file, "utf8"), edits),
      apply() {
        const source = fs.readFileSync(file, "utf8");
        const next = applySource(source, edits);
        if (next === source) return;
        execFileSync(process.execPath, ["--input-type=module", "--check"], {
          input: next,
        });
        fs.writeFileSync(file, next);
      },
    };
  });
}

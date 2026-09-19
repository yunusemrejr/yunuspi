/** Needle3 worker thread. Hosts the official Cactus `needle.js`/`needle.wasm`
 * engine plus `needle3.cact` weights, exactly one instance per worker.
 *
 * The main thread never touches the engine: every op arrives as a
 * NeedleWorkerRequest and leaves as exactly one NeedleWorkerResponse.
 * Engine calls are synchronous C ABI calls; they block only this worker.
 *
 * Telemetry is disabled before the engine loads (the WASM engine has no
 * network capability of its own; the native CLI fallback honors the same
 * variables at spawn time).
 */
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

process.env.NEEDLE_TELEMETRY = "0";
process.env.DO_NOT_TRACK = "1";

const MAX_TEXTS = 512;
const MAX_TEXT_CHARS = 32768;
const MAX_COMPLETE_OUT = 8192;
const CACHE_MAX = Number.isSafeInteger(workerData?.cacheMax) && workerData.cacheMax > 0
  ? Math.min(32768, workerData.cacheMax)
  : 2048;

if (!parentPort) throw new Error("needle worker requires a parent port");
const port = parentPort;

const err = (message) => (message instanceof Error ? message.message : String(message)).slice(0, 512);

let Module = null;
let dim = 0;
/** sha256(text) -> Float32Array copy. Bounded LRU; embeddings only. */
const cache = new Map();
let cacheHits = 0;

const hashText = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function cacheGet(text) {
  const hit = cache.get(hashText(text));
  if (!hit) return undefined;
  cache.delete(hashText(text));
  cache.set(hashText(text), hit);
  cacheHits++;
  return hit;
}

function cacheSet(text, vec) {
  const key = hashText(text);
  cache.delete(key);
  cache.set(key, vec);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

const cleanText = (raw) => {
  if (typeof raw !== "string") return undefined;
  const text = raw.normalize("NFKC").replace(/\0/g, "");
  if (text.length < 1 || text.length > MAX_TEXT_CHARS) return undefined;
  return text;
};

function withModule() {
  if (!Module || dim <= 0) throw new Error("engine not initialized");
  return Module;
}

/** The loader exposes only HEAPU8; float views are built from its buffer
 * after the call and copied immediately (growth detaches the buffer). */
function heapF32(M, byteOffset, length) {
  const buffer = M.HEAPU8?.buffer;
  if (!buffer || byteOffset < 0 || byteOffset + length * 4 > buffer.byteLength) {
    throw new Error("wasm float view out of bounds");
  }
  return Float32Array.from(new Float32Array(buffer, byteOffset, length));
}

/** Embed one text. Returns a fresh Float32Array (caller-owned copy). */
function embedOne(text) {
  const hit = cacheGet(text);
  if (hit) return Float32Array.from(hit);
  const M = withModule();
  const outPtr = M._malloc(dim * 4);
  if (!outPtr) throw new Error("wasm out of memory");
  try {
    const rc = M.ccall("needle_embed", "number", ["string", "number", "number"], [text, outPtr, dim]);
    if (rc < 0) throw new Error(`needle_embed failed (rc=${rc})`);
    const vec = heapF32(M, outPtr, dim);
    if (vec.length !== dim || !vec.every(Number.isFinite)) throw new Error("needle_embed returned degenerate vector");
    cacheSet(text, vec);
    return vec;
  } finally {
    M._free(outPtr);
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function opInit(assets) {
  if (Module) return { dim, cacheHits };
  const dir = assets?.dir;
  const loaderJs = assets?.loaderJs ?? (dir ? join(dir, "needle.js") : undefined);
  const wasm = assets?.wasm ?? (dir ? join(dir, "needle.wasm") : undefined);
  const weights = assets?.weights ?? (dir ? join(dir, "needle3.cact") : undefined);
  for (const [label, file] of [["loader", loaderJs], ["wasm", wasm], ["weights", weights]]) {
    if (typeof file !== "string" || !existsSync(file)) throw new Error(`needle asset missing: ${label}`);
  }
  // The Emscripten loader resolves needle.wasm relative to its own path.
  const requireAsset = createRequire(loaderJs);
  const createNeedle = requireAsset(loaderJs);
  if (typeof createNeedle !== "function") throw new Error("needle loader export is not a factory");
  return (async () => {
    const M = await createNeedle();
    for (const key of ["_needle_load", "_needle_init", "_needle_reset", "_needle_complete", "_needle_embed", "_malloc", "_free", "ccall", "UTF8ToString"]) {
      if (typeof M[key] !== "function" && key !== "UTF8ToString") throw new Error(`needle loader lacks ${key}`);
    }
    if (typeof M.UTF8ToString !== "function") throw new Error("needle loader lacks UTF8ToString");
    if (!M.HEAPU8 || typeof M.HEAPU8.set !== "function") throw new Error("needle loader lacks HEAPU8");
    const cact = readFileSync(weights);
    if (cact.length < 1024 || cact.length > 256 * 1024 * 1024) throw new Error(`needle weights have an implausible size (${cact.length})`);
    const ptr = M._malloc(cact.length);
    if (!ptr) throw new Error("wasm out of memory for weights");
    try {
      M.HEAPU8.set(cact, ptr);
      // i64 length: the raw export requires a BigInt argument.
      const rc = M._needle_load(ptr, BigInt(cact.length));
      if (rc < 0) throw new Error(`needle_load failed (rc=${rc}); weights may be truncated or mismatched`);
    } finally {
      M._free(ptr);
    }
    const detected = M.ccall("needle_embed", "number", ["string", "number", "number"], ["needle", 0, 0]);
    if (!Number.isInteger(detected) || detected <= 0 || detected > 8192) throw new Error(`needle reported an implausible embedding dim (${detected})`);
    Module = M;
    dim = detected;
    // Representative warmup: the first real forward pass pays buffer
    // allocation (measured >1.5s cold vs ~120ms warm per embed), which the
    // op timeout cannot absorb. Three realistic-length embeds move that
    // cost off the critical path.
    embedOne("fix the failing authentication test in the login handler");
    embedOne("take a screenshot of the browser page for review");
    embedOne("summarize the deployment status and remaining verification work");
    cache.clear();
    return { dim, cacheHits };
  })();
}

function opRank(query, candidates, topK) {
  withModule();
  const q = cleanText(query);
  if (!q) throw new Error("rank query is empty or oversized");
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > MAX_TEXTS) throw new Error("rank needs 1..512 candidates");
  const qv = embedOne(q);
  const scored = [];
  for (const candidate of candidates.slice(0, MAX_TEXTS)) {
    const id = typeof candidate?.id === "string" ? candidate.id.slice(0, 256) : "";
    const text = cleanText(candidate?.text);
    if (!id || !text) continue;
    scored.push({ id, score: cosine(qv, embedOne(text)) });
  }
  if (!scored.length) throw new Error("rank found no usable candidates");
  scored.sort((a, b) => b.score - a.score);
  const limit = Number.isSafeInteger(topK) && topK > 0 ? Math.min(topK, scored.length) : scored.length;
  const ranked = scored.slice(0, limit);
  return { ranked, margin: ranked.length > 1 ? ranked[0].score - ranked[1].score : 0 };
}

function opClassify(text, labels, acceptAt, marginAt) {
  const ranked = opRank(text, labels, labels.length);
  const top = ranked.ranked[0];
  const accepted = top.score >= acceptAt && ranked.margin >= marginAt;
  return { label: top.id, score: top.score, margin: ranked.margin, accepted };
}

/** Bounded grammar-constrained extraction: the record schema becomes the
 * only tool, the engine fills it from the text, and the worker returns the
 * parsed value plus calibrated confidence. Callers still validate shape. */
function opExtract(text, name, schema, system) {
  const M = withModule();
  const body = cleanText(text);
  if (!body) throw new Error("extract text is empty or oversized");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("extract needs an object schema");
  const toolName = typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "record";
  const toolsJson = JSON.stringify([{ name: toolName, description: `Extract a ${toolName} record from the text.`, parameters: schema }]);
  if (toolsJson.length > 16384) throw new Error("extract schema is oversized");
  const sysText = typeof system === "string" ? system.slice(0, 2048) : "";
  const rcInit = M.ccall("needle_init", "number", ["string", "string", "string"], [sysText, toolsJson, null]);
  if (rcInit < 0) throw new Error(`needle_init failed (rc=${rcInit})`);
  const outPtr = M._malloc(MAX_COMPLETE_OUT);
  if (!outPtr) throw new Error("wasm out of memory");
  try {
    const rc = M.ccall("needle_complete", "number", ["string", "number", "number", "number"], [body, 512, outPtr, MAX_COMPLETE_OUT]);
    if (rc < 0) throw new Error(`needle_complete failed (rc=${rc})`);
    const raw = M.UTF8ToString(outPtr);
    if (!raw || raw.length >= MAX_COMPLETE_OUT) throw new Error("needle_complete output missing or truncated");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("needle_complete output is not JSON");
    }
    const calls = Array.isArray(parsed?.function_calls) ? parsed.function_calls : [];
    const call = calls.find((entry) => entry && entry.name === toolName);
    const confidence = typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : null;
    if (!call || typeof call.arguments !== "object" || !call.arguments) {
      return { value: null, confidence, refused: true };
    }
    return { value: call.arguments, confidence, refused: false };
  } finally {
    M._free(outPtr);
    try { M._needle_reset(); } catch { /* Reset is hygiene; a failure surfaces on the next op. */ }
  }
}

function opComplete(input, toolsJson, system, maxTokens) {
  const M = withModule();
  const body = cleanText(input);
  if (!body) throw new Error("complete input is empty or oversized");
  if (typeof toolsJson !== "string" || !toolsJson.length || toolsJson.length > 65536) throw new Error("complete needs a tools document");
  let parsed;
  try {
    parsed = JSON.parse(toolsJson);
  } catch {
    throw new Error("complete tools document is not JSON");
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 64) throw new Error("complete needs 1..64 tools");
  const sysText = typeof system === "string" ? system.slice(0, 2048) : "";
  const rcInit = M.ccall("needle_init", "number", ["string", "string", "string"], [sysText, toolsJson, null]);
  if (rcInit < 0) throw new Error(`needle_init failed (rc=${rcInit})`);
  const outPtr = M._malloc(MAX_COMPLETE_OUT);
  if (!outPtr) throw new Error("wasm out of memory");
  try {
    const budget = Number.isSafeInteger(maxTokens) ? Math.min(1024, Math.max(16, maxTokens)) : 256;
    const rc = M.ccall("needle_complete", "number", ["string", "number", "number", "number"], [body, budget, outPtr, MAX_COMPLETE_OUT]);
    if (rc < 0) throw new Error(`needle_complete failed (rc=${rc})`);
    const raw = M.UTF8ToString(outPtr);
    if (!raw || raw.length >= MAX_COMPLETE_OUT) throw new Error("needle_complete output missing or truncated");
    const envelope = JSON.parse(raw);
    if (!envelope || typeof envelope !== "object") throw new Error("needle_complete output is not an object");
    return envelope;
  } finally {
    M._free(outPtr);
    try { M._needle_reset(); } catch { /* See opExtract. */ }
  }
}

async function handle(message) {
  const started = Date.now();
  const fail = (error) => ({ id: message?.id ?? -1, ok: false, error: err(error), ms: Date.now() - started });
  try {
    if (!message || typeof message !== "object" || !Number.isSafeInteger(message.id)) return fail("malformed request");
    switch (message.op) {
      case "init": {
        const result = await opInit(message.assets);
        return { id: message.id, ok: true, result, ms: Date.now() - started };
      }
      case "embed": {
        withModule();
        if (!Array.isArray(message.texts) || !message.texts.length || message.texts.length > MAX_TEXTS) return fail("embed needs 1..512 texts");
        const vectors = [];
        for (const raw of message.texts) {
          const text = cleanText(raw);
          if (!text) return fail("embed input is empty or oversized");
          vectors.push(Array.from(embedOne(text)));
        }
        return { id: message.id, ok: true, result: { dim, vectors }, ms: Date.now() - started };
      }
      case "rank": {
        const result = opRank(message.query, message.candidates, message.topK);
        return { id: message.id, ok: true, result, ms: Date.now() - started };
      }
      case "classify": {
        const acceptAt = typeof message.acceptAt === "number" ? message.acceptAt : 0.93;
        const marginAt = typeof message.marginAt === "number" ? message.marginAt : 0.02;
        const result = opClassify(message.text, message.labels, acceptAt, marginAt);
        return { id: message.id, ok: true, result, ms: Date.now() - started };
      }
      case "extract": {
        const result = opExtract(message.text, message.name, message.schema, message.system);
        return { id: message.id, ok: true, result, ms: Date.now() - started };
      }
      case "complete": {
        const result = opComplete(message.input, message.toolsJson, message.system, message.maxTokens);
        return { id: message.id, ok: true, result, ms: Date.now() - started };
      }
      case "reset": {
        try { withModule()._needle_reset(); } catch { /* Engine will re-init on next use. */ }
        cache.clear();
        return { id: message.id, ok: true, result: { reset: true }, ms: Date.now() - started };
      }
      case "ping":
        return { id: message.id, ok: true, result: { ready: dim > 0, dim, cacheHits, cached: cache.size }, ms: Date.now() - started };
      default:
        return fail(`unknown op: ${String(message.op).slice(0, 32)}`);
    }
  } catch (error) {
    return fail(error);
  }
}

// Sequential handling: the engine is process-global and non-thread-safe.
let chain = Promise.resolve();
port.on("message", (message) => {
  chain = chain.then(() => handle(message)).then(
    (response) => { port.postMessage(response); },
    (error) => { port.postMessage({ id: message?.id ?? -1, ok: false, error: err(error), ms: 0 }); },
  );
});
port.postMessage({ id: -1, ok: true, result: { hello: "needle-worker" }, ms: 0 });

// Local advisory ranking only: never changes candidate eligibility, tiers,
// lexical identity, cluster edges, or tool/model permissions. No online training.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pairRankFeatures, RANK_FEATURE_NAMES, RANK_FEATURE_VERSION } from "./rank-features.mjs";

const MODEL_URL = new URL("./reuse-ranker-model.json", import.meta.url);
const MAX_MODEL_BYTES = 128 * 1024;
const MAX_PAIRS = 80;
const TIERS = { lexical: 3, high: 2, probable: 1, weak: 0 };
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
let cached;

export function modelDigest(model) {
  return createHash("sha256").update(JSON.stringify([
    model.schemaVersion, model.featureVersion, model.featureNames,
    model.hiddenWeights, model.hiddenBias, model.outputWeights, model.outputBias,
    model.blend, model.trainingDataSha256,
  ])).digest("hex");
}

export function createRanker(model) {
  const finite = x => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 100;
  const row = (x, n) => Array.isArray(x) && x.length === n && x.every(finite);
  const hidden = model?.hiddenBias?.length;
  if (model?.schemaVersion !== 1 || model?.featureVersion !== RANK_FEATURE_VERSION
      || JSON.stringify(model.featureNames) !== JSON.stringify(RANK_FEATURE_NAMES)
      || !Number.isInteger(hidden) || hidden < 1 || hidden > 32
      || !Array.isArray(model.hiddenWeights) || model.hiddenWeights.length !== hidden
      || !model.hiddenWeights.every(x => row(x, RANK_FEATURE_NAMES.length))
      || !row(model.hiddenBias, hidden) || !row(model.outputWeights, hidden) || !finite(model.outputBias)
      || !Number.isFinite(model.blend) || model.blend < 0 || model.blend > 1) return null;
  // Copy once: a mutable artifact object cannot alter a validated live model.
  const weights = model.hiddenWeights.map(x => [...x]), biases = [...model.hiddenBias];
  const output = [...model.outputWeights], outputBias = model.outputBias;
  return Object.freeze({
    blend: model.blend,
    score(values) {
      if (!Array.isArray(values) || values.length !== RANK_FEATURE_NAMES.length
          || !values.every(x => Number.isFinite(x) && x >= 0 && x <= 1)) return null;
      let sum = outputBias;
      for (let j = 0; j < hidden; j++) {
        let z = biases[j];
        for (let i = 0; i < values.length; i++) z += weights[j][i] * values[i];
        sum += output[j] * Math.tanh(z);
      }
      return sigmoid(sum);
    },
  });
}

function loadModel() {
  if (cached !== undefined) return cached;
  cached = { available: false, reason: "missing-or-invalid-model" };
  try {
    const stat = fs.statSync(MODEL_URL);
    if (!stat.isFile() || stat.size > MAX_MODEL_BYTES) return cached;
    const raw = fs.readFileSync(MODEL_URL, "utf8");
    if (Buffer.byteLength(raw) > MAX_MODEL_BYTES) return cached;
    const model = JSON.parse(raw), ranker = createRanker(model);
    if (!ranker || model.activation !== "validated" || !/^[a-f0-9]{64}$/.test(model.trainingDataSha256 ?? "")
        || model.modelSha256 !== modelDigest(model)) return cached;
    cached = { available: true, ranker, modelId: createHash("sha256").update(raw).digest("hex").slice(0, 16) };
  } catch { /* Missing/corrupt artifact leaves the existing rule ranker active. */ }
  return cached;
}

export function neuralRankerMode() {
  const value = process.env.PI_LENS_NEURAL_RANKER;
  if (value === undefined) return "on";
  return value === "on" || value === "shadow" ? value : "off";
}

export function neuralRankerStatus() {
  const mode = neuralRankerMode();
  if (mode === "off") return { mode, available: false, reason: "disabled", featureVersion: RANK_FEATURE_VERSION };
  const { available, reason, modelId } = loadModel();
  return { mode, available, reason, modelId, featureVersion: RANK_FEATURE_VERSION };
}

/** A total scalar ordering; never switches metrics conditionally for a pair. */
export function compareCandidates(a, b) {
  const rank = x => Number.isFinite(x.rankingScore) ? x.rankingScore : (Number.isFinite(x.jaccard) ? x.jaccard : 0);
  return (TIERS[b.tier] ?? -1) - (TIERS[a.tier] ?? -1)
    || rank(b) - rank(a) || (b.jaccard ?? 0) - (a.jaccard ?? 0);
}

export function rankCandidates(fp, candidates, { mode = neuralRankerMode() } = {}) {
  // Never trust rank fields supplied by a caller or left from an earlier mode.
  const out = candidates.map(({ neuralScore, rankingScore, ...candidate }) => candidate);
  if (mode !== "on" && mode !== "shadow") return out.sort(compareCandidates);
  if (out.length > MAX_PAIRS || !out.some(c => c.tier === "high" || c.tier === "probable")) return out.sort(compareCandidates);
  const model = loadModel();
  if (!model.available) return out.sort(compareCandidates);
  const start = performance.now();
  let scored = 0, fallback = 0;
  for (const tier of ["high", "probable"]) {
    const group = out.filter(c => c.tier === tier);
    if (!group.length) continue;
    const rows = group.map(c => pairRankFeatures(fp, c, c));
    // OOD/missing evidence abstains for the whole tier group, so partial old
    // indexes cannot privilege the subset that happened to have new features.
    if (rows.some(x => x === null)) { fallback += group.length; continue; }
    const scores = rows.map(x => model.ranker.score(x));
    if (scores.some(x => x === null)) { fallback += group.length; continue; }
    scored += group.length;
    if (mode === "on") for (let i = 0; i < group.length; i++) {
      group[i].neuralScore = scores[i];
      group[i].rankingScore = (1 - model.ranker.blend) * group[i].jaccard + model.ranker.blend * scores[i];
    }
  }
  // Existing bounded health sink accepts scalar evidence only; no source,
  // path, prompt, literal, or feature vector is written to telemetry.
  try { globalThis[Symbol.for("yunus-pi.health.v1")]?.("ml.radar.rank", {
    decision: mode, route: model.modelId, count: scored, dropped: fallback,
    durationMs: performance.now() - start,
  }); } catch {}
  return out.sort(compareCandidates);
}
